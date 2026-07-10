'use strict';

const express = require('express');
const { requireAuth } = require('./coaching');
const { getDeathHeatmap, listMapsWithDeaths } = require('../services/deathHeatmap');
const { getMinimapPng, isKnownMap } = require('../services/mapAssets');

const router = express.Router();

// デス位置ヒートマップはセッション(自動録画)由来のデータなので
// /sessions/:id/events と同じく paid 限定。

function requirePaid(req, res, next) {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'この機能はライセンスキーが必要です。' });
  }
  next();
}

// デスデータがあるマップの一覧(セレクタ用)
router.get('/heatmap/maps', requireAuth, requirePaid, (req, res) => {
  res.json({ maps: listMapsWithDeaths(req.user.id) });
});

// 指定マップの全セッション横断デス位置集計
router.get('/heatmap/deaths', requireAuth, requirePaid, (req, res) => {
  const map = typeof req.query.map === 'string' ? req.query.map.toLowerCase().trim() : '';
  if (!map) return res.status(400).json({ message: 'map パラメータが必要です' });
  // データが無いマップでも同形のゼロ埋めレスポンス(セレクタ側の分岐を単純に)
  res.json(getDeathHeatmap(req.user.id, map));
});

// マップのミニマップ画像(valorant-api.com のプロキシ+キャッシュ)。
// 公開ゲームアセットでユーザーデータを含まないため認証なし —
// <img> は Authorization ヘッダを付けられず、クエリ JWT は保護効果が無いのに
// アセット URL にトークンを載せる面だけ増えるため採らない。
router.get('/maps/:mapName/minimap', async (req, res) => {
  const mapName = String(req.params.mapName).toLowerCase();
  if (!isKnownMap(mapName)) {
    return res.status(404).json({ message: '不明なマップです' });
  }
  const buf = await getMinimapPng(mapName);
  if (!buf) {
    return res.status(502).json({ message: 'マップ画像を取得できませんでした' });
  }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});

module.exports = { router };
