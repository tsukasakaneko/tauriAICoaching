'use strict';

const riotLocalApi = require('./riotLocalApi');

// 試合結果 (KDA・マップ・エージェント) を Riot の pd サーバーから取得する。
// 読み取り専用。取得できない場合は null を返し、映像解析へフォールバックさせる。

// matchInfo.mapId ("/Game/Maps/Ascent/Ascent") の末尾セグメント(内部コードネーム)→ 表示名
const MAP_ID_TO_NAME = {
  Ascent: 'ascent',
  Duality: 'bind',
  Triad: 'haven',
  Bonsai: 'split',
  Port: 'icebox',
  Foxtrot: 'breeze',
  Canyon: 'fracture',
  Pitt: 'pearl',
  Jam: 'lotus',
  Juliett: 'sunset',
  Infinity: 'abyss',
};

// 標準的な PC/Windows の ClientPlatform ヘッダ(pd API が要求する場合がある)
const CLIENT_PLATFORM = Buffer.from(
  JSON.stringify({
    platformType: 'PC',
    platformOS: 'Windows',
    platformOSVersion: '10.0.19042.1.256.64bit',
    platformChipset: 'Unknown',
  })
).toString('base64');

// エージェント UUID → 表示名。UUID のハードコードはせず valorant-api.com から
// 一度だけ取得してキャッシュする。失敗時は null(エージェント名なしで続行)。
let agentNameCache = null; // Map<uuid(lower), displayName> | null

async function loadAgentNames() {
  if (agentNameCache) return agentNameCache;
  const url =
    process.env.RIOT_AGENTS_URL ??
    'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    const map = new Map();
    for (const a of json?.data ?? []) {
      if (a?.uuid && a?.displayName) map.set(a.uuid.toLowerCase(), a.displayName);
    }
    if (map.size === 0) return null;
    agentNameCache = map;
    return agentNameCache;
  } catch {
    return null;
  }
}

async function getAgentName(characterId) {
  if (!characterId) return null;
  const names = await loadAgentNames();
  return names?.get(String(characterId).toLowerCase()) ?? null;
}

function mapNameFromId(mapId) {
  if (typeof mapId !== 'string') return null;
  const seg = mapId.split('/').filter(Boolean).pop();
  return MAP_ID_TO_NAME[seg] ?? null;
}

async function pdRequest(pathName) {
  const shard = await riotLocalApi.getShard();
  const base = process.env.RIOT_PD_BASE_URL ?? (shard ? `https://pd.${shard}.a.pvp.net` : null);
  if (!base) return null;
  const ent = await riotLocalApi.getEntitlements();
  const res = await fetch(`${base}${pathName}`, {
    headers: {
      Authorization: `Bearer ${ent.accessToken}`,
      'X-Riot-Entitlements-JWT': ent.token,
      'X-Riot-ClientPlatform': CLIENT_PLATFORM,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null; // 4xx/5xx はグレースフルに諦める
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * match-details からキル/デス/アシストの時系列を抽出する(純関数)。
 * roundResults[].playerStats[].kills[] は「そのプレイヤーが取ったキル」の一覧
 * なので、全 playerStats を走査すれば各キルイベントは一度ずつ現れる。
 * → [{ type: 'kill'|'death'|'assist', gameTimeMs, round }] (gameTimeMs 昇順)
 */
function extractTimeline(details, puuid) {
  const out = [];
  for (const rr of details?.roundResults ?? []) {
    for (const ps of rr?.playerStats ?? []) {
      for (const k of ps?.kills ?? []) {
        const t = k?.timeSinceGameStartMillis;
        if (typeof t !== 'number') continue;
        const round = rr.roundNum ?? k.round ?? null;
        if (k.killer === puuid && k.victim !== puuid) {
          out.push({ type: 'kill', gameTimeMs: t, round });
        }
        if (k.victim === puuid) {
          out.push({ type: 'death', gameTimeMs: t, round });
        } else if ((k.assistants ?? []).includes(puuid)) {
          out.push({ type: 'assist', gameTimeMs: t, round });
        }
      }
    }
  }
  return out.sort((a, b) => a.gameTimeMs - b.gameTimeMs);
}

/**
 * 直近の試合の統計を取得する。絶対に throw しない(失敗は null)。
 * match-details は試合終了から 30〜90 秒遅れて反映されるためリトライする。
 * sinceMillis より古い試合(=前の試合)は誤帰属を防ぐためスキップ。
 */
async function fetchLatestMatchStats({ sinceMillis }) {
  const retries = parseInt(process.env.RIOT_MATCH_RETRIES ?? '6', 10);
  const retryMs = parseInt(process.env.RIOT_MATCH_RETRY_MS ?? '12000', 10);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) await sleep(retryMs);

      const puuid = await riotLocalApi.getSessionPuuid();
      const history = await pdRequest(
        `/match-history/v1/history/${puuid}?startIndex=0&endIndex=1`
      );
      const latest = history?.History?.[0];
      if (!latest?.MatchID) continue;
      // 2分のマージン: クロックずれ・試合開始検知の遅れを吸収
      if (
        typeof sinceMillis === 'number' &&
        typeof latest.GameStartTime === 'number' &&
        latest.GameStartTime < sinceMillis - 120_000
      ) {
        continue; // まだ前の試合しか出ていない — 反映待ち
      }

      const details = await pdRequest(`/match-details/v1/matches/${latest.MatchID}`);
      if (!details?.players) continue;

      const me = details.players.find((p) => p.subject === puuid);
      if (!me?.stats) continue;
      const myTeam = (details.teams ?? []).find((t) => t.teamId === me.teamId);

      return {
        kills: me.stats.kills ?? null,
        deaths: me.stats.deaths ?? null,
        assists: me.stats.assists ?? null,
        agent: await getAgentName(me.characterId),
        mapName: mapNameFromId(details.matchInfo?.mapId),
        totalRounds: myTeam?.roundsPlayed ?? me.stats.roundsPlayed ?? null,
        wonRounds: myTeam?.roundsWon ?? null,
        won: myTeam?.won ?? null,
        queueId: details.matchInfo?.queueID ?? latest.QueueID ?? null,
        matchId: latest.MatchID,
        // 動画内時刻への変換に使うエポックと、キル/デス/アシストの時系列
        gameStartMillis: details.matchInfo?.gameStartMillis ?? latest.GameStartTime ?? null,
        timeline: extractTimeline(details, puuid),
      };
    } catch {
      // 個別の失敗はリトライで吸収。窓を使い切ったら null
    }
  }
  return null;
}

module.exports = { fetchLatestMatchStats, extractTimeline, getAgentName, mapNameFromId, MAP_ID_TO_NAME };
