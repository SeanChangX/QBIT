// ---------------------------------------------------------------------------
//  Client IP resolution behind reverse proxies
// ---------------------------------------------------------------------------
// One trust policy is shared by Express (req.ip, rate limiters, ban checks)
// and the raw WebSocket / Socket.io upgrade requests, so every code path sees
// the same client address.
//
// X-Forwarded-For is walked from right to left and the first address that is
// NOT a trusted proxy is the client. Entries a client puts in the header
// itself sit further left and are never reached, so they cannot be spoofed.
//
// Default: trust loopback and private ranges (Docker networks, a reverse
// proxy or cloudflared on the same host / LAN). Deployments where the backend
// sees a public proxy address (e.g. Cloudflare proxied DNS straight to the
// origin, a cloud load balancer) must add that proxy's ranges via TRUST_PROXY.

import type { IncomingMessage } from 'http';
import proxyaddr from 'proxy-addr';

export type TrustProxySetting = boolean | number | string[];
export type TrustFn = (addr: string, hop: number) => boolean;

export const DEFAULT_TRUST_PROXY = ['loopback', 'linklocal', 'uniquelocal'];

/**
 * Parse the TRUST_PROXY environment variable.
 *   unset / empty      -> DEFAULT_TRUST_PROXY
 *   "true" / "false"   -> trust every / no proxy
 *   "2"                -> trust that many hops in front of the backend
 *   "a, b/24, loopback" -> trust these addresses, CIDRs or named ranges
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_TRUST_PROXY;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  proxyaddr.compile(list); // throws on an invalid address / range
  return list;
}

/** Same semantics as Express's own 'trust proxy' compilation. */
export function compileTrust(setting: TrustProxySetting): TrustFn {
  if (typeof setting === 'boolean') return () => setting;
  if (typeof setting === 'number') return (_addr, hop) => hop < setting;
  return proxyaddr.compile(setting);
}

/** Client address for a raw Node request (WebSocket / Socket.io handshake). */
export function resolveClientIp(req: IncomingMessage, trust: TrustFn): string {
  if (!req.socket?.remoteAddress) return '';
  return proxyaddr(req, trust);
}
