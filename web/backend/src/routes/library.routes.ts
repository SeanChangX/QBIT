// ---------------------------------------------------------------------------
//  Library routes -- /api/library/*
// ---------------------------------------------------------------------------

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate';
import { libraryBatchSchema } from '../schemas';
import { LIBRARY_RATE_LIMIT, MAX_QGIF_SIZE } from '../config';
import * as libraryService from '../services/library.service';
import logger from '../logger';
import type { AppUser } from '../types';

const router = Router();

// Rate limit specifically for library endpoints
const libraryLimiter = rateLimit({
  windowMs: LIBRARY_RATE_LIMIT.windowMs,
  max: LIBRARY_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
router.use(libraryLimiter);

// Multer: store in memory for validation before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_QGIF_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.qgif')) {
      cb(null, true);
    } else {
      cb(new Error('Only .qgif files are accepted'));
    }
  },
});

// GET /api/library -- list all items
router.get('/', (_req, res) => {
  res.json(libraryService.getAll());
});

// POST /api/library/upload -- upload a .qgif file
router.post('/upload', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to upload' });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const buf = req.file.buffer;

    // Validate .qgif header (5 bytes minimum)
    if (buf.length < 5) {
      return res.status(400).json({ error: 'File too small' });
    }

    const frameCount = buf[0];
    const width = buf[1] | (buf[2] << 8);
    const height = buf[3] | (buf[4] << 8);

    if (frameCount === 0 || width !== 128 || height !== 64) {
      return res.status(400).json({ error: 'Invalid .qgif format' });
    }

    // Verify expected file size: header(5) + delays(fc*2) + frames(fc*1024)
    const expectedSize = 5 + frameCount * 2 + frameCount * 1024;
    if (buf.length < expectedSize) {
      return res.status(400).json({ error: 'File is truncated' });
    }

    const user = req.user as AppUser;
    const item = libraryService.addItem(buf, req.file.originalname, user.displayName || 'Unknown', user.id, frameCount);
    res.json(item);
  });
});

// DELETE /api/library/batch -- batch delete (must be before /:id to avoid matching "batch")
router.delete('/batch', validate(libraryBatchSchema), (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const user = req.user as AppUser;
  const { ids } = req.body;
  const result = libraryService.batchDelete(ids, user.id);
  res.json({ ok: true, ...result });
});

// POST /api/library/batch-download -- zip download
router.post('/batch-download', validate(libraryBatchSchema), (req, res) => {
  const { ids } = req.body;
  const filesToZip: { filename: string; filepath: string }[] = [];

  for (const id of ids) {
    const item = libraryService.getById(id);
    if (!item) continue;
    const filePath = libraryService.getFilePath(id);
    if (fs.existsSync(filePath)) {
      filesToZip.push({ filename: item.filename, filepath: filePath });
    }
  }

  if (filesToZip.length === 0) {
    return res.status(404).json({ error: 'No files found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="qgif-library.zip"');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);
  for (const f of filesToZip) {
    // Sanitize filename: only keep basename to prevent zip-slip
    const safeName = path.basename(f.filename);
    archive.file(f.filepath, { name: safeName });
  }
  archive.finalize();
});

// GET /api/library/:id/download -- download with Content-Disposition
router.get('/:id/download', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const filePath = libraryService.getFilePath(item.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  // Sanitised Content-Disposition to avoid header injection
  res.setHeader('Content-Disposition', libraryService.contentDisposition(item.filename));
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/library/:id/raw -- raw bytes for canvas renderer
router.get('/:id/raw', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const filePath = libraryService.getFilePath(item.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/library/:id -- delete a single item (own uploads only)
router.delete('/:id', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const user = req.user as AppUser;
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  if (item.uploaderId !== user.id) {
    return res.status(403).json({ error: 'You can only delete your own uploads' });
  }

  libraryService.deleteItem(req.params.id);
  res.json({ ok: true });
});

export default router;
