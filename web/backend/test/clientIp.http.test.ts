// ---------------------------------------------------------------------------
//  Client IP end-to-end: Express req.ip, express-rate-limit and the IP ban
//  middleware behave per real client behind nginx + cloudflared
// ---------------------------------------------------------------------------
// Requests come from 127.0.0.1 (a trusted proxy) carrying the X-Forwarded-For
// chain that nginx forwards in a Cloudflare Tunnel deployment.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import rateLimit from 'express-rate-limit';

const CLIENT_A = '203.0.113.9';
const CLIENT_B = '198.51.100.7';
const SPOOF = '1.2.3.4';
const DOCKER_GW = '172.21.0.1';

// config.ts / db.ts write to LIBRARY_DIR on import -- keep them in a temp dir
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-test-'));
process.env.LIBRARY_DIR = dataDir;
delete process.env.TRUST_PROXY;

let server: http.Server;
let port: number;
let banService: typeof import('../src/services/ban.service');

function get(
  urlPath: string,
  xff: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.get(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        headers: { 'x-forwarded-for': xff, ...extraHeaders },
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    r.on('error', reject);
  });
}

// What nginx forwards for a visitor coming through cloudflared
const viaTunnel = (client: string, spoofed?: string) =>
  [spoofed, client, DOCKER_GW].filter(Boolean).join(', ');

before(async () => {
  const { TRUST_PROXY_FN } = await import('../src/config');
  const { resolveClientIp } = await import('../src/clientIp');
  const { requireNotBanned } = await import('../src/middleware/requireNotBanned');
  banService = await import('../src/services/ban.service');

  const app = express();
  app.set('trust proxy', TRUST_PROXY_FN);

  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip, wsIp: resolveClientIp(req, TRUST_PROXY_FN), secure: req.secure });
  });

  const limiter = rateLimit({ windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false });
  app.get('/limited', limiter, (_req, res) => {
    res.json({ ok: true });
  });

  // Stand-in for passport: every request is the same logged-in user, so only
  // the IP decides whether requireNotBanned lets it through
  app.get(
    '/protected',
    (req, _res, next) => {
      Object.assign(req, { isAuthenticated: () => true, user: { id: 'user-1' } });
      next();
    },
    requireNotBanned,
    (_req, res) => {
      res.json({ ok: true });
    }
  );

  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server?.closeAllConnections();
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Express and WebSocket paths agree on the client IP', () => {
  it('req.ip and the WebSocket resolver both return the visitor', async () => {
    const res = await get('/whoami', viaTunnel(CLIENT_A, SPOOF));
    const body = JSON.parse(res.body);
    assert.equal(body.ip, CLIENT_A);
    assert.equal(body.wsIp, CLIENT_A);
  });
});

describe('HTTPS detection behind the proxy (secure session cookies)', () => {
  it('honours X-Forwarded-Proto from the trusted proxy', async () => {
    const res = await get('/whoami', viaTunnel(CLIENT_A), { 'x-forwarded-proto': 'https' });
    assert.equal(JSON.parse(res.body).secure, true);
  });
});

describe('rate limiting is per client, not shared by everyone', () => {
  it('limits client A without affecting client B, and spoofing does not reset it', async () => {
    assert.equal((await get('/limited', viaTunnel(CLIENT_A))).status, 200);
    assert.equal((await get('/limited', viaTunnel(CLIENT_A))).status, 200);
    assert.equal((await get('/limited', viaTunnel(CLIENT_A))).status, 429);
    assert.equal((await get('/limited', viaTunnel(CLIENT_A, SPOOF))).status, 429);
    assert.equal((await get('/limited', viaTunnel(CLIENT_B))).status, 200);
  });
});

describe('IP bans apply to the REST API', () => {
  it('blocks the banned IP, even with a spoofed header, and lets others through', async () => {
    banService.addBan(undefined, CLIENT_A);
    try {
      assert.equal((await get('/protected', viaTunnel(CLIENT_A))).status, 403);
      assert.equal((await get('/protected', viaTunnel(CLIENT_A, SPOOF))).status, 403);
      assert.equal((await get('/protected', viaTunnel(CLIENT_B))).status, 200);
    } finally {
      banService.removeBan(undefined, CLIENT_A);
    }
    assert.equal((await get('/protected', viaTunnel(CLIENT_A))).status, 200);
  });

  it('banning the spoofed address does not block the real client', async () => {
    banService.addBan(undefined, SPOOF);
    try {
      assert.equal((await get('/protected', viaTunnel(CLIENT_B, SPOOF))).status, 200);
    } finally {
      banService.removeBan(undefined, SPOOF);
    }
  });
});
