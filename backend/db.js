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

module.exports = db;
