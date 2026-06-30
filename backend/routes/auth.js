const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { buildAuthUrl, exchangeCode, refreshToken: riotRefreshToken, revokeToken } = require('../services/riotAuth');
const { encrypt, decrypt, isEncryptionKeyConfigured } = require('../services/crypto');
const sseRegistry = require('../services/sseRegistry');

const router = express.Router();
const SALT_ROUNDS = 12;

// Pre-computed hash used to equalize response timing when the user is not found,
// preventing email enumeration via timing side-channel (bcrypt takes ~100ms).
const DUMMY_HASH = '$2b$12$JrZ4JmtdtWBzsx1qsuti2eAluf3FqlhdnTjpGNauwoxEpTy35iW6i';

// IP-based rate limit for auth endpoints — 5 attempts per 15 minutes.
// Prevents brute-force and credential-stuffing attacks.
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const _authAttempts = new Map(); // ip → { count: number, resetAt: number }

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const entry = _authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    _authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  if (entry.count >= AUTH_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

// Middleware to apply the rate limit and return 429 when exceeded
function authRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkAuthRateLimit(ip)) {
    return res.status(429).json({
      message: "試行回数が多すぎます。15分後に再度お試しください。",
    });
  }
  next();
}

function signToken(user) {
  // Minimal payload — only the opaque user ID. Email is fetched from DB on each request.
  return jwt.sign(
    { id: user.id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function formatUser(user) {
  return { id: user.id, email: user.email, isPaid: user.is_paid === 1 };
}

// POST /auth/register
router.post("/register", authRateLimit, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "メールアドレスとパスワードは必須です" });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: "パスワードは8文字以上必要です" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "有効なメールアドレスを入力してください" });
  }

  try {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      return res.status(409).json({ message: "このメールアドレスは既に登録されています" });
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare("INSERT INTO users (email, password) VALUES (?, ?)").run(email, hashed);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    const token = signToken(user);

    res.status(201).json({ token, user: formatUser(user) });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "登録に失敗しました" });
  }
});

// POST /auth/login
router.post("/login", authRateLimit, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "メールアドレスとパスワードは必須です" });
  }

  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH); // timing equalization
      return res.status(401).json({ message: "メールアドレスまたはパスワードが正しくありません" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: "メールアドレスまたはパスワードが正しくありません" });
    }

    const token = signToken(user);
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "ログインに失敗しました" });
  }
});

// ─── Riot ID SSO routes ───────────────────────────────────────────────────────

// CSRF state store for Riot OAuth: state → { userId, expiresAt }
const _oauthStates = new Map();
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of _oauthStates) {
    if (entry.expiresAt < now) _oauthStates.delete(state);
  }
}, 5 * 60 * 1000);

function riotRequireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ message: '認証が必要です' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ message: 'ユーザーが見つかりません' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'トークンが無効または期限切れです' });
  }
}

// GET /auth/riot — Returns OAuth authorize URL (paid users only)
router.get('/riot', riotRequireAuth, (req, res) => {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'Riot連携は有料プランのみ利用できます' });
  }
  if (!isEncryptionKeyConfigured()) {
    return res.status(503).json({ message: 'Riot連携はまだ設定されていません (RIOT_ENCRYPTION_KEY 未設定)' });
  }
  try {
    const state = crypto.randomBytes(32).toString('hex');
    _oauthStates.set(state, { userId: req.user.id, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    const url = buildAuthUrl(state);
    res.json({ url });
  } catch (err) {
    console.error('[riot-auth] buildAuthUrl error:', err.message);
    res.status(503).json({ message: 'Riot認証URLの生成に失敗しました。RIOT_CLIENT_ID を確認してください。' });
  }
});

// GET /auth/riot/status — Returns current Riot link status
router.get('/riot/status', riotRequireAuth, (req, res) => {
  const { riot_puuid, riot_game_name, riot_tag_line } = req.user;
  if (riot_puuid) {
    res.json({ linked: true, gameName: riot_game_name, tagLine: riot_tag_line });
  } else {
    res.json({ linked: false });
  }
});

