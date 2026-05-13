'use strict';

require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

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

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// P1-A: In-memory dedup set — only add event.id AFTER successful fulfillment.
// Ephemeral (resets on restart) but handles the common case of Stripe auto-retries
// that arrive within the same process lifetime.
const processedEventIds = new Set();
function markEventProcessed(eventId) {
  if (processedEventIds.size >= 5000) {
    const oldest = [...processedEventIds].slice(0, 1000);
    oldest.forEach(id => processedEventIds.delete(id));
  }
  processedEventIds.add(eventId);
}

const PRICE_MAP = {
  starter:     process.env.STRIPE_PRICE_STARTER,
  standard:    process.env.STRIPE_PRICE_STANDARD,
  pro_pack:    process.env.STRIPE_PRICE_PRO_PACK,
  monthly:     process.env.STRIPE_PRICE_MONTHLY,
  yearly:      process.env.STRIPE_PRICE_YEARLY,
};

// Maps Stripe product metadata.tier → keygen tier + key prefix
const TIER_CONFIG = {
  credit10:     { tierCode: 0x03, prefix: 'VCREDIT', credits: 10 },
  credit30:     { tierCode: 0x04, prefix: 'VCREDIT', credits: 30 },
  credit80:     { tierCode: 0x05, prefix: 'VCREDIT', credits: 80 },
  cloud:        { tierCode: 0x02, prefix: 'VCLOUD',  credits: 50 },
  cloud_yearly: { tierCode: 0x06, prefix: 'VCLOUD',  credits: 600 },
};

// PKCS8 DER prefix for a raw 32-byte Ed25519 private key seed
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function issueLicenseKey(tierCode, prefix, expiryYear, expiryMonth) {
  const privateKeyB64 = process.env.LICENSE_PRIVATE_KEY;
  if (!privateKeyB64) throw new Error('LICENSE_PRIVATE_KEY is not set');

  const seed = Buffer.from(privateKeyB64, 'base64url');
  if (seed.length !== 32) throw new Error('LICENSE_PRIVATE_KEY must be 32 bytes (43 base64url chars)');

  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  const nonce = crypto.randomInt(256);
  const payload = Buffer.from([tierCode, expiryYear, expiryMonth, nonce]);
  const signature = crypto.sign(null, payload, privateKey);

  const body = Buffer.concat([payload, signature]);
  return `${prefix}-${body.toString('base64url')}`;
}

function expiryForTier(tier) {
  const now = new Date();
  if (tier === 'cloud') {
    // Monthly: expire end of next month
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { year: d.getFullYear() - 2020, month: d.getMonth() + 1 };
  }
  if (tier === 'cloud_yearly') {
    const d = new Date(now.getFullYear() + 1, now.getMonth(), 1);
    return { year: d.getFullYear() - 2020, month: d.getMonth() + 1 };
  }
  // Credits: 1 year from now
  const d = new Date(now.getFullYear() + 1, now.getMonth(), 1);
  return { year: d.getFullYear() - 2020, month: d.getMonth() + 1 };
}

