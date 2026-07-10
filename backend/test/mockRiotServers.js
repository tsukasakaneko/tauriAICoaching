'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Riot ローカル API / pd サーバー / valorant-api.com のテスト用モック。
// lockfile は protocol=http で書き、riotLocalApi をそのまま通す。

const OWN_PUUID = 'own-puuid-1234';
const FRIEND_PUUID = 'friend-puuid-9999';
const JETT_UUID = 'add6443a-41bd-e414-f6ad-e58d267f4e95'; // モック内でのみ使用
const LOCK_PASSWORD = 'testpass';

function jwtWithExp(expSecondsFromNow) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })
  ).toString('base64url');
  return `header.${payload}.sig`;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * すべてのモックを起動し、環境変数(RIOT_LOCKFILE_PATH / RIOT_PD_BASE_URL /
 * RIOT_AGENTS_URL)を設定して制御オブジェクトを返す。
 */
async function startMockRiot({ historyEmptyAttempts = 0 } = {}) {
  const state = {
    sessionLoopState: null, // null = presence なし(VALORANT 未起動)
    matchMap: '/Game/Maps/Ascent/Ascent',
    historyCalls: 0,
    gameStartTime: Date.now(),
  };

  // ── ローカル API モック ──────────────────────────────────────────────
  const localServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization ?? '';
    const expected = `Basic ${Buffer.from(`riot:${LOCK_PASSWORD}`).toString('base64')}`;
    if (auth !== expected) return json(res, 401, { message: 'unauthorized' });

    switch (url.pathname) {
      case '/chat/v1/session':
        return json(res, 200, { puuid: OWN_PUUID });
      case '/entitlements/token/v1':
        return json(res, 200, {
          accessToken: jwtWithExp(3600),
          token: 'entitlement-jwt',
          subject: OWN_PUUID,
        });
      case '/riotclient/region-locale':
        return json(res, 200, { region: 'ap', locale: 'ja_JP' });
      case '/chat/v4/presences': {
        const presences = [
          // フレンドの presence(自分の puuid フィルタを検証するため)
          {
            puuid: FRIEND_PUUID,
            product: 'valorant',
            private: Buffer.from(
              JSON.stringify({ sessionLoopState: 'INGAME' })
            ).toString('base64'),
          },
        ];
        if (state.sessionLoopState !== null) {
          presences.push({
            puuid: OWN_PUUID,
            product: 'valorant',
            private: Buffer.from(
              JSON.stringify({
                sessionLoopState: state.sessionLoopState,
                matchMap: state.matchMap,
              })
            ).toString('base64'),
          });
        }
        return json(res, 200, { presences });
      }
      default:
        return json(res, 404, { message: 'not found' });
    }
  });

  // ── pd サーバーモック ────────────────────────────────────────────────
  const pdServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return json(res, 401, { message: 'unauthorized' });
    }

    if (url.pathname === `/match-history/v1/history/${OWN_PUUID}`) {
      state.historyCalls++;
      if (state.historyCalls <= historyEmptyAttempts) {
        return json(res, 200, { History: [] }); // まだ反映されていない状態
      }
      return json(res, 200, {
        History: [
          { MatchID: 'match-001', GameStartTime: state.gameStartTime, QueueID: 'competitive' },
        ],
      });
    }

    if (url.pathname === '/match-details/v1/matches/match-001') {
      return json(res, 200, {
        matchInfo: {
          mapId: state.matchMap,
          queueID: 'competitive',
          gameStartMillis: state.gameStartTime,
        },
        // キル/デス/アシストのタイムライン抽出用: 自分がキル/被キル/アシスト
        // したイベントと、無関係なイベント(フィルタ検証用)を1件ずつ
        roundResults: [
          {
            roundNum: 0,
            playerStats: [
              {
                subject: OWN_PUUID,
                kills: [
                  {
                    killer: OWN_PUUID,
                    victim: 'enemy-puuid-1',
                    assistants: [],
                    timeSinceGameStartMillis: 65_000,
                  },
                ],
              },
            ],
          },
          {
            roundNum: 1,
            playerStats: [
              {
                subject: 'enemy-puuid-1',
                kills: [
                  {
                    killer: 'enemy-puuid-1',
                    victim: OWN_PUUID,
                    assistants: [],
                    timeSinceGameStartMillis: 130_000,
                  },
                ],
              },
            ],
          },
          {
            roundNum: 2,
            playerStats: [
              {
                subject: FRIEND_PUUID,
                kills: [
                  {
                    killer: FRIEND_PUUID,
                    victim: 'enemy-puuid-2',
                    assistants: [OWN_PUUID],
                    timeSinceGameStartMillis: 200_000,
                  },
                  // 無関係なキル(自分は killer/victim/assistants のどれでもない)
                  {
                    killer: FRIEND_PUUID,
                    victim: 'enemy-puuid-3',
                    assistants: [],
                    timeSinceGameStartMillis: 210_000,
                  },
                ],
              },
            ],
          },
        ],
        players: [
          {
            subject: FRIEND_PUUID,
            teamId: 'Red',
            characterId: JETT_UUID,
            stats: { kills: 1, deaths: 2, assists: 3, roundsPlayed: 24 },
          },
          {
            subject: OWN_PUUID,
            teamId: 'Blue',
            characterId: JETT_UUID,
            stats: { kills: 21, deaths: 14, assists: 6, roundsPlayed: 24 },
          },
        ],
        teams: [
          { teamId: 'Blue', won: true, roundsWon: 13, roundsPlayed: 24 },
          { teamId: 'Red', won: false, roundsWon: 11, roundsPlayed: 24 },
        ],
      });
    }

    return json(res, 404, { message: 'not found' });
  });

  // ── valorant-api.com(エージェント一覧)モック ───────────────────────
  const agentsServer = http.createServer((_req, res) => {
    json(res, 200, { data: [{ uuid: JETT_UUID, displayName: 'Jett' }] });
  });

  const [localPort, pdPort, agentsPort] = await Promise.all([
    listen(localServer),
    listen(pdServer),
    listen(agentsServer),
  ]);

  // lockfile(protocol=http でモックに向ける)
  const lockfilePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'riot-lock-')),
    'lockfile'
  );
  fs.writeFileSync(lockfilePath, `Riot Client:1234:${localPort}:${LOCK_PASSWORD}:http`);

  process.env.RIOT_LOCKFILE_PATH = lockfilePath;
  process.env.RIOT_PD_BASE_URL = `http://127.0.0.1:${pdPort}`;
  process.env.RIOT_AGENTS_URL = `http://127.0.0.1:${agentsPort}/v1/agents`;

  return {
    state,
    lockfilePath,
    localPort,
    setLoopState(s) { state.sessionLoopState = s; },
    async close() {
      await Promise.all(
        [localServer, pdServer, agentsServer].map(
          (s) => new Promise((r) => s.close(r))
        )
      );
      fs.rmSync(path.dirname(lockfilePath), { recursive: true, force: true });
    },
  };
}

module.exports = { startMockRiot, OWN_PUUID, JETT_UUID };
