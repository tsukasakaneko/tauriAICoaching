import { Agent, tool } from '@strands-agents/sdk';
import { VercelModel } from '@strands-agents/sdk/models/vercel';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { parse as parseToml } from 'smol-toml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tomlPath = process.env.RESOURCE_DIR
  ? join(process.env.RESOURCE_DIR, 'agent_knowledge.toml')
  : resolve(__dirname, '../../src-tauri/resources/agent_knowledge.toml');

const knowledge = parseToml(readFileSync(tomlPath, 'utf8'));

const RANK_MAP = {
  'アイアン': 'Iron',       'iron': 'Iron',
  'ブロンズ': 'Bronze',     'bronze': 'Bronze',
  'シルバー': 'Silver',     'silver': 'Silver',
  'ゴールド': 'Gold',       'gold': 'Gold',
  'プラチナ': 'Platinum',   'platinum': 'Platinum',
  'ダイアモンド': 'Diamond', 'diamond': 'Diamond',
  'アセンダント': 'Ascendant', 'ascendant': 'Ascendant',
  'イモータル': 'Immortal', 'immortal': 'Immortal',
  'レディアント': 'Radiant', 'radiant': 'Radiant',
};

const lookupAgentKnowledge = tool({
  name: 'lookup_agent_knowledge',
  description: 'Valorant エージェントのロール・プレイスタイル・コーチング Tip を取得する',
  inputSchema: z.object({
    agentName: z.string().describe('英語のエージェント名 (例: Jett, Sage, Reyna)'),
  }),
  callback: ({ agentName }) => {
    const info = knowledge.agents?.[agentName];
    if (!info) {
      return `エージェント "${agentName}" は知識ベースにありません。一般的なアドバイスを提供してください。`;
    }
    const tips = Array.isArray(info.tips)
      ? info.tips.map((t) => `  - ${t}`).join('\n')
      : '';
    return [`ロール: ${info.role}`, `プレイスタイル: ${info.playstyle}`, `コーチング Tip:\n${tips}`].join('\n');
  },
});

const lookupRankGuidance = tool({
  name: 'lookup_rank_guidance',
  description: 'プレイヤーのランクに合わせたコーチング方針を取得する',
  inputSchema: z.object({
    rank: z.string().describe('ランク名（日本語または英語）例: ゴールド, Gold, ゴールド1'),
  }),
  callback: ({ rank }) => {
    const lc = rank.toLowerCase();
    const key = Object.entries(RANK_MAP).find(([k]) => lc.startsWith(k.toLowerCase()))?.[1];
    const info = key && knowledge.ranks?.[key];
    if (!info) {
      return `ランク "${rank}" の専用指針はありません。基礎徹底のアドバイスを提供してください。`;
    }
    return `${key} 向けコーチング指針:\n${info.calibration}`;
  },
});

const formatVideoStats = tool({
  name: 'format_video_stats',
  description: 'YOLOv8 動画解析データを人間が読みやすいテキストに整形する',
  inputSchema: z.object({
    statsJson: z.string().optional().describe(
      'videoAnalysis オブジェクトの JSON 文字列。動画なしの場合は省略'
    ),
  }),
  callback: ({ statsJson }) => {
    if (!statsJson) return '動画解析データなし。';
    let va;
    try {
      va = JSON.parse(statsJson);
    } catch {
      return '動画解析 JSON のパースに失敗しました。';
    }
    const lines = ['【自動解析データ (YOLOv8)】'];
    if (va.kills != null)         lines.push(`- KDA: ${va.kills}/${va.deaths}/${va.assists}`);
    if (va.headshotRate != null)  lines.push(`- ヘッドショット率: ${Math.round(va.headshotRate * 100)}%`);
    if (va.damageDealt != null)   lines.push(`- ダメージ合計: ${va.damageDealt}`);
    if (va.abilityKills != null)  lines.push(`- アビリティキル: ${va.abilityKills}回`);
    if (va.dominantZone != null)  lines.push(`- 主な活動エリア: ${va.dominantZone}`);
    if (va.aggressiveness != null) {
      const label = va.aggressiveness > 0.7 ? '積極的' : va.aggressiveness > 0.4 ? 'バランス型' : '慎重';
      lines.push(`- ポジショニング傾向: ${label} (${va.aggressiveness.toFixed(2)})`);
    }
    if (va.deathsInLateRound != null) lines.push(`- ラウンド後半デス: ${va.deathsInLateRound}回`);
    if (va.longestLoseStreak != null) lines.push(`- 最長連敗: ${va.longestLoseStreak}R`);
    if (va.totalRounds != null)   lines.push(`- ラウンド勝敗: ${va.wonRounds}/${va.totalRounds}`);
    return lines.join('\n');
  },
});

export const CoachingReportSchema = z.object({
  improvements: z.array(
    z.object({
      title:       z.string(),
      description: z.string(),
      cause:       z.string(),
      actions:     z.array(z.string()),
    })
  ),
  training_plan: z.array(z.string()),
  summary: z.object({
    strengths:  z.string(),
    weaknesses: z.string(),
    focus:      z.string(),
  }),
});

const SYSTEM_PROMPT = `あなたはValorantのプロコーチです。

分析を始める前に、必ず以下のツールをこの順番で呼んでください：
1. lookup_agent_knowledge でプレイヤーが使用するエージェントの特性を確認
2. lookup_rank_guidance でプレイヤーのランクに合ったコーチング方針を確認
3. 動画データがある場合は format_video_stats でデータを整形

ツールで得た情報をすべて統合して、具体的で行動レベルに落としたコーチングレポートを日本語で生成してください。
抽象的な表現は禁止。「〇〇してください」「〇〇を毎日△分行う」のような具体的なアクションを含めること。`;

export function createStrandsAgent(apiKey) {
  const anthropicProvider = createAnthropic({ apiKey });
  return new Agent({
    model: new VercelModel({ provider: anthropicProvider('claude-sonnet-4-6') }),
    tools: [lookupAgentKnowledge, lookupRankGuidance, formatVideoStats],
    systemPrompt: SYSTEM_PROMPT,
    structuredOutputSchema: CoachingReportSchema,
    printer: false,
    name: 'ValorantCoach',
  });
}
