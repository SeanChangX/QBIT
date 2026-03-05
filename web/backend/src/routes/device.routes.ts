// ---------------------------------------------------------------------------
//  Device routes -- /api/devices, /api/poke, /api/poke/user, /api/claim
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { validate, validateParams } from '../middleware/validate';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { pokeSchema, pokeUserSchema, claimSchema, friendRequestSchema, meSettingsSchema, friendUserIdParamSchema } from '../schemas';
import * as deviceService from '../services/device.service';
import * as claimService from '../services/claim.service';
import * as friendService from '../services/friend.service';
import * as userService from '../services/user.service';
import * as socketService from '../services/socket.service';
import { ensurePublicUserId, getUserIdFromPublicId } from '../services/publicUserId.service';
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
router.post('/poke', requireNotBanned, validate(pokeSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to poke' });
  }
  const user = req.user as AppUser;

  const { targetId, text, senderBitmap, senderBitmapWidth, textBitmap, textBitmapWidth } = req.body;

  const device = deviceService.getDevice(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  const claim = claimService.getClaimByDevice(targetId);
  if (claim && friendService.getOnlyFriendsCanPoke(claim.userId)) {
    if (!friendService.areFriends(claim.userId, user.id)) {
      return res.status(403).json({ error: 'Only friends can poke this QBIT' });
    }
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
  const io = socketService.getIo();
  if (io) io.emit('poke:highlight', { deviceId: targetId });
  logger.info({ sender: user.displayName, target: device.name }, 'Poke sent');
  res.json({ ok: true });
});

// POST /api/poke/user -- poke another web user (target by publicUserId)
router.post('/poke/user', requireNotBanned, validate(pokeUserSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to poke' });
  }
  const sender = req.user as AppUser;

  const { targetPublicUserId, text } = req.body;
  const textStr = String(text).substring(0, 25);
  const targetUserId = getUserIdFromPublicId(targetPublicUserId);
  if (!targetUserId) {
    return res.status(404).json({ error: 'User not found' });
  }

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
    fromPublicUserId: ensurePublicUserId(sender.id),
    text: textStr,
  };
  for (const sid of targetSocketIds) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('poke', payload);
  }
  io.emit('poke:highlight', { publicUserId: targetPublicUserId });

  logger.info({ sender: sender.displayName, targetUserId }, 'User poke sent');
  res.json({ ok: true });
});

