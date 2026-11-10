// ---------------------------------------------------------------------------
//  Client IP resolution -- one case per deployment topology
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'http';
import {
  DEFAULT_TRUST_PROXY,
  compileTrust,
  parseTrustProxy,
  resolveClientIp,
} from '../src/clientIp';

// Addresses used below
const CLIENT = '203.0.113.9'; // real visitor (public)
const SPOOF = '1.2.3.4'; // value a visitor writes into X-Forwarded-For
const NGINX = '172.21.0.5'; // frontend nginx container
const DOCKER_GW = '172.21.0.1'; // host -> container via published port
const CF_EDGE = '162.158.10.20'; // Cloudflare edge (public)

function req(remoteAddress: string, xff?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  const socket = { remoteAddress };
  return { headers, socket, connection: socket } as unknown as IncomingMessage;
}

const DEFAULT = compileTrust(parseTrustProxy(undefined));

describe('parseTrustProxy', () => {
  it('defaults to loopback + private ranges when unset or blank', () => {
    assert.deepEqual(parseTrustProxy(undefined), DEFAULT_TRUST_PROXY);
    assert.deepEqual(parseTrustProxy('   '), DEFAULT_TRUST_PROXY);
  });

  it('parses booleans and hop counts', () => {
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('FALSE'), false);
    assert.equal(parseTrustProxy('2'), 2);
  });

  it('parses a comma-separated list of addresses, CIDRs and named ranges', () => {
    assert.deepEqual(parseTrustProxy(' loopback, 10.0.0.0/8 ,162.158.0.0/15 '), [
      'loopback',
      '10.0.0.0/8',
      '162.158.0.0/15',
    ]);
  });

  it('rejects an invalid entry at startup instead of silently trusting nothing', () => {
    assert.throws(() => parseTrustProxy('loopback, not-an-ip'));
  });
});

describe('resolveClientIp with the default policy', () => {
  it('Cloudflare Tunnel -> nginx -> backend (cloudflared on the host)', () => {
    // cloudflared sends XFF=client; nginx appends the Docker gateway it saw
    assert.equal(resolveClientIp(req(NGINX, `${CLIENT}, ${DOCKER_GW}`), DEFAULT), CLIENT);
  });

  it('Cloudflare Tunnel: a spoofed X-Forwarded-For is ignored', () => {
    // Cloudflare appends the real client after whatever the visitor sent
    assert.equal(
      resolveClientIp(req(NGINX, `${SPOOF}, ${CLIENT}, ${DOCKER_GW}`), DEFAULT),
      CLIENT
    );
  });

  it('Cloudflare Tunnel straight to the admin port (no nginx)', () => {
    assert.equal(resolveClientIp(req(DOCKER_GW, CLIENT), DEFAULT), CLIENT);
  });

  it('frontend port exposed directly: nginx sees the client itself', () => {
    assert.equal(resolveClientIp(req(NGINX, CLIENT), DEFAULT), CLIENT);
  });

  it('frontend port exposed directly: a spoofed X-Forwarded-For is ignored', () => {
    assert.equal(resolveClientIp(req(NGINX, `${SPOOF}, ${CLIENT}`), DEFAULT), CLIENT);
  });

  it('backend reached directly from the internet: headers are not trusted', () => {
    assert.equal(resolveClientIp(req(CLIENT, SPOOF), DEFAULT), CLIENT);
  });

  it('no proxy headers at all: socket address', () => {
    assert.equal(resolveClientIp(req(CLIENT), DEFAULT), CLIENT);
  });

  it('IPv4-mapped IPv6 proxy addresses are still recognised as private', () => {
    assert.equal(
      resolveClientIp(req(`::ffff:${NGINX}`, `${CLIENT}, ${DOCKER_GW}`), DEFAULT),
      CLIENT
    );
  });

  it('missing socket address returns an empty string', () => {
    assert.equal(resolveClientIp(req(''), DEFAULT), '');
  });

  it('public proxy in front (Cloudflare DNS proxy to origin) yields the proxy, not the client', () => {
    // Documented limitation: such proxies must be listed in TRUST_PROXY
    assert.equal(resolveClientIp(req(NGINX, `${CLIENT}, ${CF_EDGE}`), DEFAULT), CF_EDGE);
  });
});

describe('resolveClientIp with explicit TRUST_PROXY values', () => {
  it('listing the public proxy range recovers the client', () => {
    const trust = compileTrust(parseTrustProxy('loopback, linklocal, uniquelocal, 162.158.0.0/15'));
    assert.equal(resolveClientIp(req(NGINX, `${SPOOF}, ${CLIENT}, ${CF_EDGE}`), trust), CLIENT);
  });

  it('hop count trusts exactly that many proxies', () => {
    const trust = compileTrust(parseTrustProxy('2'));
    assert.equal(resolveClientIp(req(NGINX, `${SPOOF}, ${CLIENT}, ${DOCKER_GW}`), trust), CLIENT);
  });

  it('a hop count of 1 behind nginx + cloudflared returns the Docker gateway (the old bug)', () => {
    const trust = compileTrust(parseTrustProxy('1'));
    assert.equal(resolveClientIp(req(NGINX, `${CLIENT}, ${DOCKER_GW}`), trust), DOCKER_GW);
  });

  it('false ignores X-Forwarded-For entirely', () => {
    const trust = compileTrust(parseTrustProxy('false'));
    assert.equal(resolveClientIp(req(NGINX, `${CLIENT}, ${DOCKER_GW}`), trust), NGINX);
  });

  it('true takes the left-most entry, which the client controls', () => {
    const trust = compileTrust(parseTrustProxy('true'));
    assert.equal(resolveClientIp(req(NGINX, `${SPOOF}, ${CLIENT}`), trust), SPOOF);
  });
});