async function sendLicenseEmail(to, productLabel, licenseKey) {
  if (!process.env.SMTP_HOST && !process.env.SENDGRID_API_KEY) {
    console.log(`[email] Would send key to ${to}: ${licenseKey}`);
    return;
  }

  let transporter;
  if (process.env.SENDGRID_API_KEY) {
    transporter = nodemailer.createTransport({
      service: 'SendGrid',
      auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
    });
  } else {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  const from = process.env.EMAIL_FROM || 'noreply@valorant-coaching.app';
  await transporter.sendMail({
    from,
    to,
    subject: '【Valorant AIコーチング】ライセンスキーのご案内',
    text: [
      'この度はValorant AIコーチングをご購入いただきありがとうございます。',
      '',
      `■ ご購入プラン: ${productLabel}`,
      `■ ライセンスキー: ${licenseKey}`,
      '',
      '【アクティベート方法】',
      '1. Valorant AIコーチングアプリを起動してください。',
      '2. 設定画面 → ライセンス → 「アクティベーションキー」欄にキーを入力してください。',
      '3. 「有効化」ボタンを押すと、クレジットが付与されます。',
      '',
      'ご不明な点がございましたら、お気軽にお問い合わせください。',
    ].join('\n'),
  });
}

// ── Allow Tauri webview origins
app.use(cors({
  origin: ['tauri://localhost', 'https://tauri.localhost', 'http://localhost:1420'],
  credentials: true,
}));

// Stripe webhook must receive raw body — mount BEFORE express.json()
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ message: 'Stripe not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // P1-A: Idempotency — skip already-fulfilled events
  if (processedEventIds.has(event.id)) {
    return res.json({ received: true });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const tier = session.metadata?.tier;
      const productLabel = session.metadata?.product_label || tier || '不明';

      if (!email || !tier || !TIER_CONFIG[tier]) {
        // Permanent data error — retrying won't help; log and ack
        console.warn('[stripe webhook] missing email or tier in session:', session.id);
        return res.json({ received: true });
      }

      const cfg = TIER_CONFIG[tier];
      const exp = expiryForTier(tier);
      const key = issueLicenseKey(cfg.tierCode, cfg.prefix, exp.year, exp.month);
      await sendLicenseEmail(email, productLabel, key);
      console.log(`[stripe webhook] issued ${tier} key for ${email}`);

    } else if (event.type === 'invoice.paid') {
      // P1-B: Handle subscription renewals (2nd billing cycle onward)
      const invoice = event.data.object;

      // 'subscription_create' = first invoice, already handled by checkout.session.completed
      if (invoice.billing_reason === 'subscription_create') {
        return res.json({ received: true });
      }
      if (invoice.billing_reason !== 'subscription_cycle') {
        return res.json({ received: true });
      }

      const email = invoice.customer_email;
      if (!email || !invoice.subscription) {
        console.warn('[stripe webhook] invoice.paid missing email or subscription:', invoice.id);
        return res.json({ received: true });
      }

      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      const tier = subscription.metadata?.tier;
      const productLabel = subscription.metadata?.product_label || tier || 'サブスクリプション更新';

      if (!tier || !TIER_CONFIG[tier]) {
        console.warn('[stripe webhook] unknown tier in subscription metadata:', subscription.id);
        return res.json({ received: true });
      }

      const cfg = TIER_CONFIG[tier];
      const exp = expiryForTier(tier);
      const key = issueLicenseKey(cfg.tierCode, cfg.prefix, exp.year, exp.month);
      await sendLicenseEmail(email, productLabel, key);
      console.log(`[stripe webhook] renewal: issued ${tier} key for ${email}`);
    }

    // P1-A: Mark as processed only after successful fulfillment
    markEventProcessed(event.id);
    res.json({ received: true });

  } catch (err) {
    // P1-C: Return 500 so Stripe retries transient failures (SMTP down, etc.)
    // event.id is NOT added to processedEventIds, allowing the retry to proceed.
    console.error('[stripe webhook] fulfillment error — will allow Stripe retry:', err);
    res.status(500).json({ message: 'Fulfillment failed, will retry' });
  }
});

app.use(express.json({ limit: '1mb' }));

// ── Create Stripe Checkout session ───────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Stripe not configured' });

  const { product } = req.body;
  if (typeof product !== 'string' || !PRICE_MAP[product]) {
    return res.status(400).json({ message: '不正なプロダクトです' });
  }

  const isSubscription = product === 'monthly' || product === 'yearly';
  const tierMap = {
    starter: 'credit10', standard: 'credit30', pro_pack: 'credit80',
    monthly: 'cloud', yearly: 'cloud_yearly',
  };
  const productLabels = {
    starter: 'スターター (10クレジット)', standard: 'スタンダード (30クレジット)',
    pro_pack: 'プロパック (80クレジット)', monthly: '月額プラン', yearly: '年額プラン',
  };

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{ price: PRICE_MAP[product], quantity: 1 }],
      mode: isSubscription ? 'subscription' : 'payment',
      success_url: `${process.env.APP_SUCCESS_URL || 'https://valorant-coaching.app/purchase-complete'}`,
      cancel_url: `${process.env.APP_CANCEL_URL || 'https://valorant-coaching.app/purchase-cancel'}`,
      customer_creation: isSubscription ? undefined : 'always',
      metadata: { tier: tierMap[product], product_label: productLabels[product] },
      subscription_data: isSubscription
        ? { metadata: { tier: tierMap[product], product_label: productLabels[product] } }
        : undefined,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] session creation error:', err);
    res.status(500).json({ message: 'チェックアウトセッションの作成に失敗しました' });
  }
});

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
