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
import archiver from 'archiver';
import { IncomingMessage } from 'http';
import { setupAuth, AppUser } from './auth';

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3001', 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3002', 10);
const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qbit.labxcloud.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'qbit-secret-change-me';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '.labxcloud.com';
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';
const MAX_DEVICE_CONNECTIONS = parseInt(process.env.MAX_DEVICE_CONNECTIONS || '100', 10);

// Server start time (for uptime calculation)
const SERVER_START = Date.now();

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
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => req.originalUrl?.startsWith('/api/library') === true, // library has its own limit
});

const libraryLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300, // library list + many /raw previews per page (incl. unauthenticated users)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use('/api/library', libraryLimiter);
app.use('/api/', apiLimiter);

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
  publicIp: string;
  version: string;
  ws: WebSocket;
  connectedAt: Date;
}

const devices = new Map<string, DeviceState>();

function getDeviceList() {
  return Array.from(devices.values()).map((d) => {
    const claim = claims[d.id] || null;
    return {
      id: d.id,
      name: d.name,
      ip: d.ip,
      publicIp: d.publicIp,
      version: d.version,
      connectedAt: d.connectedAt.toISOString(),
      claimedBy: claim ? { userName: claim.userName, userAvatar: claim.userAvatar } : null,
    };
  });
}

function broadcastDevices() {
  io.emit('devices:update', getDeviceList());
}

// ---------------------------------------------------------------------------
//  Claims persistence
// ---------------------------------------------------------------------------

const LIBRARY_DIR = process.env.LIBRARY_DIR || '/data';
const CLAIMS_JSON = path.join(LIBRARY_DIR, 'claims.json');

interface ClaimInfo {
  userId: string;
  userName: string;
  userAvatar: string;
  claimedAt: string;
}

let claims: Record<string, ClaimInfo> = {};

