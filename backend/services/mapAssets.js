'use strict';

const { MAP_ID_TO_NAME } = require('./riotMatchData');

// valorant-api.com からマップのミニマップ画像(displayIcon)を取得して
// メモリキャッシュするプロキシ。Tauri webview の CSP は外部画像を許可しない
// ため、フロントはローカルバックエンド経由で画像を読む。
// agentNameCache(riotMatchData.js)と同じ「失敗は null・成功のみキャッシュ」方針。

// 内部コードネーム('Ascent' 等)→ 表示名('ascent' 等)の逆引きで、
// /v1/maps の mapUrl 末尾セグメントをこちらの小文字マップ名に解決する
const KNOWN_MAPS = new Set(Object.values(MAP_ID_TO_NAME));

let mapIndexCache = null; // Map<lowercaseName, displayIconUrl> | null
const imageCache = new Map(); // lowercaseName → Buffer

function isKnownMap(mapName) {
  return KNOWN_MAPS.has(mapName);
}

async function loadMapIndex() {
  if (mapIndexCache) return mapIndexCache;
  const url = process.env.RIOT_MAPS_URL ?? 'https://valorant-api.com/v1/maps';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    const index = new Map();
    for (const m of json?.data ?? []) {
      const seg = typeof m?.mapUrl === 'string' ? m.mapUrl.split('/').filter(Boolean).pop() : null;
      const name = seg ? MAP_ID_TO_NAME[seg] : null;
      if (name && m?.displayIcon) index.set(name, m.displayIcon);
    }
    if (index.size === 0) return null;
    mapIndexCache = index;
    return mapIndexCache;
  } catch {
    return null;
  }
}

// → PNG Buffer | null(未知マップ・取得失敗)
async function getMinimapPng(mapName) {
  if (!isKnownMap(mapName)) return null;
  if (imageCache.has(mapName)) return imageCache.get(mapName);

  const index = await loadMapIndex();
  const iconUrl = index?.get(mapName);
  if (!iconUrl) return null;

  try {
    const res = await fetch(iconUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    imageCache.set(mapName, buf); // 11マップ×1〜2MB 程度 — メモリで十分
    return buf;
  } catch {
    return null;
  }
}

module.exports = { getMinimapPng, isKnownMap, loadMapIndex };
