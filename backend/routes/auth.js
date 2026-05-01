const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const SALT_ROUNDS = 12;

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function formatUser(user) {
  return { id: user.id, email: user.email, isPaid: user.is_paid === 1 };
}

// POST /auth/register
router.post("/register", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "メールアドレスとパスワードは必須です" });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "パスワードは6文字以上必要です" });
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
router.post("/login", async (req, res) => {
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
