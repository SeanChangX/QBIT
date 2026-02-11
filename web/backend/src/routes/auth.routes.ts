// ---------------------------------------------------------------------------
//  Auth routes -- Google OAuth
// ---------------------------------------------------------------------------

import { Router } from 'express';
import passport from 'passport';
import rateLimit from 'express-rate-limit';
import { FRONTEND_URL, AUTH_RATE_LIMIT } from '../config';
import { isBanned } from '../services/ban.service';
import logger from '../logger';
import type { AppUser } from '../types';

const router = Router();

const authLimiter = rateLimit({
  windowMs: AUTH_RATE_LIMIT.windowMs,
  max: AUTH_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

const oauthConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// GET /auth/google -- start OAuth flow
router.get('/google', authLimiter, (req, res, next) => {
  if (!oauthConfigured) {
    return res.status(503).json({ error: 'Google OAuth is not configured' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// GET /auth/google/callback -- OAuth callback
router.get('/google/callback', (req, res, next) => {
  if (!oauthConfigured) {
    return res.redirect(FRONTEND_URL);
  }
  passport.authenticate('google', (err: Error | null, user: AppUser | false) => {
    if (err) return next(err);
    if (!user) return res.redirect(FRONTEND_URL);

    const clientIp = req.ip || req.socket?.remoteAddress || '';
    if (isBanned(user.id, clientIp)) {
      logger.info({ userId: user.id, ip: clientIp }, 'Banned user attempted login');
      return res.redirect(FRONTEND_URL + '?banned=1');
    }

    req.logIn(user, (loginErr: Error | undefined) => {
      if (loginErr) return next(loginErr);
      res.redirect(FRONTEND_URL);
    });
  })(req, res, next);
});

// GET /auth/me -- current user info
router.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json(req.user as AppUser);
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect(FRONTEND_URL);
  });
});

export default router;
