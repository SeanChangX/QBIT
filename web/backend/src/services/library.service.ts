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

type LibraryItemInternal = LibraryItem & { contentHash?: string };

const LIBRARY_FILES = path.join(LIBRARY_DIR, 'files');
fs.mkdirSync(LIBRARY_FILES, { recursive: true });

// Prepared statements
const stmtAll = db.prepare('SELECT * FROM library ORDER BY uploadedAt DESC');
const stmtInsert = db.prepare(
  'INSERT INTO library (id, filename, uploader, uploaderId, uploadedAt, size, frameCount, downloadCount, contentHash) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
);
const stmtGetByContentHash = db.prepare('SELECT id FROM library WHERE contentHash = ? LIMIT 1');
const stmtUpdateContentHash = db.prepare('UPDATE library SET contentHash = ? WHERE id = ?');
const stmtDelete = db.prepare('DELETE FROM library WHERE id = ?');
const stmtDeleteStars = db.prepare('DELETE FROM library_stars WHERE libraryId = ?');
const stmtGetById = db.prepare('SELECT * FROM library WHERE id = ?');
const stmtIncrementDownload = db.prepare('UPDATE library SET downloadCount = COALESCE(downloadCount, 0) + 1 WHERE id = ?');
const stmtStarCounts = db.prepare('SELECT libraryId, COUNT(*) as cnt FROM library_stars GROUP BY libraryId');
const stmtStarGet = db.prepare('SELECT 1 FROM library_stars WHERE userId = ? AND libraryId = ?');
const stmtStarInsertOrIgnore = db.prepare(
  'INSERT OR IGNORE INTO library_stars (userId, libraryId) VALUES (?, ?)'
);
const stmtStarRemove = db.prepare('DELETE FROM library_stars WHERE userId = ? AND libraryId = ?');

// ---------------------------------------------------------------------------
//  In-memory cache (Map<id, LibraryItem>) and backfill queue
// ---------------------------------------------------------------------------

const cache = new Map<string, LibraryItemInternal>();
const backfillQueue: LibraryItemInternal[] = [];

/** True only after UNIQUE index on contentHash exists; uploads are rejected with 503 until then to avoid race duplicates. */
let uniqueIndexReady = false;
/** Last time we ran DDL for UNIQUE index; used to cooldown retries from upload path. */
let lastUniqueIndexRetryAt = 0;
const UNIQUE_INDEX_RETRY_COOLDOWN_MS = 60_000; // 60s between DDL attempts from upload path

function loadCache(): void {
  cache.clear();
  backfillQueue.length = 0;
  const rows = stmtAll.all() as Record<string, unknown>[];
  for (const row of rows) {
    const item: LibraryItemInternal = {
      id: row.id as string,
      filename: row.filename as string,
      uploader: row.uploader as string,
      uploaderId: row.uploaderId as string,
      uploadedAt: row.uploadedAt as string,
      size: (row.size as number) ?? 0,
      frameCount: (row.frameCount as number) ?? 0,
      downloadCount: (row.downloadCount as number) ?? 0,
      contentHash: row.contentHash as string | undefined,
    };
    cache.set(item.id, item);
    if (!item.contentHash) backfillQueue.push(item);
  }
  logger.info({ count: cache.size, backfill: backfillQueue.length }, 'Library cache loaded');
}

const BACKFILL_CHUNK = 50;
const BACKFILL_DELAY_MS = 10;

function runBackfillChunk(): void {
  if (backfillQueue.length === 0) {
    dedupeLibraryDuplicates();
    ensureUniqueContentHashConstraint();
    return;
  }

  const chunk = backfillQueue.splice(0, BACKFILL_CHUNK);
  for (const item of chunk) {
    const filePath = path.join(LIBRARY_FILES, `${item.id}.qgif`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const buf = fs.readFileSync(filePath);
      const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
      stmtUpdateContentHash.run(contentHash, item.id);
      item.contentHash = contentHash;
    } catch (err) {
      logger.warn({ id: item.id, err }, 'Failed to backfill contentHash');
    }
  }

  setTimeout(runBackfillChunk, BACKFILL_DELAY_MS);
}

function dedupeLibraryDuplicates(): void {
  const byHash = new Map<string, LibraryItemInternal[]>();
  for (const item of cache.values()) {
    if (!item.contentHash) continue;
    const list = byHash.get(item.contentHash) ?? [];
    list.push(item);
    byHash.set(item.contentHash, list);
  }
  let removed = 0;
  for (const list of byHash.values()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
    for (let i = 1; i < list.length; i++) {
      if (deleteItem(list[i].id)) removed++;
    }
  }
  if (removed > 0) logger.info({ removed }, 'Library dedupe: removed duplicate contentHash rows');
}

/** Single index on contentHash: UNIQUE only (legacy non-unique idx_library_contentHash dropped here to avoid dual index). */
function tryCreateUniqueContentHashIndex(): boolean {
  try {
    db.exec('DROP INDEX IF EXISTS idx_library_contentHash');
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_library_contentHash_unique ON library(contentHash)"
    );
    uniqueIndexReady = true;
    logger.info('Library: UNIQUE index on contentHash ready');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Library: UNIQUE index on contentHash not created (e.g. duplicate contentHash in DB)');
    uniqueIndexReady = false;
    return false;
  }
}

