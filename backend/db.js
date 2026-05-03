const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const Database = require("better-sqlite3");
const os = require("os");
const fs = require("fs");

// Use XDG data dir on Linux, or home dir — ensures writability in packaged app
const defaultDataDir = path.join(os.homedir(), ".local", "share", "valorant-ai-coaching");
fs.mkdirSync(defaultDataDir, { recursive: true });
const dbPath = process.env.DB_PATH || path.join(defaultDataDir, "coaching.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_paid INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Persistent daily usage counter — survives server restarts unlike an in-memory Map
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_usage (
    user_id   INTEGER NOT NULL REFERENCES users(id),
    date      TEXT    NOT NULL,           -- "YYYY-MM-DD"
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS match_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT DEFAULT (datetime('now')),
    match_started_at TEXT,
    match_ended_at TEXT,
    recording_path TEXT,
    video_analysis_json TEXT,
    status TEXT DEFAULT 'recording',
    error_message TEXT
  )
`);

// Speed up the common "latest done session per user" query
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_match_sessions_user_status
  ON match_sessions(user_id, status)
`);

module.exports = db;
