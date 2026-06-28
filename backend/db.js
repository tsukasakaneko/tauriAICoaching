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
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Add Stripe columns to existing DBs that predate this migration
for (const col of [
  "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT",
  "ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT",
  "ALTER TABLE users ADD COLUMN subscription_status TEXT",
]) {
  try { db.exec(col); } catch { /* column already exists */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    stripe_event_id TEXT UNIQUE NOT NULL,
    stripe_session_id TEXT,
    product TEXT NOT NULL,
    amount INTEGER NOT NULL,
    license_key TEXT,
    customer_email TEXT,
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

// Phase 1 migrations: per-frame event log + match metadata
db.exec(`
  CREATE TABLE IF NOT EXISTS match_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES match_sessions(id) ON DELETE CASCADE,
    frame_idx   INTEGER NOT NULL,
    t_ms        INTEGER NOT NULL,
    event_type  TEXT    NOT NULL,
    payload_json TEXT
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_match_events_session_t
  ON match_events(session_id, t_ms)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS match_meta (
    session_id      INTEGER PRIMARY KEY REFERENCES match_sessions(id) ON DELETE CASCADE,
    map_name        TEXT,
    agent           TEXT,
    ally_side_initial TEXT
  )
`);

module.exports = db;
