'use strict';

// キル/アシスト/デスのタイムスタンプ付与機能のテスト。実行: node --test backend/test/
// - extractTimeline: match-details からの K/D/A 時系列抽出
// - riotTimelineToEvents / mergeEvents: 動画内時刻への変換とYOLOイベント置換
// - recordingRetention: 失敗録画の削除・起動時 sweep(一時 DB を使用)

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// db.js は最初の require で DB_PATH を確定するため、require 前に設定する
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachmate-timeline-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.RIOT_MATCH_RETRIES = '2';
process.env.RIOT_MATCH_RETRY_MS = '50';

const { startMockRiot, OWN_PUUID } = require('./mockRiotServers');

let mock;

before(async () => {
  mock = await startMockRiot();
});

after(async () => {
  await mock.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── extractTimeline ─────────────────────────────────────────────────────────

test('extractTimeline: killer/victim/assistant を分類し無関係キルを無視する', () => {
  const { extractTimeline } = require('../services/riotMatchData');
  const details = {
    roundResults: [
      {
        roundNum: 0,
        playerStats: [
          {
            kills: [
              { killer: OWN_PUUID, victim: 'e1', assistants: [], timeSinceGameStartMillis: 5000 },
              { killer: 'e1', victim: OWN_PUUID, assistants: [], timeSinceGameStartMillis: 9000 },
              { killer: 'ally', victim: 'e2', assistants: [OWN_PUUID], timeSinceGameStartMillis: 7000 },
              { killer: 'ally', victim: 'e3', assistants: [], timeSinceGameStartMillis: 8000 },
              { killer: 'ally', victim: 'e4', assistants: ['other'] }, // 時刻なし → 無視
            ],
          },
        ],
      },
    ],
  };
  const timeline = extractTimeline(details, OWN_PUUID);
  assert.deepStrictEqual(timeline, [
    { type: 'kill', gameTimeMs: 5000, round: 0 },
    { type: 'assist', gameTimeMs: 7000, round: 0 },
    { type: 'death', gameTimeMs: 9000, round: 0 },
  ]);
});

test('extractTimeline: roundResults なしは空配列', () => {
  const { extractTimeline } = require('../services/riotMatchData');
  assert.deepStrictEqual(extractTimeline({}, OWN_PUUID), []);
  assert.deepStrictEqual(extractTimeline(null, OWN_PUUID), []);
});

test('fetchLatestMatchStats: timeline と gameStartMillis を返す', async () => {
  const { fetchLatestMatchStats } = require('../services/riotMatchData');
  const stats = await fetchLatestMatchStats({ sinceMillis: Date.now() - 60_000 });
  assert.ok(stats);
  assert.strictEqual(stats.gameStartMillis, mock.state.gameStartTime);
  assert.deepStrictEqual(stats.timeline, [
    { type: 'kill', gameTimeMs: 65_000, round: 0 },
    { type: 'death', gameTimeMs: 130_000, round: 1 },
    { type: 'assist', gameTimeMs: 200_000, round: 2 },
  ]);
});

// ─── riotTimelineToEvents / mergeEvents ──────────────────────────────────────

test('riotTimelineToEvents: 動画内時刻へ変換し負値は 0 にクランプ', () => {
  const { riotTimelineToEvents } = require('../services/statsMerge');
  const riot = {
    gameStartMillis: 1_000_000,
    timeline: [
      { type: 'kill', gameTimeMs: 65_000, round: 0 },
      { type: 'assist', gameTimeMs: 1_000, round: 0 }, // 録画開始前 → 0 に丸め
    ],
  };
  // 録画はゲーム開始の 5 秒後に始まった
  const events = riotTimelineToEvents(riot, 1_005_000);
  assert.deepStrictEqual(events, [
    { frameIdx: 120, tMs: 60_000, type: 'kill', payload: { round: 0, source: 'riot' } },
    { frameIdx: 0, tMs: 0, type: 'assist', payload: { round: 0, source: 'riot' } },
  ]);
});

test('riotTimelineToEvents: エポック欠落・timeline 空は []', () => {
  const { riotTimelineToEvents } = require('../services/statsMerge');
  const timeline = [{ type: 'kill', gameTimeMs: 1000, round: 0 }];
  assert.deepStrictEqual(riotTimelineToEvents(null, 123), []);
  assert.deepStrictEqual(riotTimelineToEvents({ timeline: [] }, 123), []);
  assert.deepStrictEqual(
    riotTimelineToEvents({ gameStartMillis: null, timeline }, 123),
    []
  );
  assert.deepStrictEqual(
    riotTimelineToEvents({ gameStartMillis: 456, timeline }, null),
    []
  );
});

test('mergeEvents: Riot がある時は YOLO の kill/death を置換し position は保持', () => {
  const { mergeEvents } = require('../services/statsMerge');
  const videoEvents = [
    { frameIdx: 0, tMs: 0, type: 'position', payload: { x: 0.5, y: 0.5 } },
    { frameIdx: 10, tMs: 5000, type: 'kill', payload: { headshot: true } },
    { frameIdx: 20, tMs: 10_000, type: 'death', payload: {} },
  ];
  const riotEvents = [
    { frameIdx: 12, tMs: 6000, type: 'kill', payload: { round: 0, source: 'riot' } },
    { frameIdx: 4, tMs: 2000, type: 'assist', payload: { round: 0, source: 'riot' } },
  ];

  const merged = mergeEvents(videoEvents, riotEvents);
  assert.deepStrictEqual(
    merged.map((e) => e.type),
    ['position', 'assist', 'kill'],
    'YOLO kill/death は落ち、tMs 順にソートされる'
  );

  // Riot なし → YOLO のまま
  assert.deepStrictEqual(mergeEvents(videoEvents, []), videoEvents);
});

// ─── recordingRetention(一時 DB)──────────────────────────────────────────────

function makeUser(db) {
  return db
    .prepare(`INSERT INTO users (email, password) VALUES (?, 'x')`)
    .run(`u${Date.now()}${Math.random()}@test.local`).lastInsertRowid;
}

test('deleteRecording: ファイル削除と参照全セッションの recording_path NULL 化', () => {
  const db = require('../db');
  const { deleteRecording } = require('../services/recordingRetention');
  const userId = makeUser(db);

  const file = path.join(tmpDir, 'match_shared_111.mp4');
  fs.writeFileSync(file, 'x');
  // 同じ録画ファイルを 2 セッションが共有参照する(共有録画の実挙動)
  const insert = db.prepare(
    `INSERT INTO match_sessions (user_id, recording_path, status) VALUES (?, ?, 'error')`
  );
  const s1 = insert.run(userId, file).lastInsertRowid;
  const s2 = insert.run(userId, file).lastInsertRowid;

  deleteRecording(file);

  assert.strictEqual(fs.existsSync(file), false);
  const paths = db
    .prepare('SELECT recording_path FROM match_sessions WHERE id IN (?, ?)')
    .all(s1, s2);
  assert.deepStrictEqual(paths, [{ recording_path: null }, { recording_path: null }]);

  // ENOENT(既に無い)でも参照は掃除される
  const gone = path.join(tmpDir, 'match_shared_222.mp4');
  const s3 = insert.run(userId, gone).lastInsertRowid;
  deleteRecording(gone);
  assert.strictEqual(
    db.prepare('SELECT recording_path FROM match_sessions WHERE id = ?').get(s3).recording_path,
    null
  );
});

test('sweepStaleRecordings: done の録画は残し、未参照/未完了の録画を回収する', () => {
  const db = require('../db');
  const { sweepStaleRecordings } = require('../services/recordingRetention');
  const userId = makeUser(db);
  const dataDir = fs.mkdtempSync(path.join(tmpDir, 'sweep-'));

  const keep = path.join(dataDir, 'match_shared_1.mp4'); // done → 保持
  const stale = path.join(dataDir, 'match_shared_2.mp4'); // recording のまま → 回収
  const orphan = path.join(dataDir, 'match_shared_3.mp4'); // DB 未参照 → 回収
  const other = path.join(dataDir, 'notes.txt'); // 対象外
  for (const f of [keep, stale, orphan, other]) fs.writeFileSync(f, 'x');

  const insert = db.prepare(
    `INSERT INTO match_sessions (user_id, recording_path, status) VALUES (?, ?, ?)`
  );
  insert.run(userId, keep, 'done');
  const staleId = insert.run(userId, stale, 'recording').lastInsertRowid;

  const removed = sweepStaleRecordings(dataDir);

  assert.strictEqual(removed, 2);
  assert.strictEqual(fs.existsSync(keep), true);
  assert.strictEqual(fs.existsSync(stale), false);
  assert.strictEqual(fs.existsSync(orphan), false);
  assert.strictEqual(fs.existsSync(other), true);
  assert.strictEqual(
    db.prepare('SELECT recording_path FROM match_sessions WHERE id = ?').get(staleId)
      .recording_path,
    null
  );
});

// ─── eventLog: events_source メタ ────────────────────────────────────────────

test('eventLog: assist イベントと events_source を永続化できる', () => {
  const db = require('../db');
  const eventLog = require('../services/eventLog');
  const userId = makeUser(db);
  const sessionId = db
    .prepare(`INSERT INTO match_sessions (user_id, status) VALUES (?, 'done')`)
    .run(userId).lastInsertRowid;

  eventLog.persist(
    sessionId,
    [{ frameIdx: 4, tMs: 2000, type: 'assist', payload: { round: 0, source: 'riot' } }],
    { mapName: 'ascent', agent: 'Jett', eventsSource: 'riot' }
  );

  const event = db
    .prepare('SELECT event_type, t_ms FROM match_events WHERE session_id = ?')
    .get(sessionId);
  assert.deepStrictEqual(event, { event_type: 'assist', t_ms: 2000 });

  const meta = db
    .prepare('SELECT events_source FROM match_meta WHERE session_id = ?')
    .get(sessionId);
  assert.strictEqual(meta.events_source, 'riot');
});
