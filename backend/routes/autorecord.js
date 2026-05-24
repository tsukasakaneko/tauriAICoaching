'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const db = require('../db');
const screenMonitor = require('../services/screenMonitor');
const screenRecorder = require('../services/screenRecorder');
const { analyzeVideo } = require('../services/videoAnalyzer');
const eventLog = require('../services/eventLog');

const router = express.Router();

// ─── Auth helper for SSE (token in query param) ───────────────────────────────

function authFromQuery(req, res) {
  const token = req.query.token;
  if (!token) { res.status(401).json({ message: '認証が必要です' }); return null; }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) { res.status(401).json({ message: 'ユーザーが見つかりません' }); return null; }
    return user;
  } catch {
    res.status(401).json({ message: 'トークンが無効または期限切れです' });
    return null;
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { return res.status(401).json({ message: '認証が必要です' }); }
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

// ─── Per-user SSE client registry ────────────────────────────────────────────

const sseClients = new Map(); // userId → Set<Response>

function broadcast(userId, eventName, data) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// Active recording session per user (in-memory)
const activeSessions = new Map(); // userId → { sessionId, recordingPath }

// ─── Wire up monitor events ───────────────────────────────────────────────────

screenMonitor.on('stateChanged', (newState, _prev) => {
  // Broadcast to all connected SSE clients (global state — one monitor for all)
  for (const [userId] of sseClients) {
    broadcast(userId, 'state_change', { state: newState, timestamp: new Date().toISOString() });
  }
});

screenMonitor.on('matchStarted', () => {
  // Start the recorder ONCE per match (singleton — same path returned if already recording)
  const recordingPath = screenRecorder.start('shared');
  const matchStartTime = new Date().toISOString();

  for (const [userId] of sseClients) {
    // Create a DB session per user that all point to the same recording file
    const session = db.prepare(
      `INSERT INTO match_sessions (user_id, match_started_at, recording_path, status)
       VALUES (?, datetime('now'), ?, 'recording')`
    ).run(userId, recordingPath);

    activeSessions.set(userId, { sessionId: session.lastInsertRowid, recordingPath });
    broadcast(userId, 'recording_started', {
      state: 'match_active',
      matchStartTime,
      sessionId: session.lastInsertRowid,
    });
  }
});

screenMonitor.on('resultScreenDetected', async () => {
  const videoPath = await screenRecorder.stop();

  // Guard: resultScreenDetected fired but recorder was never started (e.g. monitor
  // was watching before any match began). Nothing to analyse.
  if (!videoPath) {
    console.warn('[autorecord] resultScreenDetected fired with no recording path — skipping');
    return;
  }

  // Collect users who have an active session before starting async work
  const activeUsers = [...sseClients.keys()].filter(uid => activeSessions.has(uid));

  // Analyze the video ONCE, then fan out results to each user
  const broadcastProgress = (prog) => {
    for (const userId of activeUsers) {
      broadcast(userId, 'analysis_progress', { ...prog, timestamp: new Date().toISOString() });
    }
  };

  for (const userId of activeUsers) {
    broadcast(userId, 'state_change', { state: 'analyzing', timestamp: new Date().toISOString() });
    db.prepare(
      `UPDATE match_sessions SET match_ended_at = datetime('now'), status = 'analyzing' WHERE id = ?`
    ).run(activeSessions.get(userId).sessionId);
  }

  try {
    const { result: videoAnalysis, events, meta } = await analyzeVideo(videoPath, broadcastProgress);

    for (const userId of activeUsers) {
      const session = activeSessions.get(userId);
      if (!session) continue;
      db.prepare(
        `UPDATE match_sessions SET video_analysis_json = ?, status = 'done' WHERE id = ?`
      ).run(JSON.stringify(videoAnalysis), session.sessionId);
      // Persist the per-frame timeline + map for this session (one analysis → many sessions)
      try {
        eventLog.persist(session.sessionId, events, meta);
      } catch (logErr) {
        console.warn('[autorecord] failed to persist match events:', logErr.message);
      }
      broadcast(userId, 'form_ready', { state: 'done', videoAnalysis, timestamp: new Date().toISOString() });
      activeSessions.delete(userId);
    }
  } catch (err) {
    console.error('[autorecord] analysis error:', err);
    for (const userId of activeUsers) {
      const session = activeSessions.get(userId);
      if (!session) continue;
      db.prepare(
        `UPDATE match_sessions SET status = 'error', error_message = ? WHERE id = ?`
      ).run(err.message, session.sessionId);
      broadcast(userId, 'error', { state: 'error', errorMessage: err.message });
      activeSessions.delete(userId);
    }
  } finally {
    // Delete the MP4 after analysis (success or failure) to reclaim disk space.
    // The analysis JSON is persisted in DB; the raw video is no longer needed.
    fs.unlink(videoPath, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.warn('[autorecord] failed to delete recording:', unlinkErr.message);
      }
    });
  }
});

screenMonitor.on('monitorError', (msg) => {
  console.error('[screenMonitor] error:', msg);
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// SSE endpoint — token via query string (EventSource limitation)
router.get('/autorecord/status', (req, res) => {
  const user = authFromQuery(req, res);
  if (!user) return;

  // C-03: Free tier cannot subscribe to recording events
  if (user.is_paid !== 1) return res.status(403).json({ error: 'paid_only' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
  sseClients.get(user.id).add(res);

  // Send current state immediately
  res.write(`event: connected\ndata: ${JSON.stringify({
    state: screenMonitor.state,
    isRecording: screenRecorder.isRecording,
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // Heartbeat every 25s
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({
        state: screenMonitor.state,
        timestamp: new Date().toISOString(),
      })}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(user.id);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(user.id);
    }
  });
});

// Start monitoring
router.post('/autorecord/start', requireAuth, (req, res) => {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'この機能はライセンスキーが必要です。' });
  }
  if (screenMonitor.state !== 'idle' && screenMonitor.isRunning) {
    return res.json({ ok: true, state: screenMonitor.state, message: '既に監視中です' });
  }
  screenMonitor.start();
  res.json({ ok: true, state: screenMonitor.state });
});

// Stop monitoring
router.post('/autorecord/stop', requireAuth, (req, res) => {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'この機能はライセンスキーが必要です。' });
  }
  screenMonitor.stop();
  screenRecorder.stop().catch(() => {});
  activeSessions.delete(req.user.id);
  res.json({ ok: true });
});

// Current status
router.get('/autorecord/state', requireAuth, (req, res) => {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'この機能はライセンスキーが必要です。' });
  }
  res.json({
    state: screenMonitor.state,
    isRecording: screenRecorder.isRecording,
  });
});

// Latest analysis for this user
router.get('/autorecord/latest', requireAuth, (req, res) => {
  if (req.user.is_paid !== 1) {
    return res.status(403).json({ message: 'この機能はライセンスキーが必要です。' });
  }
  const row = db.prepare(
    `SELECT video_analysis_json FROM match_sessions
     WHERE user_id = ? AND status = 'done'
     ORDER BY id DESC LIMIT 1`
  ).get(req.user.id);

  if (!row?.video_analysis_json) return res.json(null);
  try {
    res.json(JSON.parse(row.video_analysis_json));
  } catch {
    res.json(null);
  }
});

module.exports = { router };
