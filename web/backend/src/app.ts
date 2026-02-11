// ---------------------------------------------------------------------------
//  Main Express app -- middleware wiring and route mounting
// ---------------------------------------------------------------------------

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import {
  FRONTEND_URL,
  SESSION_SECRET,
  IS_LOCAL_DEV,
  SESSION_MAX_AGE,
  API_RATE_LIMIT,
} from './config';
import { SQLiteSessionStore } from './db';
import { setupAuth } from './auth';
import { helmetMiddleware, csrfOriginCheck } from './middleware/security';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth.routes';
import deviceRoutes from './routes/device.routes';
import libraryRoutes from './routes/library.routes';
import healthRoutes from './routes/health.routes';

const app = express();

// ---------------------------------------------------------------------------
//  Core middleware
// ---------------------------------------------------------------------------

app.set('trust proxy', 1); // trust Cloudflare / reverse proxy

// Security headers (helmet)
app.use(helmetMiddleware);

// CORS
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// Body parsing
app.use(express.json());

// ---------------------------------------------------------------------------
//  Rate limiting (general API -- library has its own in library.routes.ts)
// ---------------------------------------------------------------------------

const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT.windowMs,
  max: API_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => req.originalUrl?.startsWith('/api/library') === true,
});
app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------------
//  Session (SQLite-backed store)
// ---------------------------------------------------------------------------

export const sessionMiddleware = session({
  store: new SQLiteSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: !IS_LOCAL_DEV,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
  },
});

app.use(sessionMiddleware);

// ---------------------------------------------------------------------------
//  Passport (Google OAuth)
// ---------------------------------------------------------------------------

app.use(passport.initialize());
app.use(passport.session());
setupAuth(passport);

// ---------------------------------------------------------------------------
//  CSRF origin check (after session/passport so user info is available)
// ---------------------------------------------------------------------------

app.use(csrfOriginCheck);

// ---------------------------------------------------------------------------
//  Routes
// ---------------------------------------------------------------------------

app.use('/auth', authRoutes);
app.use('/api', deviceRoutes);
app.use('/api/library', libraryRoutes);
app.use('/health', healthRoutes);

// ---------------------------------------------------------------------------
//  Global error handler (must be last)
// ---------------------------------------------------------------------------

app.use(errorHandler);

export default app;