function loadClaims(): Record<string, ClaimInfo> {
  try {
    const data = fs.readFileSync(CLAIMS_JSON, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveClaims() {
  fs.writeFileSync(CLAIMS_JSON, JSON.stringify(claims, null, 2));
}

claims = loadClaims();

// ---------------------------------------------------------------------------
//  Ban list (admin)
// ---------------------------------------------------------------------------

const BANNED_JSON = path.join(LIBRARY_DIR, 'banned.json');

interface BannedList {
  userIds: string[];
  ips: string[];
  deviceIds: string[];
}

function loadBanned(): BannedList {
  try {
    const data = fs.readFileSync(BANNED_JSON, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      userIds: parsed.userIds ?? [],
      ips: parsed.ips ?? [],
      deviceIds: parsed.deviceIds ?? [],
    };
  } catch {
    return { userIds: [], ips: [], deviceIds: [] };
  }
}

function saveBanned(list: BannedList) {
  fs.writeFileSync(BANNED_JSON, JSON.stringify(list, null, 2));
}

function isBanned(userId?: string, ip?: string): boolean {
  const list = loadBanned();
  if (userId && list.userIds.includes(userId)) return true;
  if (ip && list.ips.includes(ip)) return true;
  return false;
}

function isBannedDevice(deviceId: string): boolean {
  const list = loadBanned();
  return list.deviceIds.includes(deviceId);
}

function addBan(userId?: string, ip?: string, deviceId?: string): void {
  const list = loadBanned();
  if (userId && !list.userIds.includes(userId)) list.userIds.push(userId);
  if (ip && !list.ips.includes(ip)) list.ips.push(ip);
  if (deviceId && !list.deviceIds.includes(deviceId)) list.deviceIds.push(deviceId);
  saveBanned(list);
}

function removeBan(userId?: string, ip?: string, deviceId?: string): void {
  const list = loadBanned();
  if (userId) list.userIds = list.userIds.filter((id) => id !== userId);
  if (ip) list.ips = list.ips.filter((i) => i !== ip);
  if (deviceId) list.deviceIds = list.deviceIds.filter((id) => id !== deviceId);
  saveBanned(list);
}

// ---------------------------------------------------------------------------
//  Known users (all who have ever logged in; persisted for admin)
// ---------------------------------------------------------------------------

const USERS_JSON = path.join(LIBRARY_DIR, 'users.json');

interface KnownUser {
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  firstSeen: string;
  lastSeen: string;
  status: 'online' | 'offline';
}

const knownUsersMap = new Map<string, KnownUser>();

function loadKnownUsers(): void {
  try {
    const data = fs.readFileSync(USERS_JSON, 'utf-8');
    const arr = JSON.parse(data) as KnownUser[];
    knownUsersMap.clear();
    for (const u of arr) {
      if (u?.userId) knownUsersMap.set(u.userId, u);
    }
  } catch {
    knownUsersMap.clear();
  }
}

function saveKnownUsers(): void {
  const arr = Array.from(knownUsersMap.values()).sort(
    (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
  );
  fs.writeFileSync(USERS_JSON, JSON.stringify(arr, null, 2));
}

function upsertKnownUser(userId: string, data: { displayName: string; email: string; avatar: string }): void {
  const now = new Date().toISOString();
  const existing = knownUsersMap.get(userId);
  knownUsersMap.set(userId, {
    userId,
    displayName: data.displayName,
    email: data.email,
    avatar: data.avatar,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
    status: 'online',
  });
  saveKnownUsers();
}

function setKnownUserOffline(userId: string): void {
  const u = knownUsersMap.get(userId);
  if (u) {
    u.status = 'offline';
    u.lastSeen = new Date().toISOString();
    saveKnownUsers();
  }
}

function getKnownUsersList(): KnownUser[] {
  const onlineIds = new Set(Array.from(onlineUsers.values()).map((u) => u.userId));
  const now = new Date().toISOString();
  const out: KnownUser[] = [];
  for (const u of knownUsersMap.values()) {
    const isOnline = onlineIds.has(u.userId);
    out.push({
      ...u,
      status: isOnline ? 'online' : 'offline',
      lastSeen: isOnline ? now : u.lastSeen,
    });
  }
  return out.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

loadKnownUsers();

// Pending claim requests (deviceId -> user info, waiting for device confirmation)
interface PendingClaim {
  userId: string;
  userName: string;
  userAvatar: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingClaims = new Map<string, PendingClaim>();

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

// Extract public IP from the incoming request
function extractPublicIp(request: IncomingMessage): string {
  // Check X-Forwarded-For first (behind Cloudflare / reverse proxy)
  const xff = request.headers['x-forwarded-for'];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    if (first) return first;
  }
  // Check CF-Connecting-IP (Cloudflare specific)
  const cfIp = request.headers['cf-connecting-ip'];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;
  // Fallback to socket remote address
  return request.socket.remoteAddress || '';
}

const bannedDeviceLogLast = new Map<string, number>();
const bannedUserLogLast = new Map<string, number>();
const BANNED_DEVICE_LOG_INTERVAL_MS = 5 * 60 * 1000; // log at most once per device/user per 5 min

wss.on('connection', (ws, request: IncomingMessage) => {
  let deviceId: string | null = null;
  const publicIp = extractPublicIp(request);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'device.register' && msg.id) {
        deviceId = msg.id;
        if (isBannedDevice(msg.id)) {
          const now = Date.now();
          const last = bannedDeviceLogLast.get(msg.id) ?? 0;
          if (now - last >= BANNED_DEVICE_LOG_INTERVAL_MS) {
            bannedDeviceLogLast.set(msg.id, now);
            console.warn(`Device WS rejected: banned device ${msg.id}`);
          }
          ws.close();
          return;
        }
        // If device reconnects, close the stale socket
        const existing = devices.get(msg.id);
        if (existing && existing.ws !== ws) {
          existing.ws.close();
        }

        devices.set(msg.id, {
          id: msg.id,
          name: msg.name || msg.id,
          ip: msg.ip || '',
          publicIp,
          version: msg.version || '1.0.0',
          ws,
          connectedAt: existing?.ws === ws ? existing.connectedAt : new Date(),
        });

        broadcastDevices();
        console.log(`Device online: ${msg.name} (${msg.id}) localIP=${msg.ip} publicIP=${publicIp}`);
      }

      // Handle claim confirmation from device
      if (msg.type === 'claim_confirm' && deviceId) {
        const pending = pendingClaims.get(deviceId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingClaims.delete(deviceId);

          claims[deviceId] = {
            userId: pending.userId,
            userName: pending.userName,
            userAvatar: pending.userAvatar,
            claimedAt: new Date().toISOString(),
          };
          saveClaims();
          broadcastDevices();
          console.log(`Device ${deviceId} claimed by ${pending.userName}`);
        }
      }

      if (msg.type === 'claim_reject' && deviceId) {
        const pending = pendingClaims.get(deviceId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingClaims.delete(deviceId);
          console.log(`Device ${deviceId} rejected claim by ${pending.userName}`);
        }
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
  authLimiter,
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err: Error | null, user: AppUser | false) => {
    if (err) return next(err);
    if (!user) return res.redirect(FRONTEND_URL);
    const clientIp = (req as any).ip || req.socket?.remoteAddress || '';
    if (isBanned(user.id, clientIp)) {
      return res.redirect(FRONTEND_URL + '?banned=1');
    }
    req.logIn(user, (loginErr: Error | undefined) => {
      if (loginErr) return next(loginErr);
      res.redirect(FRONTEND_URL);
    });
  })(req, res, next);
});

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
  const user = req.user as AppUser;
  const clientIp = (req as any).ip || req.socket?.remoteAddress || '';
  if (isBanned(user.id, clientIp)) {
    return res.status(403).json({ error: 'Account or IP is banned' });
  }

  const { targetId, text, senderBitmap, senderBitmapWidth, textBitmap, textBitmapWidth } = req.body;
  if (!targetId || !text) {
    return res.status(400).json({ error: 'Missing targetId or text' });
  }

  const device = devices.get(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  const pokePayload: Record<string, unknown> = {
    type: 'poke',
    sender: user.displayName || 'Anonymous',
    text: String(text).substring(0, 25),
  };

  // Forward bitmap data if provided (for multi-language OLED rendering)
  if (senderBitmap && senderBitmapWidth) {
    pokePayload.senderBitmap = senderBitmap;
    pokePayload.senderBitmapWidth = senderBitmapWidth;
  }
  if (textBitmap && textBitmapWidth) {
    pokePayload.textBitmap = textBitmap;
    pokePayload.textBitmapWidth = textBitmapWidth;
  }

  device.ws.send(JSON.stringify(pokePayload));

  console.log(`Poke: ${user.displayName} -> ${device.name}`);
  res.json({ ok: true });
});

// User-to-user poke (send to online web user by userId)
app.post('/api/poke/user', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required to poke' });
  }
  const sender = req.user as AppUser;
  const clientIp = (req as any).ip || req.socket?.remoteAddress || '';
  if (isBanned(sender.id, clientIp)) {
    return res.status(403).json({ error: 'Account or IP is banned' });
  }
  const { targetUserId, text } = req.body;
  if (!targetUserId || !text) {
    return res.status(400).json({ error: 'Missing targetUserId or text' });
  }
  const textStr = String(text).substring(0, 25);
  const targetSocketIds: string[] = [];
  for (const u of onlineUsers.values()) {
    if (u.userId === targetUserId) targetSocketIds.push(u.socketId);
  }
  if (targetSocketIds.length === 0) {
    return res.status(404).json({ error: 'User not found or offline' });
  }
  const payload = {
    from: sender.displayName || 'Anonymous',
    fromUserId: sender.id,
    text: textStr,
  };
  for (const sid of targetSocketIds) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('poke', payload);
  }
  console.log(`Poke user: ${sender.displayName} -> ${targetUserId}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Device claiming
// ---------------------------------------------------------------------------

app.get('/api/claims', (_req, res) => {
  res.json(claims);
});

app.post('/api/claim', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const { targetId, deviceIdFull } = req.body;
  if (!targetId || !deviceIdFull) {
    return res.status(400).json({ error: 'Missing targetId or deviceIdFull' });
  }

  const device = devices.get(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  // Validate: deviceIdFull must match the device ID
  if (device.id !== deviceIdFull) {
    return res.status(400).json({ error: 'Device ID does not match' });
  }

  // Check if already claimed by someone else
  if (claims[targetId]) {
    return res.status(409).json({ error: 'Device already claimed' });
  }

  // Check if there is already a pending claim
  if (pendingClaims.has(targetId)) {
    return res.status(409).json({ error: 'A claim request is already pending for this device' });
  }

  const user = req.user as AppUser;

  // Send claim request to device
  device.ws.send(JSON.stringify({
    type: 'claim_request',
    userName: user.displayName || 'Unknown',
    userAvatar: user.avatar || '',
  }));

  // Set a 30-second timeout for the claim
  const timer = setTimeout(() => {
    pendingClaims.delete(targetId);
    console.log(`Claim request timed out for device ${targetId}`);
  }, 30_000);

  pendingClaims.set(targetId, {
    userId: user.id,
    userName: user.displayName || 'Unknown',
    userAvatar: user.avatar || '',
    timer,
  });

  console.log(`Claim request: ${user.displayName} -> ${device.name}`);
  res.json({ ok: true, status: 'pending' });
});

app.delete('/api/claim/:deviceId', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const user = req.user as AppUser;
  const deviceId = req.params.deviceId;
  const claim = claims[deviceId];

  if (!claim) {
    return res.status(404).json({ error: 'No claim found for this device' });
  }

  if (claim.userId !== user.id) {
    return res.status(403).json({ error: 'You can only unclaim your own devices' });
  }

  delete claims[deviceId];
  saveClaims();
  broadcastDevices();

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Library (community .qgif file sharing)
// ---------------------------------------------------------------------------

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

// Batch delete library items (only deletes items owned by the user)
// NOTE: must be registered BEFORE /api/library/:id to avoid "batch" matching as :id
app.delete('/api/library/batch', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }

  const user = req.user as AppUser;
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Missing ids array' });
  }

  let deleted = 0;
  let failed = 0;

  for (const id of ids) {
    const idx = library.findIndex((i) => i.id === id);
    if (idx === -1) { failed++; continue; }
    if (library[idx].uploaderId !== user.id) { failed++; continue; }

    const filePath = path.join(LIBRARY_FILES, `${library[idx].id}.qgif`);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }

    library.splice(idx, 1);
    deleted++;
  }

  saveLibrary(library);
  res.json({ ok: true, deleted, failed });
});

// Batch download library items as a zip archive
app.post('/api/library/batch-download', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Missing ids array' });
  }

  const filesToZip: { filename: string; filepath: string }[] = [];
  for (const id of ids) {
    const item = library.find((i) => i.id === id);
    if (!item) continue;

    const filePath = path.join(LIBRARY_FILES, `${item.id}.qgif`);
    if (fs.existsSync(filePath)) {
      filesToZip.push({ filename: item.filename, filepath: filePath });
    }
  }

  if (filesToZip.length === 0) {
    return res.status(404).json({ error: 'No files found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="qgif-library.zip"');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  for (const f of filesToZip) {
    archive.file(f.filepath, { name: f.filename });
  }

  archive.finalize();
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

// ---------------------------------------------------------------------------
//  Health check (human-readable ASCII table dashboard)
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function pad(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function drawTable(headers: string[], rows: string[][]): string {
  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || '').length))
  );

  const sep = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;

  const line = (cells: string[]) =>
    '|' + cells.map((c, i) => ' ' + pad(c, widths[i]) + ' ').join('|') + '|';

  const lines: string[] = [];
  lines.push(sep('+', '+', '+', '-'));
  lines.push(line(headers));
  lines.push(sep('+', '+', '+', '-'));
  for (const row of rows) {
    lines.push(line(row));
  }
  lines.push(sep('+', '+', '+', '-'));
  return lines.join('\n');
}

app.get('/health', (req, res) => {
  const format = req.query.format;
  const now = Date.now();

  if (format === 'json') {
    res.json({
      status: 'ok',
      uptime: formatUptime(now - SERVER_START),
      timestamp: new Date(now).toISOString(),
      devices: {
        count: devices.size,
        list: Array.from(devices.values()).map((d) => ({
          id: d.id,
          name: d.name,
          localIp: d.ip,
          publicIp: d.publicIp,
          version: d.version,
          connectedAt: d.connectedAt.toISOString(),
          uptime: formatUptime(now - d.connectedAt.getTime()),
        })),
      },
      claims: {
        count: Object.keys(claims).length,
        list: Object.entries(claims).map(([deviceId, c]) => ({
          deviceId,
          userName: c.userName,
          claimedAt: c.claimedAt,
        })),
      },
      users: {
        count: onlineUsers.size,
        list: Array.from(onlineUsers.values()).map((u) => ({
          displayName: u.displayName,
          email: u.email,
          connectedAt: u.connectedAt.toISOString(),
          uptime: formatUptime(now - u.connectedAt.getTime()),
        })),
      },
      library: { fileCount: library.length },
    });
    return;
  }

  // Plain-text ASCII table dashboard
  const lines: string[] = [];
  lines.push('QBIT Server Status');
  lines.push('===================');
  lines.push(`Status:    OK`);
  lines.push(`Uptime:    ${formatUptime(now - SERVER_START)}`);
  lines.push(`Timestamp: ${new Date(now).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`);
  lines.push('');

  // Devices table
  lines.push(`Devices Online: ${devices.size}`);
  if (devices.size > 0) {
    const deviceRows = Array.from(devices.values()).map((d) => [
      d.id,
      d.name,
      d.ip || '-',
      d.publicIp || '-',
      d.version,
      formatUptime(now - d.connectedAt.getTime()),
    ]);
    lines.push(drawTable(
      ['ID', 'Name', 'Local IP', 'Public IP', 'Version', 'Uptime'],
      deviceRows
    ));
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Claims table
  const claimEntries = Object.entries(claims);
  lines.push(`Claims: ${claimEntries.length}`);
  if (claimEntries.length > 0) {
    const claimRows = claimEntries.map(([deviceId, c]) => {
      const dev = devices.get(deviceId);
      return [
        dev ? dev.name : deviceId,
        c.userName,
        c.claimedAt.split('T')[0],
      ];
    });
    lines.push(drawTable(['Device', 'Owner', 'Claimed'], claimRows));
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Users table
  // Deduplicate by userId (a user may have multiple tabs open)
  const uniqueUsers = new Map<string, OnlineUser>();
  for (const u of onlineUsers.values()) {
    if (!uniqueUsers.has(u.userId)) {
      uniqueUsers.set(u.userId, u);
    }
  }
  lines.push(`Users Online: ${uniqueUsers.size}` + (onlineUsers.size !== uniqueUsers.size ? ` (${onlineUsers.size} sessions)` : ''));
  if (uniqueUsers.size > 0) {
    const userRows = Array.from(uniqueUsers.values()).map((u) => [
      u.displayName,
      u.email || '-',
      formatUptime(now - u.connectedAt.getTime()),
    ]);
    lines.push(drawTable(['Name', 'Email', 'Session'], userRows));
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Library summary
  lines.push(`Library: ${library.length} files`);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ---------------------------------------------------------------------------
//  Socket.io connections -- track online web users
// ---------------------------------------------------------------------------

interface OnlineUser {
  socketId: string;
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  ip: string;
  connectedAt: Date;
}

const onlineUsers = new Map<string, OnlineUser>();

type OnlineUserPublic = {
  userId: string;
  displayName: string;
  avatar?: string;
  connectedAt: string;
  socketIds: string[];
};

function getOnlineUsersList(): OnlineUserPublic[] {
  const byUserId = new Map<string, OnlineUserPublic>();
  for (const u of onlineUsers.values()) {
    const existing = byUserId.get(u.userId);
    if (existing) {
      existing.socketIds.push(u.socketId);
    } else {
      byUserId.set(u.userId, {
        userId: u.userId,
        displayName: u.displayName,
        avatar: u.avatar || undefined,
        connectedAt: u.connectedAt.toISOString(),
        socketIds: [u.socketId],
      });
    }
  }
  return Array.from(byUserId.values());
}

function broadcastOnlineUsers() {
  io.emit('users:update', getOnlineUsersList());
}

function getSessionsList(): Array<{
  socketId: string;
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  ip: string;
  connectedAt: string;
}> {
  return Array.from(onlineUsers.values()).map((u) => ({
    socketId: u.socketId,
    userId: u.userId,
    displayName: u.displayName,
    email: u.email,
    avatar: u.avatar || '',
    ip: u.ip,
    connectedAt: u.connectedAt.toISOString(),
  }));
}

function disconnectUserSockets(userId: string): void {
  const toDisconnect = Array.from(onlineUsers.entries())
    .filter(([, u]) => u.userId === userId)
    .map(([sid]) => sid);
  for (const sid of toDisconnect) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.disconnect(true);
    onlineUsers.delete(sid);
  }
  broadcastOnlineUsers();
}

function disconnectDevice(deviceId: string): void {
  const dev = devices.get(deviceId);
  if (dev) {
    dev.ws.close();
    devices.delete(deviceId);
    broadcastDevices();
  }
}

io.on('connection', (socket) => {
  // Send current device and user lists on connect
  socket.emit('devices:update', getDeviceList());
  socket.emit('users:update', getOnlineUsersList());

  const req = socket.request as IncomingMessage;
  const clientIp = extractPublicIp(req);
  const passportUser = (socket.request as any)?.session?.passport?.user as AppUser | undefined;

  if (passportUser && passportUser.id) {
    if (isBanned(passportUser.id, clientIp)) {
      socket.disconnect(true);
      const banKey = `${passportUser.id}:${clientIp}`;
      const now = Date.now();
      const last = bannedUserLogLast.get(banKey) ?? 0;
      if (now - last >= BANNED_DEVICE_LOG_INTERVAL_MS) {
        bannedUserLogLast.set(banKey, now);
        console.log(`Banned user/IP rejected: ${passportUser.displayName} / ${clientIp}`);
      }
      return;
    }
    onlineUsers.set(socket.id, {
      socketId: socket.id,
      userId: passportUser.id,
      displayName: passportUser.displayName || 'Unknown',
      email: passportUser.email || '',
      avatar: passportUser.avatar || '',
      ip: clientIp,
      connectedAt: new Date(),
    });
    upsertKnownUser(passportUser.id, {
      displayName: passportUser.displayName || 'Unknown',
      email: passportUser.email || '',
      avatar: passportUser.avatar || '',
    });
    console.log(`User online: ${passportUser.displayName}`);
    broadcastOnlineUsers();
  }

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);
      setKnownUserOffline(user.userId);
      console.log(`User offline: ${user.displayName}`);
      broadcastOnlineUsers();
    }
  });
});

// ---------------------------------------------------------------------------
//  Admin server (session-based auth, httpOnly cookie, safe for public-facing)
// ---------------------------------------------------------------------------

const adminApp = express();
adminApp.set('trust proxy', 1); // trust nginx / reverse proxy (needed for rate-limit + secure cookie)
adminApp.use(express.json());

const adminSessionSecret = (process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || 'admin-secret-change').trim();
const adminSessionMaxAge = 24 * 60 * 60 * 1000; // 24 hours

adminApp.use(
  session({
    secret: adminSessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'qbit_admin_sid',
    cookie: {
      httpOnly: true,
      secure: !isLocalDev,
      sameSite: 'lax',
      maxAge: adminSessionMaxAge,
    },
  })
);

// Strict rate limit only for login (brute-force protection). Other admin routes (sessions, devices, bans, polled every 10s) are not limited.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});
const FAILED_LOGIN_DELAY_MS = 800;
const ADMIN_USERNAME_MAX_LEN = 64;
const ADMIN_PASSWORD_MIN_LEN = 8;
const ADMIN_PASSWORD_MAX_LEN = 128;

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return next();
  }
  const s = req.session as { admin?: boolean } | undefined;
  if (s?.admin === true) {
    return next();
  }
  res.status(401).json({ error: 'Login required' });
}

// Login: POST /api/admin/login { username, password } -> set session, httpOnly cookie
adminApp.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(200).json({ ok: true });
  }
  const { username, password } = req.body || {};
  const user = (typeof username === 'string' ? username : '').trim();
  const pass = typeof password === 'string' ? password : '';
  if (user.length === 0 || user.length > ADMIN_USERNAME_MAX_LEN ||
      pass.length < ADMIN_PASSWORD_MIN_LEN || pass.length > ADMIN_PASSWORD_MAX_LEN) {
    setTimeout(() => {
      res.status(401).json({ error: 'Invalid username or password' });
    }, FAILED_LOGIN_DELAY_MS);
    return;
  }
  const valid = user === ADMIN_USERNAME && pass === ADMIN_PASSWORD;
  if (!valid) {
    setTimeout(() => {
      res.status(401).json({ error: 'Invalid username or password' });
    }, FAILED_LOGIN_DELAY_MS);
    return;
  }
  (req.session as { admin?: boolean }).admin = true;
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.status(200).json({ ok: true });
  });
});

// Logout: POST /api/admin/logout -> destroy session
adminApp.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('qbit_admin_sid', { path: '/' });
    res.status(200).json({ ok: true });
  });
});

adminApp.get('/api/sessions', adminAuth, (_req, res) => {
  res.json(getSessionsList());
});
adminApp.get('/api/users', adminAuth, (_req, res) => {
  res.json(getKnownUsersList());
});
adminApp.get('/api/devices', adminAuth, (_req, res) => {
  res.json(getDeviceList());
});
adminApp.get('/api/claims', adminAuth, (_req, res) => {
  const list = Object.entries(claims).map(([deviceId, c]) => ({
    deviceId,
    deviceName: devices.get(deviceId)?.name ?? null,
    userId: c.userId,
    userName: c.userName,
    userAvatar: c.userAvatar,
    claimedAt: c.claimedAt,
  }));
  res.json(list);
});
adminApp.get('/api/bans', adminAuth, (_req, res) => {
  res.json(loadBanned());
});
adminApp.post('/api/ban', adminAuth, (req, res) => {
  const { userId, ip, deviceId } = req.body || {};
  if (!userId && !ip && !deviceId) {
    return res.status(400).json({ error: 'Missing userId, ip or deviceId' });
  }
  addBan(userId, ip, deviceId);
  if (userId) disconnectUserSockets(userId);
  if (deviceId) disconnectDevice(deviceId);
  res.json({ ok: true });
});
adminApp.delete('/api/ban', adminAuth, (req, res) => {
  const { userId, ip, deviceId } = req.body || {};
  removeBan(userId, ip, deviceId);
  res.json({ ok: true });
});

const adminStaticDir = path.join(__dirname, '..', 'static', 'admin');
if (fs.existsSync(adminStaticDir)) {
  adminApp.use(express.static(adminStaticDir));
  adminApp.get('*', (_req, res) => {
    res.sendFile(path.join(adminStaticDir, 'index.html'));
  });
} else {
  adminApp.get('/', (_req, res) => {
    res.send(
      '<p>Admin UI not built. Build the admin app and place output in backend/static/admin.</p>'
    );
  });
}

const adminHttpServer = createServer(adminApp);

// ---------------------------------------------------------------------------
//  Start servers
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`QBIT backend listening on port ${PORT}`);
});

adminHttpServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.log(`Admin server on http://${ADMIN_HOST}:${ADMIN_PORT} (internal only)`);
});
