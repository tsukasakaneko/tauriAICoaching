'use strict';

// デス位置ヒートマップのテスト。実行: node --test backend/test/
// - normalizeDotInRegion: ミニマップ領域内へのドット座標正規化
// - correlateDeaths: デスと position イベントの時刻相関
// - getDeathHeatmap / listMapsWithDeaths: 一時 DB での集計
// - mapAssets: valorant-api.com モックからの画像取得・キャッシュ

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// db.js は最初の require で DB_PATH を確定するため、require 前に設定する
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachmate-heatmap-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── normalizeDotInRegion ────────────────────────────────────────────────────

test('normalizeDotInRegion: 領域内の中心座標を 0-1 に正規化しクランプする', () => {
  const { normalizeDotInRegion } = require('../services/minimapAnalyzer');

  // 領域 [100,100,200,200]、ドット中心 (200,150) → (0.5, 0.25)
  assert.deepStrictEqual(
    normalizeDotInRegion([196, 146, 8, 8], [100, 100, 200, 200]),
    { x: 0.5, y: 0.25 }
  );
  // 領域外のドットは 0-1 にクランプ
  assert.deepStrictEqual(
    normalizeDotInRegion([396, 46, 8, 8], [100, 100, 200, 200]),
    { x: 1, y: 0 }
  );
  // サイズ 0 の領域は null
  assert.strictEqual(normalizeDotInRegion([10, 10, 8, 8], [100, 100, 0, 200]), null);
});

// ─── correlateDeaths ─────────────────────────────────────────────────────────

const pos = (tMs, x, y, calibrated = true) => ({ tMs, type: 'position', payload: { x, y, calibrated } });
const death = (tMs) => ({ tMs, type: 'death', payload: {} });

test('correlateDeaths: 直前の位置を優先し、無ければ直後にフォールバック', () => {
  const { correlateDeaths } = require('../services/deathHeatmap');

  const events = [
    pos(1000, 0.1, 0.1),
    death(2000),            // 直前 1000ms ≤ 3000ms → (0.1, 0.1)
    death(10_000),          // 直前は 9000ms 前(窓外)、直後 10500 は +500 ≤ 1000ms → (0.2, 0.2)
    pos(10_500, 0.2, 0.2),
    death(20_000),          // 直前 9500ms 前・直後なし → unmatched
  ];
  const out = correlateDeaths(events);
  assert.deepStrictEqual(out, [
    { x: 0.1, y: 0.1, calibrated: true, tMs: 2000 },
    { x: 0.2, y: 0.2, calibrated: true, tMs: 10_000 },
  ]);
});

test('correlateDeaths: 複数デスが同じ位置を共有でき、不正 payload はスキップ', () => {
  const { correlateDeaths } = require('../services/deathHeatmap');

  const events = [
    { tMs: 500, type: 'position', payload: { x: 'bad', y: 0.5 } }, // 不正 → 無視
    pos(1000, 0.3, 0.4, false),
    death(1500),
    death(2500), // 同じ position(t=1000)に対応(差 1500ms ≤ 3000ms)
  ];
  const out = correlateDeaths(events);
  assert.deepStrictEqual(out, [
    { x: 0.3, y: 0.4, calibrated: false, tMs: 1500 },
    { x: 0.3, y: 0.4, calibrated: false, tMs: 2500 },
  ]);
});

// ─── DB 集計 ─────────────────────────────────────────────────────────────────

function makeUser(db) {
  return db
    .prepare(`INSERT INTO users (email, password) VALUES (?, 'x')`)
    .run(`u${Date.now()}${Math.random()}@test.local`).lastInsertRowid;
}

function makeSession(db, userId, mapName, status = 'done') {
  const sid = db
    .prepare(`INSERT INTO match_sessions (user_id, status) VALUES (?, ?)`)
    .run(userId, status).lastInsertRowid;
  db.prepare(`INSERT INTO match_meta (session_id, map_name) VALUES (?, ?)`).run(sid, mapName);
  return sid;
}

function insertEvents(db, sessionId, events) {
  const stmt = db.prepare(
    `INSERT INTO match_events (session_id, frame_idx, t_ms, event_type, payload_json)
     VALUES (?, 0, ?, ?, ?)`
  );
  for (const e of events) stmt.run(sessionId, e.tMs, e.type, JSON.stringify(e.payload));
}

