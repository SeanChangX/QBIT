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
`);

// ---------------------------------------------------------------------------
//  One-time migration from JSON files
// ---------------------------------------------------------------------------

function migrateJsonFiles(): void {
  const claimsPath = path.join(LIBRARY_DIR, 'claims.json');
  const bannedPath = path.join(LIBRARY_DIR, 'banned.json');
  const usersPath = path.join(LIBRARY_DIR, 'users.json');
  const libraryPath = path.join(LIBRARY_DIR, 'library.json');

  // --- claims.json ---
  if (fs.existsSync(claimsPath)) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM claims').get() as { c: number };
    if (count.c === 0) {
      try {
        const data = JSON.parse(fs.readFileSync(claimsPath, 'utf-8'));
        const insert = db.prepare(
          'INSERT OR IGNORE INTO claims (deviceId, userId, userName, userAvatar, claimedAt) VALUES (?, ?, ?, ?, ?)'
        );
        const tx = db.transaction(() => {
          for (const [deviceId, c] of Object.entries(data) as [string, Record<string, string>][]) {
            insert.run(deviceId, c.userId, c.userName, c.userAvatar, c.claimedAt);
          }
        });
        tx();
        logger.info('Migrated claims.json -> SQLite');
      } catch (e) {
        logger.warn({ err: e }, 'Failed to migrate claims.json');
      }
    }
    fs.renameSync(claimsPath, claimsPath + '.migrated');
  }

  // --- banned.json ---
  if (fs.existsSync(bannedPath)) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM bans').get() as { c: number };
    if (count.c === 0) {
      try {
        const data = JSON.parse(fs.readFileSync(bannedPath, 'utf-8'));
        const insert = db.prepare('INSERT OR IGNORE INTO bans (type, value) VALUES (?, ?)');
        const tx = db.transaction(() => {
          for (const uid of data.userIds ?? []) insert.run('userId', uid);
          for (const ip of data.ips ?? []) insert.run('ip', ip);
          for (const did of data.deviceIds ?? []) insert.run('deviceId', did);
        });
        tx();
        logger.info('Migrated banned.json -> SQLite');
      } catch (e) {
        logger.warn({ err: e }, 'Failed to migrate banned.json');
      }
    }
    fs.renameSync(bannedPath, bannedPath + '.migrated');
  }

  // --- users.json ---
  if (fs.existsSync(usersPath)) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    if (count.c === 0) {
      try {
        const arr = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
        const insert = db.prepare(
          'INSERT OR IGNORE INTO users (userId, displayName, email, avatar, firstSeen, lastSeen) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const tx = db.transaction(() => {
          for (const u of arr) {
            if (u?.userId) insert.run(u.userId, u.displayName, u.email, u.avatar, u.firstSeen, u.lastSeen);
          }
        });
        tx();
        logger.info('Migrated users.json -> SQLite');
      } catch (e) {
        logger.warn({ err: e }, 'Failed to migrate users.json');
      }
    }
    fs.renameSync(usersPath, usersPath + '.migrated');
  }

  // --- library.json ---
  if (fs.existsSync(libraryPath)) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM library').get() as { c: number };
    if (count.c === 0) {
      try {
        const arr = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));
        const insert = db.prepare(
          'INSERT OR IGNORE INTO library (id, filename, uploader, uploaderId, uploadedAt, size, frameCount) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const tx = db.transaction(() => {
          for (const item of arr) {
            insert.run(item.id, item.filename, item.uploader, item.uploaderId, item.uploadedAt, item.size, item.frameCount);
          }
        });
        tx();
        logger.info('Migrated library.json -> SQLite');
      } catch (e) {
        logger.warn({ err: e }, 'Failed to migrate library.json');
      }
    }
    fs.renameSync(libraryPath, libraryPath + '.migrated');
  }
}

migrateJsonFiles();

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
