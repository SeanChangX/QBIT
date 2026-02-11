// ---------------------------------------------------------------------------
//  Zod input-validation schemas for all API endpoints
// ---------------------------------------------------------------------------

import { z } from 'zod';

// POST /api/poke
export const pokeSchema = z.object({
  targetId: z.string().min(1),
  text: z.string().min(1).max(25),
  senderBitmap: z.string().optional(),
  senderBitmapWidth: z.number().int().positive().optional(),
  textBitmap: z.string().optional(),
  textBitmapWidth: z.number().int().positive().optional(),
});

// POST /api/poke/user
export const pokeUserSchema = z.object({
  targetUserId: z.string().min(1),
  text: z.string().min(1).max(25),
});

// POST /api/claim
export const claimSchema = z.object({
  targetId: z.string().min(1),
  deviceIdFull: z.string().min(1),
});

// DELETE /api/library/batch  &  POST /api/library/batch-download
export const libraryBatchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

// POST /api/admin/login
export const adminLoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(128),
});

// POST /api/ban  &  DELETE /api/ban
export const adminBanSchema = z
  .object({
    userId: z.string().optional(),
    ip: z.string().optional(),
    deviceId: z.string().optional(),
  })
  .refine((data) => data.userId || data.ip || data.deviceId, {
    message: 'At least one of userId, ip, or deviceId is required',
  });
