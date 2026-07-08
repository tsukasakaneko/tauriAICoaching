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

module.exports = { mergeStats };
