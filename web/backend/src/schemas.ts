// ---------------------------------------------------------------------------
//  Zod input-validation schemas for all API endpoints
// ---------------------------------------------------------------------------

import { z } from 'zod';

// Shared: opaque poke token (24 hex); used for poke/claim/friend target and DELETE /claim/:token
const pokeTokenSchema = z.string().length(24).regex(/^[a-f0-9]+$/);

// POST /api/poke
export const pokeSchema = z.object({
  targetId: pokeTokenSchema,
  text: z.string().min(1).max(25),
  senderBitmap: z.string().optional(),
  senderBitmapWidth: z.number().int().positive().optional(),
  textBitmap: z.string().optional(),
  textBitmapWidth: z.number().int().positive().optional(),
});

// POST /api/poke/user (targetPublicUserId: opaque id, not raw Google id)
export const pokeUserSchema = z.object({
  targetPublicUserId: z.string().length(24).regex(/^[a-f0-9]+$/),
  text: z.string().min(1).max(25),
});

// POST /api/claim
export const claimSchema = z.object({
  targetId: pokeTokenSchema,
  deviceIdFull: z.string().min(1).max(256).regex(/^[a-zA-Z0-9:]+$/),
});

// POST /api/friends/request (same body as claim: target poke token + deviceIdFull to confirm)
export const friendRequestSchema = z.object({
  targetId: pokeTokenSchema,
  deviceIdFull: z.string().min(1).max(256).regex(/^[a-zA-Z0-9:]+$/),
});

// PATCH /api/me/settings (partial: either or both)
export const meSettingsSchema = z.object({
  onlyFriendsCanPoke: z.boolean().optional(),
  publicFriends: z.boolean().optional(),
}).refine((d) => d.onlyFriendsCanPoke !== undefined || d.publicFriends !== undefined, {
  message: 'At least one of onlyFriendsCanPoke or publicFriends is required',
});

// DELETE /api/library/batch  &  POST /api/library/batch-download
export const libraryBatchSchema = z.object({
  ids: z.array(z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/)).min(1).max(100),
});

// POST /api/admin/login
export const adminLoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(128),
});

// POST /api/ban  &  DELETE /api/ban
export const adminBanSchema = z
  .object({
    userId: z.string().max(256).regex(/^[a-zA-Z0-9@._+-]+$/).optional(),
    ip: z.string().max(45).regex(/^[0-9a-fA-F:.]+$/).optional(),
    deviceId: z.string().max(128).regex(/^[a-zA-Z0-9-]+$/).optional(),
  })
  .refine((data) => data.userId || data.ip || data.deviceId, {
    message: 'At least one of userId, ip, or deviceId is required',
  });

// DELETE /api/devices (admin batch delete device records)
export const adminDevicesDeleteSchema = z.object({
  deviceIds: z.array(z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/)).min(1).max(100),
});

// POST /api/report (reportedPublicUserId: opaque id)
export const reportSchema = z.object({
  reportedPublicUserId: z.string().length(24).regex(/^[a-f0-9]+$/),
  description: z.string().max(500).transform((s) => s.trim()).pipe(z.string().min(1)),
});

// POST /api/admin/broadcast (optional bitmaps for Chinese/any language, same as poke)
export const adminBroadcastSchema = z.object({
  text: z.string().min(1).max(100),
  senderBitmap: z.string().optional(),
  senderBitmapWidth: z.number().int().positive().optional(),
  textBitmap: z.string().optional(),
  textBitmapWidth: z.number().int().positive().optional(),
});

// DELETE /api/friends/:userId (param value is publicUserId, opaque hex)
export const friendUserIdParamSchema = z.object({
  userId: z.string().length(24).regex(/^[a-f0-9]+$/),
});

// Admin path params (validate to avoid malformed IDs)
export const adminUserIdParamSchema = z.object({
  userId: z.string().min(1).max(256).regex(/^[a-zA-Z0-9@._+-]+$/),
});
export const adminDeviceIdParamSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/),
});
export const adminReportIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/),
});

// DELETE /api/claim/:token (opaque poke token, not raw device id)
export const claimTokenParamSchema = z.object({
  token: pokeTokenSchema,
});
