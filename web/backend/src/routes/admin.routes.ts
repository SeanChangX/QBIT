// ---------------------------------------------------------------------------
//  Admin routes -- login, sessions, users, devices, bans
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { validate, validateParams } from '../middleware/validate';
import {
  adminLoginSchema,
  adminBanSchema,
  adminDevicesDeleteSchema,
  adminUserIdParamSchema,
  adminDeviceIdParamSchema,
} from '../schemas';
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

router.delete('/users/:userId', adminAuth, validateParams(adminUserIdParamSchema), (req, res) => {
  const userId = req.params.userId as string;
  const deleted = userService.deleteUser(userId);
  if (!deleted) return res.status(404).json({ error: 'User not found' });
  logger.info({ userId }, 'User record deleted');
  res.json({ ok: true });
});

router.get('/devices', adminAuth, (_req, res) => {
  res.json(deviceService.getDeviceRecordList());
});

router.delete('/devices', adminAuth, validate(adminDevicesDeleteSchema), (req, res) => {
  const { deviceIds } = req.body as { deviceIds: string[] };
  deviceService.deleteDeviceRecords(deviceIds);
  logger.info({ deviceIds }, 'Device records deleted');
  res.json({ ok: true });
});

router.get('/claims', adminAuth, (_req, res) => {
  const claims = claimService.getAllClaims();
  const recordList = deviceService.getDeviceRecordList();
  const nameByDevice = new Map(recordList.map((r) => [r.id, r.name]));
  const list = Object.entries(claims).map(([deviceId, c]) => ({
    deviceId,
    deviceName: deviceService.getDevicesRaw().get(deviceId)?.name ?? nameByDevice.get(deviceId) ?? null,
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

router.delete('/claim/:deviceId', adminAuth, validateParams(adminDeviceIdParamSchema), (req, res) => {
  const deviceId = req.params.deviceId as string;
  const claim = claimService.getClaimByDevice(deviceId);
  if (!claim) return res.status(404).json({ error: 'No claim found for this device' });
  claimService.removeClaim(deviceId);
  deviceService.broadcastDevices();
  logger.info({ deviceId }, 'Claim removed by admin');
  res.json({ ok: true });
});

export default router;
