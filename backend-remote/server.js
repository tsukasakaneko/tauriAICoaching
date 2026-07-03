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

// P0-1: サーバー側クレジット台帳(SQLite)
const licenseStore = require('./license-store');

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
  // P0-4: クレジット系は購入から6ヶ月で失効。
  // 資金決済法の前払式支払手段は有効期間6ヶ月以内なら適用除外となるため。
  const d = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  return { year: d.getFullYear() - 2020, month: d.getMonth() + 1 };
}

/** expiryForTier の {year(2020起点), month} を台帳用の "YYYY-MM" に変換する */
function expiryString(exp) {
  return `${2020 + exp.year}-${String(exp.month).padStart(2, '0')}`;
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

  const from = process.env.EMAIL_FROM || 'noreply@coachmate.app';
  await transporter.sendMail({
    from,
    to,
    subject: '【CoachMate for VALORANT】ライセンスキーのご案内',
    text: [
      'この度は CoachMate for VALORANT をご購入いただきありがとうございます。',
      '',
      `■ ご購入プラン: ${productLabel}`,
      `■ ライセンスキー: ${licenseKey}`,
      '',
      '【アクティベート方法】',
      '1. CoachMate アプリを起動してください。',
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
      // P0-1: メール送信前に台帳へ登録(失敗時は 500 → Stripe リトライ)
      licenseStore.registerIssuedKey({
        key, email, tier, credits: cfg.credits, expiresAt: expiryString(exp),
      });
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
      licenseStore.registerIssuedKey({
        key, email, tier, credits: cfg.credits, expiresAt: expiryString(exp),
      });
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
      success_url: `${process.env.APP_SUCCESS_URL || 'https://coachmate.app/purchase-complete'}`,
      cancel_url: `${process.env.APP_CANCEL_URL || 'https://coachmate.app/purchase-cancel'}`,
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
// P0-2: 課金モデルの一本化。
//   無料: 3回/日(端末ハッシュ単位)。有料(cloud系)はクレジットが上限として
//   機能するため日次制限なし。pro のみ開発者APIキー保護の乱用ガードを残す。
const dailyUsage = new Map(); // key -> { date: string, count: number }
const DAILY_LIMIT_FREE = 3;
const DAILY_LIMIT_PRO = 30;

function checkDailyLimit(key, limit) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = dailyUsage.get(key);
  if (entry?.date === today) {
    if (entry.count >= limit) return false;
    entry.count++;
  } else {
    dailyUsage.set(key, { date: today, count: 1 });
  }
  return true;
}

// ── License auth middleware ───────────────────────────────────────────────────
// P0-1: /license/activate で発行したライセンストークンを検証する。
// 旧実装のローカル backend JWT は同梱アプリから JWT_SECRET が抽出できるため信用しない。
function requireLicense(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'ライセンスのアクティベートが必要です' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.typ !== 'license' || !decoded.lid || !decoded.dev) {
      return res.status(401).json({ message: 'ライセンストークンが無効です' });
    }
    req.license = { licenseId: decoded.lid, deviceHash: decoded.dev };
    next();
  } catch {
    res.status(401).json({ message: 'ライセンストークンが無効または期限切れです。キーを再アクティベートしてください。' });
  }
}

// ライセンストークンがあれば req.license を設定し、無ければ無料パスとして素通しする。
// ローカル backend 由来の JWT(typ 無し)も無料パス扱い。
function optionalLicense(req, _res, next) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
      if (decoded.typ === 'license' && decoded.lid && decoded.dev) {
        req.license = { licenseId: decoded.lid, deviceHash: decoded.dev };
      }
    } catch { /* 無効・期限切れトークンは無料パス扱い */ }
  }
  next();
}

function signLicenseToken(licenseId, deviceHash) {
  return jwt.sign(
    { typ: 'license', lid: licenseId, dev: deviceHash },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );
}

// ── License activation rate limit (in-memory, per IP) ────────────────────────
const activateAttempts = new Map(); // ip -> { windowStart: number, count: number }
const ACTIVATE_WINDOW_MS = 60_000;
const ACTIVATE_MAX_PER_WINDOW = 10;