// POST /api/claim
router.post('/claim', requireNotBanned, validate(claimSchema), (req, res) => {
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
    const pending = deviceService.getPendingClaim(targetId);
    deviceService.clearPendingClaim(targetId);
    if (pending) socketService.emitToUser(pending.userId, 'claim:result', { result: 'timeout' });
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
router.delete('/claim/:deviceId', requireNotBanned, (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
  const claim = claimService.getClaimByDevice(deviceId);

  if (!claim) {
    return res.status(404).json({ error: 'No claim found for this device' });
  }

  if (claim.userId !== user.id) {
    return res.status(403).json({ error: 'You can only unclaim your own devices' });
  }

  claimService.removeClaim(deviceId);
  const pendingFriend = deviceService.clearPendingFriendRequest(deviceId);
  if (pendingFriend) {
    socketService.emitToUser(pendingFriend.requesterUserId, 'friend_request:result', { result: 'cancelled' });
  }
  deviceService.broadcastDevices();
  res.json({ ok: true });
});

// GET /api/friends (returns publicUserIds and displayName per friend, from users table so names show when offline)
router.get('/friends', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const internalIds = friendService.getFriendIds(user.id);
  const friends = internalIds.map((userId) => {
    const publicUserId = ensurePublicUserId(userId);
    const u = userService.getUserById(userId);
    return { publicUserId, displayName: u?.displayName ?? 'Friend', avatar: u?.avatar ?? '' };
  });
  res.json({ friendIds: friends.map((f) => f.publicUserId), friends });
});

// GET /api/friends/pairs -- friend pairs where both users have "public friends" on (publicUserIds)
router.get('/friends/pairs', (_req, res) => {
  const pairs = friendService.getPublicFriendPairs();
  const friendPairs = pairs.map(({ a, b }) => ({
    a: ensurePublicUserId(a),
    b: ensurePublicUserId(b),
  }));
  res.json({ friendPairs });
});

// POST /api/friends/request
router.post('/friends/request', requireNotBanned, validate(friendRequestSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const { targetId, deviceIdFull } = req.body;

  const device = deviceService.getDevice(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  if (device.id !== deviceIdFull) {
    return res.status(400).json({ error: 'Device ID does not match' });
  }

  const claim = claimService.getClaimByDevice(targetId);
  if (!claim) {
    return res.status(400).json({ error: 'This QBIT is not claimed; only the owner can add friends' });
  }
  if (claim.userId === user.id) {
    return res.status(400).json({ error: 'You cannot add yourself as a friend' });
  }
  if (friendService.areFriends(claim.userId, user.id)) {
    return res.status(409).json({ error: 'Already friends' });
  }
  if (deviceService.hasPendingFriendRequest(targetId)) {
    return res.status(409).json({ error: 'A friend request is already pending for this device' });
  }

  device.ws.send(
    JSON.stringify({
      type: 'friend_request',
      userName: user.displayName || 'Unknown',
      userAvatar: user.avatar || '',
    })
  );

  const timer = setTimeout(() => {
    const pending = deviceService.clearPendingFriendRequest(targetId);
    if (pending) {
      socketService.emitToUser(pending.requesterUserId, 'friend_request:result', { result: 'timeout' });
      logger.info({ deviceId: targetId }, 'Friend request timed out');
    }
  }, 30_000);

  deviceService.setPendingFriendRequest(targetId, {
    ownerUserId: claim.userId,
    requesterUserId: user.id,
    requesterName: user.displayName || 'Unknown',
    requesterAvatar: user.avatar || '',
    timer,
  });

  logger.info({ requester: user.displayName, device: device.name, owner: claim.userId }, 'Friend request sent');
  res.json({ ok: true, status: 'pending' });
});

// DELETE /api/friends/:userId (param is publicUserId)
router.delete('/friends/:userId', requireNotBanned, validateParams(friendUserIdParamSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const friendPublicId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  if (!friendPublicId) {
    return res.status(400).json({ error: 'Friend id required' });
  }
  const friendUserId = getUserIdFromPublicId(friendPublicId);
  if (!friendUserId) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (friendUserId === user.id) {
    return res.status(400).json({ error: 'Cannot remove yourself' });
  }
  if (!friendService.areFriends(user.id, friendUserId)) {
    return res.status(404).json({ error: 'Not friends with this user' });
  }
  friendService.removeFriend(user.id, friendUserId);
  res.json({ ok: true });
});

// GET /api/me/settings
router.get('/me/settings', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const onlyFriendsCanPoke = friendService.getOnlyFriendsCanPoke(user.id);
  const publicFriends = friendService.getPublicFriends(user.id);
  res.json({ onlyFriendsCanPoke, publicFriends });
});

// PATCH /api/me/settings
router.patch('/me/settings', requireNotBanned, validate(meSettingsSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const { onlyFriendsCanPoke, publicFriends } = req.body as { onlyFriendsCanPoke?: boolean; publicFriends?: boolean };
  if (onlyFriendsCanPoke !== undefined) friendService.setOnlyFriendsCanPoke(user.id, onlyFriendsCanPoke);
  if (publicFriends !== undefined) friendService.setPublicFriends(user.id, publicFriends);
  res.json({
    onlyFriendsCanPoke: friendService.getOnlyFriendsCanPoke(user.id),
    publicFriends: friendService.getPublicFriends(user.id),
  });
});

export default router;
