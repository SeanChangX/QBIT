// ---------------------------------------------------------------------------
//  Security middleware -- helmet + CSRF origin check
// ---------------------------------------------------------------------------

import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { FRONTEND_URL } from '../config';
import logger from '../logger';

// ---------------------------------------------------------------------------
//  Helmet configuration
// ---------------------------------------------------------------------------
// Default helmet() sets X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, X-XSS-Protection, etc.
// We customise CSP to allow Google avatar images and inline styles for React.

export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // avoid breaking Google avatar images
});

// ---------------------------------------------------------------------------
//  CSRF origin-check middleware
// ---------------------------------------------------------------------------
// For state-changing requests (POST / PUT / DELETE / PATCH), verify that
// the Origin or Referer header matches FRONTEND_URL.
// This prevents cross-site form submissions while allowing same-origin
// requests from the frontend.

const allowedOrigin = new URL(FRONTEND_URL).origin;

export function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
  // Only check state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Allow requests with no origin (e.g. server-to-server, same-origin
  // navigations in some browsers, curl/Postman in dev).  The session
  // cookie's SameSite=lax already blocks cross-site cookie attachment
  // for POST, so this is an additional layer.
  if (!origin && !referer) {
    next();
    return;
  }

  const requestOrigin = origin || (referer ? new URL(referer).origin : '');

  if (requestOrigin === allowedOrigin) {
    next();
    return;
  }

  logger.warn({ origin, referer, path: req.path }, 'CSRF origin check failed');
  res.status(403).json({ error: 'Forbidden: origin mismatch' });
}
