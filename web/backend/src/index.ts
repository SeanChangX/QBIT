import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer, WebSocket } from 'ws';
import session from 'express-session';
import passport from 'passport';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupAuth, AppUser } from './auth';

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3001', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qbit.labxcloud.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'qbit-secret-change-me';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '.labxcloud.com';
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';
const MAX_DEVICE_CONNECTIONS = parseInt(process.env.MAX_DEVICE_CONNECTIONS || '100', 10);

// ---------------------------------------------------------------------------
//  Express app
// ---------------------------------------------------------------------------

const app = express();
const httpServer = createServer(app);

app.set('trust proxy', 1); // trust Cloudflare / reverse proxy

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.use(express.json());

// ---------------------------------------------------------------------------
//  Rate limiting
// ---------------------------------------------------------------------------

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,                  // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15,                  // 15 login attempts per 5 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use('/api/', apiLimiter);
app.use('/auth/', authLimiter);

// ---------------------------------------------------------------------------
//  Sessions
// ---------------------------------------------------------------------------

// Everything is same-origin now (Nginx proxies /api/ and /auth/ on the
// same domain), so 'lax' works for both local dev and production.
// 'secure' is based on trust-proxy detecting HTTPS from X-Forwarded-Proto.
const isLocalDev = COOKIE_DOMAIN === 'localhost';

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: !isLocalDev,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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
//  Socket.io (frontend real-time updates)
// ---------------------------------------------------------------------------

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: FRONTEND_URL,
    credentials: true,
  },
});

// Share session with Socket.io
io.engine.use(sessionMiddleware);

// ---------------------------------------------------------------------------
//  Device state (in-memory)
// ---------------------------------------------------------------------------

interface DeviceState {
  id: string;
  name: string;
  ip: string;
  version: string;
  ws: WebSocket;
  connectedAt: Date;
}

const devices = new Map<string, DeviceState>();

function getDeviceList() {
  return Array.from(devices.values()).map((d) => ({
    id: d.id,
    name: d.name,
    ip: d.ip,
    version: d.version,
    connectedAt: d.connectedAt.toISOString(),
  }));
}

function broadcastDevices() {
  io.emit('devices:update', getDeviceList());
}

