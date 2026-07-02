'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB_PATH env で永続ディスク上のパスを指定する(Render では /var/data 配下を推奨)。
// 未設定時は backend-remote/data/licenses.db に作成する。
const defaultDir = path.join(__dirname, 'data');
const dbPath = process.env.DB_PATH || path.join(defaultDir, 'licenses.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ライセンス台帳: 生キーは保存せず sha256 ハッシュのみ保持する
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash         TEXT UNIQUE NOT NULL,
    email            TEXT,
    tier             TEXT NOT NULL,
    credits_granted  INTEGER NOT NULL,
    activation_count INTEGER NOT NULL DEFAULT 0,
    max_activations  INTEGER NOT NULL DEFAULT 1,
    device_hash      TEXT,
    expires_at       TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    activated_at     TEXT
  )
`);

// append-only のクレジット台帳。残高 = SUM(delta)
db.exec(`
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    license_id INTEGER NOT NULL REFERENCES licenses(id),
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ledger_license ON credit_ledger(license_id)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_licenses_device ON licenses(device_hash)
`);

module.exports = db;
