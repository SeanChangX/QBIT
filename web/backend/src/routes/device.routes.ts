// ---------------------------------------------------------------------------
//  Device routes -- /api/devices, /api/poke, /api/poke/user, /api/claim
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { validate } from '../middleware/validate';
import { pokeSchema, pokeUserSchema, claimSchema } from '../schemas';
import { isBanned } from '../services/ban.service';
import * as deviceService from '../services/device.service';
import * as claimService from '../services/claim.service';
import * as socketService from '../services/socket.service';
import logger from '../logger';
import type { AppUser } from '../types';

const router = Router();

// GET /api/devices
router.get('/devices', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  res.json(deviceService.getDeviceList());
});

// POST /api/poke -- poke a device
router.post('/poke', validate(pokeSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to poke' });
  }
  const user = req.user as AppUser;
  const clientIp = req.ip || req.socket?.remoteAddress || '';
  if (isBanned(user.id, clientIp)) {
    return res.status(403).json({ error: 'Account or IP is banned' });
  }

  const { targetId, text, senderBitmap, senderBitmapWidth, textBitmap, textBitmapWidth } = req.body;

  const device = deviceService.getDevice(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  const pokePayload: Record<string, unknown> = {
    type: 'poke',
    sender: user.displayName || 'Anonymous',
    text: String(text).substring(0, 25),
  };

  if (senderBitmap && senderBitmapWidth) {
    pokePayload.senderBitmap = senderBitmap;
    pokePayload.senderBitmapWidth = senderBitmapWidth;
  }
  if (textBitmap && textBitmapWidth) {
    pokePayload.textBitmap = textBitmap;
    pokePayload.textBitmapWidth = textBitmapWidth;
  }

  device.ws.send(JSON.stringify(pokePayload));
  logger.info({ sender: user.displayName, target: device.name }, 'Poke sent');
  res.json({ ok: true });
});

// POST /api/poke/user -- poke another web user
router.post('/poke/user', validate(pokeUserSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to poke' });
  }
  const sender = req.user as AppUser;
  const clientIp = req.ip || req.socket?.remoteAddress || '';
  if (isBanned(sender.id, clientIp)) {
    return res.status(403).json({ error: 'Account or IP is banned' });
  }

  const { targetUserId, text } = req.body;
  const textStr = String(text).substring(0, 25);

  const onlineUsersMap = socketService.getOnlineUsersMap();
  const targetSocketIds: string[] = [];
  for (const u of onlineUsersMap.values()) {
    if (u.userId === targetUserId) targetSocketIds.push(u.socketId);
  }

  if (targetSocketIds.length === 0) {
    return res.status(404).json({ error: 'User not found or offline' });
  }

  const io = socketService.getIo();
  const payload = {
    from: sender.displayName || 'Anonymous',
    fromUserId: sender.id,
    text: textStr,
  };
  for (const sid of targetSocketIds) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('poke', payload);
  }

  logger.info({ sender: sender.displayName, targetUserId }, 'User poke sent');
  res.json({ ok: true });
});

// POST /api/claim
router.post('/claim', validate(claimSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const { targetId, deviceIdFull } = req.body;

  const device = deviceService.getDevice(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  if (device.id !== deviceIdFull) {
    return res.status(400).json({ error: 'Device ID does not match' });
  }

  if (claimService.getClaimByDevice(targetId)) {
    return res.status(409).json({ error: 'Device already claimed' });
  }

  if (deviceService.hasPendingClaim(targetId)) {
    return res.status(409).json({ error: 'A claim request is already pending for this device' });
  }

  const user = req.user as AppUser;

  device.ws.send(
    JSON.stringify({
      type: 'claim_request',
      userName: user.displayName || 'Unknown',
      userAvatar: user.avatar || '',
    })
  );

  const timer = setTimeout(() => {
    deviceService.clearPendingClaim(targetId);
    logger.info({ deviceId: targetId }, 'Claim request timed out');
  }, 30_000);

  deviceService.setPendingClaim(targetId, {
    userId: user.id,
    userName: user.displayName || 'Unknown',
    userAvatar: user.avatar || '',
    timer,
  });

  logger.info({ user: user.displayName, device: device.name }, 'Claim request sent');
  res.json({ ok: true, status: 'pending' });
});

// DELETE /api/claim/:deviceId
router.delete('/claim/:deviceId', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const user = req.user as AppUser;
  const deviceId = req.params.deviceId;
  const claim = claimService.getClaimByDevice(deviceId);

  if (!claim) {
    return res.status(404).json({ error: 'No claim found for this device' });
  }

  if (claim.userId !== user.id) {
    return res.status(403).json({ error: 'You can only unclaim your own devices' });
  }

  claimService.removeClaim(deviceId);
  deviceService.broadcastDevices();
  res.json({ ok: true });
});

export default router;
