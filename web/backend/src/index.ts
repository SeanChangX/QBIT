// ==========================================================================
//  QBIT Backend -- Entry point
// ==========================================================================
//  This file creates the HTTP servers, wires up WebSocket and Socket.io,
//  and handles graceful shutdown.  All route / middleware logic lives in
//  app.ts, adminApp.ts, and their imported modules.
// ==========================================================================

import { createServer } from 'http';
import { PORT, ADMIN_PORT, ADMIN_HOST } from './config';
import app, { sessionMiddleware } from './app';
import adminApp from './adminApp';
import * as deviceService from './services/device.service';
import * as socketService from './services/socket.service';
import db from './db';
import logger from './logger';

// ---------------------------------------------------------------------------
//  HTTP servers
// ---------------------------------------------------------------------------

const httpServer = createServer(app);
const adminHttpServer = createServer(adminApp);

// ---------------------------------------------------------------------------
//  Device WebSocket server (attaches to httpServer upgrade event)
// ---------------------------------------------------------------------------

deviceService.setupWebSocketServer(httpServer);

// ---------------------------------------------------------------------------
//  Socket.io (frontend real-time updates)
// ---------------------------------------------------------------------------

socketService.setupSocketIo(httpServer, sessionMiddleware);

// ---------------------------------------------------------------------------
//  Start servers
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'QBIT backend listening');
});

adminHttpServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  logger.info({ port: ADMIN_PORT, host: ADMIN_HOST }, 'Admin server listening');
});

// ---------------------------------------------------------------------------
//  Graceful shutdown
// ---------------------------------------------------------------------------

let shutdownInProgress = false;

function shutdown(signal: string): void {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  // 1. Stop accepting new connections
  httpServer.close(() => {
    logger.info('Main HTTP server closed');
  });
  adminHttpServer.close(() => {
    logger.info('Admin HTTP server closed');
  });

  // 2. Close all device WebSocket connections
  deviceService.closeAll();

  // 3. Close Socket.io
  const io = socketService.getIo();
  if (io) {
    io.close(() => {
      logger.info('Socket.io closed');
    });
  }

  // 4. Close SQLite database
  try {
    db.close();
    logger.info('SQLite database closed');
  } catch {
    // already closed or error -- ignore
  }

  // Give a short window for pending responses, then exit
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
