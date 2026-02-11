// ---------------------------------------------------------------------------
//  Centralised configuration -- all environment variables read here
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// ---- Main app ----
export const PORT = parseInt(process.env.PORT || '3001', 10);
export const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3002', 10);
export const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';

export const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qbit.labxcloud.com';
export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '.labxcloud.com';
export const IS_LOCAL_DEV = COOKIE_DOMAIN === 'localhost';

// ---- Data / library ----
export const LIBRARY_DIR = process.env.LIBRARY_DIR || '/data';

// ---------------------------------------------------------------------------
//  Auto-managed secrets
// ---------------------------------------------------------------------------
// SESSION_SECRET, ADMIN_SESSION_SECRET, and HEALTH_SECRET can be set via
// environment variables.  If not set, they are auto-generated on first
// startup and persisted to /data/secrets.json so they survive restarts
// (keeping existing session cookies valid).
//
// Operators only need to configure these explicitly if they want a
// specific value or are running multiple replicas that must share the
// same secret.

interface PersistedSecrets {
  sessionSecret?: string;
  adminSessionSecret?: string;
  healthSecret?: string;
}

const SECRETS_PATH = path.join(LIBRARY_DIR, 'secrets.json');

function loadPersistedSecrets(): PersistedSecrets {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function savePersistedSecrets(secrets: PersistedSecrets): void {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

function resolveSecret(envValue: string | undefined, persistedValue: string | undefined, label: string): { value: string; source: string } {
  // 1. Env var takes priority
  if (envValue) {
    return { value: envValue, source: 'env' };
  }
  // 2. Previously persisted value
  if (persistedValue) {
    return { value: persistedValue, source: 'persisted' };
  }
  // 3. Generate new
  const generated = crypto.randomBytes(32).toString('hex');
  // eslint-disable-next-line no-console
  console.log(`[config] Auto-generated ${label} (persisted to secrets.json)`);
  return { value: generated, source: 'generated' };
}

// Resolve all three secrets
const persisted = loadPersistedSecrets();

const sessionResult = resolveSecret(process.env.SESSION_SECRET, persisted.sessionSecret, 'SESSION_SECRET');
const adminSessionResult = resolveSecret(
  process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET,
  persisted.adminSessionSecret,
  'ADMIN_SESSION_SECRET'
);
const healthResult = resolveSecret(process.env.HEALTH_SECRET, persisted.healthSecret, 'HEALTH_SECRET');

// Persist any newly generated values back to disk
if (sessionResult.source === 'generated' || adminSessionResult.source === 'generated' || healthResult.source === 'generated') {
  savePersistedSecrets({
    sessionSecret: sessionResult.value,
    adminSessionSecret: adminSessionResult.value,
    healthSecret: healthResult.value,
  });
}

export const SESSION_SECRET = sessionResult.value;
export const ADMIN_SESSION_SECRET = adminSessionResult.value;
export const HEALTH_SECRET = healthResult.value;

// ---- Admin credentials ----
export const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
export const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();

// ---- Device WebSocket ----
export const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';
export const MAX_DEVICE_CONNECTIONS = parseInt(process.env.MAX_DEVICE_CONNECTIONS || '100', 10);

// ---- Limits ----
export const MAX_QGIF_SIZE = 512 * 1024; // 512 KB per file
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ADMIN_SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// ---- Rate limiting ----
export const API_RATE_LIMIT = { windowMs: 1 * 60 * 1000, max: 60 };
export const LIBRARY_RATE_LIMIT = { windowMs: 1 * 60 * 1000, max: 300 };
export const AUTH_RATE_LIMIT = { windowMs: 5 * 60 * 1000, max: 15 };
export const ADMIN_LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 20 };

// ---- Misc ----
export const FAILED_LOGIN_DELAY_MS = 800;
export const ADMIN_USERNAME_MAX_LEN = 64;
export const ADMIN_PASSWORD_MIN_LEN = 8;
export const ADMIN_PASSWORD_MAX_LEN = 128;

export { NODE_ENV, isProduction };