// ---------------------------------------------------------------------------
//  WebSocket server for QBIT devices (/device path)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`);

  if (url.pathname === '/device') {
    // --- Device API Key validation ---
    if (DEVICE_API_KEY) {
      const key = url.searchParams.get('key');
      if (key !== DEVICE_API_KEY) {
        console.warn(`Device WS rejected: invalid API key from ${request.socket.remoteAddress}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // --- Connection count limit ---
    if (wss.clients.size >= MAX_DEVICE_CONNECTIONS) {
      console.warn(`Device WS rejected: max connections (${MAX_DEVICE_CONNECTIONS}) reached`);
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
  // Other paths (e.g. /socket.io/) are handled by Socket.io automatically.
});

wss.on('connection', (ws) => {
  let deviceId: string | null = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'hello' && msg.id) {
        deviceId = msg.id;

        // If device reconnects, close the stale socket
        const existing = devices.get(msg.id);
        if (existing && existing.ws !== ws) {
          existing.ws.close();
        }

        devices.set(msg.id, {
          id: msg.id,
          name: msg.name || msg.id,
          ip: msg.ip || '',
          version: msg.version || '1.0.0',
          ws,
          connectedAt: existing?.ws === ws ? existing.connectedAt : new Date(),
        });

        broadcastDevices();
        console.log(`Device online: ${msg.name} (${msg.id})`);
      }
    } catch (e) {
      console.error('Invalid device message:', e);
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      // Only delete if this socket is still the registered one
      const registered = devices.get(deviceId);
      if (registered && registered.ws === ws) {
        devices.delete(deviceId);
        broadcastDevices();
        console.log(`Device offline: ${deviceId}`);
      }
    }
  });

  // Heartbeat: close stale connections after 60s of no pong
  ws.on('pong', () => {
    (ws as any).__alive = true;
  });
  (ws as any).__alive = true;
});

// Ping all device sockets every 30 seconds
setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).__alive === false) {
      ws.terminate();
      return;
    }
    (ws as any).__alive = false;
    ws.ping();
  });
}, 30_000);

// ---------------------------------------------------------------------------
//  Auth routes
// ---------------------------------------------------------------------------

app.get(
  '/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: FRONTEND_URL }),
  (_req, res) => {
    res.redirect(FRONTEND_URL);
  }
);

app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json(req.user as AppUser);
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect(FRONTEND_URL);
  });
});

// ---------------------------------------------------------------------------
//  API routes
// ---------------------------------------------------------------------------

app.get('/api/devices', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  res.json(getDeviceList());
});

app.post('/api/poke', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to poke' });
  }

  const { targetId, text } = req.body;
  if (!targetId || !text) {
    return res.status(400).json({ error: 'Missing targetId or text' });
  }

  const device = devices.get(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  const user = req.user as AppUser;
  const pokeMsg = JSON.stringify({
    type: 'poke',
    sender: user.displayName || 'Anonymous',
    text: String(text).substring(0, 50), // OLED can only show ~21 chars per line
  });

  device.ws.send(pokeMsg);

  console.log(`Poke: ${user.displayName} -> ${device.name}: ${text}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Library (community .qgif file sharing)
// ---------------------------------------------------------------------------

const LIBRARY_DIR = process.env.LIBRARY_DIR || '/data';
const LIBRARY_FILES = path.join(LIBRARY_DIR, 'files');
const LIBRARY_JSON = path.join(LIBRARY_DIR, 'library.json');
const MAX_QGIF_SIZE = 512 * 1024; // 512 KB per file

// Ensure directories exist
fs.mkdirSync(LIBRARY_FILES, { recursive: true });

interface LibraryItem {
  id: string;
  filename: string;
  uploader: string;
  uploaderId: string;
  uploadedAt: string;
  size: number;
  frameCount: number;
}

function loadLibrary(): LibraryItem[] {
  try {
    const data = fs.readFileSync(LIBRARY_JSON, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveLibrary(items: LibraryItem[]) {
  fs.writeFileSync(LIBRARY_JSON, JSON.stringify(items, null, 2));
}

let library = loadLibrary();

// Multer: store in memory for validation before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_QGIF_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.qgif')) {
      cb(null, true);
    } else {
      cb(new Error('Only .qgif files are accepted'));
    }
  },
});

// List all library items
app.get('/api/library', (_req, res) => {
  res.json(library);
});

// Upload a .qgif file (requires login)
app.post('/api/library/upload', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to upload' });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const buf = req.file.buffer;

    // Validate .qgif header (5 bytes minimum)
    if (buf.length < 5) {
      return res.status(400).json({ error: 'File too small' });
    }

    const frameCount = buf[0];
    const width = buf[1] | (buf[2] << 8);
    const height = buf[3] | (buf[4] << 8);

    if (frameCount === 0 || width !== 128 || height !== 64) {
      return res.status(400).json({ error: 'Invalid .qgif format' });
    }

    // Verify expected file size: header(5) + delays(fc*2) + frames(fc*1024)
    const expectedSize = 5 + frameCount * 2 + frameCount * 1024;
    if (buf.length < expectedSize) {
      return res.status(400).json({ error: 'File is truncated' });
    }

    const id = crypto.randomBytes(8).toString('hex');
    const user = req.user as AppUser;

    // Write file to disk
    fs.writeFileSync(path.join(LIBRARY_FILES, `${id}.qgif`), buf);

    const item: LibraryItem = {
      id,
      filename: req.file.originalname,
      uploader: user.displayName || 'Unknown',
      uploaderId: user.id,
      uploadedAt: new Date().toISOString(),
      size: buf.length,
      frameCount,
    };

    library.push(item);
    saveLibrary(library);

    console.log(`Library upload: ${item.filename} by ${item.uploader}`);
    res.json(item);
  });
});

// Download a .qgif file (with Content-Disposition: attachment)
app.get('/api/library/:id/download', (req, res) => {
  const item = library.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(LIBRARY_FILES, `${item.id}.qgif`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  res.setHeader('Content-Disposition', `attachment; filename="${item.filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

// Raw .qgif bytes (used by the frontend canvas renderer)
app.get('/api/library/:id/raw', (req, res) => {
  const item = library.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(LIBRARY_FILES, `${item.id}.qgif`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

// Delete a library item (only the uploader can delete)
app.delete('/api/library/:id', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const user = req.user as AppUser;
  const idx = library.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  if (library[idx].uploaderId !== user.id) {
    return res.status(403).json({ error: 'You can only delete your own uploads' });
  }

  const filePath = path.join(LIBRARY_FILES, `${library[idx].id}.qgif`);
  try { fs.unlinkSync(filePath); } catch { /* ignore if already gone */ }

  library.splice(idx, 1);
  saveLibrary(library);

  res.json({ ok: true });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', devices: devices.size });
});

// ---------------------------------------------------------------------------
//  Socket.io connections
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  // Send current device list on connect
  socket.emit('devices:update', getDeviceList());
});

// ---------------------------------------------------------------------------
//  Start server
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`QBIT backend listening on port ${PORT}`);
});
