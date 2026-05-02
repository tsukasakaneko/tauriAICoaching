'use strict';

const express = require("express");
const jwt = require("jsonwebtoken");
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

// POST /analyze — AI呼び出しはTauriコマンド (ai_analyze) に移管済み
router.post("/analyze", (_req, res) => {
  res.status(410).json({
    message: "このエンドポイントは廃止されました。AI分析はデスクトップアプリ内部で処理されます。",
  });
});

module.exports = { router, requireAuth };
