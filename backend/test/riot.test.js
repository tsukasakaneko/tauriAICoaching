'use strict';

// P1-10: Riot ローカル API 連携のテスト。実行: node --test backend/test/
// VALORANT 不要 — mockRiotServers がローカル API / pd / エージェント一覧を模す。

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { startMockRiot, OWN_PUUID } = require('./mockRiotServers');

// リトライを高速化(実運用は 6 回 × 12 秒)
process.env.RIOT_MATCH_RETRIES = '4';
process.env.RIOT_MATCH_RETRY_MS = '50';
process.env.RIOT_POLL_INTERVAL_MS = '30';

let mock;

before(async () => {
  mock = await startMockRiot({ historyEmptyAttempts: 2 });
});

after(async () => {
  await mock.close();
});

beforeEach(() => {
  require('../services/riotLocalApi').resetCache();
});

// ─── riotLockfile ─────────────────────────────────────────────────────────────

test('lockfile: パースできる', () => {
  const { readLockfile } = require('../services/riotLockfile');
  const lock = readLockfile();
  assert.ok(lock);
  assert.strictEqual(lock.name, 'Riot Client');
  assert.strictEqual(lock.port, mock.localPort);
  assert.strictEqual(lock.protocol, 'http');
});

test('lockfile: 欠損時は null / isAvailable false', () => {
  const saved = process.env.RIOT_LOCKFILE_PATH;
  process.env.RIOT_LOCKFILE_PATH = path.join(os.tmpdir(), 'no-such-lockfile');
  try {
    const { readLockfile, isAvailable } = require('../services/riotLockfile');
    assert.strictEqual(readLockfile(), null);
    assert.strictEqual(isAvailable(), false);
  } finally {
    process.env.RIOT_LOCKFILE_PATH = saved;
  }
});

// ─── riotLocalApi ─────────────────────────────────────────────────────────────

test('riotLocalApi: 自分の presence を base64 デコードして返す(フレンドは無視)', async () => {
  const api = require('../services/riotLocalApi');
  mock.setLoopState('INGAME');
  const presence = await api.getPresence();
  assert.ok(presence);
  assert.strictEqual(presence.sessionLoopState, 'INGAME');
  assert.strictEqual(presence.matchMap, '/Game/Maps/Ascent/Ascent');
});

test('riotLocalApi: presence なし(VALORANT 未起動)は null', async () => {
  const api = require('../services/riotLocalApi');
  mock.setLoopState(null);
  assert.strictEqual(await api.getPresence(), null);
});

test('riotLocalApi: puuid と shard を取得できる', async () => {
  const api = require('../services/riotLocalApi');
  assert.strictEqual(await api.getSessionPuuid(), OWN_PUUID);
  assert.strictEqual(await api.getShard(), 'ap');
});

// ─── riotMatchData ────────────────────────────────────────────────────────────

test('riotMatchData: リトライの末に KDA・マップ・エージェントを返す', async () => {
  const { fetchLatestMatchStats } = require('../services/riotMatchData');
  mock.state.historyCalls = 0; // 最初の 2 回は空(反映遅延を再現)
  const stats = await fetchLatestMatchStats({ sinceMillis: Date.now() - 60_000 });
  assert.ok(stats, 'stats should be returned after retries');
  assert.strictEqual(stats.kills, 21);
  assert.strictEqual(stats.deaths, 14);
  assert.strictEqual(stats.assists, 6);
  assert.strictEqual(stats.agent, 'Jett');
  assert.strictEqual(stats.mapName, 'ascent');
  assert.strictEqual(stats.totalRounds, 24);
  assert.strictEqual(stats.wonRounds, 13);
  assert.strictEqual(stats.won, true);
});

test('riotMatchData: 前の試合しか無い(GameStartTime が古い)場合は null', async () => {
  const { fetchLatestMatchStats } = require('../services/riotMatchData');
  mock.state.historyCalls = 100; // 履歴は返るが…
  const stats = await fetchLatestMatchStats({
    sinceMillis: mock.state.gameStartTime + 10 * 60_000, // 試合開始が 10 分後扱い
  });
  assert.strictEqual(stats, null);
});

test('riotMatchData: mapNameFromId の変換テーブル', () => {
  const { mapNameFromId } = require('../services/riotMatchData');
  assert.strictEqual(mapNameFromId('/Game/Maps/Ascent/Ascent'), 'ascent');
  assert.strictEqual(mapNameFromId('/Game/Maps/Duality/Duality'), 'bind');
  assert.strictEqual(mapNameFromId('/Game/Maps/Juliett/Juliett'), 'sunset');
  assert.strictEqual(mapNameFromId('/Game/Maps/Unknown/Unknown'), null);
  assert.strictEqual(mapNameFromId(null), null);
});

