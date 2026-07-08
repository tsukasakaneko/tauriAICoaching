'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Riot クライアントのローカル API 接続情報 (lockfile) の読み取り。
// 形式: "name:pid:port:password:protocol"(1行)。
// クライアント起動中のみ存在し、再起動でポート/パスワードが変わる。

function getLockfilePath() {
  if (process.env.RIOT_LOCKFILE_PATH) return process.env.RIOT_LOCKFILE_PATH;
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
}

function readLockfile() {
  try {
    const raw = fs.readFileSync(getLockfilePath(), 'utf8').trim();
    const [name, pid, port, password, protocol] = raw.split(':');
    if (!port || !password || !protocol) return null;
    const portNum = parseInt(port, 10);
    if (isNaN(portNum)) return null;
    return { name, pid: parseInt(pid, 10) || null, port: portNum, password, protocol };
  } catch {
    return null; // 未起動・アクセス不可はすべて「利用不可」扱い
  }
}

function isAvailable() {
  return readLockfile() !== null;
}

module.exports = { getLockfilePath, readLockfile, isAvailable };