function checkActivateRateLimit(ip) {
  const now = Date.now();
  const entry = activateAttempts.get(ip);
  if (!entry || now - entry.windowStart > ACTIVATE_WINDOW_MS) {
    activateAttempts.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= ACTIVATE_MAX_PER_WINDOW;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── License endpoints (P0-1) ──────────────────────────────────────────────────

// キー検証 + 端末バインド + クレジット付与。成功時にライセンストークンを発行する。
app.post('/license/activate', (req, res) => {
  if (!checkActivateRateLimit(req.ip)) {
    return res.status(429).json({ message: '試行回数が多すぎます。しばらく待ってから再度お試しください。' });
  }

  const { key, deviceHash } = req.body;
  if (typeof key !== 'string' || key.length > 200 ||
      typeof deviceHash !== 'string' || !/^[0-9a-f]{64}$/.test(deviceHash)) {
    return res.status(400).json({ message: 'リクエストが不正です' });
  }

  try {
    const result = licenseStore.activate(key, deviceHash);
    if (result.error) {
      return res.status(result.statusCode || 400).json({ message: result.error });
    }

    const status = licenseStore.statusForDevice(deviceHash);
    res.json({
      licenseToken: signLicenseToken(result.license.id, deviceHash),
      tier: status.tier,
      credits: status.credits,
      expiresAt: status.expiresAt,
      firstPaymentBonus: result.firstPaymentBonus,
    });
  } catch (err) {
    console.error('[license/activate] error:', err);
    res.status(500).json({ message: 'アクティベートに失敗しました。もう一度お試しください。' });
  }
});

// 表示用ステータス(残高はサーバー台帳が正)
app.get('/license/status', requireLicense, (req, res) => {
  try {
    res.json(licenseStore.statusForDevice(req.license.deviceHash));
  } catch (err) {
    console.error('[license/status] error:', err);
    res.status(500).json({ message: 'ステータスの取得に失敗しました' });
  }
});

// サーバー側デクリメント(通常は /analyze が内部で消費する)
// amount: 1〜4(省略時1)。P0-2: 手動分析1・自動録画2。
app.post('/credits/consume', requireLicense, (req, res) => {
  const amount = req.body?.amount ?? 1;
  if (!Number.isInteger(amount) || amount < 1 || amount > 4) {
    return res.status(400).json({ message: '消費クレジット数が不正です' });
  }
  try {
    const result = licenseStore.consume(req.license.deviceHash, amount);
    if (result.error) {
      return res.status(402).json({ message: result.error });
    }
    res.json({ credits: result.credits });
  } catch (err) {
    console.error('[credits/consume] error:', err);
    res.status(500).json({ message: 'クレジットの消費に失敗しました' });
  }
});

app.post('/analyze', optionalLicense, async (req, res) => {
  // P0-3: systemPrompt/userPrompt はクライアント(prompt_builder.rs)構築。
  // videoAnalysis はコスト判定用フラグ(手動1・自動録画2)。
  const { systemPrompt, userPrompt, videoAnalysis } = req.body;

  // P0-3: プロンプト構築は Tauri 側 prompt_builder.rs に一元化。
  // クライアントは知識ベース入りの構築済みプロンプトを送ってくる。
  // 乱用は無料3回/日・クレジット消費・pro 30回/日・max_tokens・
  // レスポンスの CoachingReport 構造検証で抑止する。
  // 検証は日次カウント・クレジットに触れる前に行う。
  const MAX_SYSTEM_PROMPT_LEN = 8_000;
  const MAX_USER_PROMPT_LEN = 12_000;
  if (typeof systemPrompt !== 'string' || systemPrompt.length === 0 ||
      systemPrompt.length > MAX_SYSTEM_PROMPT_LEN) {
    return res.status(400).json({ message: `systemPrompt は${MAX_SYSTEM_PROMPT_LEN}文字以内で必須です` });
  }
  if (typeof userPrompt !== 'string' || userPrompt.length === 0 ||
      userPrompt.length > MAX_USER_PROMPT_LEN) {
    return res.status(400).json({ message: `userPrompt は${MAX_USER_PROMPT_LEN}文字以内で必須です` });
  }

  // P0-2: 無料3回/日+有料はクレジット消費(手動1・自動録画2)に一本化
  let cost = 0; // 分析成功後に消費するクレジット数(無料・pro は 0)
  let licenseStatus = null;

  if (req.license) {
    try {
      licenseStatus = licenseStore.statusForDevice(req.license.deviceHash);
    } catch (err) {
      console.error('[analyze] license status error:', err);
      return res.status(500).json({ message: 'ライセンス情報の取得に失敗しました' });
    }
    if (licenseStatus.tier === 'free') {
      return res.status(403).json({ message: 'ライセンスキーが必要です。設定画面からキーをアクティベートしてください。' });
    }

    if (licenseStatus.tier === 'pro') {
      // pro はクレジット消費なし。開発者APIキー保護の乱用ガードのみ。
      if (!checkDailyLimit(`lic:${req.license.licenseId}`, DAILY_LIMIT_PRO)) {
        return res.status(429).json({
          message: `1日の分析回数上限（${DAILY_LIMIT_PRO}回）に達しました。明日またお試しください。`,
        });
      }
    } else {
      cost = videoAnalysis ? 2 : 1;
      if (licenseStatus.credits < cost) {
        return res.status(402).json({
          message: 'クラウドAIのクレジットが不足しています。VCREDITキーを入力してクレジットを追加してください。',
        });
      }
    }
  } else {
    // 無料パス: 端末ハッシュ単位で3回/日。自動録画分析は有料機能。
    const deviceHash = req.body.deviceHash;
    if (typeof deviceHash !== 'string' || !/^[0-9a-f]{64}$/.test(deviceHash)) {
      return res.status(401).json({ message: 'ライセンスのアクティベート、またはアプリからの利用が必要です' });
    }
    if (videoAnalysis) {
      return res.status(403).json({
        message: '自動録画の分析は有料プランの機能です。ライセンスキーをアクティベートしてください。',
      });
    }
    if (!checkDailyLimit(`free:${deviceHash}`, DAILY_LIMIT_FREE)) {
      return res.status(429).json({
        message: `無料プランの1日の分析回数上限（${DAILY_LIMIT_FREE}回）に達しました。アップグレードすると無制限にご利用いただけます。`,
      });
    }
  }

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

    // 分析成功後にサーバー台帳から消費(手動1・自動録画2。無料/pro は消費なし)
    if (cost > 0) {
      const consumed = licenseStore.consume(req.license.deviceHash, cost);
      parsed.creditsRemaining = consumed.error ? 0 : consumed.credits;
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
