'use strict';

const http = require('http');
const https = require('https');
const { readLockfile } = require('./riotLockfile');

// Riot クライアントのローカル API クライアント(読み取り専用)。
// 認証は Basic auth `riot:{lockfile password}`。https は自己署名証明書のため、
// この 127.0.0.1 接続に限り rejectUnauthorized を無効化する(外部通信には適用しない)。

// region → VALORANT pd シャードの変換
const REGION_TO_SHARD = {
  na: 'na', br: 'na', latam: 'na',
  eu: 'eu',
  ap: 'ap',
  kr: 'kr',
};

let cachedPuuid = null;
let cachedEntitlements = null; // { accessToken, token, subject, expiresAtMs }
let cachedShard = null;

/** GET {protocol}://127.0.0.1:{port}{apiPath} — lockfile は毎回読み直す(再起動でポートが変わる) */
function request(apiPath) {
  return new Promise((resolve, reject) => {
    const lock = readLockfile();
    if (!lock) {
      reject(new Error('Riot クライアントが起動していません(lockfile なし)'));
      return;
    }
    const isHttps = lock.protocol === 'https';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        host: '127.0.0.1',
        port: lock.port,
        path: apiPath,
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`riot:${lock.password}`).toString('base64')}`,
        },
        // ローカル API の自己署名証明書のみ許容(127.0.0.1 固定)
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`ローカル API ${apiPath} が ${res.statusCode} を返しました`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`ローカル API ${apiPath} のレスポンスが JSON ではありません`));
          }
        });
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('ローカル API タイムアウト')));
    req.on('error', reject);
    req.end();
  });
}

async function getSessionPuuid() {
  if (cachedPuuid) return cachedPuuid;
  const session = await request('/chat/v1/session');
  if (!session?.puuid) throw new Error('ローカル API から puuid を取得できません');
  cachedPuuid = session.puuid;
  return cachedPuuid;
}

/** JWT の exp(秒)を読む。パース不能なら null */
function jwtExpMs(jwt) {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')
    );
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function getEntitlements() {
  const now = Date.now();
  if (cachedEntitlements && cachedEntitlements.expiresAtMs - now > 60_000) {
    return cachedEntitlements;
  }
  const ent = await request('/entitlements/token/v1');
  if (!ent?.accessToken || !ent?.token) {
    throw new Error('entitlements の取得に失敗しました');
  }
  cachedEntitlements = {
    accessToken: ent.accessToken,
    token: ent.token,
    subject: ent.subject ?? null,
    // exp が読めない場合は 30 分キャッシュ
    expiresAtMs: jwtExpMs(ent.accessToken) ?? now + 30 * 60_000,
  };
  if (ent.subject) cachedPuuid = ent.subject;
  return cachedEntitlements;
}

/**
 * 自分の VALORANT presence を返す。取得・パース失敗はすべて null(グレースフル)。
 * 戻り値: { sessionLoopState, matchMap, ... }(base64 の private をデコードした JSON)
 */
async function getPresence() {
  try {
    const puuid = await getSessionPuuid();
    const data = await request('/chat/v4/presences');
    const presences = Array.isArray(data?.presences) ? data.presences : [];
    // フレンドの presence も混ざるため、自分の puuid + valorant で絞る
    const own = presences.find((p) => p.puuid === puuid && p.product === 'valorant');
    if (!own?.private) return null;
    return JSON.parse(Buffer.from(own.private, 'base64').toString('utf8'));
  } catch {
    cachedPuuid = null; // クライアント再起動の可能性 — 次回取り直す
    return null;
  }
}

async function getShard() {
  if (process.env.RIOT_SHARD) return process.env.RIOT_SHARD;
  if (cachedShard) return cachedShard;

  try {
    const rl = await request('/riotclient/region-locale');
    const region = (rl?.region ?? '').toLowerCase();
    if (REGION_TO_SHARD[region]) {
      cachedShard = REGION_TO_SHARD[region];
      return cachedShard;
    }
  } catch { /* fall through to secondary source */ }

  // 第二候補: 起動引数の -ares-deployment={region}
  try {
    const sessions = await request('/product-session/v1/external-sessions');
    for (const key of Object.keys(sessions ?? {})) {
      const args = sessions[key]?.launchConfiguration?.arguments ?? [];
      for (const arg of args) {
        const m = /-ares-deployment=([a-z]+)/.exec(arg);
        if (m && REGION_TO_SHARD[m[1]]) {
          cachedShard = REGION_TO_SHARD[m[1]];
          return cachedShard;
        }
      }
    }
  } catch { /* graceful */ }

  return null;
}

function resetCache() {
  cachedPuuid = null;
  cachedEntitlements = null;
  cachedShard = null;
}

module.exports = { request, getSessionPuuid, getEntitlements, getPresence, getShard, resetCache };
