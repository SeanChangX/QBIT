// ---------------------------------------------------------------------------
//  Socket.io service -- online web users tracking
// ---------------------------------------------------------------------------

import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { IncomingMessage } from 'http';
import { FRONTEND_URL } from '../config';
import { isBanned } from './ban.service';
import * as userService from './user.service';
import * as deviceService from './device.service';
import logger from '../logger';
import type { AppUser, OnlineUser, OnlineUserPublic } from '../types';
import type { RequestHandler } from 'express';

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

const onlineUsers = new Map<string, OnlineUser>();

// Throttle ban-rejection log
const bannedUserLogLast = new Map<string, number>();
const BANNED_LOG_INTERVAL_MS = 5 * 60 * 1000;

let io: SocketIOServer;

// ---------------------------------------------------------------------------
//  Public helpers
// ---------------------------------------------------------------------------

export function getOnlineUsersList(): OnlineUserPublic[] {
  const byUserId = new Map<string, OnlineUserPublic>();
  for (const u of onlineUsers.values()) {
    const existing = byUserId.get(u.userId);
    if (existing) {
      existing.socketIds.push(u.socketId);
    } else {
      byUserId.set(u.userId, {
        userId: u.userId,
        displayName: u.displayName,
        avatar: u.avatar || undefined,
        connectedAt: u.connectedAt.toISOString(),
        socketIds: [u.socketId],
      });
    }
  }
  return Array.from(byUserId.values());
}

export function getOnlineUserIds(): Set<string> {
  const ids = new Set<string>();
  for (const u of onlineUsers.values()) ids.add(u.userId);
  return ids;
}

export function getOnlineUsersMap(): Map<string, OnlineUser> {
  return onlineUsers;
}

export function broadcastOnlineUsers(): void {
  io?.emit('users:update', getOnlineUsersList());
}

export function broadcastDeviceList(): void {
  io?.emit('devices:update', deviceService.getDeviceList());
}

export function getSessionsList(): Array<{
  socketId: string;
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  ip: string;
  connectedAt: string;
}> {
  return Array.from(onlineUsers.values()).map((u) => ({
    socketId: u.socketId,
    userId: u.userId,
    displayName: u.displayName,
    email: u.email,
    avatar: u.avatar || '',
    ip: u.ip,
    connectedAt: u.connectedAt.toISOString(),
  }));
}

export function disconnectUserSockets(userId: string): void {
  const toDisconnect = Array.from(onlineUsers.entries())
    .filter(([, u]) => u.userId === userId)
    .map(([sid]) => sid);
  for (const sid of toDisconnect) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.disconnect(true);
    onlineUsers.delete(sid);
  }
  broadcastOnlineUsers();
}

export function getIo(): SocketIOServer {
  return io;
}

// ---------------------------------------------------------------------------
//  Setup
// ---------------------------------------------------------------------------

export function setupSocketIo(httpServer: HttpServer, sessionMiddleware: RequestHandler): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: FRONTEND_URL, credentials: true },
  });

  // Share session with Socket.io
  io.engine.use(sessionMiddleware);

  // Wire broadcast callback so device service can push updates
  deviceService.setBroadcastCallback(() => {
    io.emit('devices:update', deviceService.getDeviceList());
  });

  io.on('connection', (socket) => {
    // Send current device and user lists on connect
    socket.emit('devices:update', deviceService.getDeviceList());
    socket.emit('users:update', getOnlineUsersList());

    const req = socket.request as IncomingMessage;
    const clientIp = deviceService.extractPublicIp(req);
    const passportUser = (socket.request as unknown as Record<string, unknown> & { session?: { passport?: { user?: AppUser } } })
      ?.session?.passport?.user as AppUser | undefined;

    if (passportUser && passportUser.id) {
      if (isBanned(passportUser.id, clientIp)) {
        socket.disconnect(true);
        const banKey = `${passportUser.id}:${clientIp}`;
        const now = Date.now();
        const last = bannedUserLogLast.get(banKey) ?? 0;
        if (now - last >= BANNED_LOG_INTERVAL_MS) {
          bannedUserLogLast.set(banKey, now);
          logger.info({ userId: passportUser.id, ip: clientIp }, 'Banned user/IP rejected');
        }
        return;
      }

      onlineUsers.set(socket.id, {
        socketId: socket.id,
        userId: passportUser.id,
        displayName: passportUser.displayName || 'Unknown',
        email: passportUser.email || '',
        avatar: passportUser.avatar || '',
        ip: clientIp,
        connectedAt: new Date(),
      });
      userService.upsertUser(passportUser.id, {
        displayName: passportUser.displayName || 'Unknown',
        email: passportUser.email || '',
        avatar: passportUser.avatar || '',
      });
      logger.info({ userId: passportUser.id, displayName: passportUser.displayName }, 'User online');
      broadcastOnlineUsers();
    }

    socket.on('disconnect', () => {
      const user = onlineUsers.get(socket.id);
      if (user) {
        onlineUsers.delete(socket.id);
        userService.setUserOffline(user.userId);
        logger.info({ userId: user.userId, displayName: user.displayName }, 'User offline');
        broadcastOnlineUsers();
      }
    });
  });

  return io;
}
