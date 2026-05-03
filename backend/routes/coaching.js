'use strict';

const express = require("express");
const jwt = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("../db");

const router = express.Router();

// Singleton Anthropic client — created once, reused for every request
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Per-user daily rate limit — persisted in the daily_usage table so restarts don't reset counts.
// Free users: 5/day  Paid users: 20/day
const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PAID = 20;

const _stmtUpsert = db.prepare(`
  INSERT INTO daily_usage (user_id, date, count) VALUES (?, ?, 1)
  ON CONFLICT (user_id, date) DO UPDATE SET count = count + 1
`);
const _stmtGet = db.prepare(
  `SELECT count FROM daily_usage WHERE user_id = ? AND date = ?`
);

function checkDailyLimit(userId, isPaid) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const limit = isPaid ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE;
  const row = _stmtGet.get(userId, today);
  if (row && row.count >= limit) return false;
  _stmtUpsert.run(userId, today);
  return true;
}

function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "認証が必要です" });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(decoded.id);
    if (!user) return res.status(401).json({ message: "ユーザーが見つかりません" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "トークンが無効または期限切れです" });
  }
}

// GET /me
router.get("/me", requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    isPaid: req.user.is_paid === 1,
  });
});

// DELETE /me — GDPR Right to Erasure: permanently delete the account and all associated data
router.delete("/me", requireAuth, (req, res) => {
  const userId = req.user.id;
  // Use a transaction so all deletes succeed or all roll back atomically
  const deleteAll = db.transaction(() => {
    db.prepare("DELETE FROM daily_usage    WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM match_sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users          WHERE id      = ?").run(userId);
  });
  try {
    deleteAll();
    res.json({ ok: true, message: "アカウントとすべての関連データを削除しました" });
  } catch (err) {
    console.error("Account deletion error:", err);
    res.status(500).json({ message: "アカウントの削除に失敗しました" });
  }
});