// ─── riotMonitor ──────────────────────────────────────────────────────────────

function waitForEvent(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      timeoutMs
    );
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

test('riotMonitor: MENUS→PREGAME→INGAME→MENUS で matchStarted / resultScreenDetected が発火', async () => {
  const monitor = require('../services/riotMonitor');
  mock.setLoopState('MENUS');
  monitor.start();
  try {
    // MENUS → queue_wait
    await waitForEvent(monitor, 'stateChanged');
    assert.strictEqual(monitor.state, 'queue_wait');

    mock.setLoopState('PREGAME');
    await waitForEvent(monitor, 'stateChanged');
    assert.strictEqual(monitor.state, 'agent_select');

    mock.setLoopState('INGAME');
    await waitForEvent(monitor, 'matchStarted');
    assert.strictEqual(monitor.state, 'in_match');
    assert.ok(monitor.matchStartedAtMillis > 0);

    mock.setLoopState('MENUS');
    await waitForEvent(monitor, 'resultScreenDetected');
    assert.strictEqual(monitor.state, 'result_screen');

    // 次の tick で idle → その後 queue_wait に戻る
    await waitForEvent(monitor, 'gameExited');
  } finally {
    monitor.stop();
  }
});

test('riotMonitor: クライアント終了(presence なし)で idle に落ちる', async () => {
  const monitor = require('../services/riotMonitor');
  mock.setLoopState('INGAME');
  monitor.start();
  try {
    await waitForEvent(monitor, 'matchStarted');
    mock.setLoopState(null);
    await waitForEvent(monitor, 'gameExited');
    assert.strictEqual(monitor.state, 'idle');
  } finally {
    monitor.stop();
  }
});

// ─── statsMerge ───────────────────────────────────────────────────────────────

test('statsMerge: Riot 優先・映像フォールバック', () => {
  const { mergeStats } = require('../services/statsMerge');
  const video = {
    kills: 5, deaths: 9, assists: 1, headshotRate: 0.3,
    dominantZone: 'mid', totalRounds: null, wonRounds: null,
    mapName: null, agent: null, statsSource: 'video',
  };

  const merged = mergeStats(video, {
    kills: 21, deaths: 14, assists: 6, agent: 'Jett', mapName: 'ascent',
    totalRounds: 24, wonRounds: 13, won: true,
  });
  assert.strictEqual(merged.kills, 21);
  assert.strictEqual(merged.totalRounds, 24);
  assert.strictEqual(merged.agent, 'Jett');
  assert.strictEqual(merged.mapName, 'ascent');
  assert.strictEqual(merged.headshotRate, 0.3, 'video-only fields pass through');
  assert.strictEqual(merged.statsSource, 'riot');

  // riot が部分的に null → 映像値にフォールバック
  const partial = mergeStats(video, { kills: null, deaths: 10, assists: null, agent: null, mapName: null, totalRounds: null, wonRounds: null });
  assert.strictEqual(partial.kills, 5);
  assert.strictEqual(partial.deaths, 10);

  // riot なし → そのまま
  const noRiot = mergeStats(video, null);
  assert.strictEqual(noRiot.kills, 5);
  assert.strictEqual(noRiot.statsSource, 'video');
});

// ─── matchMonitor ─────────────────────────────────────────────────────────────

test('matchMonitor: lockfile があれば riot、無ければ yolo を選ぶ', () => {
  const matchMonitor = require('../services/matchMonitor');
  mock.setLoopState(null);

  matchMonitor.start();
  assert.strictEqual(matchMonitor.activeSource, 'riot');
  matchMonitor.stop();
  assert.strictEqual(matchMonitor.activeSource, null);

  const saved = process.env.RIOT_LOCKFILE_PATH;
  process.env.RIOT_LOCKFILE_PATH = path.join(os.tmpdir(), 'no-such-lockfile');
  try {
    matchMonitor.start();
    assert.strictEqual(matchMonitor.activeSource, 'yolo');
    matchMonitor.stop();
  } finally {
    process.env.RIOT_LOCKFILE_PATH = saved;
  }
});

test('matchMonitor: RIOT_MONITOR=off で yolo に固定', () => {
  const matchMonitor = require('../services/matchMonitor');
  process.env.RIOT_MONITOR = 'off';
  try {
    matchMonitor.start();
    assert.strictEqual(matchMonitor.activeSource, 'yolo');
    matchMonitor.stop();
  } finally {
    delete process.env.RIOT_MONITOR;
  }
});
