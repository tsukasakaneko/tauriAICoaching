'use strict';

// Riot API の実測値と映像解析の統計をマージする(P1-10)。
// KDA・ラウンド・マップは Riot を優先し、無い場合のみ映像解析(killfeed/OCR)に
// フォールバック。HS率・ポジショニング系は映像解析のみが持つのでそのまま。

function mergeStats(videoResult, riot) {
  if (!riot) {
    return { ...videoResult, statsSource: videoResult.statsSource ?? 'video' };
  }
  return {
    ...videoResult,
    kills: riot.kills ?? videoResult.kills,
    deaths: riot.deaths ?? videoResult.deaths,
    assists: riot.assists ?? videoResult.assists,
    totalRounds: riot.totalRounds ?? videoResult.totalRounds,
    wonRounds: riot.wonRounds ?? videoResult.wonRounds,
    mapName: riot.mapName ?? videoResult.mapName ?? null,
    agent: riot.agent ?? null,
    statsSource: 'riot',
  };
}

// videoAnalyzer の INTERVAL_SECS * 1000 と一致させること
const FRAME_MS = 500;

// Riot タイムラインを eventLog 形式 [{ frameIdx, tMs, type, payload }] に変換する。
// tMs は動画内時刻: gameStartMillis + gameTimeMs - recordingStartedAtMs。
// 録画開始は実際のゲーム開始より遅い(検知+ffmpeg起動)ため負値は 0 にクランプ。
// timeline が空、またはどちらかのエポックが欠けていれば [](YOLO フォールバック)。
function riotTimelineToEvents(riot, recordingStartedAtMs) {
  if (!riot?.timeline?.length) return [];
  if (typeof riot.gameStartMillis !== 'number' || typeof recordingStartedAtMs !== 'number') {
    return [];
  }
  return riot.timeline.map((e) => {
    const tMs = Math.max(0, riot.gameStartMillis + e.gameTimeMs - recordingStartedAtMs);
    return {
      frameIdx: Math.round(tMs / FRAME_MS),
      tMs,
      type: e.type,
      payload: { round: e.round, source: 'riot' },
    };
  });
}

// Riot タイムラインがあれば kill/death/assist はそれを正とし、YOLO 由来の
// kill/death を全て置き換える('position' 等は保持)。時刻の曖昧マッチングは
// せず、ソース単位の全置換で決定的に扱う。空なら従来どおり YOLO のまま。
function mergeEvents(videoEvents, riotEvents) {
  if (!riotEvents.length) return videoEvents;
  return videoEvents
    .filter((e) => e.type !== 'kill' && e.type !== 'death')
    .concat(riotEvents)
    .sort((a, b) => a.tMs - b.tMs);
}

module.exports = { mergeStats, riotTimelineToEvents, mergeEvents, FRAME_MS };
