const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SALT_ROUNDS = 12;

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

module.exports = router;
