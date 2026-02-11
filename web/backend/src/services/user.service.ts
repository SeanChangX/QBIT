// ---------------------------------------------------------------------------
//  User service -- known users, SQLite-backed
// ---------------------------------------------------------------------------

import db from '../db';
import type { KnownUser, AppUser } from '../types';

const stmtGet = db.prepare('SELECT * FROM users WHERE userId = ?');
const stmtAll = db.prepare('SELECT * FROM users ORDER BY lastSeen DESC');
const stmtUpsert = db.prepare(`
  INSERT INTO users (userId, displayName, email, avatar, firstSeen, lastSeen)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(userId) DO UPDATE SET
    displayName = excluded.displayName,
    email = excluded.email,
    avatar = excluded.avatar,
    lastSeen = excluded.lastSeen
`);
const stmtUpdateLastSeen = db.prepare('UPDATE users SET lastSeen = ? WHERE userId = ?');

export function getUserById(userId: string): AppUser | null {
  const row = stmtGet.get(userId) as { userId: string; displayName: string; email: string; avatar: string } | undefined;
  if (!row) return null;
  return { id: row.userId, displayName: row.displayName, email: row.email, avatar: row.avatar };
}

export function upsertUser(
  userId: string,
  data: { displayName: string; email: string; avatar: string }
): void {
  const now = new Date().toISOString();
  stmtUpsert.run(userId, data.displayName, data.email, data.avatar, now, now);
}

export function setUserOffline(userId: string): void {
  stmtUpdateLastSeen.run(new Date().toISOString(), userId);
}

export function getAllUsers(onlineUserIds: Set<string>): KnownUser[] {
  const rows = stmtAll.all() as {
    userId: string;
    displayName: string;
    email: string;
    avatar: string;
    firstSeen: string;
    lastSeen: string;
  }[];

  const now = new Date().toISOString();
  return rows.map((u) => {
    const isOnline = onlineUserIds.has(u.userId);
    return {
      userId: u.userId,
      displayName: u.displayName,
      email: u.email,
      avatar: u.avatar,
      firstSeen: u.firstSeen,
      lastSeen: isOnline ? now : u.lastSeen,
      status: isOnline ? 'online' as const : 'offline' as const,
    };
  });
}