test('getDeathHeatmap / listMapsWithDeaths: マップ別に集計し他ユーザーを除外する', () => {
  const db = require('../db');
  const { getDeathHeatmap, listMapsWithDeaths } = require('../services/deathHeatmap');

  const userId = makeUser(db);
  const otherId = makeUser(db);

  // ascent: calibrated セッション(2デス中2件対応、1件は unmatched)
  const s1 = makeSession(db, userId, 'ascent');
  insertEvents(db, s1, [
    pos(1000, 0.2, 0.3),
    death(2000),
    pos(5000, 0.7, 0.8),
    death(5500),
    death(60_000), // 近傍 position なし → unmatched
  ]);

  // ascent: 旧・未補正データのセッション
  const s2 = makeSession(db, userId, 'ascent');
  insertEvents(db, s2, [pos(1000, 0.05, 0.05, false), death(1500)]);

  // bind: 1デス / 未完了セッションと他ユーザーのデータは集計対象外
  const s3 = makeSession(db, userId, 'bind');
  insertEvents(db, s3, [pos(1000, 0.5, 0.5), death(1200)]);
  const s4 = makeSession(db, userId, 'ascent', 'recording');
  insertEvents(db, s4, [death(1000)]);
  const s5 = makeSession(db, otherId, 'ascent');
  insertEvents(db, s5, [death(1000)]);

  const heat = getDeathHeatmap(userId, 'ascent');
  assert.strictEqual(heat.sessions, 2);
  assert.strictEqual(heat.totalDeaths, 4); // s1: 3 + s2: 1
  assert.strictEqual(heat.matchedDeaths, 3);
  assert.strictEqual(heat.calibratedDeaths, 2);
  assert.deepStrictEqual(
    heat.points.map((p) => [p.x, p.y, p.calibrated, p.sessionId]),
    [
      [0.2, 0.3, true, s1],
      [0.7, 0.8, true, s1],
      [0.05, 0.05, false, s2],
    ]
  );

  const maps = listMapsWithDeaths(userId);
  assert.deepStrictEqual(maps, [
    { map: 'ascent', deaths: 4, sessions: 2 },
    { map: 'bind', deaths: 1, sessions: 1 },
  ]);

  // データが無いマップはゼロ埋めの同形レスポンス
  const empty = getDeathHeatmap(userId, 'lotus');
  assert.deepStrictEqual(empty, {
    map: 'lotus', totalDeaths: 0, matchedDeaths: 0, calibratedDeaths: 0, sessions: 0, points: [],
  });
});

// ─── mapAssets ───────────────────────────────────────────────────────────────

test('mapAssets: index 取得失敗はキャッシュ汚染せず、復旧後に画像を取得できる', async () => {
  const PNG = Buffer.from('fake-png-bytes');
  let failIndex = true;

  const server = http.createServer((req, res) => {
    if (req.url === '/v1/maps') {
      if (failIndex) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        data: [
          { displayName: 'Ascent', mapUrl: '/Game/Maps/Ascent/Ascent', displayIcon: `http://127.0.0.1:${port}/ascent.png` },
          { displayName: 'The Range', mapUrl: '/Game/Maps/Poveglia/Range', displayIcon: `http://127.0.0.1:${port}/range.png` },
        ],
      }));
    }
    if (req.url === '/ascent.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404); res.end();
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  process.env.RIOT_MAPS_URL = `http://127.0.0.1:${port}/v1/maps`;

  try {
    const { getMinimapPng, isKnownMap } = require('../services/mapAssets');

    assert.strictEqual(isKnownMap('ascent'), true);
    assert.strictEqual(isKnownMap('nope'), false);
    assert.strictEqual(await getMinimapPng('nope'), null);

    // index 取得失敗 → null(キャッシュされない)
    assert.strictEqual(await getMinimapPng('ascent'), null);

    // 復旧後は取得できる(Range など未知マップは index に載らない)
    failIndex = false;
    const buf = await getMinimapPng('ascent');
    assert.ok(buf && buf.equals(PNG));
    // 2回目はキャッシュから(サーバーを止めても返る)
    server.close();
    const cached = await getMinimapPng('ascent');
    assert.ok(cached && cached.equals(PNG));
  } finally {
    server.close();
    delete process.env.RIOT_MAPS_URL;
  }
});
