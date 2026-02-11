// ---------------------------------------------------------------------------
//  Claim service -- SQLite-backed
// ---------------------------------------------------------------------------

import db from '../db';
import type { ClaimInfo } from '../types';

const stmtGet = db.prepare('SELECT * FROM claims WHERE deviceId = ?');
const stmtAll = db.prepare('SELECT * FROM claims');
const stmtInsert = db.prepare(
  'INSERT OR REPLACE INTO claims (deviceId, userId, userName, userAvatar, claimedAt) VALUES (?, ?, ?, ?, ?)'
);
const stmtDelete = db.prepare('DELETE FROM claims WHERE deviceId = ?');

export function getClaimByDevice(deviceId: string): ClaimInfo | null {
  const row = stmtGet.get(deviceId) as (ClaimInfo & { deviceId: string }) | undefined;
  if (!row) return null;
  return { userId: row.userId, userName: row.userName, userAvatar: row.userAvatar, claimedAt: row.claimedAt };
}

export function getAllClaims(): Record<string, ClaimInfo> {
  const rows = stmtAll.all() as (ClaimInfo & { deviceId: string })[];
  const result: Record<string, ClaimInfo> = {};
  for (const row of rows) {
    result[row.deviceId] = {
      userId: row.userId,
      userName: row.userName,
      userAvatar: row.userAvatar,
      claimedAt: row.claimedAt,
    };
  }
  return result;
}

export function setClaim(deviceId: string, claim: ClaimInfo): void {
  stmtInsert.run(deviceId, claim.userId, claim.userName, claim.userAvatar, claim.claimedAt);
}

export function removeClaim(deviceId: string): boolean {
  const result = stmtDelete.run(deviceId);
  return result.changes > 0;
}
