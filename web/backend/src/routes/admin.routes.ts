// ---------------------------------------------------------------------------
//  Admin routes -- login, sessions, users, devices, bans
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate';
import { adminLoginSchema, adminBanSchema } from '../schemas';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  ADMIN_LOGIN_RATE_LIMIT,
  FAILED_LOGIN_DELAY_MS,
} from '../config';
import * as banService from '../services/ban.service';
import * as claimService from '../services/claim.service';
import * as userService from '../services/user.service';
import * as deviceService from '../services/device.service';
import * as socketService from '../services/socket.service';
import logger from '../logger';

const router = Router();

// ---------------------------------------------------------------------------
//  Admin auth middleware
// ---------------------------------------------------------------------------

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // If credentials are not configured, allow access (with startup warning)
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    next();
    return;
  }
  const s = req.session as { admin?: boolean } | undefined;
  if (s?.admin === true) {
    next();
    return;
  }
  res.status(401).json({ error: 'Login required' });
}

// ---------------------------------------------------------------------------
//  Constant-time comparison for admin token
// ---------------------------------------------------------------------------

function timingSafeCompare(a: string, b: string): boolean {
  // Pad both to the same length to avoid leaking length info
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB) && a.length === b.length;
}

// ---------------------------------------------------------------------------
//  Rate limiter for login
// ---------------------------------------------------------------------------

const adminLoginLimiter = rateLimit({
  windowMs: ADMIN_LOGIN_RATE_LIMIT.windowMs,
  max: ADMIN_LOGIN_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

// ---------------------------------------------------------------------------
//  Login / Logout
// ---------------------------------------------------------------------------

// POST /api/admin/login
router.post('/admin/login', adminLoginLimiter, validate(adminLoginSchema), (req, res) => {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(200).json({ ok: true });
  }

  const { username, password } = req.body as { username: string; password: string };

  const validUser = timingSafeCompare(username, ADMIN_USERNAME);
  const validPass = timingSafeCompare(password, ADMIN_PASSWORD);

  if (!validUser || !validPass) {
    logger.warn({ username }, 'Failed admin login attempt');
    setTimeout(() => {
      res.status(401).json({ error: 'Invalid username or password' });
    }, FAILED_LOGIN_DELAY_MS);
    return;
  }

  (req.session as { admin?: boolean }).admin = true;
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.status(200).json({ ok: true });
  });
});

// POST /api/admin/logout
router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('qbit_admin_sid', { path: '/' });
    res.status(200).json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
//  Protected admin API routes
// ---------------------------------------------------------------------------

router.get('/sessions', adminAuth, (_req, res) => {
  res.json(socketService.getSessionsList());
});

router.get('/users', adminAuth, (_req, res) => {
  const onlineIds = socketService.getOnlineUserIds();
  res.json(userService.getAllUsers(onlineIds));
});

router.get('/devices', adminAuth, (_req, res) => {
  res.json(deviceService.getDeviceList());
});

router.get('/claims', adminAuth, (_req, res) => {
  const claims = claimService.getAllClaims();
  const devices = deviceService.getDevicesRaw();
  const list = Object.entries(claims).map(([deviceId, c]) => ({
    deviceId,
    deviceName: devices.get(deviceId)?.name ?? null,
    userId: c.userId,
    userName: c.userName,
    userAvatar: c.userAvatar,
    claimedAt: c.claimedAt,
  }));
  res.json(list);
});

router.get('/bans', adminAuth, (_req, res) => {
  res.json(banService.getBanList());
});

router.post('/ban', adminAuth, validate(adminBanSchema), (req, res) => {
  const { userId, ip, deviceId } = req.body;
  banService.addBan(userId, ip, deviceId);
  if (userId) socketService.disconnectUserSockets(userId);
  if (deviceId) deviceService.disconnectDevice(deviceId);
  if (ip) {
    const disconnectedUsers = socketService.disconnectUserSocketsByIp(ip);
    const disconnectedDevices = deviceService.disconnectDevicesByIp(ip);
    logger.info({ ip, disconnectedUsers, disconnectedDevices }, 'IP ban: disconnected existing connections');
  }
  logger.info({ userId, ip, deviceId }, 'Ban added');
  res.json({ ok: true });
});

router.delete('/ban', adminAuth, validate(adminBanSchema), (req, res) => {
  const { userId, ip, deviceId } = req.body;
  banService.removeBan(userId, ip, deviceId);
  logger.info({ userId, ip, deviceId }, 'Ban removed');
  res.json({ ok: true });
});

export default router;
