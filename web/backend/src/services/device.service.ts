// ---------------------------------------------------------------------------
//  Device service -- WebSocket server, device state, heartbeat
// ---------------------------------------------------------------------------

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Server as HttpServer } from 'http';
import { DEVICE_API_KEY, MAX_DEVICE_CONNECTIONS } from '../config';
import { isBannedDevice } from './ban.service';
import * as claimService from './claim.service';
import logger from '../logger';
import type { DeviceState, PendingClaim, ClaimInfo } from '../types';

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

const devices = new Map<string, DeviceState>();
const pendingClaims = new Map<string, PendingClaim>();

// Throttle ban-rejection log to avoid log flood
const bannedDeviceLogLast = new Map<string, number>();
const BANNED_LOG_INTERVAL_MS = 5 * 60 * 1000;

// Broadcast callback -- set by index.ts after Socket.io is ready
let broadcastCallback: (() => void) | null = null;

export function setBroadcastCallback(cb: () => void): void {
  broadcastCallback = cb;
}

// ---------------------------------------------------------------------------
//  Public helpers
// ---------------------------------------------------------------------------

export function getDeviceList() {
  return Array.from(devices.values()).map((d) => {
    const claim = claimService.getClaimByDevice(d.id);
    return {
      id: d.id,
      name: d.name,
      ip: d.ip,
      publicIp: d.publicIp,
      version: d.version,
      connectedAt: d.connectedAt.toISOString(),
      claimedBy: claim ? { userName: claim.userName, userAvatar: claim.userAvatar } : null,
    };
  });
}

export function broadcastDevices(): void {
  broadcastCallback?.();
}

export function getDevice(id: string): DeviceState | undefined {
  return devices.get(id);
}

export function getDeviceCount(): number {
  return devices.size;
}

export function getDevicesRaw(): Map<string, DeviceState> {
  return devices;
}

export function disconnectDevice(deviceId: string): void {
  const dev = devices.get(deviceId);
  if (dev) {
    dev.ws.close();
    devices.delete(deviceId);
    broadcastDevices();
  }
}

// ---------------------------------------------------------------------------
//  Pending claims
// ---------------------------------------------------------------------------

export function getPendingClaim(deviceId: string): PendingClaim | undefined {
  return pendingClaims.get(deviceId);
}

export function hasPendingClaim(deviceId: string): boolean {
  return pendingClaims.has(deviceId);
}

export function setPendingClaim(deviceId: string, claim: PendingClaim): void {
  pendingClaims.set(deviceId, claim);
}

export function clearPendingClaim(deviceId: string): void {
  const pending = pendingClaims.get(deviceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingClaims.delete(deviceId);
  }
}

// ---------------------------------------------------------------------------
//  Extract public IP from request
// ---------------------------------------------------------------------------

export function extractPublicIp(request: IncomingMessage): string {
  const xff = request.headers['x-forwarded-for'];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    if (first) return first;
  }
  const cfIp = request.headers['cf-connecting-ip'];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;
  return request.socket.remoteAddress || '';
}

// ---------------------------------------------------------------------------
//  WebSocket server setup
// ---------------------------------------------------------------------------

let wss: WebSocketServer;

export function setupWebSocketServer(httpServer: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  // Log startup warning if DEVICE_API_KEY is empty
  if (!DEVICE_API_KEY) {
    logger.warn('DEVICE_API_KEY is empty -- all device WebSocket connections will be REJECTED');
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);

    if (url.pathname === '/device') {
      // --- Device API Key validation (reject if empty or mismatched) ---
      const key = url.searchParams.get('key');
      if (!DEVICE_API_KEY || key !== DEVICE_API_KEY) {
        logger.warn({ ip: request.socket.remoteAddress }, 'Device WS rejected: invalid or missing API key');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // --- Connection count limit ---
      if (wss.clients.size >= MAX_DEVICE_CONNECTIONS) {
        logger.warn('Device WS rejected: max connections reached');
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Other paths (e.g. /socket.io/) are handled by Socket.io automatically.
  });

  // --- Connection handler ---
  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    let deviceId: string | null = null;
    const publicIp = extractPublicIp(request);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'device.register' && msg.id) {
          deviceId = msg.id;

          if (isBannedDevice(msg.id)) {
            const now = Date.now();
            const last = bannedDeviceLogLast.get(msg.id) ?? 0;
            if (now - last >= BANNED_LOG_INTERVAL_MS) {
              bannedDeviceLogLast.set(msg.id, now);
              logger.warn({ deviceId: msg.id }, 'Device WS rejected: banned');
            }
            ws.close();
            return;
          }

          // If device reconnects, close the stale socket
          const existing = devices.get(msg.id);
          if (existing && existing.ws !== ws) {
            existing.ws.close();
          }

          devices.set(msg.id, {
            id: msg.id,
            name: msg.name || msg.id,
            ip: msg.ip || '',
            publicIp,
            version: msg.version || '1.0.0',
            ws,
            connectedAt: existing?.ws === ws ? existing.connectedAt : new Date(),
          });

          broadcastDevices();
          logger.info({ deviceId: msg.id, name: msg.name, localIp: msg.ip, publicIp }, 'Device online');
        }

        // Handle claim confirmation from device
        if (msg.type === 'claim_confirm' && deviceId) {
          const pending = pendingClaims.get(deviceId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingClaims.delete(deviceId);

            const claim: ClaimInfo = {
              userId: pending.userId,
              userName: pending.userName,
              userAvatar: pending.userAvatar,
              claimedAt: new Date().toISOString(),
            };
            claimService.setClaim(deviceId, claim);
            broadcastDevices();
            logger.info({ deviceId, userName: pending.userName }, 'Device claimed');
          }
        }

        if (msg.type === 'claim_reject' && deviceId) {
          const pending = pendingClaims.get(deviceId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingClaims.delete(deviceId);
            logger.info({ deviceId, userName: pending.userName }, 'Device claim rejected');
          }
        }
      } catch (e) {
        logger.error({ err: e }, 'Invalid device message');
      }
    });

    ws.on('close', () => {
      if (deviceId) {
        const registered = devices.get(deviceId);
        if (registered && registered.ws === ws) {
          devices.delete(deviceId);
          broadcastDevices();
          logger.info({ deviceId }, 'Device offline');
        }
      }
    });

    // Heartbeat
    ws.on('pong', () => {
      (ws as unknown as Record<string, unknown>).__alive = true;
    });
    (ws as unknown as Record<string, unknown>).__alive = true;
  });

  // Ping all device sockets every 30 seconds
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as unknown as Record<string, unknown>).__alive === false) {
        ws.terminate();
        return;
      }
      (ws as unknown as Record<string, unknown>).__alive = false;
      ws.ping();
    });
  }, 30_000);

  // Store interval so graceful shutdown can clear it
  (wss as unknown as Record<string, unknown>).__heartbeatInterval = heartbeatInterval;

  return wss;
}

export function getWss(): WebSocketServer {
  return wss;
}

/**
 * Close all device WebSocket connections (for graceful shutdown).
 */
export function closeAll(): void {
  if (wss) {
    const interval = (wss as unknown as Record<string, unknown>).__heartbeatInterval as ReturnType<typeof setInterval> | undefined;
    if (interval) clearInterval(interval);
    wss.clients.forEach((ws) => ws.close());
    wss.close();
  }
}
