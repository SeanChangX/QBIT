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
    id            TEXT PRIMARY KEY,
    filename      TEXT,
    uploader      TEXT,
    uploaderId    TEXT,
    uploadedAt    TEXT,
    size          INTEGER,
    frameCount    INTEGER,
    downloadCount INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS library_stars (
    userId    TEXT NOT NULL,
    libraryId TEXT NOT NULL,
    PRIMARY KEY (userId, libraryId),
    FOREIGN KEY (libraryId) REFERENCES library(id)
  );
  CREATE INDEX IF NOT EXISTS idx_library_stars_libraryId ON library_stars(libraryId);

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

// Migration: add downloadCount to library if missing (existing DBs)
try {
  db.exec('ALTER TABLE library ADD COLUMN downloadCount INTEGER DEFAULT 0');
} catch {
  // Column already exists
}

// Migration: add contentHash for duplicate detection (same content = same file, any user).
// Index on contentHash is maintained only in library.service.ts (single UNIQUE index).
try {
  db.exec('ALTER TABLE library ADD COLUMN contentHash TEXT');
} catch {
  // Column already exists
}

// Reports (user-reported accounts for admin review)
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reporterUserId TEXT NOT NULL,
    reporterName   TEXT,
    reportedUserId TEXT NOT NULL,
    reportedUserName TEXT,
    description  TEXT NOT NULL,
    createdAt   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reports_createdAt ON reports(createdAt);
`);

// Friends (symmetric: store both (a,b) and (b,a) for easy lookup)
db.exec(`
  CREATE TABLE IF NOT EXISTS friends (
    userId   TEXT NOT NULL,
    friendId TEXT NOT NULL,
    PRIMARY KEY (userId, friendId)
  );
  CREATE INDEX IF NOT EXISTS idx_friends_userId ON friends(userId);
`);

// User settings (e.g. only friends can poke my QBIT, public friend list on graph)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    userId TEXT PRIMARY KEY,
    onlyFriendsCanPoke INTEGER NOT NULL DEFAULT 0,
    publicFriends INTEGER NOT NULL DEFAULT 1
  );
`);
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN publicFriends INTEGER NOT NULL DEFAULT 1');
} catch {
  // Column already exists (e.g. after first run)
}

// Opaque public user id (cannot reverse to Google userId); used in device list, friends API, poke target
db.exec(`
  CREATE TABLE IF NOT EXISTS user_public_ids (
    userId TEXT PRIMARY KEY,
    publicId TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_user_public_ids_publicId ON user_public_ids(publicId);
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
