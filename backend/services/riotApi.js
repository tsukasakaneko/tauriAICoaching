'use strict';

// Riot VALORANT API client.
// [BLOCKED] Requires valid RSO access tokens — available only after Riot Developer Portal
// approval and OAuth flow completion (riotAuth.js).

// Asia-Pacific is the region for Japanese accounts.
// Override via RIOT_REGION env var if needed.
const REGION = process.env.RIOT_REGION || 'ap';
const RIOT_API_BASE = `https://${REGION}.api.riotgames.com`;
const ACCOUNT_API_BASE = 'https://asia.api.riotgames.com';

// TTL cache: puuid → { data, expiresAt }
const _cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Guard against concurrent duplicate fetches for the same PUUID
const _pending = new Set();

const RANK_NAMES = {
  0: '未ランク',
  3: 'アイアン1',   4: 'アイアン2',   5: 'アイアン3',
  6: 'ブロンズ1',   7: 'ブロンズ2',   8: 'ブロンズ3',
  9: 'シルバー1',   10: 'シルバー2',  11: 'シルバー3',
  12: 'ゴールド1',  13: 'ゴールド2',  14: 'ゴールド3',
  15: 'プラチナ1',  16: 'プラチナ2',  17: 'プラチナ3',
  18: 'ダイヤモンド1', 19: 'ダイヤモンド2', 20: 'ダイヤモンド3',
  21: 'アセンダント1', 22: 'アセンダント2', 23: 'アセンダント3',
  24: 'イモータル1', 25: 'イモータル2', 26: 'イモータル3',
  27: 'レディアント',
};

async function _riotFetch(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
    const err = new Error('Riot API rate limit exceeded');
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Riot API error: ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function getAccountByPuuid(puuid, accessToken) {
  return _riotFetch(`${ACCOUNT_API_BASE}/riot/account/v1/accounts/by-puuid/${puuid}`, accessToken);
}

async function getMatchList(puuid, accessToken, count = 5) {
  const data = await _riotFetch(
    `${RIOT_API_BASE}/val/match/v1/matchlists/by-puuid/${puuid}?size=${count}`,
    accessToken
  );
  return (data.history || []).slice(0, count);
}

async function getMatch(matchId, accessToken) {
  return _riotFetch(`${RIOT_API_BASE}/val/match/v1/matches/${matchId}`, accessToken);
}

// Aggregate stats from the last N matches for a given PUUID.
// Returns a pre-formatted Japanese text string for AI consumption.
async function getAggregatedStats(puuid, accessToken, count = 5) {
  const cached = _cache.get(puuid);
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  if (_pending.has(puuid)) throw new Error('Stats fetch already in progress for this PUUID');

  _pending.add(puuid);
  try {
    const history = await getMatchList(puuid, accessToken, count);
    const matchResults = await Promise.all(
      history.map(({ matchId }) => getMatch(matchId, accessToken).catch(() => null))
    );

    let totalKills = 0, totalDeaths = 0, totalAssists = 0;
    let totalHeadshots = 0, totalBodyshots = 0, totalLegshots = 0;
    let latestRank = null;
    let gameCount = 0;

    for (const match of matchResults) {
      if (!match) continue;
      const player = match.players?.find((p) => p.puuid === puuid);
      if (!player) continue;
      gameCount++;
      totalKills    += player.stats?.kills   ?? 0;
      totalDeaths   += player.stats?.deaths  ?? 0;
      totalAssists  += player.stats?.assists ?? 0;
      totalHeadshots += player.headshots ?? 0;
      totalBodyshots += player.bodyshots ?? 0;
      totalLegshots  += player.legshots  ?? 0;
      if (latestRank === null && player.competitiveTier != null) {
        latestRank = player.competitiveTier;
      }
    }

    const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
    const hsRate = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;
    const avgKDA = gameCount > 0
      ? `${(totalKills / gameCount).toFixed(1)}/${(totalDeaths / gameCount).toFixed(1)}/${(totalAssists / gameCount).toFixed(1)}`
      : '不明';

    const lines = ['【Riot IDスタッツ（直近試合データ）】'];
    lines.push(`- 集計試合数: ${gameCount}試合`);
    lines.push(`- 平均KDA: ${avgKDA}`);
    lines.push(`- HS率: ${hsRate}%`);
    if (latestRank !== null) {
      lines.push(`- 最新ランク: ${RANK_NAMES[latestRank] ?? `ティア${latestRank}`}`);
    }
    const text = lines.join('\n');

    _cache.set(puuid, { text, expiresAt: Date.now() + CACHE_TTL_MS });
    return text;
  } finally {
    _pending.delete(puuid);
  }
}

module.exports = { getAccountByPuuid, getMatchList, getMatch, getAggregatedStats };
