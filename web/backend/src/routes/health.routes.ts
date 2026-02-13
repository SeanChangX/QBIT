// ---------------------------------------------------------------------------
//  Health check route
// ---------------------------------------------------------------------------
// Sensitive fields (emails, IPs) are only shown when the request includes
// the correct HEALTH_SECRET query parameter.

import { Router } from 'express';
import crypto from 'crypto';
import { HEALTH_SECRET } from '../config';
import * as deviceService from '../services/device.service';
import * as claimService from '../services/claim.service';
import * as socketService from '../services/socket.service';
import * as libraryService from '../services/library.service';

const router = Router();

// Server start time (for uptime calculation)
const SERVER_START = Date.now();

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function pad(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function drawTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)));
  const sep = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;
  const line = (cells: string[]) =>
    '|' + cells.map((c, i) => ' ' + pad(c, widths[i]) + ' ').join('|') + '|';

  const lines: string[] = [];
  lines.push(sep('+', '+', '+', '-'));
  lines.push(line(headers));
  lines.push(sep('+', '+', '+', '-'));
  for (const row of rows) lines.push(line(row));
  lines.push(sep('+', '+', '+', '-'));
  return lines.join('\n');
}

/** Check if the request has the correct health secret via Authorization header */
function hasSecret(req: { headers: Record<string, unknown> }): boolean {
  if (!HEALTH_SECRET) return false;
  const authHeader = (req.headers['authorization'] || '') as string;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HEALTH_SECRET));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
//  GET /health
// ---------------------------------------------------------------------------

router.get('/', (req: any, res) => {
  const format = req.query.format as string | undefined;
  const now = Date.now();
  const showSensitive = hasSecret(req as any);

  const claims = claimService.getAllClaims();
  const onlineUsers = socketService.getOnlineUsersMap();
  const devices = deviceService.getDevicesRaw();

  if (format === 'json') {
    const devicesPayload = Array.from(devices.values()).map((d) => {
      const base: Record<string, unknown> = {
        id: d.id,
        name: d.name,
        version: d.version,
        connectedAt: d.connectedAt.toISOString(),
        uptime: formatUptime(now - d.connectedAt.getTime()),
      };
      if (showSensitive) {
        base.localIp = d.ip;
        base.publicIp = d.publicIp;
      }
      return base;
    });

    const uniqueUsers = new Map<string, { displayName: string; email: string; connectedAt: Date }>();
    for (const u of onlineUsers.values()) {
      if (!uniqueUsers.has(u.userId)) {
        uniqueUsers.set(u.userId, { displayName: u.displayName, email: u.email, connectedAt: u.connectedAt });
      }
    }

    const usersPayload = Array.from(uniqueUsers.values()).map((u) => {
      const base: Record<string, unknown> = {
        displayName: u.displayName,
        connectedAt: u.connectedAt.toISOString(),
        uptime: formatUptime(now - u.connectedAt.getTime()),
      };
      if (showSensitive) {
        base.email = u.email;
      }
      return base;
    });

    res.json({
      status: 'ok',
      uptime: formatUptime(now - SERVER_START),
      timestamp: new Date(now).toISOString(),
      devices: { count: devices.size, list: devicesPayload },
      claims: {
        count: Object.keys(claims).length,
        list: Object.entries(claims).map(([deviceId, c]) => ({
          deviceId,
          userName: c.userName,
          claimedAt: c.claimedAt,
        })),
      },
      users: { count: uniqueUsers.size, list: usersPayload },
      library: { fileCount: libraryService.getAll().length },
    });
    return;
  }

  // ---- Plain-text ASCII table dashboard ----
  const lines: string[] = [];
  lines.push('QBIT Server Status');
  lines.push('===================');
  lines.push(`Status:    OK`);
  lines.push(`Uptime:    ${formatUptime(now - SERVER_START)}`);
  lines.push(`Timestamp: ${new Date(now).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`);
  lines.push('');

  // Devices table
  lines.push(`Devices Online: ${devices.size}`);
  if (devices.size > 0) {
    const headers = showSensitive
      ? ['ID', 'Name', 'Local IP', 'Public IP', 'Version', 'Uptime']
      : ['ID', 'Name', 'Version', 'Uptime'];
    const deviceRows = Array.from(devices.values()).map((d) => {
      const base = [d.id, d.name];
      if (showSensitive) base.push(d.ip || '-', d.publicIp || '-');
      base.push(d.version, formatUptime(now - d.connectedAt.getTime()));
      return base;
    });
    lines.push(drawTable(headers, deviceRows));
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Claims table
  const claimEntries = Object.entries(claims);
  lines.push(`Claims: ${claimEntries.length}`);
  if (claimEntries.length > 0) {
    const claimRows = claimEntries.map(([deviceId, c]) => {
      const dev = devices.get(deviceId);
      return [dev ? dev.name : deviceId, c.userName, c.claimedAt.split('T')[0]];
    });
    lines.push(drawTable(['Device', 'Owner', 'Claimed'], claimRows));
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Users table
  const uniqueUsers = new Map<string, { displayName: string; email: string; connectedAt: Date }>();
  for (const u of onlineUsers.values()) {
    if (!uniqueUsers.has(u.userId)) {
      uniqueUsers.set(u.userId, { displayName: u.displayName, email: u.email, connectedAt: u.connectedAt });
    }
  }
  lines.push(
    `Users Online: ${uniqueUsers.size}` + (onlineUsers.size !== uniqueUsers.size ? ` (${onlineUsers.size} sessions)` : '')
  );
  if (uniqueUsers.size > 0) {
    const headers = showSensitive ? ['Name', 'Email', 'Session'] : ['Name', 'Session'];
    const userRows = Array.from(uniqueUsers.values()).map((u) => {
      const row = [u.displayName];
      if (showSensitive) row.push(u.email || '-');
      row.push(formatUptime(now - u.connectedAt.getTime()));
      return row;
    });
    lines.push(drawTable(headers, userRows));
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push(`Library: ${libraryService.getAll().length} files`);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

export default router;
