const express = require("express");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const db = require("../db");

const router = express.Router();

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

// POST /analyze
router.post("/analyze", requireAuth, async (req, res) => {
  if (!req.user.is_paid) {
    return res.status(403).json({ message: "この機能は有料会員限定です" });
  }

  const { rank, agent, selfAssessment, review } = req.body;

  if (!rank || !agent) {
    return res.status(400).json({ message: "ランクとエージェントは必須です" });
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

  const userPrompt = `プレイヤー情報:
- ランク: ${rank}
- エージェント: ${agent}
- 自己評価の課題: ${assessmentText}
- プレイ振り返り: ${review || "特になし"}

上記の情報を基に、Valorantのコーチングレポートを生成してください。必ず有効なJSONのみを返してください。`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 2000,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty response");

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
    if (err.message?.includes("API key") || err.message?.includes("Incorrect API")) {
      return res.status(500).json({ message: "OpenAI APIキーが正しく設定されていません" });
    }
    res.status(500).json({ message: "AI分析に失敗しました。もう一度お試しください。" });
  }
});

module.exports = { router, requireAuth };
