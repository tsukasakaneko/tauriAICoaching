'use strict';

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();

// P0-3: POST /analyze(プロンプト構築の重複実装)は削除。
// AI 分析は Tauri コマンド(ローカル)または backend-remote /analyze(リモート)に一元化。

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

module.exports = { router, requireAuth };