function ensureUniqueContentHashConstraint(): void {
  tryCreateUniqueContentHashIndex();
  if (uniqueIndexReady) return;
  // Background retry so we don't run DDL on every upload; interval cleared when index is ready
  const retryMs = 60_000;
  const t = setInterval(() => {
    if (uniqueIndexReady) {
      clearInterval(t);
      return;
    }
    if (tryCreateUniqueContentHashIndex()) clearInterval(t);
  }, retryMs);
  t.unref?.();
}

/** Call from addItem only; respects cooldown to avoid DDL/log flood. */
function tryCreateUniqueContentHashIndexIfCooldown(): boolean {
  if (uniqueIndexReady) return true;
  const now = Date.now();
  if (now - lastUniqueIndexRetryAt < UNIQUE_INDEX_RETRY_COOLDOWN_MS) return false;
  lastUniqueIndexRetryAt = now;
  return tryCreateUniqueContentHashIndex();
}

loadCache();
setImmediate(runBackfillChunk);

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

export type LibrarySort = 'newest' | 'stars' | 'downloads';

export function getAll(sort: LibrarySort = 'stars', userId?: string): LibraryItem[] {
  const starRows = stmtStarCounts.all() as { libraryId: string; cnt: number }[];
  const starCountMap = new Map(starRows.map((r) => [r.libraryId, r.cnt]));
  const starredSet = new Set<string>();
  if (userId) {
    const all = [...cache.values()];
    for (const item of all) {
      if ((stmtStarGet.get(userId, item.id) as unknown) != null) starredSet.add(item.id);
    }
  }
  const items: LibraryItem[] = [...cache.values()].map((item) => {
    const { contentHash: _h, ...rest } = item;
    return {
      ...rest,
      starCount: starCountMap.get(item.id) ?? 0,
      starredByMe: userId ? starredSet.has(item.id) : undefined,
    };
  });
  if (sort === 'newest') {
    items.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  } else if (sort === 'stars') {
    items.sort((a, b) => (b.starCount ?? 0) - (a.starCount ?? 0) || new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  } else {
    items.sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0) || new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  }
  return items;
}

export function incrementDownloadCount(id: string): void {
  const item = cache.get(id);
  if (!item) return;
  stmtIncrementDownload.run(id);
  item.downloadCount = (item.downloadCount ?? 0) + 1;
}

export function toggleStar(userId: string, libraryId: string): boolean {
  const item = cache.get(libraryId);
  if (!item) return false;
  const result = stmtStarInsertOrIgnore.run(userId, libraryId);
  if (result.changes === 1) return true;
  stmtStarRemove.run(userId, libraryId);
  return false;
}

export function getById(id: string): LibraryItem | null {
  const item = cache.get(id);
  if (!item) return null;
  const { contentHash: _h, ...rest } = item;
  return rest as LibraryItem;
}

export function getFilePath(id: string): string {
  return path.join(LIBRARY_FILES, `${id}.qgif`);
}

export function fileExists(id: string): boolean {
  return fs.existsSync(getFilePath(id));
}

/** Thrown when upload content is identical to an existing library file (any user). */
export class DuplicateContentError extends Error {
  constructor() {
    super('Duplicate file content');
    this.name = 'DuplicateContentError';
  }
}

/** Thrown when UNIQUE index on contentHash is not available; uploads disabled to avoid duplicate race. */
export class LibraryUploadUnavailableError extends Error {
  constructor() {
    super('Library upload temporarily unavailable');
    this.name = 'LibraryUploadUnavailableError';
  }
}

function getByContentHash(contentHash: string): LibraryItemInternal | null {
  const row = stmtGetByContentHash.get(contentHash) as { id: string } | undefined;
  if (!row) return null;
  return cache.get(row.id) ?? null;
}

export function addItem(
  buf: Buffer,
  originalFilename: string,
  uploader: string,
  uploaderId: string,
  frameCount: number
): LibraryItem {
  if (!uniqueIndexReady) {
    if (!tryCreateUniqueContentHashIndexIfCooldown()) {
      throw new LibraryUploadUnavailableError();
    }
  }

  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
  if (getByContentHash(contentHash)) {
    throw new DuplicateContentError();
  }

  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(getFilePath(id), buf);

  const item: LibraryItemInternal = {
    id,
    filename: originalFilename,
    uploader,
    uploaderId,
    uploadedAt: new Date().toISOString(),
    size: buf.length,
    frameCount,
    downloadCount: 0,
    contentHash,
  };

  try {
    stmtInsert.run(item.id, item.filename, item.uploader, item.uploaderId, item.uploadedAt, item.size, item.frameCount, contentHash);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    try {
      fs.unlinkSync(getFilePath(id));
    } catch {
      // ignore
    }
    if (code === 'SQLITE_CONSTRAINT') {
      throw new DuplicateContentError();
    }
    throw err;
  }
  cache.set(id, item);

  logger.info({ id, filename: item.filename, uploader: item.uploader }, 'Library item added');
  const { contentHash: _h, ...rest } = item;
  return rest as LibraryItem;
}

export function deleteItem(id: string): boolean {
  const item = cache.get(id);
  if (!item) return false;

  try {
    fs.unlinkSync(getFilePath(id));
  } catch {
    // file already gone, continue
  }

  stmtDeleteStars.run(id);
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

      stmtDeleteStars.run(id);
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
