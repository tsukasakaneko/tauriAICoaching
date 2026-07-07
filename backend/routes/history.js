'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('./coaching');

const router = express.Router();

// 履歴 API は認証のみで paid ゲート無し — 無料ユーザーも手動分析レポートを
// 再閲覧できる必要がある。セッション(自動録画)自体は paid 限定なので、
// 無料ユーザーの一覧には手動レポートだけが並ぶ。

function parseKda(videoAnalysisJson) {
  if (!videoAnalysisJson) return null;
  try {
    const v = JSON.parse(videoAnalysisJson);
    return {
      kda: { kills: v.kills ?? 0, deaths: v.deaths ?? 0, assists: v.assists ?? 0 },
      wonRounds: v.wonRounds ?? null,
      totalRounds: v.totalRounds ?? null,
    };
  } catch {
    return null;
  }
}

// GET /history — sessions (latest report per session) + standalone manual reports
router.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT s.id, s.started_at, s.match_started_at, s.match_ended_at, s.status,
            s.video_analysis_json,
            m.map_name, m.agent,
            r.report_id
     FROM match_sessions s
     LEFT JOIN match_meta m ON m.session_id = s.id
     LEFT JOIN (
       SELECT session_id, MAX(id) AS report_id
       FROM coaching_reports
       WHERE user_id = ? AND session_id IS NOT NULL
       GROUP BY session_id
     ) r ON r.session_id = s.id
     WHERE s.user_id = ?
     ORDER BY s.id DESC
     LIMIT 100`
  ).all(req.user.id, req.user.id);

  const sessions = rows.map((row) => {
    const stats = parseKda(row.video_analysis_json);
    return {
      id: row.id,
      startedAt: row.started_at,
      matchStartedAt: row.match_started_at,
      matchEndedAt: row.match_ended_at,
      status: row.status,
      mapName: row.map_name ?? null,
      agent: row.agent ?? null,
      kda: stats?.kda ?? null,
      wonRounds: stats?.wonRounds ?? null,
      totalRounds: stats?.totalRounds ?? null,
      reportId: row.report_id ?? null,
    };
  });

  const standaloneReports = db.prepare(
    `SELECT id, created_at AS createdAt
     FROM coaching_reports
     WHERE user_id = ? AND session_id IS NULL
     ORDER BY id DESC
     LIMIT 100`
  ).all(req.user.id);

  res.json({ sessions, standaloneReports });
});

// POST /reports — persist a generated report (sessionId nullable for manual analyses)
router.post('/reports', requireAuth, (req, res) => {
  const { sessionId, report } = req.body ?? {};
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return res.status(400).json({ message: 'report オブジェクトが必要です' });
  }

  let sid = null;
  if (sessionId !== null && sessionId !== undefined) {
    sid = parseInt(sessionId, 10);
    if (isNaN(sid)) return res.status(400).json({ message: '無効なセッション ID です' });
    const session = db.prepare('SELECT user_id FROM match_sessions WHERE id = ?').get(sid);
    if (!session) return res.status(404).json({ message: 'セッションが見つかりません' });
    if (session.user_id !== req.user.id) {
      return res.status(403).json({ message: 'アクセス権がありません' });
    }
  }

  const info = db.prepare(
    'INSERT INTO coaching_reports (user_id, session_id, report_json) VALUES (?, ?, ?)'
  ).run(req.user.id, sid, JSON.stringify(report));

  res.json({ id: info.lastInsertRowid });
});

// GET /reports/:id — reopen a saved report
router.get('/reports/:id', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id, 10);
  if (isNaN(reportId)) return res.status(400).json({ message: '無効なレポート ID です' });

  const row = db.prepare(
    'SELECT id, user_id, session_id, report_json, created_at FROM coaching_reports WHERE id = ?'
  ).get(reportId);
  if (!row) return res.status(404).json({ message: 'レポートが見つかりません' });
  if (row.user_id !== req.user.id) {
    return res.status(403).json({ message: 'アクセス権がありません' });
  }

  let report;
  try {
    report = JSON.parse(row.report_json);
  } catch {
    return res.status(404).json({ message: 'レポートの読み込みに失敗しました' });
  }

  res.json({ id: row.id, sessionId: row.session_id, createdAt: row.created_at, report });
});

module.exports = { router };
