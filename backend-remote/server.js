'use strict';

require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters.');
  process.exit(1);
}
if (process.env.JWT_SECRET === 'your-super-secret-jwt-key-change-this-in-production-min-32-chars') {
  console.error('FATAL: JWT_SECRET が .env.example のデフォルト値のままです。必ず変更してください。');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY must be set.');
  process.exit(1);
}

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Allow Tauri webview origins
app.use(cors({
  origin: ['tauri://localhost', 'https://tauri.localhost', 'http://localhost:1420'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting (in-memory, resets on restart) ──────────────────────────────
// Per-user daily limit prevents runaway usage on the free Anthropic key.
const dailyUsage = new Map(); // userId -> { date: string, count: number }
const DAILY_LIMIT = 30;

function checkDailyLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = dailyUsage.get(userId);
  if (entry?.date === today) {
    if (entry.count >= DAILY_LIMIT) return false;
    entry.count++;
  } else {
    dailyUsage.set(userId, { date: today, count: 1 });
  }
  return true;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
// Validates the JWT issued by the local backend. No DB lookup needed here —
// the signature check is sufficient since we share the same JWT_SECRET.
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ message: '認証が必要です' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    req.userId = String(decoded.id);
    next();
  } catch {
    res.status(401).json({ message: 'トークンが無効または期限切れです' });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/analyze', requireAuth, async (req, res) => {
  if (!checkDailyLimit(req.userId)) {
    return res.status(429).json({
      message: `1日の分析回数上限（${DAILY_LIMIT}回）に達しました。明日またお試しください。`,
    });
  }

  const { rank, agent, selfAssessment, review, videoAnalysis } = req.body;

  if (!rank || !agent) {
    return res.status(400).json({ message: 'ランクとエージェントは必須です' });
  }
  if (typeof agent !== 'string' || agent.length > 60) {
    return res.status(400).json({ message: 'エージェント名は60文字以内です' });
  }
  if (review && (typeof review !== 'string' || review.length > 2000)) {
    return res.status(400).json({ message: '振り返りは2000文字以内です' });
  }
  if (selfAssessment && (!Array.isArray(selfAssessment) || selfAssessment.length > 10 ||
      selfAssessment.some((s) => typeof s !== 'string' || s.length > 100))) {
    return res.status(400).json({ message: '自己評価の値が不正です' });
  }

  const assessmentText = Array.isArray(selfAssessment) && selfAssessment.length > 0
    ? selfAssessment.join('、')
    : '特になし';

  // Build user prompt (mirrors prompt_builder.rs)
  let userPrompt = `プレイヤー情報:\n- ランク: ${rank}\n- エージェント: ${agent}\n- 自己評価の課題: ${assessmentText}\n- プレイ振り返り: ${review || '特になし'}\n`;

  if (videoAnalysis && typeof videoAnalysis === 'object') {
    const va = videoAnalysis;
    userPrompt += '\n【自動解析データ (YOLOv8)】\n';
    if (va.kills != null && va.deaths != null && va.assists != null)
      userPrompt += `- KDA: ${va.kills}/${va.deaths}/${va.assists}\n`;
    if (va.headshotRate != null)
      userPrompt += `- ヘッドショット率: ${Math.round(va.headshotRate * 100)}%\n`;
    if (va.damageDealt != null)
      userPrompt += `- ダメージ合計: ${va.damageDealt}\n`;
    if (va.abilityKills != null)
      userPrompt += `- アビリティキル: ${va.abilityKills}回\n`;
    if (va.dominantZone != null)
      userPrompt += `- 主な活動エリア: ${va.dominantZone}\n`;
    if (va.aggressiveness != null) {
      const label = va.aggressiveness > 0.7 ? '積極的' : va.aggressiveness > 0.4 ? 'バランス型' : '慎重';
      userPrompt += `- ポジショニング傾向: ${label} (スコア: ${va.aggressiveness.toFixed(2)})\n`;
    }
    if (va.deathsInLateRound != null)
      userPrompt += `- ラウンド後半デス数: ${va.deathsInLateRound}回\n`;
    if (va.longestLoseStreak != null)
      userPrompt += `- 最長連敗ストリーク: ${va.longestLoseStreak}ラウンド\n`;
    if (va.totalRounds != null && va.wonRounds != null)
      userPrompt += `- ラウンド勝敗: ${va.wonRounds}/${va.totalRounds}\n`;
    userPrompt += '\n上記の客観的データと、プレイヤーの自己評価を合わせて分析してください。\n';
  }

  userPrompt += '\n上記の情報を基に、Valorantのコーチングレポートを生成してください。必ず有効なJSONのみを返してください。';

  const systemPrompt = `あなたはValorantのプロコーチです。
全ランク帯（アイアン〜レディアント）のプレイヤーに対して、そのランクに合った具体的で実行可能な改善アドバイスを提供してください。
抽象的な表現は禁止。必ず"行動レベル"に落としてください。
データがある場合は必ず数値を引用して根拠を示してください（例: 「HS率が23%と低いため…」）。

以下のJSON形式のみで返答してください：
{
  "improvements": [
    {
      "title": "改善点のタイトル",
      "description": "詳細な説明（数値データがあれば引用）",
      "cause": "問題の根本原因",
      "actions": ["具体的なアクション1", "アクション2", "アクション3"]
    }
  ],
  "training_plan": [
    "Day1: 具体的なトレーニング内容",
    "Day2: ...",
    "Day3: ...",
    "Day4: ...",
    "Day5: ...",
    "Day6: ...",
    "Day7: ..."
  ],
  "summary": {
    "strengths": "プレイヤーの強みの説明",
    "weaknesses": "主な弱点の説明",
    "focus": "最優先で取り組むべき課題"
  }
}`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const content = response.content[0]?.text;
    if (!content) throw new Error('Anthropic returned empty response');

    const parsed = JSON.parse(content);

    const isValidImprovement = (item) =>
      item && typeof item.title === 'string' &&
      typeof item.description === 'string' &&
      typeof item.cause === 'string' &&
      Array.isArray(item.actions) &&
      item.actions.every((a) => typeof a === 'string');

    if (
      !Array.isArray(parsed.improvements) || !parsed.improvements.every(isValidImprovement) ||
      !Array.isArray(parsed.training_plan) || !parsed.training_plan.every((d) => typeof d === 'string') ||
      !parsed.summary || typeof parsed.summary.strengths !== 'string' ||
      typeof parsed.summary.weaknesses !== 'string' || typeof parsed.summary.focus !== 'string'
    ) {
      throw new Error('AI response failed structural validation');
    }

    res.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    if (err.status === 401 || err.message?.includes('API key')) {
      return res.status(500).json({ message: 'Anthropic APIキーが正しく設定されていません' });
    }
    res.status(500).json({ message: 'AI分析に失敗しました。もう一度お試しください。' });
  }
});

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Remote analyze server running on port ${PORT}`));
