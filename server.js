const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const brainMcp = require('./brain-mcp-client');
const mcpRegistry = require('./mcp-registry');
const { AutomationManager } = require('./automation-manager');
const { createLinuxComputerAction } = require('./linux-computer-control');
const { TerminalManager, TERMINAL_PROFILE_IDS, DEFAULT_TERMINAL_PROFILE } = require('./terminal-manager');
const { RustAgentBridge } = require('./rust-agent-bridge');
const { mobileAllowed, tunnelRouteAllowed } = require('./tunnel-policy');
const modelCatalog = require('./model-catalog');
// QR generation for the phone remote-control pairing. Guarded so a missing
// install never prevents the server from booting.
let QRCode = null;
try { QRCode = require('qrcode'); } catch {}

const app = express();
const PORT = Number(process.env.ZAALIS_PORT || process.env.PORT) || 3000;
// Le pont de contrôle du bureau tourne dans ce processus (xdotool + overlay GTK).
// L'overlay affiche un bouton « Arrêter le travail » qui rappelle le serveur sur
// /api/automation/stop-bridge : il s'authentifie avec ce secret tiré au lancement,
// jamais avec la session de l'utilisateur.
const COMPUTER_STOP_SECRET = crypto.randomBytes(32).toString('hex');
const linuxComputer = { call: createLinuxComputerAction({ port: PORT, secret: COMPUTER_STOP_SECRET }) };
const automationManager = new AutomationManager({ actionHandler: linuxComputer.call });
const computerRuns = new Map();
const terminalManager = new TerminalManager();
const TUNNEL_HEADER = 'x-zaalis-tunnel-origin';
const TUNNEL_ORIGIN_TOKEN = crypto.randomBytes(32).toString('base64url');

// Base directory for static assets and writable data.
// When packaged into an .exe (pkg), __dirname points inside the read-only
// snapshot, so we use the folder next to the executable instead.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
let APP_VERSION = '0.0.0';
try {
  APP_VERSION = require('./package.json').version || APP_VERSION;
} catch {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8'));
    APP_VERSION = pkg.version || APP_VERSION;
  } catch {}
}

// ---------------------------------------------------------------------------
// Local accounts + sessions (no external dependency)
// ---------------------------------------------------------------------------
// Accounts and per-user chats are stored as local files under server-data/.
// Passwords are hashed with scrypt; sessions are signed HttpOnly cookies.
// When packaged, the data lives in the XDG data directory
// ($XDG_DATA_HOME/zaalis/server-data, ~/.local/share/zaalis/server-data by
// default) — a stable per-user location that survives app updates and
// reinstalls. Keeping it next to the binary would lose accounts and chats at
// every update, and /opt or /usr are not writable by the user anyway.
function resolveDataDir() {
  if (process.env.ZAALIS_DATA_DIR) {
    return path.resolve(process.env.ZAALIS_DATA_DIR);
  }
  if (process.pkg && process.platform === 'linux') {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'zaalis', 'server-data');
  }
  return path.join(APP_DIR, 'server-data');
}
const DATA_DIR = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const COOKIE_NAME = 'zaalis_session';
const rustAgentBridge = new RustAgentBridge({
  baseDir: APP_DIR,
  dataDir: DATA_DIR,
  enabled: !/^(0|false|off)$/i.test(String(process.env.ZAALIS_RUST_CORE || 'on')),
});

// One-time migration: copy data from the old location (next to the exe)
// so existing accounts and chats are kept.
const LEGACY_DATA_DIR = path.join(APP_DIR, 'server-data');
if (!process.env.ZAALIS_DATA_DIR && path.resolve(DATA_DIR) !== path.resolve(LEGACY_DATA_DIR) &&
    !fs.existsSync(USERS_FILE) && fs.existsSync(path.join(LEGACY_DATA_DIR, 'users.json'))) {
  try { fs.cpSync(LEGACY_DATA_DIR, DATA_DIR, { recursive: true, force: false }); } catch {}
}

fs.mkdirSync(CHATS_DIR, { recursive: true });

// Persisted signing secret so sessions survive server restarts.
let SESSION_SECRET;
try {
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf-8');
} catch {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SESSION_SECRET);
}

// ---------------------------------------------------------------------------
// API key vault — keys are encrypted at rest (AES-256-GCM) with a key derived
// from the local install secret, stored per user and never sent back in clear.
// ---------------------------------------------------------------------------
const KEY_PROVIDERS = ['openai', 'anthropic', 'google', 'grok', 'mistral', 'moonshot'];
const VAULT_KEY = crypto.scryptSync(SESSION_SECRET, 'zaalis-api-key-vault', 32);

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return iv.toString('base64') + '.' + enc.toString('base64') + '.' + cipher.getAuthTag().toString('base64');
}
function decryptSecret(blob) {
  try {
    const [iv, data, tag] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return ''; }
}
// Decrypted keys for a user (used server-side only, never returned to a client).
function userApiKeys(user) {
  const out = {};
  for (const p of KEY_PROVIDERS) {
    const enc = user && user.apiKeys && user.apiKeys[p];
    if (enc) { const v = decryptSecret(enc); if (v) out[p] = v; }
  }
  return out;
}
// Masked status, safe to send to the client: { set, last4 } per provider.
function apiKeysStatus(user) {
  const st = {};
  for (const p of KEY_PROVIDERS) {
    const enc = user && user.apiKeys && user.apiKeys[p];
    const v = enc ? decryptSecret(enc) : '';
    st[p] = { set: !!v, last4: v ? v.slice(-4) : '' };
  }
  return st;
}

// users.json is consulted on every authenticated request (currentUser), so it
// is cached in memory and re-read only when the file actually changed on disk.
let _usersCache = null;
let _usersMtimeMs = -1;
function loadUsers() {
  try {
    const st = fs.statSync(USERS_FILE);
    if (_usersCache && st.mtimeMs === _usersMtimeMs) return _usersCache;
    let raw = fs.readFileSync(USERS_FILE, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolerate a UTF-8 BOM
    const d = JSON.parse(raw);
    _usersCache = Array.isArray(d) ? d : [d];             // tolerate a single object
    _usersMtimeMs = st.mtimeMs;
    return _usersCache;
  } catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  _usersCache = users;
  try { _usersMtimeMs = fs.statSync(USERS_FILE).mtimeMs; } catch { _usersMtimeMs = -1; }
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function makeToken(userId) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
  return userId + '.' + sig;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const userId = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
  return safeEqual(sig, expected) ? userId : null;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
function currentUser(req) {
  const userId = verifyToken(parseCookies(req)[COOKIE_NAME]);
  if (!userId) return null;
  return loadUsers().find((u) => u.id === userId) || null;
}

// ---------------------------------------------------------------------------
// BROWSER BRIDGE — restricted access for zaalis browser (same machine).
// A shared secret is written to the stable per-user folder (the same one
// DATA_DIR uses when packaged). zaalis browser reads it from disk and sends it
// in the x-zaalis-browser header. Loopback only (already enforced by the global
// middleware) and limited to chat — never files/exec/tunnel. Same trust model
// as the `secret` file: any local process of this user can read it, so this
// exposes nothing beyond what the local vault already allows.
// ---------------------------------------------------------------------------
function browserBridgeDir() {
  if (process.env.ZAALIS_DATA_DIR) return DATA_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'zaalis', 'server-data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'zaalis', 'server-data');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'zaalis', 'server-data');
}
const BROWSER_SECRET_FILE = path.join(browserBridgeDir(), 'browser-secret');
let BROWSER_SECRET;
try {
  BROWSER_SECRET = fs.readFileSync(BROWSER_SECRET_FILE, 'utf-8').trim();
  if (!BROWSER_SECRET) throw new Error('empty');
} catch {
  BROWSER_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(browserBridgeDir(), { recursive: true });
    fs.writeFileSync(BROWSER_SECRET_FILE, BROWSER_SECRET, { mode: 0o600 });
  } catch {}
}
// Last account seen driving the IDE itself (valid session cookie). The browser
// has no session of its own, so this is the most accurate answer to "whose
// account is this machine using right now".
let lastActiveUserId = '';
function browserUser(req) {
  const header = String(req.headers['x-zaalis-browser'] || '');
  if (!header || !safeEqual(header, BROWSER_SECRET)) return null;
  const users = loadUsers();
  if (!users.length) return null;
  const active = users.find((u) => u.id === lastActiveUserId);
  if (active) return active;
  // No IDE session seen yet: fall back to the most recently used real account.
  // Accounts with no API key and no recorded login (throwaway/test accounts)
  // rank last — binding the browser to one of those means every request comes
  // back "no API key configured" even though a configured account exists.
  return users.slice().sort((a, b) => {
    const ka = a.apiKeys && Object.keys(a.apiKeys).length ? 1 : 0;
    const kb = b.apiKeys && Object.keys(b.apiKeys).length ? 1 : 0;
    if (ka !== kb) return kb - ka;
    return String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || ''));
  })[0];
}
// The browser only reaches chat, the local model lists (to fill its menus) and
// the local voice bricks — never files, exec or keys.
function browserAllowed(p) {
  return p === '/chat' || p === '/ollama-models' || p === '/gguf-models' ||
         p === '/stt' || p === '/tts' || p === '/voice-status' || p === '/voice-options';
}
// ---------------------------------------------------------------------------
// CODESTRALE BRIDGE — restricted access for the codestrale desktop app.
// ---------------------------------------------------------------------------
// codestrale is a separate Tauri app on the same machine: it syncs Git repos
// between the user's devices and delegates every AI turn to this IDE, so the
// account, the API keys and the Rust core all stay in one place.
//
// It cannot guess where we listen or how to authenticate, so on start-up we
// publish a descriptor — `codestrale-bridge.json` { secret, port, version, pid,
// updatedAt } — in the stable per-user folders codestrale looks into. It reads
// the secret from disk and sends it in the x-zaalis-codestrale header.
//
// Same trust model as `browser-secret`: any local process of this user can
// already read the vault, so this exposes nothing new. The reachable surface is
// deliberately narrow — agent turns, their decisions, their cancellation, and
// the two read-only descriptors. Never files, keys, exec or tunnel.
const CODESTRALE_BRIDGE_FILE = 'codestrale-bridge.json';
const CODESTRALE_HEADER = 'x-zaalis-codestrale';

// The stable per-user `zaalis` root, independent of any ZAALIS_DATA_DIR
// override: codestrale is a separate process and only ever looks here.
function zaalisRootDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'zaalis');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'zaalis');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'zaalis');
}

// Every folder codestrale probes: the `zaalis` root, its `server-data`
// subfolder, and DATA_DIR — which adds nothing on a packaged install but is
// where an unpackaged run actually lives.
//
// ZAALIS_DATA_DIR means "this instance is self-contained" (resolveDataDir and
// browserBridgeDir already read it that way), so an isolated run must not
// overwrite the descriptor of the real install. codestrale probes that same
// variable first, so an override still pairs correctly.
function codestraleBridgeDirs() {
  if (process.env.ZAALIS_DATA_DIR) return [DATA_DIR];
  const root = zaalisRootDir();
  const seen = new Set();
  return [root, path.join(root, 'server-data'), DATA_DIR].filter((dir) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CODESTRALE_SECRET_FILE = path.join(browserBridgeDir(), 'codestrale-secret');
let CODESTRALE_SECRET;
try {
  CODESTRALE_SECRET = fs.readFileSync(CODESTRALE_SECRET_FILE, 'utf-8').trim();
  if (!CODESTRALE_SECRET) throw new Error('empty');
} catch {
  CODESTRALE_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(browserBridgeDir(), { recursive: true });
    fs.writeFileSync(CODESTRALE_SECRET_FILE, CODESTRALE_SECRET, { mode: 0o600 });
  } catch {}
}

// Announce where we listen and how to talk to us. Called once the port is
// actually bound, so the descriptor never advertises a port we failed to take.
function publishCodestraleBridge(port) {
  const payload = JSON.stringify({
    secret: CODESTRALE_SECRET,
    port,
    version: APP_VERSION,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }, null, 2);
  for (const dir of codestraleBridgeDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CODESTRALE_BRIDGE_FILE), payload, { mode: 0o600 });
    } catch {}
  }
}

// Remove the descriptor on a clean exit so codestrale says "IDE fermé" instead
// of trying a port nobody listens on. A crash leaves the file behind, which is
// harmless: the connection simply fails and codestrale reports the same thing.
function unpublishCodestraleBridge() {
  for (const dir of codestraleBridgeDirs()) {
    try { fs.unlinkSync(path.join(dir, CODESTRALE_BRIDGE_FILE)); } catch {}
  }
}

// codestrale has no session of its own: like the browser bridge, it acts as the
// account currently driving the IDE.
function codestraleUser(req) {
  const header = String(req.headers[CODESTRALE_HEADER] || '');
  if (!header || !safeEqual(header, CODESTRALE_SECRET)) return null;
  const users = loadUsers();
  if (!users.length) return null;
  const active = users.find((u) => u.id === lastActiveUserId);
  if (active) return active;
  return users.slice().sort((a, b) => {
    const ka = a.apiKeys && Object.keys(a.apiKeys).length ? 1 : 0;
    const kb = b.apiKeys && Object.keys(b.apiKeys).length ? 1 : 0;
    if (ka !== kb) return kb - ka;
    return String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || ''));
  })[0];
}

// An agent turn, the decisions it asks for, its cancellation, and the two
// descriptors — nothing else. The Rust core's own status stays out: /ping
// already reports it, so there is no reason to widen the surface.
// `/agent-runs/<session>/cancel` is matched on shape, not on a fixed id.
function codestraleAllowed(p) {
  return p === '/codestrale/ping' || p === '/codestrale/models' ||
         p === '/agent-chat' || p === '/rust-core/decision' ||
         /^\/agent-runs\/[^/]+\/cancel$/.test(p);
}

function chatsFile(userId, kind) {
  // kind: 'chat' (single chat) or 'agents' (multi-agent). Kept in separate files.
  const k = kind === 'agents' ? 'agents' : 'chat';
  return path.join(CHATS_DIR, `${userId}__${k}.json`);
}