// POST /analyze
router.post("/analyze", requireAuth, async (req, res) => {
  if (!checkDailyLimit(req.user.id, req.user.is_paid === 1)) {
    const limit = req.user.is_paid === 1 ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE;
    return res.status(429).json({
      message: `1日の分析回数上限（${limit}回）に達しました。明日またお試しください。`,
    });
  }

  const { rank, agent, selfAssessment, review, videoAnalysis } = req.body;

  if (!rank || !agent) {
    return res.status(400).json({ message: "ランクとエージェントは必須です" });
  }

  // Enforce input length limits to prevent oversized payloads reaching the AI API
  const MAX_AGENT_LEN = 60;
  const MAX_REVIEW_LEN = 2000;
  const MAX_ASSESSMENT_ITEMS = 10;
  const MAX_ASSESSMENT_ITEM_LEN = 100;

  if (typeof agent !== "string" || agent.length > MAX_AGENT_LEN) {
    return res.status(400).json({ message: `エージェント名は${MAX_AGENT_LEN}文字以内で入力してください` });
  }
  if (review && (typeof review !== "string" || review.length > MAX_REVIEW_LEN)) {
    return res.status(400).json({ message: `振り返りは${MAX_REVIEW_LEN}文字以内で入力してください` });
  }
  if (selfAssessment) {
    if (!Array.isArray(selfAssessment) || selfAssessment.length > MAX_ASSESSMENT_ITEMS
      || selfAssessment.some((s) => typeof s !== "string" || s.length > MAX_ASSESSMENT_ITEM_LEN)) {
      return res.status(400).json({ message: "自己評価の値が不正です" });
    }
  }

  const assessmentText =
    Array.isArray(selfAssessment) && selfAssessment.length > 0
      ? selfAssessment.join("、")
      : "特になし";

  const systemPrompt = `あなたはValorantのプロコーチです。
初心者〜中級者（ブロンズ〜プラチナ）に対して、具体的で実行可能な改善アドバイスを提供してください。
抽象的な表現は禁止。必ず"行動レベル"に落としてください。

以下のJSON形式のみで返答してください：

{
  "improvements": [
    {
      "title": "改善点のタイトル",
      "description": "詳細な説明",
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

  let userPrompt = `プレイヤー情報:\n- ランク: ${rank}\n- エージェント: ${agent}\n- 自己評価の課題: ${assessmentText}\n- プレイ振り返り: ${review || "特になし"}\n`;

  if (videoAnalysis && typeof videoAnalysis === "object") {
    const va = videoAnalysis;
    userPrompt += "\n【自動解析データ (YOLOv8)】\n";
    if (va.kills != null && va.deaths != null && va.assists != null) {
      userPrompt += `- KDA: ${va.kills}/${va.deaths}/${va.assists}\n`;
    }
    if (va.headshotRate != null) {
      userPrompt += `- ヘッドショット率: ${Math.round(va.headshotRate * 100)}%\n`;
    }
    if (va.damageDealt != null) {
      userPrompt += `- ダメージ合計: ${va.damageDealt}\n`;
    }
    if (va.abilityKills != null) {
      userPrompt += `- アビリティキル: ${va.abilityKills}回\n`;
    }
    if (va.dominantZone != null) {
      userPrompt += `- 主な活動エリア: ${va.dominantZone}\n`;
    }
    if (va.aggressiveness != null) {
      const label = va.aggressiveness > 0.7 ? "積極的" : va.aggressiveness > 0.4 ? "バランス型" : "慎重";
      userPrompt += `- ポジショニング傾向: ${label} (スコア: ${va.aggressiveness.toFixed(2)})\n`;
    }
    if (va.deathsInLateRound != null) {
      userPrompt += `- ラウンド後半デス数: ${va.deathsInLateRound}回\n`;
    }
    if (va.longestLoseStreak != null) {
      userPrompt += `- 最長連敗ストリーク: ${va.longestLoseStreak}ラウンド\n`;
    }
    if (va.totalRounds != null && va.wonRounds != null) {
      userPrompt += `- ラウンド勝敗: ${va.wonRounds}/${va.totalRounds}\n`;
    }
    userPrompt += "\n上記の客観的データと、プレイヤーの自己評価を合わせて分析してください。\n";
  }

  userPrompt += "\n上記の情報を基に、Valorantのコーチングレポートを生成してください。必ず有効なJSONのみを返してください。";

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });

    const content = response.content[0]?.text;
    if (!content) throw new Error("Anthropic returned empty response");

    const parsed = JSON.parse(content);

    // Structural validation: ensure arrays/objects have the right shape
    // so ReportScreen never calls .map() on a non-array
    const isValidImprovement = (item) =>
      item && typeof item === "object" &&
      typeof item.title === "string" &&
      typeof item.description === "string" &&
      typeof item.cause === "string" &&
      Array.isArray(item.actions) &&
      item.actions.every((a) => typeof a === "string");

    if (
      !Array.isArray(parsed.improvements) ||
      !parsed.improvements.every(isValidImprovement) ||
      !Array.isArray(parsed.training_plan) ||
      !parsed.training_plan.every((d) => typeof d === "string") ||
      !parsed.summary ||
      typeof parsed.summary !== "object" ||
      typeof parsed.summary.strengths !== "string" ||
      typeof parsed.summary.weaknesses !== "string" ||
      typeof parsed.summary.focus !== "string"
    ) {
      throw new Error("AI response failed structural validation");
    }

    res.json(parsed);
  } catch (err) {
    console.error("Analyze error:", err);
    if (err.status === 401 || err.message?.includes("API key")) {
      return res.status(500).json({ message: "Anthropic APIキーが正しく設定されていません" });
    }
    res.status(500).json({ message: "AI分析に失敗しました。もう一度お試しください。" });
  }
});

module.exports = { router, requireAuth };
