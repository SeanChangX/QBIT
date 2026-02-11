// ---------------------------------------------------------------------------
//  Admin Express app -- separate session, routes, static serving
// ---------------------------------------------------------------------------

import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import {
  ADMIN_SESSION_SECRET,
  ADMIN_SESSION_MAX_AGE,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  IS_LOCAL_DEV,
} from './config';
import { SQLiteSessionStore } from './db';
import { helmetMiddleware } from './middleware/security';
import { errorHandler } from './middleware/errorHandler';
import adminRoutes from './routes/admin.routes';
import logger from './logger';

const adminApp = express();

// ---------------------------------------------------------------------------
//  Core middleware
// ---------------------------------------------------------------------------

adminApp.set('trust proxy', 1);
adminApp.use(helmetMiddleware);
adminApp.use(express.json());

// ---------------------------------------------------------------------------
//  Session (SQLite-backed, separate cookie name)
// ---------------------------------------------------------------------------

adminApp.use(
  session({
    store: new SQLiteSessionStore(),
    secret: ADMIN_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'qbit_admin_sid',
    cookie: {
      httpOnly: true,
      secure: !IS_LOCAL_DEV,
      sameSite: 'lax',
      maxAge: ADMIN_SESSION_MAX_AGE,
    },
  })
);

// ---------------------------------------------------------------------------
//  Startup warning if admin auth is disabled
// ---------------------------------------------------------------------------

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  logger.warn('ADMIN_USERNAME / ADMIN_PASSWORD not set -- admin API is unprotected');
}

// ---------------------------------------------------------------------------
//  Routes
// ---------------------------------------------------------------------------

// Admin API routes (login, logout, sessions, users, devices, bans, claims)
adminApp.use('/api', adminRoutes);

// ---------------------------------------------------------------------------
//  Static files (admin UI built by Vite)
// ---------------------------------------------------------------------------

const adminStaticDir = path.join(__dirname, '..', 'static', 'admin');
if (fs.existsSync(adminStaticDir)) {
  adminApp.use(express.static(adminStaticDir));
  adminApp.get('*', (_req, res) => {
    res.sendFile(path.join(adminStaticDir, 'index.html'));
  });
} else {
  adminApp.get('/', (_req, res) => {
    res.send('<p>Admin UI not built. Build the admin app and place output in backend/static/admin.</p>');
  });
}

// ---------------------------------------------------------------------------
//  Global error handler
// ---------------------------------------------------------------------------

adminApp.use(errorHandler);

export default adminApp;