// GET /auth/riot/callback — OAuth callback from Riot RSO
// [BLOCKED] Requires RIOT_CLIENT_ID / RIOT_CLIENT_SECRET to function
router.get('/riot/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('<h1>エラー</h1><p>code または state パラメータが不足しています。</p>');
  }

  const stateEntry = _oauthStates.get(state);
  if (!stateEntry || stateEntry.expiresAt < Date.now()) {
    _oauthStates.delete(state);
    return res.status(400).send('<h1>エラー</h1><p>認証セッションが無効または期限切れです。もう一度お試しください。</p>');
  }
  _oauthStates.delete(state);
  const { userId } = stateEntry;

  if (!process.env.RIOT_CLIENT_ID || !process.env.RIOT_CLIENT_SECRET) {
    return res.status(503).send('<h1>設定エラー</h1><p>Riot OAuth認証情報が設定されていません (RIOT_CLIENT_ID / RIOT_CLIENT_SECRET)。</p>');
  }

  try {
    const tokens = await exchangeCode(code);
    const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);

    // Extract PUUID from the Riot access token (JWT sub claim)
    let puuid;
    try {
      const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
      puuid = payload.sub;
      if (!puuid) throw new Error('sub claim missing');
    } catch {
      throw new Error('Riot access token does not contain a valid PUUID (sub claim)');
    }

    // Get gameName and tagLine from the Riot Account API
    let gameName = null, tagLine = null;
    try {
      const { getAccountByPuuid } = require('../services/riotApi');
      const account = await getAccountByPuuid(puuid, tokens.access_token);
      gameName = account.gameName ?? null;
      tagLine = account.tagLine ?? null;
    } catch (err) {
      console.warn('[riot-auth] Account API lookup failed (non-fatal):', err.message);
    }

    // Encrypt tokens before writing to DB
    const encAccess = encrypt(tokens.access_token);
    const encRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    db.prepare(`
      UPDATE users SET
        riot_puuid = ?,
        riot_game_name = ?,
        riot_tag_line = ?,
        riot_access_token = ?,
        riot_refresh_token = ?,
        riot_token_expires_at = ?
      WHERE id = ?
    `).run(puuid, gameName, tagLine, encAccess, encRefresh, expiresAt, userId);

    // Notify the Tauri window — the SSE stream on /autorecord/status picks this up
    sseRegistry.broadcast(userId, 'riot_linked', {
      gameName,
      tagLine,
      timestamp: new Date().toISOString(),
    });

    res.send('<html><head><meta charset="utf-8"></head><body><h1>Riot ID 連携完了</h1><p>このウィンドウを閉じてアプリに戻ってください。</p></body></html>');
  } catch (err) {
    console.error('[riot-auth] callback error:', err);
    sseRegistry.broadcast(userId, 'riot_link_error', { error: err.message });
    res.status(500).send(`<html><head><meta charset="utf-8"></head><body><h1>連携エラー</h1><p>${err.message}</p></body></html>`);
  }
});

// DELETE /auth/riot — Unlink Riot account
router.delete('/riot', riotRequireAuth, async (req, res) => {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'Riot連携は有料プランのみ利用できます' });
  }
  if (!req.user.riot_puuid) {
    return res.status(400).json({ message: 'Riot IDは連携されていません' });
  }

  // Revoke refresh token (non-fatal — DB is cleared regardless)
  if (req.user.riot_refresh_token) {
    try {
      const plainRefresh = decrypt(req.user.riot_refresh_token);
      await revokeToken(plainRefresh);
    } catch (err) {
      console.warn('[riot-auth] token revocation failed (non-fatal):', err.message);
    }
  }

  db.prepare(`
    UPDATE users SET
      riot_puuid = NULL,
      riot_game_name = NULL,
      riot_tag_line = NULL,
      riot_access_token = NULL,
      riot_refresh_token = NULL,
      riot_token_expires_at = NULL
    WHERE id = ?
  `).run(req.user.id);

  res.json({ ok: true });
});

module.exports = router;
