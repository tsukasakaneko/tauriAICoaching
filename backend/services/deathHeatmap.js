'use strict';

const db = require('../db');

// デス位置ヒートマップ用の集計。デスイベント自体は座標を持たないため、
// 時刻の近い position イベントと突き合わせて位置を推定する。
// デス後はミニマップからドットが消える(デスカム)ので、
// 「直前 ≤ LOOKBACK_MS の位置を優先、無ければ直後 ≤ LOOKAHEAD_MS」とする。

const LOOKBACK_MS = 3000;
const LOOKAHEAD_MS = 1000;

// events: 1セッション分の [{ tMs, type: 'death'|'position', payload }](tMs 昇順)
// → 位置を対応付けられたデスごとに [{ x, y, calibrated, tMs }]
function correlateDeaths(events, { lookbackMs = LOOKBACK_MS, lookaheadMs = LOOKAHEAD_MS } = {}) {
  const positions = [];
  const deaths = [];
  for (const e of events) {
    if (e.type === 'position') {
      const { x, y, calibrated } = e.payload ?? {};
      if (typeof x === 'number' && typeof y === 'number') {
        positions.push({ tMs: e.tMs, x, y, calibrated: calibrated === true });
      }
    } else if (e.type === 'death') {
      deaths.push(e.tMs);
    }
  }

  const out = [];
  let cursor = 0; // positions は昇順 — デスも昇順なので前回位置から走査を再開できる
  for (const deathTMs of deaths) {
    while (cursor < positions.length && positions[cursor].tMs <= deathTMs) cursor++;
    const before = cursor > 0 ? positions[cursor - 1] : null;
    const after = cursor < positions.length ? positions[cursor] : null;

    let match = null;
    if (before && deathTMs - before.tMs <= lookbackMs) {
      match = before;
    } else if (after && after.tMs - deathTMs <= lookaheadMs) {
      match = after;
    }
    if (match) {
      out.push({ x: match.x, y: match.y, calibrated: match.calibrated, tMs: deathTMs });
    }
  }
  return out;
}

function parsePayload(json) {
  if (!json) return {};
  try { return JSON.parse(json) ?? {}; } catch { return {}; }
}

// → { map, totalDeaths, matchedDeaths, calibratedDeaths, sessions, points }
function getDeathHeatmap(userId, mapName) {
  const sessionRows = db.prepare(
    `SELECT s.id FROM match_sessions s
     JOIN match_meta m ON m.session_id = s.id
     WHERE s.user_id = ? AND m.map_name = ? AND s.status = 'done'`
  ).all(userId, mapName);

  const selectEvents = db.prepare(
    `SELECT t_ms, event_type, payload_json FROM match_events
     WHERE session_id = ? AND event_type IN ('death', 'position')
     ORDER BY t_ms ASC`
  );

  let totalDeaths = 0;
  const points = [];
  for (const { id: sessionId } of sessionRows) {
    const rows = selectEvents.all(sessionId);
    const events = rows.map((r) => ({
      tMs: r.t_ms,
      type: r.event_type,
      payload: parsePayload(r.payload_json),
    }));
    totalDeaths += events.filter((e) => e.type === 'death').length;
    for (const p of correlateDeaths(events)) {
      points.push({ ...p, sessionId });
    }
  }

  return {
    map: mapName,
    totalDeaths,
    matchedDeaths: points.length,
    calibratedDeaths: points.filter((p) => p.calibrated).length,
    sessions: sessionRows.length,
    points,
  };
}

// → [{ map, deaths, sessions }](デス数降順)
function listMapsWithDeaths(userId) {
  return db.prepare(
    `SELECT m.map_name AS map,
            COUNT(e.id) AS deaths,
            COUNT(DISTINCT s.id) AS sessions
     FROM match_sessions s
     JOIN match_meta m ON m.session_id = s.id AND m.map_name IS NOT NULL
     LEFT JOIN match_events e ON e.session_id = s.id AND e.event_type = 'death'
     WHERE s.user_id = ? AND s.status = 'done'
     GROUP BY m.map_name
     ORDER BY deaths DESC`
  ).all(userId);
}

module.exports = { correlateDeaths, getDeathHeatmap, listMapsWithDeaths, LOOKBACK_MS, LOOKAHEAD_MS };
