// ---------------------------------------------------------------------------
//  Ban service -- SQLite-backed with in-memory Set cache for O(1) lookups
// ---------------------------------------------------------------------------

import db from '../db';
import logger from '../logger';

type BanType = 'userId' | 'ip' | 'deviceId';

// In-memory cache: Map<type, Set<value>>
const cache = new Map<BanType, Set<string>>([
  ['userId', new Set()],
  ['ip', new Set()],
  ['deviceId', new Set()],
]);

// Prepared statements
const stmtInsert = db.prepare('INSERT OR IGNORE INTO bans (type, value) VALUES (?, ?)');
const stmtDelete = db.prepare('DELETE FROM bans WHERE type = ? AND value = ?');
const stmtSelectAll = db.prepare('SELECT type, value FROM bans');

// ---------------------------------------------------------------------------
//  Load cache from SQLite at startup
// ---------------------------------------------------------------------------

function loadCache(): void {
  for (const set of cache.values()) set.clear();
  const rows = stmtSelectAll.all() as { type: BanType; value: string }[];
  for (const row of rows) {
    cache.get(row.type)?.add(row.value);
  }
  logger.info(
    {
      userIds: cache.get('userId')!.size,
      ips: cache.get('ip')!.size,
      deviceIds: cache.get('deviceId')!.size,
    },
    'Ban cache loaded'
  );
}

loadCache();

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

export function isBanned(userId?: string, ip?: string): boolean {
  if (userId && cache.get('userId')!.has(userId)) return true;
  if (ip && cache.get('ip')!.has(ip)) return true;
  return false;
}

export function isBannedDevice(deviceId: string): boolean {
  return cache.get('deviceId')!.has(deviceId);
}

export function addBan(userId?: string, ip?: string, deviceId?: string): void {
  const tx = db.transaction(() => {
    if (userId) {
      stmtInsert.run('userId', userId);
      cache.get('userId')!.add(userId);
    }
    if (ip) {
      stmtInsert.run('ip', ip);
      cache.get('ip')!.add(ip);
    }
    if (deviceId) {
      stmtInsert.run('deviceId', deviceId);
      cache.get('deviceId')!.add(deviceId);
    }
  });
  tx();
}

export function removeBan(userId?: string, ip?: string, deviceId?: string): void {
  const tx = db.transaction(() => {
    if (userId) {
      stmtDelete.run('userId', userId);
      cache.get('userId')!.delete(userId);
    }
    if (ip) {
      stmtDelete.run('ip', ip);
      cache.get('ip')!.delete(ip);
    }
    if (deviceId) {
      stmtDelete.run('deviceId', deviceId);
      cache.get('deviceId')!.delete(deviceId);
    }
  });
  tx();
}

export function getBanList(): { userIds: string[]; ips: string[]; deviceIds: string[] } {
  return {
    userIds: [...cache.get('userId')!],
    ips: [...cache.get('ip')!],
    deviceIds: [...cache.get('deviceId')!],
  };
}