const SHARED_CONFIG_DEFAULTS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  ggufCtx: 8192,
  ggufVariant: '',
  ggufGpuLayers: '',
  terminalProfile: DEFAULT_TERMINAL_PROFILE
};
// Variantes du moteur GGUF acceptees par la configuration. Elles dependent de
// ce que llama.cpp publie pour la plateforme : Metal sur macOS, ROCm/Vulkan sur
// Linux (pas de binaire CUDA publie), CUDA/Vulkan sur Windows.
const GGUF_VARIANTS = new Set(process.platform === 'darwin'
  ? ['', 'metal', 'cpu']
  : process.platform === 'linux'
    ? ['', 'rocm', 'vulkan', 'cpu']
    : ['', 'cuda', 'vulkan', 'cpu']);
const TERMINAL_PROFILES = new Set(TERMINAL_PROFILE_IDS);

function clampSharedGgufCtx(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return SHARED_CONFIG_DEFAULTS.ggufCtx;
  return Math.max(512, Math.min(131072, n));
}

function sanitizeSharedConfig(input, base = SHARED_CONFIG_DEFAULTS) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...SHARED_CONFIG_DEFAULTS, ...(base || {}) };
  if ('ollamaUrl' in src) {
    const v = String(src.ollamaUrl || '').trim();
    out.ollamaUrl = v || SHARED_CONFIG_DEFAULTS.ollamaUrl;
  }
  if ('ollamaModel' in src) {
    const v = String(src.ollamaModel || '').trim();
    out.ollamaModel = v || SHARED_CONFIG_DEFAULTS.ollamaModel;
  }
  if ('ggufCtx' in src) out.ggufCtx = clampSharedGgufCtx(src.ggufCtx);
  if ('ggufVariant' in src) {
    const v = String(src.ggufVariant || '').trim().toLowerCase();
    out.ggufVariant = GGUF_VARIANTS.has(v) ? v : '';
  }
  if ('terminalProfile' in src) {
    const value = String(src.terminalProfile || '').trim().toLowerCase();
    out.terminalProfile = TERMINAL_PROFILES.has(value) ? value : SHARED_CONFIG_DEFAULTS.terminalProfile;
  }
  if ('ggufGpuLayers' in src) {
    const raw = src.ggufGpuLayers;
    out.ggufGpuLayers = (raw === '' || raw === undefined || raw === null)
      ? ''
      : Math.max(0, Math.min(999, parseInt(raw, 10) || 0));
  }
  return out;
}

function sharedConfigForUser(user) {
  return sanitizeSharedConfig(user && user.sharedConfig);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Do not advertise the framework.
app.disable('x-powered-by');

// Loopback addresses allowed to reach the API. The server also binds to
// 127.0.0.1 only (see app.listen below); this is defense in depth so that even
// if it were ever exposed, only the local machine can read/write files, run
// commands, or reach the endpoints that carry the user's API keys.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

app.use((req, res, next) => {
  const remote = req.socket.remoteAddress;
  if (!LOOPBACK.has(remote)) {
    return res.status(403).json({ error: 'Forbidden: local access only' });
  }
  const tunnelMarker = String(req.headers[TUNNEL_HEADER] || '');
  if (tunnelMarker && !safeEqual(tunnelMarker, TUNNEL_ORIGIN_TOKEN)) {
    return res.status(403).json({ error: 'Forbidden: invalid tunnel origin' });
  }
  req.isTunnel = !!tunnelMarker;
  if (req.isTunnel && !tunnelRouteAllowed(req.method, req.path)) {
    return res.status(403).json({ error: 'Action indisponible via le tunnel.' });
  }

  // Never serve the accounts/secret/chats store as a static file.
  if (req.path === '/server-data' || req.path.startsWith('/server-data/')) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Security headers. connect-src 'self' is the important one: even if a script
  // were injected, it cannot exfiltrate the API keys to an external server.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=()');
  // Never cache the app shell, so updates always load (no stale script.js).
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '50mb' }));
// The web interface (index.html, css, js) lives in the interface/ folder.
app.use(express.static(path.join(APP_DIR, 'interface'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

// ---------------------------------------------------------------------------
// AUTH API (public)
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(emailNorm)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caracteres minimum).' });

  const users = loadUsers();
  if (users.some((u) => u.email === emailNorm)) return res.status(409).json({ error: 'Un compte existe deja avec cet email.' });

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    email: emailNorm,
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
    profile: {
      pseudo: emailNorm.split('@')[0],
      photo: ''
    }
  };
  users.push(user);
  saveUsers(users);
  setSessionCookie(res, makeToken(user.id));
  res.json({ email: user.email, profile: user.profile });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const emailNorm = String(email || '').trim().toLowerCase();
  const user = loadUsers().find((u) => u.email === emailNorm);
  // Always compute a hash to keep timing similar whether or not the user exists.
  const candidate = hashPassword(password || '', user ? user.salt : 'x'.repeat(32));
  if (!user || !safeEqual(candidate, user.hash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }
  // Remember the last login (used by the zaalis browser bridge to pick which
  // account to answer for when no IDE session has been seen yet).
  try {
    const users = loadUsers();
    const i = users.findIndex((u) => u.id === user.id);
    if (i >= 0) { users[i].lastLoginAt = new Date().toISOString(); saveUsers(users); }
  } catch {}
  lastActiveUserId = user.id;
  setSessionCookie(res, makeToken(user.id));
  res.json({ email: user.email, profile: user.profile || { pseudo: user.email.split('@')[0], photo: '' } });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  // Status check: always 200 so the browser console isn't polluted with a 401.
  const user = req.isTunnel ? mobileUser(req) : currentUser(req);
  res.json({
    authenticated: !!user,
    email: user ? user.email : null,
    profile: user ? (user.profile || { pseudo: user.email.split('@')[0], photo: '' }) : null
  });
});

// Private loopback bridge used only by the Rust `computer` tool. Tokens are
// random, per-run, memory-only, and never enter MCP or persisted config.
app.post('/api/internal/rust-computer', async (req, res) => {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const entry = computerRuns.get(raw);
  if (!entry || raw.length < 32) return res.status(401).json({ error: 'Jeton computer invalide.' });
  try {
    return res.json(await automationManager.execute(entry.session, req.body || {}));
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
});

// Bouton « Arrêter le travail » de l'overlay de contrôle du bureau. L'overlay
// est un processus séparé, sans cookie de session : il s'authentifie avec le
// secret tiré au lancement (COMPUTER_STOP_SECRET), partagé uniquement avec lui.
// La seule chose que ce jeton permet est d'arrêter la tâche en cours, donc
// l'exposer avant le garde d'authentification n'élargit aucune surface.
app.post('/api/automation/stop-bridge', async (req, res) => {
  const header = String(req.headers['x-zaalis-computer'] || '');
  if (!COMPUTER_STOP_SECRET || !header || !safeEqual(header, COMPUTER_STOP_SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try { return res.json(await automationManager.stop()); }
  catch (error) { return res.status(500).json({ error: error.message || String(error) }); }
});

// ---------------------------------------------------------------------------
// AUTH GUARD — every other /api/* route requires a valid session
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/check-update') return next();
  const user = req.isTunnel ? null : currentUser(req);
  if (user) { lastActiveUserId = user.id; req.user = user; return next(); }
  // Phone remote-control session: a signed pairing cookie, restricted to a safe
  // subset of endpoints (chat only — never files/exec/tunnel-start).
  const mUser = mobileUser(req);
  if (mUser) {
    if (!mobileAllowed(req.method, req.path)) return res.status(403).json({ error: 'Action indisponible en mode mobile.' });
    req.user = mUser;
    req.isMobile = true;
    return next();
  }
  // zaalis browser bridge: shared local secret, chat endpoints only.
  const bUser = browserUser(req);
  if (bUser) {
    if (!browserAllowed(req.path)) return res.status(403).json({ error: 'Action indisponible pour le navigateur.' });
    req.user = bUser;
    req.isBrowser = true;
    return next();
  }
  // codestrale bridge: shared local secret, agent endpoints only.
  const cUser = codestraleUser(req);
  if (cUser) {
    if (!codestraleAllowed(req.path)) return res.status(403).json({ error: 'Action indisponible pour codestrale.' });
    req.user = cUser;
    req.isCodestrale = true;
    return next();
  }
  return res.status(401).json({ error: 'Authentification requise.' });
});

// Update profile
app.post('/api/profile', (req, res) => {
  const { pseudo, photo } = req.body || {};
  const users = loadUsers();
  const userIdx = users.findIndex((u) => u.id === req.user.id);
  if (userIdx === -1) return res.status(404).json({ error: 'Utilisateur non trouve.' });

  const currentPseudo = String(pseudo || '').trim();
  users[userIdx].profile = {
    pseudo: currentPseudo || req.user.email.split('@')[0],
    photo: String(photo || '')
  };
  saveUsers(users);
  res.json({ success: true, profile: users[userIdx].profile });
});

// Shared local runtime settings used by both the desktop IDE and the CLI.
// This intentionally covers hardware/local-model settings, not UI state.
app.get('/api/config', (req, res) => {
  res.json({
    configured: !!(req.user && req.user.sharedConfig),
    config: sharedConfigForUser(req.user),
    terminalProfiles: terminalManager.profiles()
  });
});

// ---------------------------------------------------------------------------
// INTEGRATED TERMINAL — persistent interactive shell sessions
// ---------------------------------------------------------------------------
// Sessions are scoped to a logged-in user and bound to the project folder that
// user selected.  Never exposed to the phone remote or the browser bridge.
app.post('/api/terminal/sessions', (req, res) => {
  try {
    if (req.isMobile || req.isBrowser) return res.status(403).json({ error: 'Terminal indisponible dans ce mode.' });
    const cwd = resolveBase((req.body && req.body.cwd) || APP_DIR);
    const profileId = sharedConfigForUser(req.user).terminalProfile;
    const session = terminalManager.create({ userId: req.user.id, cwd, profileId, origin: 'user' });
    res.json(terminalManager.snapshot(session));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/terminal/sessions/:id', (req, res) => {
  const session = terminalManager.get(String(req.params.id || ''), req.user.id);
  if (!session) return res.status(404).json({ error: 'Terminal introuvable.' });
  res.json(terminalManager.snapshot(session));
});

app.get('/api/terminal/sessions/:id/stream', (req, res) => {
  const session = terminalManager.get(String(req.params.id || ''), req.user.id);
  if (!session) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  const write = (event, value) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); } catch {} };
  write('snapshot', terminalManager.snapshot(session));
  const onData = (data) => write('data', data);
  const onExit = (data) => { write('exit', data); try { res.end(); } catch {} };
  session.events.on('data', onData); session.events.once('exit', onExit);
  req.on('close', () => { session.events.removeListener('data', onData); session.events.removeListener('exit', onExit); });
});

app.post('/api/terminal/sessions/:id/input', (req, res) => {
  try {
    const session = terminalManager.get(String(req.params.id || ''), req.user.id);
    if (!session) return res.status(404).json({ error: 'Terminal introuvable.' });
    terminalManager.write(session, String(req.body && req.body.data || '').slice(0, 16000)); res.json({ ok: true });
  } catch (err) { res.status(409).json({ error: err.message }); }
});

app.post('/api/terminal/sessions/:id/resize', (req, res) => {
  const session = terminalManager.get(String(req.params.id || ''), req.user.id);
  if (!session) return res.status(404).json({ error: 'Terminal introuvable.' });
  terminalManager.resize(session, req.body && req.body.cols, req.body && req.body.rows); res.json({ ok: true });
});

app.delete('/api/terminal/sessions/:id', (req, res) => {
  const session = terminalManager.get(String(req.params.id || ''), req.user.id);
  if (!session) return res.status(404).json({ error: 'Terminal introuvable.' });
  terminalManager.close(session); res.json({ ok: true });
});

