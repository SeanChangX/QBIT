// ---------------------------------------------------------------------------
//  Library service -- SQLite-backed with in-memory Map for O(1) lookups
// ---------------------------------------------------------------------------

import db from '../db';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LIBRARY_DIR } from '../config';
import logger from '../logger';
import type { LibraryItem } from '../types';

const LIBRARY_FILES = path.join(LIBRARY_DIR, 'files');
fs.mkdirSync(LIBRARY_FILES, { recursive: true });

// Prepared statements
const stmtAll = db.prepare('SELECT * FROM library ORDER BY uploadedAt DESC');
const stmtInsert = db.prepare(
  'INSERT INTO library (id, filename, uploader, uploaderId, uploadedAt, size, frameCount) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const stmtDelete = db.prepare('DELETE FROM library WHERE id = ?');
const stmtGetById = db.prepare('SELECT * FROM library WHERE id = ?');

// ---------------------------------------------------------------------------
//  In-memory cache (Map<id, LibraryItem>)
// ---------------------------------------------------------------------------

const cache = new Map<string, LibraryItem>();

function loadCache(): void {
  cache.clear();
  const rows = stmtAll.all() as LibraryItem[];
  for (const row of rows) {
    cache.set(row.id, row);
  }
  logger.info({ count: cache.size }, 'Library cache loaded');
}

loadCache();

// ---------------------------------------------------------------------------
//  Filename sanitisation for Content-Disposition headers
// ---------------------------------------------------------------------------

/**
 * Sanitise a filename for use in Content-Disposition.
 * Strips control characters and problematic ASCII, then produces an
 * RFC-5987-encoded filename* for full Unicode support.
 */
export function sanitizeFilename(raw: string): { ascii: string; encoded: string } {
  // Remove control chars, quotes, backslashes, path separators
  const safe = raw.replace(/[\x00-\x1f"\\/:*?<>|]/g, '_');
  // ASCII-only fallback (replace non-ASCII with _)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  // RFC 5987 percent-encode
  const encoded = encodeURIComponent(safe).replace(/'/g, '%27');
  return { ascii, encoded };
}

/**
 * Build a full Content-Disposition header value for file download.
 */
export function contentDisposition(filename: string): string {
  const { ascii, encoded } = sanitizeFilename(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

export function getAll(): LibraryItem[] {
  return [...cache.values()];
}

export function getById(id: string): LibraryItem | null {
  return cache.get(id) ?? null;
}

export function getFilePath(id: string): string {
  return path.join(LIBRARY_FILES, `${id}.qgif`);
}

export function fileExists(id: string): boolean {
  return fs.existsSync(getFilePath(id));
}

export function addItem(
  buf: Buffer,
  originalFilename: string,
  uploader: string,
  uploaderId: string,
  frameCount: number
): LibraryItem {
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(getFilePath(id), buf);

  const item: LibraryItem = {
    id,
    filename: originalFilename,
    uploader,
    uploaderId,
    uploadedAt: new Date().toISOString(),
    size: buf.length,
    frameCount,
  };

  stmtInsert.run(item.id, item.filename, item.uploader, item.uploaderId, item.uploadedAt, item.size, item.frameCount);
  cache.set(id, item);

  logger.info({ id, filename: item.filename, uploader: item.uploader }, 'Library item added');
  return item;
}

export function deleteItem(id: string): boolean {
  const item = cache.get(id);
  if (!item) return false;

  try {
    fs.unlinkSync(getFilePath(id));
  } catch {
    // file already gone, continue
  }

  stmtDelete.run(id);
  cache.delete(id);
  return true;
}

export function batchDelete(ids: string[], userId: string): { deleted: number; failed: number } {
  let deleted = 0;
  let failed = 0;

  const tx = db.transaction(() => {
    for (const id of ids) {
      const item = cache.get(id);
      if (!item || item.uploaderId !== userId) {
        failed++;
        continue;
      }

      try {
        fs.unlinkSync(getFilePath(id));
      } catch {
        // ignore
      }

      stmtDelete.run(id);
      cache.delete(id);
      deleted++;
    }
  });
  tx();

  return { deleted, failed };
}

/**
 * Reloads from DB -- useful if needed after external changes.
 * Not typically called at runtime.
 */
export function reload(): void {
  loadCache();
}
