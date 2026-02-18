// ---------------------------------------------------------------------------
//  SQLite database -- schema, session store, JSON migration
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Store, SessionData } from 'express-session';
import { LIBRARY_DIR } from './config';
import logger from './logger';

const DB_PATH = path.join(LIBRARY_DIR, 'qbit.db');

// Ensure data directory exists
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ---------------------------------------------------------------------------
//  Schema creation
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid  TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);

  CREATE TABLE IF NOT EXISTS bans (
    type  TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (type, value)
  );
  CREATE INDEX IF NOT EXISTS idx_bans_type ON bans(type);

  CREATE TABLE IF NOT EXISTS users (
    userId      TEXT PRIMARY KEY,
    displayName TEXT,
    email       TEXT,
    avatar      TEXT,
    firstSeen   TEXT,
    lastSeen    TEXT
  );

  CREATE TABLE IF NOT EXISTS claims (
    deviceId   TEXT PRIMARY KEY,
    userId     TEXT,
    userName   TEXT,
    userAvatar TEXT,
    claimedAt  TEXT
  );

  CREATE TABLE IF NOT EXISTS library (
    id         TEXT PRIMARY KEY,
    filename   TEXT,
    uploader   TEXT,
    uploaderId TEXT,
    uploadedAt TEXT,
    size       INTEGER,
    frameCount INTEGER
  );

  CREATE TABLE IF NOT EXISTS device_records (
    deviceId   TEXT PRIMARY KEY,
    name       TEXT,
    ip         TEXT,
    publicIp   TEXT,
    version    TEXT,
    lastSeen   TEXT,
    status     TEXT
  );
`);



// ---------------------------------------------------------------------------
//  Session store backed by better-sqlite3
// ---------------------------------------------------------------------------

const stmtGetSession = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
const stmtSetSession = db.prepare(
  'INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)'
);
const stmtDestroySession = db.prepare('DELETE FROM sessions WHERE sid = ?');
const stmtCleanupSessions = db.prepare('DELETE FROM sessions WHERE expired <= ?');

// Cleanup expired sessions every 15 minutes
setInterval(() => {
  stmtCleanupSessions.run(Date.now());
}, 15 * 60 * 1000);

export class SQLiteSessionStore extends Store {
  get(sid: string, callback: (err?: Error | null, session?: SessionData | null) => void): void {
    try {
      const row = stmtGetSession.get(sid, Date.now()) as { sess: string } | undefined;
      if (row) {
        callback(null, JSON.parse(row.sess));
      } else {
        callback(null, null);
      }
    } catch (err) {
      callback(err as Error);
    }
  }

  set(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    try {
      const maxAge = session.cookie?.maxAge ?? 86400000;
      const expired = Date.now() + maxAge;
      stmtSetSession.run(sid, JSON.stringify(session), expired);
      callback?.(null);
    } catch (err) {
      callback?.(err as Error);
    }
  }

  destroy(sid: string, callback?: (err?: Error | null) => void): void {
    try {
      stmtDestroySession.run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err as Error);
    }
  }
}

// ---------------------------------------------------------------------------
//  Export database instance for services
// ---------------------------------------------------------------------------

export default db;