app.put('/api/config', (req, res) => {
  try {
    if (req.isMobile) return res.status(403).json({ error: 'Action indisponible en mode mobile.' });
    const users = loadUsers();
    const userIdx = users.findIndex((u) => u.id === req.user.id);
    if (userIdx === -1) return res.status(404).json({ error: 'Utilisateur non trouve.' });
    const current = sharedConfigForUser(users[userIdx]);
    users[userIdx].sharedConfig = sanitizeSharedConfig((req.body && req.body.config) || {}, current);
    saveUsers(users);
    res.json({ success: true, config: users[userIdx].sharedConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------------------------------------
// API KEYS API (protected) — write-only vault with masked read-back
// ---------------------------------------------------------------------------
// GET  /api/keys -> { keys: { openai: { set, last4 }, ... } }   (never the key)
app.get('/api/keys', (req, res) => {
  res.json({ keys: apiKeysStatus(req.user) });
});

// PUT /api/keys  { keys: { openai: 'sk-...', anthropic: null, ... } }
// Non-empty string = set/replace (encrypted). null = delete. Absent/'' = keep.
app.put('/api/keys', (req, res) => {
  if (req.isMobile || req.isBrowser || req.isTunnel) {
    return res.status(403).json({ error: 'Modification des cles reservee au desktop.' });
  }
  try {
    const incoming = (req.body && req.body.keys) || {};
    const users = loadUsers();
    const user = users.find((u) => u.id === req.user.id);
    if (!user) return res.status(401).json({ error: 'Authentification requise.' });
    user.apiKeys = user.apiKeys || {};
    for (const p of KEY_PROVIDERS) {
      if (!(p in incoming)) continue;
      const v = incoming[p];
      if (v === null) delete user.apiKeys[p];
      else if (typeof v === 'string' && v.trim()) user.apiKeys[p] = encryptSecret(v.trim());
    }
    saveUsers(users);
    res.json({ keys: apiKeysStatus(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// MCP configuration: Zaalis Brain is distinct from personal MCP servers.
function publicMcpServers(user) { return (user.mcpServers || []).map((s) => ({ ...s, token: undefined, tokenConfigured: !!s.token })); }
function rustMcpServersFor(user) {
  return [
    ...(user.mcpServers || []).filter((server) => server && server.enabled).map((server) => ({ ...server, token: server.token ? decryptSecret(server.token) : '' })),
    ...(user.brainMcp && user.brainMcp.enabled && user.brainMcp.endpoint && user.brainMcp.token
      ? [{ id: 'zaalis-brain', name: 'Zaalis Brain', endpoint: user.brainMcp.endpoint, token: decryptSecret(user.brainMcp.token), enabled: true, allow: [], deny: [] }]
      : []),
  ];
}
app.get('/api/brain-mcp', (req, res) => { const s = req.user.brainMcp || {}; res.json({ configured: !!(s.endpoint && s.token), enabled: !!s.enabled, endpoint: s.endpoint || '', state: s.enabled ? 'disconnected' : 'not_configured' }); });
app.put('/api/brain-mcp', (req, res) => {
  try { const b = req.body || {}, users = loadUsers(), i = users.findIndex((u) => u.id === req.user.id), old = users[i].brainMcp || {}; const endpoint = String(b.endpoint === undefined ? old.endpoint || '' : b.endpoint).trim(); const token = String(b.token || '') || (old.token ? decryptSecret(old.token) : ''); if ((b.enabled || endpoint || token) && !brainMcp.validateConfig({ endpoint, token })) return res.status(400).json({ error: 'Route ou jeton Zaalis Brain invalide.' }); users[i].brainMcp = { enabled: !!b.enabled, endpoint, token: token ? encryptSecret(token) : '' }; saveUsers(users); res.json({ configured: !!(endpoint && token), enabled: !!b.enabled, endpoint, state: b.enabled ? 'disconnected' : 'not_configured' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/mcp', (req, res) => res.json({ servers: publicMcpServers(req.user) }));
app.get('/api/automation/status', (req, res) => res.json(automationManager.snapshot()));
app.post('/api/automation/stop', async (req, res) => res.json(await automationManager.stop()));
app.post('/api/agent-runs/:id/cancel', async (req, res) => {
  try {
    res.json(await rustAgentBridge.cancel(req.user.id, req.params.id));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});
app.put('/api/mcp', (req, res) => {
  try { const incoming = Array.isArray(req.body && req.body.servers) ? req.body.servers : null; if (!incoming) return res.status(400).json({ error: 'Liste MCP invalide.' }); const users = loadUsers(), i = users.findIndex((u) => u.id === req.user.id), old = new Map((users[i].mcpServers || []).map((s) => [s.id, s])); users[i].mcpServers = incoming.slice(0, 32).map((s) => { const n = mcpRegistry.normaliseServer(s); if (!n) throw new Error('Serveur MCP invalide. HTTPS requis sauf loopback HTTP.'); const token = String(s.token || '') || (old.get(n.id) && decryptSecret(old.get(n.id).token)) || ''; return { ...n, token: token ? encryptSecret(token) : '' }; }); saveUsers(users); res.json({ servers: publicMcpServers(users[i]) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
// ---------------------------------------------------------------------------
// PER-USER CHATS API (protected)
// ---------------------------------------------------------------------------
app.get('/api/chats', (req, res) => {
  const kind = req.query.kind === 'agents' ? 'agents' : 'chat';
  let file = chatsFile(req.user.id, kind);
  // Migration: older versions stored the single chat as "<id>.json".
  if (kind === 'chat' && !fs.existsSync(file)) {
    const legacy = path.join(CHATS_DIR, req.user.id + '.json');
    if (fs.existsSync(legacy)) file = legacy;
  }
  try { res.json(JSON.parse(fs.readFileSync(file, 'utf-8'))); }
  catch { res.json([]); }
});

app.put('/api/chats', (req, res) => {
  try {
    const conversations = (req.body && req.body.conversations) || [];
    fs.writeFileSync(chatsFile(req.user.id, req.body && req.body.kind), JSON.stringify(conversations, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PER-USER RECENT PROJECTS (protected)
// ---------------------------------------------------------------------------
// Mirrored from the desktop so the mobile remote's "Projets" list shows the
// same folders the user has opened on the PC. Read-only for mobile sessions.
app.get('/api/recent-projects', (req, res) => {
  res.json({ projects: Array.isArray(req.user.recentProjects) ? req.user.recentProjects : [] });
});

app.put('/api/recent-projects', (req, res) => {
  if (req.isMobile) return res.status(403).json({ error: 'Action indisponible en mode mobile.' });
  try {
    const list = (req.body && req.body.projects) || [];
    const clean = Array.isArray(list)
      ? list.filter((p) => typeof p === 'string' && p.trim()).slice(0, 12)
      : [];
    const users = loadUsers();
    const u = users.find((x) => x.id === req.user.id);
    if (!u) return res.status(404).json({ error: 'Utilisateur non trouve.' });
    u.recentProjects = clean;
    saveUsers(users);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FILTERED = new Set(['node_modules', '.git', '.env', '.DS_Store', 'server-data']);

function resolveBase(root) {
  return root ? path.resolve(root) : APP_DIR;
}

function isInsideBase(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function fetchJSON(url, options) {
  // A desktop-agent turn makes several ordered provider calls. Honour a
  // provider's short 429 cooldown instead of failing the whole task after one
  // desktop action. Retrying only 429 is safe: the provider rejected it before
  // processing and the original request was not executed.
  const wait = (ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const signal = options && options.signal;
    if (!signal) return;
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Requete interrompue.')); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 || attempt === 3) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 30000)
      : Math.min(1000 * (2 ** attempt), 8000);
    // Consume the rejected body before retrying so the connection can be reused.
    try { await res.arrayBuffer(); } catch {}
    await wait(delayMs);
  }
  // Read the body as text first: a non-JSON error (empty body, OOM, an HTML 500,
  // an Ollama plain-text error) then surfaces the REAL message instead of
  // throwing on res.json() and bubbling up as a generic "connection error".
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300) || res.statusText}`);
    throw new Error('Réponse non-JSON reçue du serveur distant.');
  }
  if (!res.ok) {
    const errMsg =
      data.error?.message || data.error?.type ||
      (typeof data.error === 'string' ? data.error : '') ||
      (data.error ? JSON.stringify(data.error) : '') || res.statusText;
    throw new Error(errMsg);
  }
  return data;
}

// ---------------------------------------------------------------------------
// FILE SYSTEM API
// ---------------------------------------------------------------------------

// GET /api/files?path=...&root=...
app.get('/api/files', (req, res) => {
  try {
    const base = resolveBase(req.query.root);
    const relPath = req.query.path || '';
    const fullPath = path.resolve(base, relPath);

    if (!isInsideBase(base, fullPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Prevent directory traversal outside the base when no root is given
    if (!req.query.root && !isInsideBase(APP_DIR, fullPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const items = entries
      .filter((e) => !FILTERED.has(e.name))
      .map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: path.join(relPath, e.name).replace(/\\/g, '/'),
      }))
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/file?path=...&root=...
app.get('/api/file', (req, res) => {
  try {
    const base = resolveBase(req.query.root);
    const relPath = req.query.path || '';
    const fullPath = path.resolve(base, relPath);

    if (!isInsideBase(base, fullPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.query.root && !isInsideBase(APP_DIR, fullPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tree?root=...  -> { files: [relative paths], truncated }
// Recursive, filtered, bounded listing used to give the AI project context.
app.get('/api/tree', (req, res) => {
  try {
    const base = resolveBase(req.query.root);
    if (!req.query.root && !base.startsWith(APP_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const out = [];
    const MAX = 600;
    const walk = (dir, rel, depth) => {
      if (out.length >= MAX || depth > 7) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory()) ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
      for (const e of entries) {
        if (out.length >= MAX) break;
        if (FILTERED.has(e.name)) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { out.push(r + '/'); walk(path.join(dir, e.name), r, depth + 1); }
        else out.push(r);
      }
    };
    walk(base, '', 0);
    res.json({ files: out, truncated: out.length >= MAX });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/file  { root, path, content }
app.post('/api/file', (req, res) => {
  try {
    const { root, path: relPath, content } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });

    const base = resolveBase(root);
    const fullPath = path.resolve(base, relPath);

    if (!isInsideBase(base, fullPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!root && !isInsideBase(APP_DIR, fullPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// EXEC API
// ---------------------------------------------------------------------------

// Un lancement depuis un fichier .desktop (menu d'applications, dock) hérite
// d'un PATH minimal : ni /usr/local/bin, ni ~/.local/bin, ni les paquets
// installés par l'utilisateur. On complète donc le PATH avant tout exec, sinon
// git/rg/node « disparaissent » selon la façon dont l'IDE a été démarré.
function execEnv() {
  const extra = [
    '/usr/local/bin', '/usr/local/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/snap/bin', '/var/lib/flatpak/exports/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
  ];
  const seen = new Set();
  const merged = [];
  for (const dir of [...String(process.env.PATH || '').split(':'), ...extra]) {
    if (dir && !seen.has(dir)) { seen.add(dir); merged.push(dir); }
  }
  return { ...process.env, PATH: merged.join(':') };
}

// POST /api/exec  { command, cwd }
// `/bin/sh -lc` runs the command through a login shell so the user's profile
// (nvm, pyenv, cargo, asdf…) is applied exactly as in their own terminal.
app.post('/api/exec', (req, res) => {
  try {
    const { command, cwd } = req.body;
    if (!command) return res.status(400).json({ error: 'command is required' });

    const execCwd = cwd || APP_DIR;

    execFile('/bin/sh', ['-lc', command], {
      cwd: execCwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5,
      env: execEnv()
    }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ stdout: stdout || '', stderr: stderr || '' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AGENT TOOLS — read-only search & diagnostics (Grep / Glob / GitDiff / Doctor)
// ---------------------------------------------------------------------------
// These power the slash commands (/grep, /glob, /diff, /review, /doctor). They
// are strictly read-only, bounded in output, and path-guarded to the project.

// zaalis browser est un projet frere (meme auteur). Sur Linux il est installe
// par son paquet .deb dans /opt/zaalis-browser, ou extrait dans le dossier
// personnel pour une version portable : on essaie les emplacements standards
// puis le PATH, sans dependre d'un raccourci que l'utilisateur peut deplacer.
const ZAALIS_BROWSER_EXE = (() => {
  const candidates = [
    '/opt/zaalis-browser/zaalis-browser',
    '/usr/lib/zaalis-browser/zaalis-browser',
    '/usr/bin/zaalis-browser',
    '/usr/local/bin/zaalis-browser',
    path.join(os.homedir(), '.local', 'share', 'zaalis-browser', 'zaalis-browser'),
    path.join(os.homedir(), '.local', 'bin', 'zaalis-browser'),
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
})();
const ZAALIS_BROWSER_PING = 'http://127.0.0.1:8715/zaalis/ping';
const SEARCH_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 zaalis/1.0';

async function pingZaalisBrowser(timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ZAALIS_BROWSER_PING, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// S'assure que zaalis browser tourne, en le lancant si besoin (chemin fixe
// ci-dessus). L'API locale du navigateur demarre des l'ouverture du process,
// avant meme que la fenetre/WebView2 soit prete : on patiente donc un peu
// apres le premier ping reussi pour laisser le premier onglet s'initialiser
// (sinon une recherche envoyee trop tot est silencieusement ignoree).
let launchingBrowser = null;
async function ensureZaalisBrowserRunning() {
  if (await pingZaalisBrowser(800)) return true;
  if (launchingBrowser) return launchingBrowser;

  launchingBrowser = (async () => {
    if (!ZAALIS_BROWSER_EXE || !fs.existsSync(ZAALIS_BROWSER_EXE)) return false;
    try {
      const child = spawn(ZAALIS_BROWSER_EXE, [], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      return false;
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await pingZaalisBrowser(800)) {
        await new Promise((r) => setTimeout(r, 700)); // laisse le premier onglet s'initialiser
        return true;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })();

  try {
    return await launchingBrowser;
  } finally {
    launchingBrowser = null;
  }
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    const key = ent.toLowerCase();
    if (key[0] === '#') {
      const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : m;
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,2})\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
}

function publicHttpUrl(raw) {
  const url = safeHttpUrl(raw);
  if (!url) return null;
  try {
    const u = new URL(url);
    if (isPrivateHost(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function searchPageUrl(query) {
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function hostnameLabel(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function faviconApiUrl(rawUrl) {
  const host = hostnameLabel(rawUrl);
  return host ? `/api/favicon?domain=${encodeURIComponent(host)}` : '';
}

function usefulQuote(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const firstSentence = clean.match(/^.{80,260}?[.!?](?:\s|$)/);
  const picked = firstSentence ? firstSentence[0] : clean.slice(0, 190);
  return picked.length < clean.length ? picked.replace(/[.,;:\s]+$/, '') + '...' : picked;
}

function resolveDuckUrl(href) {
  const cleaned = decodeHtmlEntities(href).trim();
  try {
    const u = new URL(cleaned, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return publicHttpUrl(uddg || u.toString());
  } catch {
    return null;
  }
}

function extractSearchResults(html, sourceQuery, limit) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*\bclass=(["'])[^"']*(?:result__a|result-link)[^"']*\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || '')) !== null && out.length < limit) {
    const attrs = m[1] || '';
    const hrefMatch = attrs.match(/\bhref=(["'])([^"']+)\1/i);
    if (!hrefMatch) continue;
    const url = resolveDuckUrl(hrefMatch[2]);
    if (!url) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const tail = String(html || '').slice(re.lastIndex, re.lastIndex + 1800);
    const sn = tail.match(/class=(["'])[^"']*(?:result__snippet|result-snippet)[^"']*\1[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    out.push({
      title: stripHtml(m[3]).slice(0, 180) || url,
      url,
      host: hostnameLabel(url),
      favicon: faviconApiUrl(url),
      snippet: sn ? stripHtml(sn[2]).slice(0, 500) : '',
      sourceQuery,
    });
  }
  return out;
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const { headers = {}, ...rest } = options;
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      ...rest,
      headers: {
        'User-Agent': SEARCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(query, limit) {
  const r = await fetchWithTimeout(searchPageUrl(query), 8000);
  if (!r.ok) return [];
  const html = await r.text();
  return extractSearchResults(html, query, limit);
}

function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 180) : '';
}

function metaDescription(html) {
  const re = /<meta\b([^>]+)>/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    const attrs = m[1] || '';
    if (!/\bname=(["'])description\1/i.test(attrs) && !/\bproperty=(["'])og:description\1/i.test(attrs)) continue;
    const c = attrs.match(/\bcontent=(["'])([\s\S]*?)\1/i);
    if (c) return stripHtml(c[2]).slice(0, 400);
  }
  return '';
}

async function fetchPageExcerpt(url) {
  const safe = publicHttpUrl(url);
  if (!safe) return { error: 'URL non publique ignoree.' };
  try {
    const r = await fetchWithTimeout(safe, 9000);
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    const len = Number(r.headers.get('content-length') || 0);
    if (!r.ok) return { error: `HTTP ${r.status}` };
    if (len && len > 3 * 1024 * 1024) return { error: 'Page trop lourde pour le resume.' };
    if (ct && !/text\/html|text\/plain|application\/xhtml|application\/xml/.test(ct)) {
      return { error: `Type non texte (${ct.split(';')[0]}).` };
    }
    const html = await r.text();
    return {
      title: pageTitle(html),
      description: metaDescription(html),
      excerpt: stripHtml(html).slice(0, 3200),
    };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'Timeout' : ((e && e.message) || 'Erreur lecture page') };
  }
}

async function openInZaalisBrowser(targetUrl, { background = false, timeoutMs = 4000 } = {}) {
  const url = safeHttpUrl(targetUrl);
  if (!url) return { ok: false, status: 400, body: { error: 'invalid_url' } };
  const running = await ensureZaalisBrowserRunning();
  if (!running) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'browser_unavailable',
        message: 'zaalis browser est introuvable ou n a pas pu demarrer.',
      },
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const bg = background ? '&background=1' : '';
    const r = await fetch(`http://127.0.0.1:8715/zaalis/newtab?url=${encodeURIComponent(url)}${bg}`, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    if (body.error === 'offline_mode') {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'offline_mode',
          message: body.message || 'Mode local securise actif : recherche impossible.',
        },
      };
    }
    if (!r.ok || body.error) return { ok: false, status: r.status || 502, body: { error: body.error || `browser HTTP ${r.status}` } };
    return { ok: true, status: 200, body };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: {
        error: e && e.name === 'AbortError' ? 'zaalis browser ne repond pas' : 'zaalis browser est indisponible',
        detail: e && e.message,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function deepSearchQueries(query) {
  const base = String(query || '').replace(/\s+/g, ' ').trim();
  const out = [base, `${base} official source`, `${base} documentation`, `${base} analysis`];
  return Array.from(new Set(out)).filter(Boolean).slice(0, 4);
}

app.get('/api/favicon', async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/i.test(domain) || isPrivateHost(domain)) {
    return res.status(400).json({ error: 'invalid domain' });
  }
  try {
    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    const r = await fetchWithTimeout(url, 6000, { headers: { Accept: 'image/png,image/*;q=0.8,*/*;q=0.5' } });
    if (!r.ok) return res.status(r.status).end();
    const bytes = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(bytes);
  } catch (e) {
    res.status(502).json({ error: 'favicon unavailable', detail: e && e.message });
  }
});

app.get('/api/browser-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  const mode = String(req.query.mode || 'newtab').toLowerCase();
  const background = /^(1|true|yes)$/i.test(String(req.query.background || ''));
  const visibleParam = background ? '&background=1' : '';
  const endpoint = mode === 'active' ? 'search?q=' : 'newtab?url=';
  const url = `http://127.0.0.1:8715/zaalis/${endpoint}${encodeURIComponent(q)}${visibleParam}`;

  const running = await ensureZaalisBrowserRunning();
  if (!running) {
    return res.status(503).json({
      error: 'browser_unavailable',
      message: 'zaalis browser est introuvable ou n a pas pu demarrer.',
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    if (body.error === 'offline_mode') {
      return res.status(409).json({
        error: 'offline_mode',
        message: body.message || 'Mode local securise actif : recherche impossible.',
      });
    }
    if (!r.ok || body.error) {
      return res.status(r.status || 502).json({ error: body.error || `browser HTTP ${r.status}` });
    }
    res.json({ ok: true, query: q, mode, background, browser: body });
  } catch (e) {
    const msg = e && e.name === 'AbortError'
      ? 'zaalis browser ne repond pas'
      : 'zaalis browser est indisponible';
    res.status(502).json({ error: msg, detail: e && e.message });
  } finally {
    clearTimeout(timer);
  }
});

app.get('/api/browser-open', async (req, res) => {
  const url = safeHttpUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'url is required' });
  const background = /^(1|true|yes)$/i.test(String(req.query.background || ''));
  const r = await openInZaalisBrowser(url, { background });
  if (!r.ok) return res.status(r.status).json(r.body);
  res.json({ ok: true, url, browser: r.body });
});

app.post('/api/deep-search', async (req, res) => {
  const query = String(req.body && req.body.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });

  const maxResults = Math.max(3, Math.min(12, Number(req.body.maxResults || 8)));
  const maxPages = Math.max(1, Math.min(8, Number(req.body.maxPages || 5)));
  const openTabs = Math.max(0, Math.min(8, Number(req.body.openTabs || 5)));

  // First open the search page in zaalis browser. If secure local mode blocks it,
  // do not perform server-side web requests behind the user's back.
  const firstOpen = await openInZaalisBrowser(searchPageUrl(query), { background: false, timeoutMs: 5000 });
  if (!firstOpen.ok) return res.status(firstOpen.status).json(firstOpen.body);

  const searchedQueries = deepSearchQueries(query);
  const all = [];
  const seen = new Set();
  for (const q of searchedQueries) {
    try {
      const results = await webSearch(q, Math.ceil(maxResults / 2) + 2);
      for (const r of results) {
        const key = r.url.replace(/#.*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(r);
        if (all.length >= maxResults) break;
      }
    } catch {}
    if (all.length >= maxResults) break;
  }

  for (const result of all.slice(0, maxPages)) {
    const page = await fetchPageExcerpt(result.url);
    Object.assign(result, page);
    result.host = result.host || hostnameLabel(result.url);
    result.favicon = result.favicon || faviconApiUrl(result.url);
    result.quote = usefulQuote(result.excerpt || result.description || result.snippet);
  }

  const opened = [{ url: searchPageUrl(query), kind: 'search', foreground: true }];
  for (const result of all.slice(0, openTabs)) {
    const openedTab = await openInZaalisBrowser(result.url, { background: true, timeoutMs: 4000 });
    if (openedTab.ok) opened.push({ url: result.url, kind: 'source', foreground: false });
  }

  res.json({ ok: true, query, searchedQueries, results: all, opened });
});

// Detect a CLI tool once (node/npm/git/rg). Cached promise so /doctor and the
// grep fallback don't re-spawn the same probe repeatedly.
const _cliCache = new Map();
function detectCli(name) {
  if (_cliCache.has(name)) return _cliCache.get(name);
  const p = new Promise((resolve) => {
    const done = (err, stdout) => {
      if (err || !stdout) return resolve({ available: false, version: '' });
      resolve({ available: true, version: String(stdout).split(/\r?\n/)[0].trim() });
    };
    try {
      execFile(name, ['--version'], { timeout: 5000, env: execEnv() }, done);
    } catch { resolve({ available: false, version: '' }); }
  });
  _cliCache.set(name, p);
  return p;
}

function clampInt(v, lo, hi, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

// Directories never walked by Grep/Glob (heavy / irrelevant). FILTERED already
// covers node_modules/.git/.env/server-data; add common build output folders.
const WALK_IGNORE = new Set([...FILTERED, 'dist', 'build', '.next', 'out', '.cache', 'coverage', '.nuxt', '.svelte-kit']);

// Collect relative file paths under base, bounded. Returns { list, truncated }.
function collectFiles(base, opts) {
  const max = (opts && opts.max) || 20000;
  const list = [];
  let truncated = false;
  const walk = (dir, rel, depth) => {
    if (truncated || depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (WALK_IGNORE.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else {
        if (list.length >= max) { truncated = true; return; }
        list.push(r);
      }
    }
  };
  walk(base, '', 0);
  return { list, truncated };
}

// Convert a glob (**, *, ?) into an anchored, case-insensitive RegExp.
function globToRe(glob) {
  const g = String(glob || '**/*').replace(/\\/g, '/').trim();
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]'.indexOf(c) >= 0) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

// Parse ripgrep "relpath:line:text" output into bounded structured results.
function parseRgOutput(stdout, max) {
  const list = [];
  let truncated = false;
  const lines = String(stdout || '').split(/\r?\n/);
  for (const ln of lines) {
    if (!ln) continue;
    const m = ln.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    if (list.length >= max) { truncated = true; break; }
    list.push({ file: m[1].replace(/\\/g, '/'), line: parseInt(m[2], 10), text: m[3].slice(0, 240) });
  }
  return { list, truncated };
}

// Pure-JS grep fallback when ripgrep is not installed. Bounded everywhere.
// `searchAbs` may be the project root, a sub-directory, or a single file.
function jsGrep(searchAbs, base, pattern, ignoreCase, glob, max) {
  let re;
  try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); }
  catch { const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); re = new RegExp(esc, ignoreCase ? 'i' : ''); }
  const globRe = glob ? globToRe(glob) : null;

  // Build the list of target files (abs + project-relative path) for either a
  // single-file target or a directory walk.
  const targets = [];
  let st;
  try { st = fs.statSync(searchAbs); } catch { return { list: [], truncated: false }; }
  if (st.isFile()) {
    targets.push({ abs: searchAbs, rel: path.relative(base, searchAbs).replace(/\\/g, '/') });
  } else {
    const prefix = path.relative(base, searchAbs).replace(/\\/g, '/');
    for (const r of collectFiles(searchAbs, { max: 8000 }).list) {
      targets.push({ abs: path.join(searchAbs, r), rel: prefix ? prefix + '/' + r : r });
    }
  }

  const list = [];
  let truncated = false, scanned = 0;
  for (const t of targets) {
    if (truncated) break;
    if (globRe && !globRe.test(t.rel)) continue;
    if (scanned++ > 6000) { truncated = true; break; }
    let buf;
    try {
      const s = fs.statSync(t.abs);
      if (s.size > 512 * 1024) continue;             // skip large files
      buf = fs.readFileSync(t.abs);
    } catch { continue; }
    if (buf.includes(0)) continue;                   // skip binary
    const rows = buf.toString('utf-8').split('\n');
    for (let i = 0; i < rows.length; i++) {
      if (re.test(rows[i])) {
        if (list.length >= max) { truncated = true; break; }
        list.push({ file: t.rel, line: i + 1, text: rows[i].trim().slice(0, 240) });
      }
    }
  }
  return { list, truncated };
}

// POST /api/grep  { root, pattern, path?, glob?, ignoreCase?, maxResults }
app.post('/api/grep', async (req, res) => {
  try {
    const b = req.body || {};
    const pat = String(b.pattern || '');
    if (!pat || pat.length > 1000) return res.status(400).json({ error: 'pattern requis' });
    const base = resolveBase(b.root);
    if (!b.root && !base.startsWith(APP_DIR)) return res.status(403).json({ error: 'Access denied' });

    const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    let searchAbs = base;
    if (rel) {
      searchAbs = path.resolve(base, rel);
      if (!isInsideBase(base, searchAbs)) return res.status(403).json({ error: 'Access denied' });
    }
    const glob = String(b.glob || '').trim();
    const ic = !!b.ignoreCase;
    const maxResults = clampInt(b.maxResults, 1, 500, 200);

    const rg = await detectCli('rg');
    if (rg.available) {
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-count', '30',
        '-g', '!node_modules', '-g', '!.git', '-g', '!dist', '-g', '!build', '-g', '!.next'];
      if (ic) args.push('-i');
      if (glob) args.push('-g', glob);
      args.push('--regexp', pat, rel || '.');
      execFile('rg', args, { cwd: base, timeout: 15000, maxBuffer: 1024 * 1024 * 8, env: execEnv() }, (err, stdout, stderr) => {
        if (err && err.code === 1 && !stdout) return res.json({ tool: 'ripgrep', pattern: pat, results: [], count: 0, truncated: false });
        if (err && err.code !== 1 && !stdout) return res.status(500).json({ error: String(stderr || err.message || 'ripgrep error').slice(0, 300) });
        const r = parseRgOutput(stdout, maxResults);
        res.json({ tool: 'ripgrep', pattern: pat, results: r.list, count: r.list.length, truncated: r.truncated });
      });
      return;
    }
    const r = jsGrep(searchAbs, base, pat, ic, glob, maxResults);
    res.json({ tool: 'js', pattern: pat, results: r.list, count: r.list.length, truncated: r.truncated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/glob?root=...&pattern=**/*.js&maxResults=...
app.get('/api/glob', (req, res) => {
  try {
    const base = resolveBase(req.query.root);
    if (!req.query.root && !base.startsWith(APP_DIR)) return res.status(403).json({ error: 'Access denied' });
    const pattern = String(req.query.pattern || '**/*');
    const max = clampInt(req.query.maxResults, 1, 2000, 500);
    let re;
    try { re = globToRe(pattern); } catch { return res.status(400).json({ error: 'pattern invalide' }); }
    const all = collectFiles(base, { max: 20000 });
    const files = [];
    let truncated = false;
    for (const f of all.list) {
      if (re.test(f)) {
        if (files.length >= max) { truncated = true; break; }
        files.push(f);
      }
    }
    res.json({ pattern, files, count: files.length, truncated: truncated || all.truncated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gitdiff?root=...  -> { available, repo, branch, status, unstaged, staged }
app.get('/api/gitdiff', async (req, res) => {
  try {
    const base = resolveBase(req.query.root);
    if (!req.query.root && !base.startsWith(APP_DIR)) return res.status(403).json({ error: 'Access denied' });
    const git = await detectCli('git');
    if (!git.available) return res.json({ available: false, error: 'git introuvable' });
    const run = (args) => new Promise((resolve) => {
      execFile('git', ['-C', base, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 * 16, env: execEnv() },
        (e, so) => resolve(e && !so ? '' : String(so || '')));
    });
    const inside = (await run(['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return res.json({ available: true, repo: false });
    const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const status = await run(['status', '--porcelain=v1']);
    const unstaged = await run(['diff']);
    const staged = await run(['diff', '--staged']);
    const cap = (s) => (s.length > 60000 ? s.slice(0, 60000) + '\n... (tronqué)' : s);
    res.json({ available: true, repo: true, branch, status: cap(status), unstaged: cap(unstaged), staged: cap(staged) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/version -> { version }
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

// GET /api/doctor?root=...  -> environment diagnostics (never exposes API keys)
app.get('/api/doctor', async (req, res) => {
  try {
    const base = req.query.root ? resolveBase(req.query.root) : null;
    const [npm, git, rg] = await Promise.all([detectCli('npm'), detectCli('git'), detectCli('rg')]);

    let ollama = { reachable: false, models: 0 };
    try {
      const url = String(req.query.ollama || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) { const d = await r.json().catch(() => ({})); ollama = { reachable: true, models: (d.models || []).length }; }
    } catch {}

    let gguf = { variant: '', installed: false };
    try { const v = detectEngineVariant(); gguf = { variant: v, installed: !!findExeRecursive(path.join(ENGINE_DIR, v), engineBinaryName()) }; } catch {}

    // Le paquet Linux est produit dans native/installer/ (.deb ou AppImage).
    const installerDirs = [path.join(APP_DIR, 'native', 'installer'), path.join(process.cwd(), 'native', 'installer')];
    const installer = installerDirs.some((dir) => {
      try { return fs.readdirSync(dir).some((f) => /\.(deb|AppImage|tar\.gz)$/i.test(f)); } catch { return false; }
    });

    let scripts = [];
    try { const pj = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8')); scripts = Object.keys(pj.scripts || {}); } catch {}

    let projectGit = null;
    if (base && git.available) {
      projectGit = await new Promise((resolve) => {
        execFile('git', ['-C', base, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000, env: execEnv() },
          (e, so) => resolve(e ? null : String(so || '').trim()));
      });
    }

    res.json({
      version: APP_VERSION,
      node: process.version,
      npm, git, rg, ollama, gguf, installer,
      scripts, projectGit,
      platform: process.platform,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// FOLDER PICKER — opens the native OS folder dialog (local app)
// ---------------------------------------------------------------------------
// POST /api/pick-folder  -> { path } | { cancelled: true }
// Dans l'application Electron empaquetee, le renderer passe par le pont natif
// (window.zaalisNative.pickFolder) ; cette route est le repli navigateur/dev.
// Linux n'a pas de dialogue unique : on essaie les selecteurs GTK puis Qt, dans
// cet ordre, et on s'arrete au premier reellement installe.
const LINUX_FOLDER_PICKERS = [
  { bin: 'zenity', args: ['--file-selection', '--directory', '--title=Choisissez le dossier du projet'] },
  { bin: 'qarma', args: ['--file-selection', '--directory', '--title=Choisissez le dossier du projet'] },
  { bin: 'kdialog', args: ['--getexistingdirectory', os.homedir(), '--title', 'Choisissez le dossier du projet'] },
];

app.post('/api/pick-folder', (req, res) => {
  const env = execEnv();
  const tryPicker = (index) => {
    if (index >= LINUX_FOLDER_PICKERS.length) {
      return res.status(501).json({ error: 'Aucun sélecteur de dossier trouvé. Installez zenity (GNOME) ou kdialog (KDE).' });
    }
    const picker = LINUX_FOLDER_PICKERS[index];
    execFile(picker.bin, picker.args, { timeout: 180000, env }, (err, stdout) => {
      // ENOENT = ce sélecteur n'est pas installé : on passe au suivant.
      if (err && (err.code === 'ENOENT' || err.code === 127)) return tryPicker(index + 1);
      // Code 1 (zenity/qarma) ou 1 (kdialog) = l'utilisateur a fermé la fenêtre.
      if (err && err.code === 1) return res.json({ cancelled: true });
      if (err) return res.status(500).json({ error: err.message });
      const selected = String(stdout || '').trim();
      if (!selected) return res.json({ cancelled: true });
      res.json({ path: selected });
    });
  };
  tryPicker(0);
});

// GET /api/ollama-models?url=...  -> { models: [names] }
app.get('/api/ollama-models', async (req, res) => {
  try {
    const configured = sharedConfigForUser(req.user).ollamaUrl || 'http://127.0.0.1:11434';
    const url = (req.isMobile ? configured : (req.query.url || configured)).replace(/\/+$/, '');
    const r = await fetch(`${url}/api/tags`);
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ollama-delete  { name, url }  -> uninstall a model from Ollama
app.post('/api/ollama-delete', async (req, res) => {
  try {
    const name = req.body && req.body.name;
    const url = ((req.body && req.body.url) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await fetch(`${url}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(500).json({ error: t || ('HTTP ' + r.status) });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hf-search?q=...  -> search GGUF models on Hugging Face (proxied)
app.get('/api/hf-search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const sort = ['downloads', 'likes', 'trendingScore', 'lastModified'].includes(req.query.sort) ? req.query.sort : 'downloads';
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 50);
    const searchParam = q ? `search=${encodeURIComponent(q)}&` : '';
    const u = `https://huggingface.co/api/models?${searchParam}filter=gguf&sort=${sort}&direction=-1&limit=${limit}&full=true`;
    const r = await fetch(u, { headers: { 'User-Agent': 'zaalis-ide' } });
    const data = await r.json();
    const NOISE = new Set(['gguf', 'text-generation', 'transformers', 'region:us', 'endpoints_compatible', 'autotrain_compatible', 'conversational']);
    const models = (Array.isArray(data) ? data : []).map((m) => ({
      id: m.id || m.modelId,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      pipeline: m.pipeline_tag || '',
      // a few meaningful tags (languages, base model, size...) without the noise
      tags: (m.tags || []).filter((t) => !NOISE.has(t) && !t.includes(':') && t.length < 22).slice(0, 5),
    })).filter((m) => m.id);
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hf-files?id=<repo>  -> available GGUF quantizations with sizes
app.get('/api/hf-files', async (req, res) => {
  try {
    const id = (req.query.id || '').toString();
    if (!id) return res.status(400).json({ error: 'id required' });
    const r = await fetch(`https://huggingface.co/api/models/${id}?blobs=true`, { headers: { 'User-Agent': 'zaalis-ide' } });
    const d = await r.json();
    const groups = {};
    for (const s of (d.siblings || [])) {
      const f = s.rfilename || '';
      if (!/\.gguf$/i.test(f)) continue;
      const m = f.match(/(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*K[A-Z0-9_]*|Q\d_\d|Q\d[A-Z0-9_]*|BF16|F16|F32)/i);
      const quant = (m ? m[1] : 'default').toUpperCase();
      if (!groups[quant]) groups[quant] = { size: 0, files: [], file: '' };
      const size = s.size || 0;
      groups[quant].size += size;
      groups[quant].files.push({ file: f, size });
      if (!groups[quant].file || size > (groups[quant]._bestSize || 0)) {
        groups[quant].file = f;
        groups[quant]._bestSize = size;
      }
    }
    let quants = Object.entries(groups).map(([quant, info]) => ({
      quant,
      size: info.size,
      file: info.file,
      files: info.files,
    })).filter((x) => x.size > 0);
    // Drop the unlabelled (fp16/full) group when real quantizations exist.
    if (quants.some((x) => x.quant !== 'DEFAULT')) quants = quants.filter((x) => x.quant !== 'DEFAULT');
    quants.sort((a, b) => a.size - b.size);
    res.json({ quants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ollama-pull?name=...&url=...  -> streams Ollama's pull progress (NDJSON)
app.get('/api/ollama-pull', async (req, res) => {
  const name = req.query.name;
  const url = (req.query.url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  if (!name) return res.status(400).json({ error: 'name required' });
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  // If the client cancels (closes the request), abort the pull to Ollama.
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const r = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: ac.signal,
    });
    if (!r.body) { res.end(); return; }
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!ac.signal.aborted) {
      try { res.write(JSON.stringify({ error: err.message }) + '\n'); } catch {}
    }
    try { res.end(); } catch {}
  }
});

// ---------------------------------------------------------------------------
// LOCAL GGUF ENGINE (llama.cpp) — run GGUF models directly, NO Ollama needed.
// We download the official llama.cpp `llama-server` build that matches the
// machine (ROCm / Vulkan / CPU) into ~/.local/share/zaalis/engine, spawn it as a
// child process, and proxy chat to its OpenAI-compatible /v1/chat/completions.
// This is exactly how LM Studio / Jan work, but fully self-contained.
//
// Linux n'a pas d'équivalent de CUDA prêt à l'emploi côté llama.cpp : le projet
// ne publie pas de binaire CUDA pour Linux. Vulkan couvre NVIDIA, Intel et AMD
// avec les pilotes du système, et ROCm est préféré sur AMD quand le runtime est
// réellement installé. Une variante `cuda` demandée par la configuration (ou
// héritée d'une machine Windows) retombe donc sur Vulkan.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.join(DATA_DIR, 'models');   // installed *.gguf files
const ENGINE_DIR = path.join(DATA_DIR, 'engine');   // extracted llama.cpp builds
const LLAMA_TAG = 'b9690';                          // pinned llama.cpp release
const ENGINE_PORT = 8091;

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
ensureDir(MODELS_DIR);

// Detect the fastest engine variant available on this machine.
let _gpuVariant = null;
function detectEngineVariant() {
  if (_gpuVariant) return _gpuVariant;
  let names = '';
  try { names = execSyncSafe('sh -lc "lspci 2>/dev/null | grep -Ei \'vga|3d|display\' || true"'); } catch {}
  if (!names) { try { names = execSyncSafe('sh -lc "lshw -C display 2>/dev/null || true"'); } catch {} }
  names = (names || '').toLowerCase();
  if (/amd|radeon/.test(names) && hasRocmRuntime()) _gpuVariant = 'rocm';
  else if (/nvidia|geforce|rtx|quadro|tesla|amd|radeon|intel|arc|iris/.test(names)) _gpuVariant = 'vulkan';
  else _gpuVariant = 'cpu';
  return _gpuVariant;
}
function execSyncSafe(cmd) {
  const { execSync } = require('child_process');
  return execSync(cmd, { timeout: 9000, env: execEnv() }).toString();
}

// ROCm n'est utilisable que si son runtime est réellement installé : une carte
// AMD sans /opt/rocm ferait échouer le binaire au premier chargement.
function hasRocmRuntime() {
  if (fs.existsSync('/opt/rocm/bin/rocminfo')) return true;
  try { return execSyncSafe('sh -lc "command -v rocminfo >/dev/null 2>&1 && echo yes || true"').trim() === 'yes'; }
  catch { return false; }
}

function engineBinaryName() { return 'llama-server'; }

// Ramène une variante demandée (configuration utilisateur, ou héritée d'une
// autre plateforme) sur une variante que cette machine sait réellement lancer.
function normalizeEngineVariant(variant) {
  const v = String(variant || '').toLowerCase();
  if (v === 'rocm' || v === 'vulkan' || v === 'cpu') return v;
  if (v === 'cuda' || v === 'metal') return 'vulkan';
  return detectEngineVariant();
}

function engineAssetUrls(variant) {
  variant = normalizeEngineVariant(variant);
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`;
  if (variant === 'rocm') return [base + `llama-${LLAMA_TAG}-bin-ubuntu-rocm-7.2-x64.tar.gz`];
  if (variant === 'vulkan') return [base + `llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`];
  return [base + `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`];
}

// Les archives tar ne conservent pas toujours le bit d'exécution selon l'outil
// d'extraction : on le repose explicitement avant chaque lancement.
function ensureExecutable(file) {
  if (!file) return;
  try { fs.chmodSync(file, 0o755); } catch {}
}

function findExeRecursive(dir, name) {
  let found = null;
  const walk = (d) => {
    if (found) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.toLowerCase() === name) { found = fp; return; }
    }
  };
  walk(dir);
  return found;
}

function terminalGgufPullStatus(status) {
  return status === 'success' || status === 'error' || status === 'canceled';
}

function ggufPullSnapshot(task) {
  return {
    id: task.id,
    status: task.status,
    name: task.name,
    repo: task.repo,
    file: task.file,
    completed: task.completed || 0,
    total: task.total || 0,
    error: task.error || '',
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    doneAt: task.doneAt || 0,
  };
}

// Stream a URL to a file; calls onProgress(received, total). Abortable.
async function downloadTo(url, dest, onProgress, signal) {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Téléchargement échoué (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  ensureDir(path.dirname(dest));
  const out = fs.createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(received, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

const ggufPullTasks = new Map();

function sweepGgufPullTasks() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, task] of ggufPullTasks) {
    if (task.doneAt && task.doneAt < cutoff) ggufPullTasks.delete(id);
  }
}

function startGgufPullTask({ repo, file, url }) {
  sweepGgufPullTasks();
  if (!url && repo && file) url = `https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`;
  if (!url) throw new Error('url, ou repo+file requis');

  let base = path.basename((file || url).split('?')[0]) || `model-${Date.now()}.gguf`;
  if (!base.toLowerCase().endsWith('.gguf')) base += '.gguf';
  const dest = path.join(MODELS_DIR, base);
  const tmp = dest + '.part';

  for (const task of ggufPullTasks.values()) {
    if (!terminalGgufPullStatus(task.status) && task.dest === dest) return task;
  }

  const ac = new AbortController();
  const task = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    repo,
    file,
    url,
    name: base,
    dest,
    tmp,
    status: 'queued',
    completed: 0,
    total: 0,
    error: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    doneAt: 0,
    ac,
  };
  ggufPullTasks.set(task.id, task);

  task.promise = (async () => {
    try {
      ensureDir(MODELS_DIR);
      if (fs.existsSync(dest)) {
        const size = fs.statSync(dest).size;
        task.completed = size;
        task.total = size;
        task.status = 'success';
        return;
      }
      try { fs.unlinkSync(tmp); } catch {}
      task.status = 'downloading';
      await downloadTo(url, tmp, (rec, tot) => {
        task.completed = rec;
        task.total = tot || task.total || 0;
        task.status = 'downloading';
        task.updatedAt = Date.now();
      }, ac.signal);
      fs.renameSync(tmp, dest);
      task.completed = task.total || task.completed;
      task.status = 'success';
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      task.status = ac.signal.aborted ? 'canceled' : 'error';
      task.error = ac.signal.aborted ? 'Téléchargement annulé.' : ((e && e.message) || String(e));
    } finally {
      task.updatedAt = Date.now();
      task.doneAt = Date.now();
    }
  })();

  return task;
}

// Les binaires llama.cpp pour Linux sont publiés en .tar.gz ; on garde le repli
// unzip pour une éventuelle archive .zip téléchargée à la main par l'utilisateur.
function extractArchive(archivePath, destDir) {
  ensureDir(destDir);
  const { execFileSync } = require('child_process');
  const env = execEnv();
  if (/\.(tar\.gz|tgz)$/i.test(archivePath)) {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 300000, env });
    return;
  }
  execFileSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { timeout: 300000, env });
}

// Ensure the engine binary for `variant` exists; returns the llama-server path.
// Downloads + extracts on first use, reporting progress via onLog({stage, pct}).
const engineExePaths = {};
async function ensureEngineBinary(variant, onLog) {
  variant = normalizeEngineVariant(variant);
  if (engineExePaths[variant] && fs.existsSync(engineExePaths[variant])) {
    ensureExecutable(engineExePaths[variant]);
    return engineExePaths[variant];
  }
  const vdir = path.join(ENGINE_DIR, variant);
  const binName = engineBinaryName();
  let exe = findExeRecursive(vdir, binName);
  if (exe) { ensureExecutable(exe); engineExePaths[variant] = exe; return exe; }
  ensureDir(vdir);
  const urls = engineAssetUrls(variant);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const archive = path.join(vdir, path.basename(url));
    if (onLog) onLog({ stage: 'engine', pct: 0, part: i + 1, parts: urls.length });
    await downloadTo(url, archive, (rec, tot) => {
      if (onLog && tot) onLog({ stage: 'engine', pct: Math.round((rec / tot) * 100), part: i + 1, parts: urls.length });
    });
    if (onLog) onLog({ stage: 'extract', pct: 100, part: i + 1, parts: urls.length });
    extractArchive(archive, vdir);
    try { fs.unlinkSync(archive); } catch {}
  }
  exe = findExeRecursive(vdir, binName);
  if (!exe) throw new Error(`${binName} introuvable après extraction.`);
  ensureExecutable(exe);
  engineExePaths[variant] = exe;
  return exe;
}

// --- Engine process lifecycle (one model loaded at a time, swapped on demand) ---
let engineProc = null, engineModelFile = null, engineVariant = null, engineStarting = null;

function stopEngine() {
  return new Promise((resolve) => {
    if (!engineProc) return resolve();
    const p = engineProc; engineProc = null; engineModelFile = null; engineVariant = null; engineRequestedVariant = null;
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { p.once('exit', fin); p.kill(); setTimeout(fin, 2000); } catch { fin(); }
  });
}

async function waitForHealth(port, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) { const j = await r.json().catch(() => ({})); if (!j.status || j.status === 'ok') return; }
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("Le moteur GGUF n'a pas démarré à temps (modèle trop lourd ?).");
    await new Promise((r) => setTimeout(r, 600));
  }
}

// Track the engine options the running process was started with, so a change in
// context size / GPU layers forces a restart even when the model is unchanged.
// `engineRequestedVariant` retient la variante demandée : après un repli sur
// CPU, `engineVariant` vaut 'cpu' alors que la demande d'origine reste 'vulkan',
// et sans cela chaque appel relancerait le moteur en boucle.
let engineOpts = '';
let engineRequestedVariant = null;

// Make sure the engine is running and serving `modelFile`. Swaps model if needed.
// `opts` = { ctx, gpuLayers } let the user tune context window and VRAM usage.
async function ensureEngine(modelFile, preferredVariant, opts) {
  opts = opts || {};
  const modelPath = path.join(MODELS_DIR, modelFile);
  if (!fs.existsSync(modelPath)) throw new Error('Modèle GGUF introuvable : ' + modelFile);
  // Normalize options: context (clamped) and GPU layers ('' = all -> 999).
  let ctx = parseInt(opts.ctx, 10); if (!Number.isFinite(ctx) || ctx <= 0) ctx = 8192;
  ctx = Math.max(512, Math.min(131072, ctx));
  const nglRaw = opts.gpuLayers;
  const ngl = (nglRaw === '' || nglRaw === undefined || nglRaw === null) ? 999 : (parseInt(nglRaw, 10) || 0);
  const optsKey = `${ctx}|${ngl}`;
  const requestedVariant = normalizeEngineVariant(preferredVariant || detectEngineVariant());
  if (engineProc && engineModelFile === modelFile && engineOpts === optsKey && engineRequestedVariant === requestedVariant) return;
  if (engineStarting) { try { await engineStarting; } catch {} if (engineProc && engineModelFile === modelFile && engineOpts === optsKey && engineRequestedVariant === requestedVariant) return; }
  engineStarting = (async () => {
    await stopEngine();
    const startVariant = async (v) => {
      const exe = await ensureEngineBinary(v);
      const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(ENGINE_PORT), '--ctx-size', String(ctx)];
      // Offload layers to the GPU unless we're on the CPU build or the user capped it at 0.
      if (v === 'cpu') args.push('-ngl', '0');
      else if (ngl > 0) args.push('-ngl', String(ngl));
      engineOpts = optsKey;
      const proc = spawn(exe, args, { stdio: 'ignore', cwd: path.dirname(exe), env: execEnv() });
      proc.on('error', () => {});
      engineProc = proc; engineModelFile = modelFile; engineVariant = v; engineRequestedVariant = requestedVariant;
      proc.once('exit', () => {
        if (engineProc === proc) {
          engineProc = null; engineModelFile = null; engineVariant = null; engineRequestedVariant = null;
        }
      });
      await waitForHealth(ENGINE_PORT, 180000);
    };
    // Un pilote Vulkan/ROCm absent ou trop ancien ne se voit qu'au lancement :
    // on retombe alors sur la variante CPU, qui marche partout.
    try {
      await startVariant(requestedVariant);
    } catch (e) {
      await stopEngine();
      if (requestedVariant === 'cpu') throw e;
      await startVariant('cpu');
    }
  })();
  try { await engineStarting; } finally { engineStarting = null; }
}

// GET /api/gguf-models -> installed models + engine status
app.get('/api/gguf-models', (req, res) => {
  try {
    ensureDir(MODELS_DIR);
    const files = fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith('.gguf'));
    const models = files.map((f) => {
      let size = 0; try { size = fs.statSync(path.join(MODELS_DIR, f)).size; } catch {}
      return { name: f, size };
    });
    res.json({ models, variant: detectEngineVariant(), running: !!engineProc, current: engineModelFile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gguf-engine -> which variant this machine will use + whether installed
app.get('/api/gguf-engine', (req, res) => {
  const variant = detectEngineVariant();
  res.json({
    variant,
    installed: !!findExeRecursive(path.join(ENGINE_DIR, variant), engineBinaryName()),
    running: !!engineProc, current: engineModelFile,
  });
});

// POST /api/gguf-load { name, ctx, gpuLayers, variant } -> explicitly load a
// model into memory (LM Studio style). Streams NDJSON: loading -> ready/error.
app.post('/api/gguf-load', async (req, res) => {
  const b = req.body || {};
  const name = path.basename(String(b.name || ''));
  res.setHeader('Content-Type', 'application/x-ndjson');
  if (!name.toLowerCase().endsWith('.gguf')) {
    try { res.write(JSON.stringify({ status: 'error', error: 'Nom de modèle invalide.' }) + '\n'); } catch {}
    return res.end();
  }
  // Heartbeat so the client can show progress while the engine boots.
  try { res.write(JSON.stringify({ status: 'loading', name }) + '\n'); } catch {}
  const hb = setInterval(() => { try { res.write(JSON.stringify({ status: 'loading', name }) + '\n'); } catch {} }, 1500);
  try {
    await ensureEngine(name, b.variant || undefined, { ctx: b.ctx, gpuLayers: b.gpuLayers });
    clearInterval(hb);
    try { res.write(JSON.stringify({ status: 'ready', name, variant: engineVariant, ctx: engineOpts.split('|')[0] }) + '\n'); } catch {}
    res.end();
  } catch (e) {
    clearInterval(hb);
    try { res.write(JSON.stringify({ status: 'error', error: (e && e.message) || String(e) }) + '\n'); } catch {}
    res.end();
  }
});

// POST /api/gguf-unload -> eject the model currently held in memory.
app.post('/api/gguf-unload', async (req, res) => {
  try { await stopEngine(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: (e && e.message) || String(e) }); }
});

// POST /api/gguf-delete { name }
app.post('/api/gguf-delete', async (req, res) => {
  try {
    const name = path.basename(String((req.body && req.body.name) || ''));
    if (!name.toLowerCase().endsWith('.gguf')) return res.status(400).json({ error: 'Nom invalide.' });
    if (engineModelFile === name) await stopEngine();
    fs.unlinkSync(path.join(MODELS_DIR, name));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gguf-pull?repo=owner/name&file=x.gguf  (or url=<direct>) -> NDJSON progress.
// The download is owned by the server, not by the browser request. Closing the
// catalog/model window only detaches this progress stream; it does not cancel.
app.get('/api/gguf-pull', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  let task;
  try {
    task = startGgufPullTask({
      repo: String(req.query.repo || '').trim(),
      file: String(req.query.file || '').trim(),
      url: String(req.query.url || '').trim(),
    });
  } catch (e) {
    try { res.write(JSON.stringify({ status: 'error', error: e.message }) + '\n'); } catch {}
    try { res.end(); } catch {}
    return;
  }

  let closed = false;
  let lastPayload = '';
  const writeSnapshot = () => {
    if (closed) return;
    const payload = JSON.stringify(ggufPullSnapshot(task));
    if (payload === lastPayload && !terminalGgufPullStatus(task.status)) return;
    lastPayload = payload;
    try { res.write(payload + '\n'); } catch { closed = true; }
    if (terminalGgufPullStatus(task.status)) {
      closed = true;
      clearInterval(timer);
      try { res.end(); } catch {}
    }
  };
  const timer = setInterval(writeSnapshot, 300);
  req.on('close', () => { closed = true; clearInterval(timer); });
  writeSnapshot();
});

app.get('/api/gguf-pulls', (req, res) => {
  sweepGgufPullTasks();
  res.json({ tasks: Array.from(ggufPullTasks.values()).map(ggufPullSnapshot) });
});

app.post('/api/gguf-pull-cancel', (req, res) => {
  const id = String((req.body && req.body.id) || req.query.id || '').trim();
  const task = ggufPullTasks.get(id);
  if (!task) return res.status(404).json({ error: 'Téléchargement introuvable.' });
  if (!terminalGgufPullStatus(task.status)) task.ac.abort();
  res.json({ success: true, task: ggufPullSnapshot(task) });
});

// GET /api/gguf-engine-pull?variant=cpu|cuda|vulkan -> download the engine, NDJSON progress
app.get('/api/gguf-engine-pull', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  try {
    const variant = String(req.query.variant || detectEngineVariant());
    await ensureEngineBinary(variant, (p) => { try { res.write(JSON.stringify({ status: p.stage, pct: p.pct, part: p.part, parts: p.parts }) + '\n'); } catch {} });
    res.write(JSON.stringify({ status: 'success', variant }) + '\n');
    res.end();
  } catch (e) {
    try { res.write(JSON.stringify({ status: 'error', error: e.message }) + '\n'); } catch {}
    try { res.end(); } catch {}
  }
});

// ---------------------------------------------------------------------------
// AI CHAT API
// ---------------------------------------------------------------------------

app.get('/api/rust-core/status', (req, res) => res.json(rustAgentBridge.status()));

// ---------------------------------------------------------------------------
// CODESTRALE BRIDGE — the two descriptors the companion app reads.
// ---------------------------------------------------------------------------
// Reaching either of these already proves the secret was valid and an account
// exists (the auth guard answers 401 otherwise), which is exactly how
// codestrale tells "IDE closed" from "IDE open, nobody logged in".

// GET /api/codestrale/ping -> is the bridge alive, and can models actually answer
app.get('/api/codestrale/ping', (req, res) => {
  const core = rustAgentBridge.status();
  res.json({
    ok: true,
    version: APP_VERSION,
    account: req.user ? req.user.email : null,
    // codestrale greys out the composer unless both are true: without the Rust
    // core there is no agent runtime, so no model can answer.
    rustCore: { available: !!core.available, enabled: !!core.enabled },
  });
});

// GET /api/codestrale/models -> provider -> exact models, with readiness
app.get('/api/codestrale/models', async (req, res) => {
  const shared = sharedConfigForUser(req.user);
  // Both local runtimes are optional: a missing Ollama or an empty models
  // folder must leave the cloud providers perfectly usable, so each lookup
  // degrades to an empty list instead of failing the whole catalogue.
  let ollama = [];
  try {
    const url = String(shared.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const answer = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const data = await answer.json();
    ollama = (data.models || []).map((m) => m.name).filter(Boolean);
  } catch {}
  let gguf = [];
  try {
    ensureDir(MODELS_DIR);
    gguf = fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith('.gguf'));
  } catch {}
  res.json(modelCatalog.buildCatalog({
    keys: userApiKeys(req.user),
    ollama,
    gguf,
    ggufCtx: shared.ggufCtx,
  }));
});

app.post('/api/rust-core/decision', async (req, res) => {
  try {
    const result = await rustAgentBridge.decide(req.user.id, req.body || {});
    res.json(result || { resolved: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

async function rustAgentHttp(req, res, next) {
  const status = rustAgentBridge.status();
  if (!status.enabled) return res.status(503).json({ error: 'Core Rust desactive.' });
  if (!status.available) {
    return res.status(503).json({ error: 'Binaire zaalis-agentd introuvable.' });
  }
  let streamOpen = false;
  const wantsStream = req.body && req.body.stream === true || /\bapplication\/x-ndjson\b/i.test(String(req.headers.accept || ''));
  const openStream = (statusCode = 200) => {
    if (streamOpen) return;
    streamOpen = true;
    res.status(statusCode);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  };
  const emit = (event) => {
    if (!wantsStream) return;
    try { openStream(); res.write(JSON.stringify(event) + '\n'); } catch {}
  };
  const controller = new AbortController();
  let computerToken = '';
  let computerSession = null;
  req.once('aborted', () => controller.abort());
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const body = req.body || {};
    const model = String(body.model || '');
    const message = String(body.message || '');
    if ((!model && !Array.isArray(body.team)) || !message.trim()) {
      if (wantsStream) { openStream(400); res.write(JSON.stringify({ type: 'error', error: 'model/team and message are required' }) + '\n'); return res.end(); }
      return res.status(400).json({ error: 'model/team and message are required' });
    }
    if (body.computerControl === true) {
      if (req.isMobile) return res.status(403).json({ error: 'Action indisponible en mode mobile.' });
      computerSession = await automationManager.start({ userId: req.user.id, permissionMode: body.permissionMode || 'supervised' });
      computerToken = crypto.randomBytes(32).toString('base64url');
      computerRuns.set(computerToken, { session: computerSession, userId: req.user.id });
    }
    // A GGUF turn needs the local engine loaded with that exact file first —
    // the single chat already did this, the agent path did not.
    if (model === 'gguf') {
      if (!body.submodel) throw Object.assign(new Error('Aucun modèle GGUF sélectionné.'), { status: 400 });
      const shared = sharedConfigForUser(req.user);
      await ensureEngine(body.submodel, (body.config && body.config.ggufVariant) || shared.ggufVariant, {
        ctx: (body.config && body.config.ggufCtx) || shared.ggufCtx,
        gpuLayers: (body.config && body.config.ggufGpuLayers) !== undefined ? body.config.ggufGpuLayers : shared.ggufGpuLayers,
      });
    }
    const result = await rustAgentBridge.run({
      userId: req.user.id,
      keys: userApiKeys(req.user),
      root: resolveBase(body.root || body.projectRoot),
      model,
      submodel: body.submodel,
      message,
      systemPrompt: body.systemPrompt,
      permissionMode: body.permissionMode || 'supervised',
      language: body.language || 'fr',
      reasoningLevel: body.reasoningLevel,
      images: Array.isArray(body.images) ? body.images : [],
      history: Array.isArray(body.history) ? body.history : [],
      team: Array.isArray(body.team) ? body.team : null,
      mcpServers: rustMcpServersFor(req.user),
      runtimeConfig: computerToken ? {
        computerEndpoint: `http://127.0.0.1:${PORT}/api/internal/rust-computer`,
        computerToken,
      } : undefined,
      signal: controller.signal,
    }, emit);
    if (wantsStream) {
      emit({ type: 'done', result });
      return res.end();
    }
    return res.json(result);
  } catch (error) {
    if (wantsStream) {
      openStream(res.headersSent ? 200 : (error.status || 500));
      try { res.write(JSON.stringify({ type: 'error', error: error.message || String(error) }) + '\n'); } catch {}
      return res.end();
    }
    return res.status(error.status || 500).json({ error: error.message || String(error) });
  } finally {
    if (computerToken) computerRuns.delete(computerToken);
    if (computerSession) {
      try { await automationManager.complete(computerSession); } catch { try { await automationManager.stop(computerSession, 'Tache interrompue.'); } catch {} }
    }
  }
}

app.post('/api/agent-chat', rustAgentHttp);
app.post('/api/rust-agent-team', rustAgentHttp);

// POST /api/chat  { model, submodel, message, systemPrompt, config, reasoningLevel, images }
// images: [{ mime, data(base64) }]  — sent to vision-capable models only.
async function rustChatHttp(req, res, next) {
  const status = rustAgentBridge.status();
  const body = req.body || {};
  const grokImage = body.model === 'grok' && ['grok-imagine-image-quality', 'grok-imagine-image'].includes(body.submodel);
  if (grokImage) return next();
  if (!status.enabled) return res.status(503).json({ error: 'Core Rust desactive.' });
  if (!status.available) {
    return res.status(503).json({ error: 'Binaire zaalis-agentd introuvable.' });
  }
  try {
    if (!body.model || !String(body.message || '').trim()) return res.status(400).json({ error: 'model and message are required' });
    if (body.model === 'gguf') {
      if (!body.submodel) return res.status(400).json({ error: 'Aucun modèle GGUF sélectionné.' });
      await ensureEngine(body.submodel, body.config && body.config.ggufVariant, { ctx: body.config && body.config.ggufCtx, gpuLayers: body.config && body.config.ggufGpuLayers });
    }
    const result = await rustAgentBridge.run({
      userId: req.user.id,
      keys: userApiKeys(req.user),
      root: resolveBase(body.root),
      model: String(body.model),
      submodel: body.submodel,
      message: String(body.message),
      systemPrompt: body.systemPrompt,
      permissionMode: 'read-only',
      language: body.language || 'fr',
      reasoningLevel: body.reasoningLevel,
      images: Array.isArray(body.images) ? body.images : [],
      history: Array.isArray(body.history) ? body.history : [],
      mcpServers: rustMcpServersFor(req.user),
      runtimeConfig: {
        ollamaUrl: req.isMobile
          ? sharedConfigForUser(req.user).ollamaUrl
          : body.config && body.config.ollamaUrl,
        ggufUrl: `http://127.0.0.1:${ENGINE_PORT}`,
      },
      signal: (() => {
        const controller = new AbortController();
        req.once('aborted', () => controller.abort());
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        return controller.signal;
      })(),
    }, () => {});
    return res.json({
      response: result.response || '',
      thinking: result.thinking || undefined,
      usage: result.usage || undefined,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || String(error) });
  }
}
app.post('/api/chat', rustChatHttp);

// Image generation is intentionally separate from the conversational core:
// xAI's image endpoint has no agent/tool loop to migrate.
app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const isImage = body.model === 'grok' && ['grok-imagine-image-quality', 'grok-imagine-image'].includes(body.submodel);
  if (!isImage) return res.status(400).json({ error: `Unknown model: ${body.model || ''}` });
  try {
    const key = userApiKeys(req.user).grok || (body.config && body.config.keys && body.config.keys.grok);
    if (!key) return res.json({ response: '[Grok] Aucune cle API configuree.' });
    const data = await fetchJSON('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt: String(body.message || ''), model: body.submodel, n: 1, response_format: 'b64_json' }),
    });
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) return res.json({ response: "Erreur: Aucune image n'a ete generee par l'API." });
    const title = String(body.message || '').replace(/[\[\]()\r\n]+/g, ' ').trim().slice(0, 120);
    return res.json({ response: `![${title}](data:image/png;base64,${b64})` });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
});

// ---------------------------------------------------------------------------
// CHAT HISTORY API
// ---------------------------------------------------------------------------

// GET /api/history?project=...
app.get('/api/history', (req, res) => {
  try {
    const project = req.query.project;
    if (!project) return res.status(400).json({ error: 'project query param is required' });

    const historyPath = path.join(project, '.zaalis', 'history.json');

    if (!fs.existsSync(historyPath)) {
      return res.json([]);
    }

    const raw = fs.readFileSync(historyPath, 'utf-8');
    const data = JSON.parse(raw);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/history  { project, conversations }
app.post('/api/history', (req, res) => {
  try {
    const { project, conversations } = req.body;
    if (!project) return res.status(400).json({ error: 'project is required' });

    const dirPath = path.join(project, '.zaalis');
    fs.mkdirSync(dirPath, { recursive: true });

    const historyPath = path.join(dirPath, 'history.json');
    fs.writeFileSync(historyPath, JSON.stringify(conversations, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auto-Updater API
// ---------------------------------------------------------------------------
const https = require('https');

function parseVersionTag(tag) {
  const match = String(tag || '').trim().match(/v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return match.slice(1).map(n => parseInt(n, 10));
}

function compareVersionTags(a, b) {
  const va = parseVersionTag(a);
  const vb = parseVersionTag(b);
  if (!va || !vb) return String(a || '').toLowerCase().localeCompare(String(b || '').toLowerCase());
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

// Proxy endpoint: check GitHub releases server-side (no CSP/CORS issues)
app.get('/api/check-update', async (req, res) => {
  try {
    const ghRes = await fetch('https://api.github.com/repos/zaalis/zaalis-labs-ide/releases/latest', {
      headers: { 'User-Agent': 'zaalis-ide-updater', Accept: 'application/vnd.github.v3+json' }
    });
    if (!ghRes.ok) return res.status(502).json({ error: 'GitHub API error ' + ghRes.status });
    const release = await ghRes.json();
    // Une release publie les paquets des trois plateformes : on prend celui de
    // Linux. Le .deb est prioritaire (installation propre, mises à jour gérées
    // par apt) et l'AppImage sert de repli pour les distributions non Debian.
    const assets = release.assets || [];
    const asset = assets.find((a) => /\.deb$/i.test(a.name)) || assets.find((a) => /\.AppImage$/i.test(a.name));
    const latestVersion = release.tag_name || null;
    const updateAvailable = latestVersion ? compareVersionTags(latestVersion, APP_VERSION) > 0 : false;
    // On a deja installe exactement ce tag et on annonce toujours une version
    // plus ancienne : le paquet publie n'a pas ete compile a la version que le
    // tag annonce. Sans le signaler, l'IDE repropose la meme mise a jour sans
    // fin et elle a l'air d'echouer alors qu'elle a reussi.
    res.json({
      tag_name: latestVersion,
      name: release.name || latestVersion || null,
      currentVersion: APP_VERSION,
      updateAvailable,
      tagMismatch: updateAvailable && !!latestVersion && readLastUpdateTag() === latestVersion,
      downloadUrl: asset ? asset.browser_download_url : null
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
let downloadProgress = 0;
let downloadedInstallerPath = null;
let pendingUpdateTag = null;

// On retient le tag de la derniere release installee : c'est ce qui permet a
// /api/check-update de distinguer une vraie nouvelle version d'un tag dont le
// paquet publie a ete compile a une autre version.
const LAST_UPDATE_TAG_FILE = path.join(DATA_DIR, 'last-update-tag');
function tagFromUpdateUrl(raw) {
  const m = String(raw || '').match(/\/releases\/download\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : null;
}
function readLastUpdateTag() {
  try { return fs.readFileSync(LAST_UPDATE_TAG_FILE, 'utf8').trim() || null; } catch { return null; }
}

// Only accept installer URLs from GitHub (where releases are published) so the
// endpoint can't be used to download and launch an arbitrary binary.
function isTrustedUpdateUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.githubusercontent.com');
  } catch { return false; }
}

app.post('/api/update/download', (req, res) => {
  try {
    const dlUrl = req.body.url;
    if (!dlUrl) return res.status(400).json({ error: 'Missing URL' });
    if (!isTrustedUpdateUrl(dlUrl)) return res.status(400).json({ error: 'URL de mise a jour non autorisee.' });
    pendingUpdateTag = tagFromUpdateUrl(dlUrl);

    // On garde l'extension publiee par la release (.deb ou .AppImage) : c'est
    // elle qui decide de l'outil d'installation cote /api/update/install.
    const suffix = /\.AppImage$/i.test(String(dlUrl).split('?')[0]) ? '.AppImage' : '.deb';
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const dest = path.join(fs.existsSync(downloadsDir) ? downloadsDir : os.tmpdir(), `zaalis-update${suffix}`);
    downloadProgress = 0;
    downloadedInstallerPath = null;
    try { fs.unlinkSync(dest); } catch {}

    // Use plain https with manual redirect following (most compatible with pkg).
    function doDownload(fileUrl, redirects) {
      if (redirects > 10) { downloadProgress = -1; return; }
      const mod = fileUrl.startsWith('https') ? https : require('http');
      mod.get(fileUrl, { headers: { 'User-Agent': 'zaalis-updater' } }, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
          return doDownload(response.headers.location, redirects + 1);
        }
        if (response.statusCode !== 200) {
          downloadProgress = -1;
          return;
        }
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;
        const file = fs.createWriteStream(dest);
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize > 0) downloadProgress = Math.round((downloadedSize / totalSize) * 100);
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          downloadedInstallerPath = dest;
          downloadProgress = 100;
        });
      }).on('error', () => { downloadProgress = -1; fs.unlink(dest, () => {}); });
    }

    doDownload(dlUrl, 0);
    res.json({ success: true, dest });
  } catch (err) {
    downloadProgress = -1;
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/update/progress', (req, res) => {
  res.json({ progress: downloadProgress, dest: downloadedInstallerPath });
});

// Le binaire a relancer une fois la mise a jour posee. APPIMAGE designe le
// fichier AppImage lui-meme (et non le point de montage temporaire), et une
// installation par paquet pose le shell Electron dans /opt.
function relaunchTarget() {
  for (const candidate of [process.env.APPIMAGE, '/opt/zaalis-ide/zaalis-ide', '/usr/local/bin/zaalis-ide']) {
    if (!candidate) continue;
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

// Citation pour /bin/sh : les chemins viennent de nous, mais un dossier
// personnel contenant une apostrophe suffirait a casser le script.
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// Mise a jour silencieuse : les fichiers installes sont remplaces et l'IDE
// revient tout seul, sans un seul ecran d'assistant — ce qu'on attend d'une
// application de bureau.
//
// Sur Linux, ecrire dans /opt demande les droits root, que ce serveur n'a pas
// et ne doit pas avoir. pkexec est ce qui s'en approche le plus : une seule
// fenetre d'authentification du bureau, puis plus aucune question. Un AppImage,
// lui, appartient a l'utilisateur et se remplace sans aucune invite.
app.post('/api/update/install', (req, res) => {
  try {
    if (process.platform !== 'linux') {
      return res.status(400).json({ error: 'Mise a jour automatique disponible sur Linux uniquement.' });
    }
    const installerPath = downloadedInstallerPath;
    if (!installerPath || !fs.existsSync(installerPath)) {
      return res.status(409).json({ error: 'Installer not downloaded yet.' });
    }

    // La mise a jour ne peut pas etre pilotee d'ici : elle doit remplacer
    // zaalis-server, c'est-a-dire *ce* processus. On confie donc le travail a un
    // script detache qui nous survit.
    const updateLog = path.join(os.tmpdir(), 'zaalis-update.log');
    const scriptPath = path.join(os.tmpdir(), 'zaalis-update-runner.sh');
    const isAppImage = /\.AppImage$/i.test(installerPath);
    const appImagePath = isAppImage ? process.env.APPIMAGE : null;
    const relaunch = relaunchTarget();

    const install = isAppImage
      // Un AppImage est un simple fichier appartenant a l'utilisateur : on ecrit
      // le nouveau par-dessus l'ancien, sans elevation ni invite. Sans savoir
      // quel fichier remplacer (IDE lance autrement que par l'AppImage), il ne
      // reste que le repli manuel.
      ? (appImagePath
          ? [`cp -f ${shQuote(installerPath)} ${shQuote(appImagePath)} && chmod +x ${shQuote(appImagePath)} || fallback`]
          : [`chmod +x ${shQuote(installerPath)}`, 'fallback'])
      // apt-get regle les dependances quand la nouvelle version en ajoute ; dpkg
      // prend le relais sur une distribution sans apt. Les deux dans le meme
      // pkexec : une seule authentification demandee a l'utilisateur.
      : [`pkexec env DEBIAN_FRONTEND=noninteractive sh -c 'apt-get install -y --allow-downgrades "$1" || dpkg -i "$1"' sh ${shQuote(installerPath)} || fallback`];

    const script = [
      '#!/bin/sh',
      '# Genere par zaalis IDE pour installer une mise a jour. Se supprime a la fin.',
      // Rien ne lit ce journal au demarrage, mais c'est la seule trace qui reste
      // si une mise a jour silencieuse echoue : l'interface a disparu depuis
      // longtemps. C'est donc par la qu'on diagnostique.
      `exec >>${shQuote(updateLog)} 2>&1`,
      'echo "--- zaalis update $(date 2>/dev/null) ---"',
      '',
      '# Elevation refusee, polkit absent, paquet casse... : on retombe sur le',
      '# gestionnaire de paquets graphique du bureau, qui a sa propre elevation.',
      "# L'utilisateur n'est jamais laisse avec une application fermee ET non mise a jour.",
      'fallback() {',
      `  xdg-open ${shQuote(installerPath)} 2>/dev/null || true`,
      `  rm -f ${shQuote(scriptPath)}`,
      '  exit 0',
      '}',
      '',
      "# Laisse la reponse HTTP atteindre l'interface avant que l'application ne tombe.",
      'sleep 1',
      "# On ferme nous-memes plutot que de compter sur l'installateur : le coeur",
      '# Rust survit a son parent, et le shell Electron rouvrirait une interface',
      "# servie par des fichiers en train d'etre remplaces.",
      'pkill -x zaalis-agentd 2>/dev/null || true',
      'pkill -x zaalis-server 2>/dev/null || true',
      'pkill -x zaalis-ide 2>/dev/null || true',
      '# Laisse le temps aux processus de rendre leurs fichiers.',
      'sleep 2',
      '',
      ...install,
      '',
      relaunch ? `setsid ${shQuote(relaunch)} >/dev/null 2>&1 &` : '# aucun shell installe a relancer',
      `rm -f ${shQuote(scriptPath)}`,
      ''
    ].join('\n');

    fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });

    // On note le tag qu'on installe. Si la prochaine verification le repropose,
    // c'est que le paquet publie ne correspond pas a son tag (voir
    // /api/check-update).
    try {
      if (pendingUpdateTag) fs.writeFileSync(LAST_UPDATE_TAG_FILE, pendingUpdateTag, 'utf8');
    } catch {}

    // detached place le script dans sa propre session : il survit donc a notre
    // arret, qui arrive une seconde plus tard. L'environnement complet est
    // transmis a dessein — sans DISPLAY ni DBUS_SESSION_BUS_ADDRESS, pkexec n'a
    // aucune fenetre ou demander le mot de passe.
    const child = spawn('/bin/sh', [scriptPath], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir(),
      env: execEnv()
    });
    child.on('error', () => {});
    child.unref();

    res.json({ success: true, installerPath, silent: true, log: updateLog });

    // On s'arrete proprement pour que le moteur GGUF tombe avec nous. Fermer la
    // fenetre Electron est laisse au script : il tue zaalis-ide juste apres, et
    // le faire ici aussi n'ajouterait qu'un doublon.
    setTimeout(() => {
      try { if (engineProc) engineProc.kill(); } catch {}
      process.exit(0);
    }, 600);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REMOTE CONTROL — pair a phone to this PC over a Cloudflare quick tunnel
// ---------------------------------------------------------------------------
// The desktop user starts it -> we boot `cloudflared`, which opens a public
// HTTPS URL forwarding to this local server. A signed pairing token in the QR
// lets the phone authenticate. The mobile session is restricted to chat
// endpoints only (never files/exec). Stopping (from PC or phone) kills the
// tunnel and bumps an epoch so every outstanding mobile token is invalid.
const MOBILE_COOKIE = 'zaalis_mobile';
let cfProc = null;        // cloudflared child process
let cfUrl = null;         // https://xxx.trycloudflare.com (null when down)
let cfStartedAt = 0;
let cfStarting = null;    // in-flight start promise (dedupe concurrent starts)
let mobileEpoch = 1;      // bump to invalidate every outstanding mobile token
let tunnelProxy = null;
let tunnelProxyPort = 0;

function cloudflaredPath() {
  const candidates = [
    path.join(APP_DIR, 'cloudflared'),          // next to the packaged app
    path.join(APP_DIR, 'native', 'cloudflared'), // dev (repo root)
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { try { fs.chmodSync(p, 0o755); } catch {} return p; } } catch {}
  }
  return 'cloudflared'; // last resort: rely on PATH
}

function makeMobileToken(userId) {
  const payload = userId + '|' + mobileEpoch;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('mobile:' + payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}
function verifyMobileToken(token) {
  if (!token || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, idx), sig = token.slice(idx + 1);
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64url').toString('utf8'); } catch { return null; }
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update('mobile:' + payload).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  const [uid, epoch] = payload.split('|');
  if (parseInt(epoch, 10) !== mobileEpoch) return null; // revoked by a stop
  return uid;
}
function mobileUser(req) {
  const uid = verifyMobileToken(parseCookies(req)[MOBILE_COOKIE]);
  if (!uid) return null;
  return loadUsers().find((u) => u.id === uid) || null;
}
// Endpoints an internet-facing mobile session may call. Everything else
// (files, exec, grep, glob, gitdiff, tunnel start, profile…) stays desktop-only.
function ensureTunnelProxy() {
  if (tunnelProxy && tunnelProxyPort) return Promise.resolve(tunnelProxyPort);
  return new Promise((resolve, reject) => {
    const proxy = http.createServer((incoming, outgoing) => {
      let parsed;
      try { parsed = new URL(incoming.url || '/', 'http://tunnel.invalid'); }
      catch { outgoing.writeHead(400).end(); return; }
      if (!tunnelRouteAllowed(incoming.method, parsed.pathname)) {
        outgoing.writeHead(403, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'Action indisponible via le tunnel.' }));
        return;
      }
      const headers = {
        ...incoming.headers,
        host: `127.0.0.1:${PORT}`,
        [TUNNEL_HEADER]: TUNNEL_ORIGIN_TOKEN,
      };
      delete headers.connection;
      const upstream = http.request({
        host: '127.0.0.1', port: PORT, method: incoming.method,
        path: incoming.url, headers,
      }, (response) => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'Tunnel local indisponible.' }));
      });
      incoming.pipe(upstream);
    });
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address();
      if (!address || typeof address === 'string') {
        proxy.close();
        reject(new Error('Port proxy tunnel invalide.'));
        return;
      }
      tunnelProxy = proxy;
      tunnelProxyPort = address.port;
      resolve(tunnelProxyPort);
    });
  });
}

function stopTunnel() {
  mobileEpoch++;                       // every paired phone is now logged out
  if (cfProc) { try { cfProc.kill(); } catch {} }
  if (tunnelProxy) { try { tunnelProxy.close(); } catch {} }
  tunnelProxy = null; tunnelProxyPort = 0;
  cfProc = null; cfUrl = null; cfStartedAt = 0; cfStarting = null;
}

function startTunnel() {
  if (cfUrl) return Promise.resolve(cfUrl);
  if (cfStarting) return cfStarting;
  cfStarting = ensureTunnelProxy().then((proxyPort) => new Promise((resolve, reject) => {
    let settled = false, proc;
    try {
      proc = spawn(cloudflaredPath(),
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${proxyPort}`],
        { windowsHide: true });
    } catch (e) { cfStarting = null; return reject(e); }
    cfProc = proc;
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) { settled = true; cfUrl = m[0]; cfStartedAt = Date.now(); resolve(cfUrl); }
    };
    proc.stdout && proc.stdout.on('data', onData);
    proc.stderr && proc.stderr.on('data', onData);
    proc.on('error', (e) => { if (!settled) { settled = true; cfStarting = null; cfProc = null; reject(e); } });
    proc.on('exit', () => {
      if (!settled) { settled = true; cfStarting = null; cfProc = null; reject(new Error('cloudflared exited')); }
      else { cfUrl = null; cfProc = null; } // tunnel died after being up
    });
    setTimeout(() => {
      if (!settled) { settled = true; try { proc.kill(); } catch {} cfStarting = null; cfProc = null; reject(new Error('Tunnel timeout (30s)')); }
    }, 30000);
  }));
  return cfStarting;
}

// POST /api/remote/start (desktop only) -> { url, qr, since }
app.post('/api/remote/start', async (req, res) => {
  if (req.isMobile) return res.status(403).json({ error: 'Indisponible en mode mobile.' });
  if (!QRCode) return res.status(500).json({ error: 'Module QR indisponible (npm install qrcode).' });
  try {
    const url = await startTunnel();
    const token = makeMobileToken(req.user.id);
    const pairUrl = `${url}/m?t=${encodeURIComponent(token)}`;
    const qr = await QRCode.toDataURL(pairUrl, { margin: 1, width: 320, color: { dark: '#0a0a0c', light: '#ffffff' } });
    res.json({ url: pairUrl, qr, since: cfStartedAt });
  } catch (e) {
    stopTunnel();
    res.status(500).json({ error: e.message || 'Échec du démarrage du tunnel.' });
  }
});

// POST /api/remote/stop (desktop or phone) — kills the tunnel + revokes tokens.
// Reply FIRST, then tear the tunnel down a moment later, so a phone stopping its
// own session still receives the confirmation before its link drops.
app.post('/api/remote/stop', (req, res) => {
  res.json({ success: true });
  setTimeout(stopTunnel, 400);
});

// GET /api/remote/status -> { active, since }
app.get('/api/remote/status', (req, res) => { res.json({ active: !!cfUrl, since: cfStartedAt }); });

// GET /m — pairing entry + mobile app shell (public; not under the /api gate).
// With ?t=<token>: validate, drop the mobile cookie, redirect to a clean /m.
app.get('/m', (req, res) => {
  const t = req.query.t;
  if (t) {
    const uid = verifyMobileToken(String(t));
    if (uid) {
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? ' Secure;' : '';
      res.setHeader('Set-Cookie', `${MOBILE_COOKIE}=${String(t)}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=604800`);
      return res.redirect('/m');
    }
    // invalid/expired -> fall through; the app shows a "not paired" screen
  }
  res.sendFile(path.join(APP_DIR, 'interface', 'mobile', 'index.html'));
});

// Kill the tunnel when the server exits.
process.on('exit', () => { try { if (cfProc) cfProc.kill(); } catch {} });

// Ferme totalement l'IDE : on demande a la coquille Electron de quitter, puis on
// arrete ce serveur. Utilise par le bouton "Fermer l'IDE" du modal de mise a
// jour, pour liberer les fichiers avant l'installation du nouveau paquet.
//
// Electron lance ce serveur comme processus enfant et lui transmet son PID :
// un SIGTERM sur ce PID declenche la fermeture propre de la fenetre. Sans PID
// connu (lancement en dev), on se contente d'arreter le serveur.
app.post('/api/app/close', (req, res) => {
  res.json({ success: true });
  setTimeout(() => {
    try { if (engineProc) engineProc.kill(); } catch {}
    const shellPid = parseInt(process.env.ZAALIS_SHELL_PID || '', 10);
    if (Number.isFinite(shellPid) && shellPid > 1) {
      try { process.kill(shellPid, 'SIGTERM'); } catch {}
    }
    process.exit(0);
  }, 300);
});

// Don't leave the GGUF engine running after the server dies.
process.on('exit', () => { try { if (engineProc) engineProc.kill(); } catch {} });

// ---------------------------------------------------------------------------
// Auto-start Ollama in the background (only if it isn't already running).
// We never stop it on exit — if it was already up, we leave it untouched.
// ---------------------------------------------------------------------------
async function startOllamaIfNeeded() {
  if (process.platform !== 'linux') return;
  try {
    await fetch('http://127.0.0.1:11434/api/tags');
    return; // already running -> do nothing
  } catch {}
  // Le paquet officiel installe un service systemd : s'il existe, c'est lui qui
  // doit demarrer Ollama, pas nous. On ne lance le binaire a la main que pour
  // les installations manuelles (~/.local/bin, /usr/local/bin).
  const candidates = [
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    path.join(os.homedir(), '.local', 'bin', 'ollama'),
    'ollama',
  ];
  const exe = candidates.find((p) => p !== 'ollama' && fs.existsSync(p)) || 'ollama';
  try {
    const child = spawn(exe, ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: execEnv()
    });
    // CRITICAL: listen for 'error' so Node doesn't crash on ENOENT / EACCES.
    child.on('error', () => { /* Ollama failed to start -> ignore */ });
    child.unref();
  } catch { /* Ollama not installed -> ignore */ }
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
// Listen on the default (dual-stack) interface so both http://localhost
// (IPv6 ::1) and http://127.0.0.1 (IPv4) work. Network exposure is still
// blocked at the application layer: the loopback guard above returns 403 to
// any request whose remote address is not a loopback address.
const server = app.listen(PORT, () => {
  const address = server.address();
  // The bound port, not the requested one, is what codestrale must dial.
  const bound = (address && typeof address === 'object' && address.port) || PORT;
  console.log(`Server running on http://localhost:${bound} (local access only)`);
  publishCodestraleBridge(bound);
  startOllamaIfNeeded();
});

// Stop advertising a bridge that is going away. `exit` covers the normal path;
// the signals cover the IDE shell closing the server — Node's default handler
// is replaced once we listen, so each one has to terminate explicitly.
process.on('exit', unpublishCodestraleBridge);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    unpublishCodestraleBridge();
    process.exit(0);
  });
}
