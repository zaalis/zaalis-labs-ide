const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const { runAgentTurn } = require('./agent-engine');
// QR generation for the phone remote-control pairing. Guarded so a missing
// install never prevents the server from booting.
let QRCode = null;
try { QRCode = require('qrcode'); } catch {}

const app = express();
const PORT = Number(process.env.ZAALIS_PORT || process.env.PORT) || 3000;

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
// When packaged, the data lives in %LOCALAPPDATA%\zaalis\server-data — a
// stable per-user location that survives app updates and reinstalls
// (storing it next to the exe meant losing accounts/chats on every update).
function resolveDataDir() {
  // When packaged with pkg, the executable can live in a read-only install
  // location. Keep accounts/chats/session secret in a stable per-user folder.
  if (process.pkg) {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      return path.join(process.env.LOCALAPPDATA, 'zaalis', 'server-data');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'zaalis', 'server-data');
    }
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'zaalis', 'server-data');
  }
  return path.join(APP_DIR, 'server-data');
}

function ensureWritableDataDir() {
  const preferred = resolveDataDir();
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'zaalis', 'server-data');
    try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
    return fallback;
  }
}
const DATA_DIR = ensureWritableDataDir();
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const COOKIE_NAME = 'zaalis_session';

// One-time migration: copy data from the old location (next to the exe)
// so existing accounts and chats are kept.
const LEGACY_DATA_DIR = path.join(APP_DIR, 'server-data');
if (path.resolve(DATA_DIR) !== path.resolve(LEGACY_DATA_DIR) &&
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
const KEY_PROVIDERS = ['openai', 'anthropic', 'google', 'grok', 'mistral'];
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

function loadUsers() {
  try {
    let raw = fs.readFileSync(USERS_FILE, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolerate a UTF-8 BOM
    const d = JSON.parse(raw);
    return Array.isArray(d) ? d : [d];                    // tolerate a single object
  } catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
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
function chatsFile(userId, kind) {
  // kind: 'chat' (single chat) or 'agents' (multi-agent). Kept in separate files.
  const k = kind === 'agents' ? 'agents' : 'chat';
  return path.join(CHATS_DIR, `${userId}__${k}.json`);
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
  setSessionCookie(res, makeToken(user.id));
  res.json({ email: user.email, profile: user.profile || { pseudo: user.email.split('@')[0], photo: '' } });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  // Status check: always 200 so the browser console isn't polluted with a 401.
  const user = currentUser(req);
  res.json({
    authenticated: !!user,
    email: user ? user.email : null,
    profile: user ? (user.profile || { pseudo: user.email.split('@')[0], photo: '' }) : null
  });
});

// ---------------------------------------------------------------------------
// AUTH GUARD — every other /api/* route requires a valid session
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/check-update') return next();
  const user = currentUser(req);
  if (user) { req.user = user; return next(); }
  // Phone remote-control session: a signed pairing cookie, restricted to a safe
  // subset of endpoints (chat only — never files/exec/tunnel-start).
  const mUser = mobileUser(req);
  if (mUser) {
    if (!mobileAllowed(req.path)) return res.status(403).json({ error: 'Action indisponible en mode mobile.' });
    req.user = mUser;
    req.isMobile = true;
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
  // Dynamic import of node-fetch is avoided; use the global fetch available
  // in Node 18+. For older versions, install node-fetch.
  const res = await fetch(url, options);
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
    if (!req.query.root && !fullPath.startsWith(APP_DIR)) {
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

    if (!req.query.root && !fullPath.startsWith(APP_DIR)) {
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

    if (!root && !fullPath.startsWith(APP_DIR)) {
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

// POST /api/exec  { command, cwd }
// Linux builds execute commands through the system POSIX shell.
app.post('/api/exec', (req, res) => {
  try {
    const { command, cwd } = req.body;
    if (!command) return res.status(400).json({ error: 'command is required' });

    const execCwd = cwd || APP_DIR;

    execFile('/bin/sh', ['-lc', command], {
      cwd: execCwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5
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
      if (process.platform === 'win32') {
        execFile('cmd.exe', ['/c', `${name} --version`], { timeout: 5000, windowsHide: true }, done);
      } else {
        execFile(name, ['--version'], { timeout: 5000 }, done);
      }
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

// POST /api/grep  { root, pattern, path?, glob?, ignoreCase?, maxResults? }
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
      execFile('rg', args, { cwd: base, timeout: 15000, maxBuffer: 1024 * 1024 * 8, windowsHide: true }, (err, stdout, stderr) => {
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
      execFile('git', ['-C', base, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 * 16, windowsHide: true },
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
    try { const v = detectEngineVariant(); gguf = { variant: v, installed: !!findExeRecursive(path.join(ENGINE_DIR, v), 'llama-server.exe') }; } catch {}

    const installerPaths = [
      path.join(APP_DIR, 'native', 'installer', 'zaalis-linux-x64.deb'),
      path.join(process.cwd(), 'native', 'installer', 'zaalis-linux-x64.deb'),
    ];
    const installer = installerPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });

    let scripts = [];
    try { const pj = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8')); scripts = Object.keys(pj.scripts || {}); } catch {}

    let projectGit = null;
    if (base && git.available) {
      projectGit = await new Promise((resolve) => {
        execFile('git', ['-C', base, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000, windowsHide: true },
          (e, so) => resolve(e ? null : String(so || '').trim()));
      });
    }

    res.json({
      version: APP_VERSION,
      node: process.version,
      npm, git, rg, ollama, gguf, installer,
      installerPath: 'native/installer/zaalis-linux-x64.deb',
      scripts, projectGit,
      platform: process.platform,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// FOLDER PICKER — opens the native OS folder dialog (local app)
// ---------------------------------------------------------------------------
// POST /api/pick-folder  -> { path } | { cancelled: true }
app.post('/api/pick-folder', (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'Folder picker only available on Windows.' });
  }

  // Prefer the bundled modern Explorer-style picker (pickfolder.exe).
  const picker = path.join(APP_DIR, 'pickfolder.exe');
  if (fs.existsSync(picker)) {
    execFile(picker, { timeout: 180000, windowsHide: true }, (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message });
      const selected = (stdout || '').trim();
      if (!selected) return res.json({ cancelled: true });
      res.json({ path: selected });
    });
    return;
  }

  // Fallback (dev): old FolderBrowserDialog via PowerShell.
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
    "$d.Description = 'Choisissez le dossier du projet';",
    '$d.ShowNewFolderButton = $true;',
    '$null = $d.ShowDialog();',
    '[Console]::Out.Write($d.SelectedPath)',
  ].join(' ');
  // Use execFile to launch PowerShell directly (no intermediate cmd.exe shell)
  // with windowsHide:true so no console window flashes.
  const psArgs = ['-NoProfile', '-STA', '-Command', ps];

  execFile('powershell.exe', psArgs, { timeout: 120000, windowsHide: true }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const selected = (stdout || '').trim();
    if (!selected) return res.json({ cancelled: true });
    res.json({ path: selected });
  });
});

// GET /api/ollama-models?url=...  -> { models: [names] }
app.get('/api/ollama-models', async (req, res) => {
  try {
    const url = (req.query.url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
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
// We download the official llama.cpp `llama-server.exe` build that matches the
// machine (CUDA / Vulkan / CPU) into %LOCALAPPDATA%\zaalis\engine, spawn it as a
// child process, and proxy chat to its OpenAI-compatible /v1/chat/completions.
// This is exactly how LM Studio / Jan work, but fully self-contained.
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
  if (process.platform !== 'win32') { _gpuVariant = 'cpu'; return _gpuVariant; }
  let names = '';
  try {
    names = execSyncSafe('powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name -join \';\'"');
  } catch {}
  if (!names) { try { names = execSyncSafe('wmic path win32_VideoController get name'); } catch {} }
  names = (names || '').toLowerCase();
  if (/nvidia|geforce|rtx|quadro|tesla/.test(names)) _gpuVariant = 'cuda';
  else if (/amd|radeon|intel|arc|iris/.test(names)) _gpuVariant = 'vulkan';
  else _gpuVariant = 'cpu';
  return _gpuVariant;
}
function execSyncSafe(cmd) {
  const { execSync } = require('child_process');
  return execSync(cmd, { timeout: 9000, windowsHide: true }).toString();
}

function engineAssetUrls(variant) {
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`;
  if (variant === 'cuda') return [
    base + `llama-${LLAMA_TAG}-bin-win-cuda-12.4-x64.zip`,
    base + `cudart-llama-bin-win-cuda-12.4-x64.zip`,   // CUDA runtime DLLs
  ];
  if (variant === 'vulkan') return [base + `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`];
  return [base + `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`];
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

// Extract a .zip. Tricky on Windows:
//  - the SYSTEM tar (C:\Windows\System32\tar.exe = bsdtar) reads zip, but a bare
//    "tar" may resolve to Git's GNU tar (no zip support), so we call it by full
//    path. bsdtar also reads "C:\path" as host:path, so we cd into the folder
//    and pass a relative name (no colon).
//  - if that fails, fall back to PowerShell's Expand-Archive (always present).
function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  const { execSync } = require('child_process');
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(sysTar)) {
    try {
      execSync(`"${sysTar}" -xf "${path.basename(zipPath)}" -C .`, {
        cwd: path.dirname(zipPath), timeout: 180000, windowsHide: true,
      });
      return;
    } catch { /* fall through to PowerShell */ }
  }
  const q = (s) => s.replace(/'/g, "''");
  const ps = `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(destDir)}' -Force`;
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, { timeout: 300000, windowsHide: true });
}

// Ensure the engine binary for `variant` exists; returns the llama-server.exe path.
// Downloads + extracts on first use, reporting progress via onLog({stage, pct}).
const engineExePaths = {};
async function ensureEngineBinary(variant, onLog) {
  if (engineExePaths[variant] && fs.existsSync(engineExePaths[variant])) return engineExePaths[variant];
  const vdir = path.join(ENGINE_DIR, variant);
  let exe = findExeRecursive(vdir, 'llama-server.exe');
  if (exe) { engineExePaths[variant] = exe; return exe; }
  ensureDir(vdir);
  const urls = engineAssetUrls(variant);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const zip = path.join(vdir, path.basename(url));
    if (onLog) onLog({ stage: 'engine', pct: 0, part: i + 1, parts: urls.length });
    await downloadTo(url, zip, (rec, tot) => {
      if (onLog && tot) onLog({ stage: 'engine', pct: Math.round((rec / tot) * 100), part: i + 1, parts: urls.length });
    });
    if (onLog) onLog({ stage: 'extract', pct: 100, part: i + 1, parts: urls.length });
    extractZip(zip, vdir);
    try { fs.unlinkSync(zip); } catch {}
  }
  exe = findExeRecursive(vdir, 'llama-server.exe');
  if (!exe) throw new Error('llama-server.exe introuvable après extraction.');
  engineExePaths[variant] = exe;
  return exe;
}

// --- Engine process lifecycle (one model loaded at a time, swapped on demand) ---
let engineProc = null, engineModelFile = null, engineVariant = null, engineStarting = null;

function stopEngine() {
  return new Promise((resolve) => {
    if (!engineProc) return resolve();
    const p = engineProc; engineProc = null; engineModelFile = null;
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
let engineOpts = '';

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
  if (engineProc && engineModelFile === modelFile && engineOpts === optsKey) return;
  if (engineStarting) { try { await engineStarting; } catch {} if (engineProc && engineModelFile === modelFile && engineOpts === optsKey) return; }
  engineStarting = (async () => {
    await stopEngine();
    let variant = preferredVariant || detectEngineVariant();
    let exe;
    try { exe = await ensureEngineBinary(variant); }
    catch (e) { if (variant !== 'cpu') { variant = 'cpu'; exe = await ensureEngineBinary('cpu'); } else throw e; }
    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(ENGINE_PORT), '--ctx-size', String(ctx)];
    // Offload layers to the GPU unless we're on the CPU build or the user capped it at 0.
    if (variant !== 'cpu' && ngl > 0) args.push('-ngl', String(ngl));
    engineOpts = optsKey;
    const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore', cwd: path.dirname(exe) });
    proc.on('error', () => {});
    engineProc = proc; engineModelFile = modelFile; engineVariant = variant;
    proc.once('exit', () => { if (engineProc === proc) { engineProc = null; engineModelFile = null; } });
    await waitForHealth(ENGINE_PORT, 180000);
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
    installed: !!findExeRecursive(path.join(ENGINE_DIR, variant), 'llama-server.exe'),
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

// GET /api/gguf-pull?repo=owner/name&file=x.gguf  (or url=<direct>) -> NDJSON progress
app.get('/api/gguf-pull', async (req, res) => {
  const repo = String(req.query.repo || '').trim();
  const file = String(req.query.file || '').trim();
  let url = String(req.query.url || '').trim();
  if (!url && repo && file) url = `https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`;
  if (!url) return res.status(400).json({ error: 'url, ou repo+file requis' });
  let base = path.basename((file || url).split('?')[0]) || `model-${Date.now()}.gguf`;
  if (!base.toLowerCase().endsWith('.gguf')) base += '.gguf';
  const dest = path.join(MODELS_DIR, base);
  const tmp = dest + '.part';
  res.setHeader('Content-Type', 'application/x-ndjson');
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    ensureDir(MODELS_DIR);
    let last = 0;
    await downloadTo(url, tmp, (rec, tot) => {
      const now = Date.now();
      if (now - last > 200 || rec === tot) { last = now; try { res.write(JSON.stringify({ status: 'downloading', completed: rec, total: tot }) + '\n'); } catch {} }
    }, ac.signal);
    fs.renameSync(tmp, dest);
    res.write(JSON.stringify({ status: 'success', name: base }) + '\n');
    res.end();
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (!ac.signal.aborted) { try { res.write(JSON.stringify({ status: 'error', error: e.message }) + '\n'); } catch {} }
    try { res.end(); } catch {}
  }
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

// POST /api/agent-chat
// Shared Claude-Code-style loop used by both the Windows app and the CLI.
// It keeps the provider dispatch in /api/chat, but centralizes project context
// and local tools here so every client sees the same files and behavior.
app.post('/api/agent-chat', async (req, res) => {
  let wantsStream = false;
  let streamOpen = false;
  const openStream = (status = 200) => {
    if (streamOpen) return;
    streamOpen = true;
    if (res.headersSent) return;
    res.status(status);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  };
  const writeStreamEvent = (event) => {
    try {
      openStream();
      res.write(JSON.stringify(event) + '\n');
    } catch {}
  };
  const respondError = (status, message) => {
    if (wantsStream) {
      openStream(status);
      try { res.write(JSON.stringify({ type: 'error', error: message }) + '\n'); } catch {}
      try { res.end(); } catch {}
      return;
    }
    res.status(status).json({ error: message });
  };
  try {
    const b = req.body || {};
    wantsStream = b.stream === true || /\bapplication\/x-ndjson\b/i.test(String(req.headers.accept || ''));
    if (req.isMobile) return respondError(403, 'Action indisponible en mode mobile.');
    const model = b.model;
    const message = String(b.message || '');
    if (!model || !message.trim()) {
      return respondError(400, 'model and message are required');
    }

    const root = resolveBase(b.root || b.projectRoot);
    const cookie = req.headers.cookie || '';
    const callModel = async (payload) => {
      const requestedTimeout = parseInt(payload.timeoutMs, 10);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.max(1000, Math.min(requestedTimeout, 120000))
        : 0;
      const ac = timeoutMs ? new AbortController() : null;
      const timer = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
      if (timer && timer.unref) timer.unref();
      try {
        const cleanPayload = { ...payload };
        delete cleanPayload.timeoutMs;
        return await fetchJSON(`http://127.0.0.1:${PORT}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(cleanPayload),
          ...(ac ? { signal: ac.signal } : {}),
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Appel modele interrompu apres ${Math.round(timeoutMs / 1000)}s.`);
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const result = await runAgentTurn({
      root,
      model,
      submodel: b.submodel,
      message,
      config: b.config || {},
      reasoningLevel: b.reasoningLevel,
      images: Array.isArray(b.images) ? b.images : [],
      history: Array.isArray(b.history) ? b.history : [],
      permissionMode: b.permissionMode || 'supervised',
      language: b.language || 'fr',
      subAgentTimeoutMs: b.subAgentTimeoutMs,
      callModel,
      emitEvent: wantsStream ? writeStreamEvent : undefined,
    });
    if (wantsStream) {
      writeStreamEvent({ type: 'done', result });
      try { res.end(); } catch {}
    } else {
      res.json(result);
    }
  } catch (err) {
    if (wantsStream) {
      openStream(res.headersSent ? 200 : 500);
      try { res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n'); } catch {}
      try { res.end(); } catch {}
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// POST /api/chat  { model, submodel, message, systemPrompt, config, reasoningLevel, images }
// images: [{ mime, data(base64) }]  — sent to vision-capable models only.
app.post('/api/chat', async (req, res) => {
  try {
    const { model, submodel, message, systemPrompt, config, reasoningLevel } = req.body;
    const images = Array.isArray(req.body.images) ? req.body.images : [];
    // Prior conversation turns (memory). Each: { role: 'user'|'assistant', content: string }
    const history = Array.isArray(req.body.history)
      ? req.body.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
    if (!model || !message) {
      return res.status(400).json({ error: 'model and message are required' });
    }

    // API keys come from the encrypted per-user vault. Keys still sent by an
    // older client (pre-1.0.9 localStorage) are accepted as a fallback only.
    const keys = { ...(config?.keys || {}), ...userApiKeys(req.user) };
    const ollamaUrl = config?.ollamaUrl || 'http://127.0.0.1:11434';
    const ollamaModel = config?.ollamaModel || 'llama3';

    let responseText = '';
    let thinkingText = '';
    let usage = null;

    // ----- OpenAI (Codex) -----
    if (model === 'codex') {
      if (!keys.openai) return res.json({ response: '[OpenAI] Aucune cle API configuree.' });

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const h of history) messages.push({ role: h.role, content: h.content });
      messages.push({
        role: 'user',
        content: images.length
          ? [
              { type: 'text', text: message },
              ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
            ]
          : message,
      });

      const payload = { model: submodel || 'gpt-5.5', messages };

      const isReasoningModel = submodel && (submodel.startsWith('o1') || submodel.startsWith('o3') || submodel.startsWith('o4') || submodel.startsWith('gpt-5'));
      if (isReasoningModel && reasoningLevel !== undefined) {
        const efforts = ['low', 'low', 'medium', 'high'];
        payload.reasoning_effort = efforts[reasoningLevel] || 'medium';
      }

      const data = await fetchJSON('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.openai}`,
        },
        body: JSON.stringify(payload),
      });

      responseText = data.choices?.[0]?.message?.content || '';
      if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
    }

    // ----- Anthropic (Claude) -----
    else if (model === 'claude') {
      if (!keys.anthropic) return res.json({ response: '[Claude] Aucune cle API configuree.' });

      const claudeContent = images.length
        ? [
            { type: 'text', text: message },
            ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })),
          ]
        : message;

      const claudeMessages = [];
      for (const h of history) claudeMessages.push({ role: h.role, content: h.content });
      claudeMessages.push({ role: 'user', content: claudeContent });

      const body = {
        model: submodel || 'claude-3-5-sonnet',
        max_tokens: 4096,
        messages: claudeMessages,
      };
      if (systemPrompt) body.system = systemPrompt;

      const isThinkingModel = submodel && (submodel.includes('3.7') || submodel.includes('3-7') || submodel.includes('4.8') || submodel.includes('4-8') || submodel.includes('fable'));
      if (isThinkingModel && reasoningLevel !== undefined && reasoningLevel > 0) {
        const budgets = [0, 1024, 2048, 4096, 8192];
        const budget = budgets[reasoningLevel] || 1024;
        if (budget > 0) {
          body.max_tokens = 10000; // Increase max tokens when thinking is enabled
          body.thinking = { type: 'enabled', budget_tokens: budget };
        }
      }

      const data = await fetchJSON('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': keys.anthropic,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      // Separate the visible answer (text blocks) from the reasoning (thinking blocks).
      responseText = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      thinkingText = (data.content || []).filter((c) => c.type === 'thinking').map((c) => c.thinking || '').join('\n');
      if (data.usage) usage = { input: data.usage.input_tokens, output: data.usage.output_tokens };
    }

    // ----- Google Gemini -----
    else if (model === 'gemini') {
      if (!keys.google) return res.json({ response: '[Gemini] Aucune cle API configuree.' });

      const modelName = submodel || 'gemini-2.5-flash';

      const parts = [{ text: message }];
      images.forEach((img) => parts.push({ inline_data: { mime_type: img.mime, data: img.data } }));

      const contents = [];
      for (const h of history) contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
      contents.push({ role: 'user', parts });

      const payload = { contents };
      if (systemPrompt) payload.system_instruction = { parts: [{ text: systemPrompt }] };

      // Native thinking is supported by Gemini 2.5 / 3.x. The thinkingConfig
      // MUST be nested inside generationConfig — placing it at the payload root
      // makes the Gemini REST API reject the request (400 INVALID_ARGUMENT),
      // which this server then surfaces as a 500.
      const geminiSupportsThinking = /(^|[^a-z])(2\.5|3)/.test(modelName) || modelName.includes('thinking');
      if (reasoningLevel !== undefined && reasoningLevel > 0 && geminiSupportsThinking) {
        const budgets = [0, 1024, 2048, 4096];
        const budget = budgets[reasoningLevel] || 1024;
        if (budget > 0) {
          payload.generationConfig = { ...(payload.generationConfig || {}), thinkingConfig: { thinkingBudget: budget } };
        }
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${keys.google}`;
      const data = await fetchJSON(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      responseText = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      if (data.usageMetadata) usage = { input: data.usageMetadata.promptTokenCount, output: data.usageMetadata.candidatesTokenCount };
    }

    // ----- xAI (Grok) -----
    else if (model === 'grok') {
      if (!keys.grok) return res.json({ response: '[Grok] Aucune cle API configuree.' });

      const isImageModel = submodel && (submodel === 'grok-2-image-gen' || submodel === 'grok-image-gen');

      if (isImageModel) {
        const grokModelName = submodel === 'grok-2-image-gen' ? 'grok-imagine-image-pro' : 'grok-imagine-image';
        const grokPayload = {
          prompt: message,
          model: grokModelName,
          n: 1,
          response_format: 'b64_json'
        };

        const data = await fetchJSON('https://api.x.ai/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${keys.grok}`,
          },
          body: JSON.stringify(grokPayload),
        });

        const b64 = data.data?.[0]?.b64_json;
        if (b64) {
          // Use the user's prompt as the image title (sanitized for markdown).
          const title = String(message || '').replace(/[\[\]()\r\n]+/g, ' ').trim().slice(0, 120);
          responseText = `![${title}](data:image/png;base64,${b64})`;
        } else {
          responseText = "Erreur: Aucune image n'a été générée par l'API.";
        }
      } else {
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        for (const h of history) messages.push({ role: h.role, content: h.content });
        messages.push({
          role: 'user',
          content: images.length
            ? [
                { type: 'text', text: message },
                ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
              ]
            : message,
        });

        // The grok-4.x reasoning models reason natively and REJECT the
        // reasoning_effort parameter ("does not support parameter reasoningEffort").
        // Only the small grok-3-mini-style models accept it, and none are in our
        // catalog, so we never send it.
        const grokPayload = { model: submodel || 'grok-4.3', messages };

        const data = await fetchJSON('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${keys.grok}`,
          },
          body: JSON.stringify(grokPayload),
        });

        responseText = data.choices?.[0]?.message?.content || '';
        if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
      }
    }

    // ----- Mistral (Le Chat) -----
    else if (model === 'mistral') {
      if (!keys.mistral) return res.json({ response: '[Mistral] Aucune cle API configuree.' });

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const h of history) messages.push({ role: h.role, content: h.content });
      messages.push({
        role: 'user',
        content: images.length
          ? [
              { type: 'text', text: message },
              ...images.map((img) => ({ type: 'image_url', image_url: `data:${img.mime};base64,${img.data}` })),
            ]
          : message,
      });

      const data = await fetchJSON('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.mistral}`,
        },
        body: JSON.stringify({ model: submodel || 'mistral-large-latest', messages }),
      });

      responseText = data.choices?.[0]?.message?.content || '';
      if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
    }

    // ----- Ollama (Local) -----
    else if (model === 'local') {
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      for (const h of history) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({
        role: 'user',
        content: message,
        ...(images.length ? { images: images.map((img) => img.data) } : {})
      });

      // Use the chosen sub-model if provided, else the configured default model.
      const olModel = submodel || ollamaModel;

      // Estimate total tokens to pick an appropriate num_ctx.
      // Rough estimate: 1 token ≈ 4 chars.
      const totalChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const estimatedTokens = Math.ceil(totalChars / 4);
      // Pick num_ctx from fixed BUCKETS rather than a value that changes on every
      // message. Ollama keeps the model loaded (keep_alive) only while the
      // options stay identical — a num_ctx that varies each turn forces it to
      // evict and reload the model on every request (long freezes / apparent
      // hangs). Buckets keep it stable across turns while still growing for big
      // prompts, which is the single biggest reliability win for local models.
      const needed = estimatedTokens + 2048; // reserve room for the answer
      const numCtx = [8192, 16384, 32768].find((b) => b >= needed) || 32768;
      // num_predict: leave room but don't exceed what the context allows.
      const numPredict = Math.min(8192, Math.max(512, numCtx - estimatedTokens));

      const ollamaBody = {
        model: olModel,
        messages,
        stream: false,
        options: { num_ctx: numCtx, num_predict: Math.max(512, numPredict) },
        keep_alive: '10m'
      };

      // Abort if Ollama takes longer than 5 minutes.
      const ollamaAC = new AbortController();
      const ollamaTimeout = setTimeout(() => ollamaAC.abort(), 300000);
      try {
        const data = await fetchJSON(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ollamaBody),
          signal: ollamaAC.signal,
        });
        clearTimeout(ollamaTimeout);

        responseText = data.message?.content || '';

        // deepseek-r1 etc. embed reasoning inside <think>...</think>.
        const tm = responseText.match(/<think>([\s\S]*?)<\/think>/i);
        if (tm) { thinkingText = tm[1].trim(); responseText = responseText.replace(/<think>[\s\S]*?<\/think>/i, '').trim(); }

        // Strip system prompt echo — some models regurgitate the instructions.
        // Detect and remove if the response starts with a large chunk of the system prompt.
        if (systemPrompt && responseText.length > 0) {
          const sysNorm = systemPrompt.replace(/\s+/g, ' ').slice(0, 200).toLowerCase();
          const resNorm = responseText.replace(/\s+/g, ' ').slice(0, 200).toLowerCase();
          if (resNorm.startsWith(sysNorm.slice(0, 80))) {
            // Find where the echo ends and keep only the original content.
            const idx = responseText.toLowerCase().indexOf(message.slice(0, 40).toLowerCase());
            if (idx > 0) {
              responseText = responseText.slice(idx + message.slice(0, 40).length).trim();
            } else {
              // Brute-force: strip up to the first real paragraph that doesn't match the prompt.
              const lines = responseText.split('\n');
              let cut = 0;
              for (let i = 0; i < lines.length && i < 30; i++) {
                if (systemPrompt.includes(lines[i].trim()) && lines[i].trim().length > 10) cut = i + 1;
                else break;
              }
              if (cut > 0) responseText = lines.slice(cut).join('\n').trim();
            }
          }
        }

        if (data.prompt_eval_count !== undefined) usage = { input: data.prompt_eval_count, output: data.eval_count };
      } catch (ollamaErr) {
        clearTimeout(ollamaTimeout);
        if (ollamaErr.name === 'AbortError') {
          throw new Error('Ollama: délai d\'attente dépassé (5 min). Le modèle est peut-être trop lent ou bloqué.');
        }
        const msg = String((ollamaErr && ollamaErr.message) || ollamaErr);
        if (/ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET|network|socket hang/i.test(msg)) {
          throw new Error("Ollama est introuvable ou arrêté. Vérifie qu'Ollama tourne (l'app tente de le démarrer automatiquement au lancement).");
        }
        if (/not found|try pulling|no such model/i.test(msg)) {
          throw new Error(`Modèle « ${olModel} » introuvable dans Ollama. Installe-le d'abord depuis le catalogue de modèles.`);
        }
        throw new Error('Ollama: ' + msg);
      }
    }

    // ----- GGUF (local, llama.cpp engine — no Ollama) -----
    else if (model === 'gguf') {
      const ggufFile = submodel;
      if (!ggufFile) throw new Error('Aucun modèle GGUF sélectionné.');
      try {
        await ensureEngine(ggufFile, config?.ggufVariant, { ctx: config?.ggufCtx, gpuLayers: config?.ggufGpuLayers });
      } catch (e) {
        throw new Error('Moteur GGUF : ' + (e.message || e));
      }

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const h of history) messages.push({ role: h.role, content: h.content });
      messages.push({ role: 'user', content: message });

      const ggufAC = new AbortController();
      const ggufTimeout = setTimeout(() => ggufAC.abort(), 300000);
      try {
        const data = await fetchJSON(`http://127.0.0.1:${ENGINE_PORT}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'local', messages, stream: false, temperature: 0.7, max_tokens: 2048 }),
          signal: ggufAC.signal,
        });
        clearTimeout(ggufTimeout);
        responseText = data.choices?.[0]?.message?.content || '';
        const tm = responseText.match(/<think>([\s\S]*?)<\/think>/i);
        if (tm) { thinkingText = tm[1].trim(); responseText = responseText.replace(/<think>[\s\S]*?<\/think>/i, '').trim(); }
        if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
      } catch (ggufErr) {
        clearTimeout(ggufTimeout);
        if (ggufErr.name === 'AbortError') throw new Error('Moteur GGUF : délai dépassé (5 min). Modèle trop lent ?');
        throw new Error('Moteur GGUF : ' + (ggufErr.message || ggufErr));
      }
    }

    // ----- Unknown model -----
    else {
      return res.status(400).json({ error: `Unknown model: ${model}` });
    }

    // Final safety net: strip any response that begins with the anti-leak marker
    // or echoes the system instructions (applies to ALL providers).
    if (systemPrompt && responseText) {
      const markers = ['[REGLE ABSOLUE]', '[ABSOLUTE RULE]', 'Tu es un agent de code', 'You are a coding agent', 'Tu es un assistant de code', 'You are a coding assistant'];
      for (const mk of markers) {
        if (responseText.startsWith(mk)) {
          // Find where the actual answer starts (after the echoed prompt).
          const newlineIdx = responseText.indexOf('\n\n', mk.length);
          if (newlineIdx > 0) {
            responseText = responseText.slice(newlineIdx + 2).trim();
          }
          break;
        }
      }
    }

    res.json({ response: responseText, thinking: thinkingText || undefined, usage: usage || undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const asset = (release.assets || []).find(a => a.name === 'zaalis-linux-x64.deb');
    const latestVersion = release.tag_name || null;
    res.json({
      tag_name: latestVersion,
      name: release.name || latestVersion || null,
      currentVersion: APP_VERSION,
      updateAvailable: latestVersion ? compareVersionTags(latestVersion, APP_VERSION) > 0 : false,
      downloadUrl: asset ? asset.browser_download_url : null
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
let downloadProgress = 0;
let downloadedInstallerPath = null;

app.post('/api/update/download', (req, res) => {
  try {
    const dlUrl = req.body.url;
    if (!dlUrl) return res.status(400).json({ error: 'Missing URL' });

    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const dest = path.join(fs.existsSync(downloadsDir) ? downloadsDir : os.tmpdir(), 'zaalis-linux-x64.deb');
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

app.post('/api/update/install', (req, res) => {
  try {
    const installerPath = downloadedInstallerPath || path.join(os.homedir(), 'Downloads', 'zaalis-linux-x64.deb');
    if (!fs.existsSync(installerPath)) {
      return res.status(409).json({ error: 'Installer not downloaded yet.' });
    }

    // Ask the desktop environment to open the Debian package.
    const child = spawn('xdg-open', [installerPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    res.json({ success: true, installerPath });
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

function cloudflaredPath() {
  const candidates = [
    path.join(APP_DIR, 'cloudflared.exe'),          // next to the packaged app
    path.join(APP_DIR, 'native', 'cloudflared.exe'), // dev (repo root)
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
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
function mobileAllowed(p) {
  return /^\/(chat|chats|recent-projects|ollama-models|gguf-models|keys)(\/|$|\?|$)/.test(p)
      || p === '/remote/stop' || p === '/remote/status';
}

function stopTunnel() {
  mobileEpoch++;                       // every paired phone is now logged out
  if (cfProc) { try { cfProc.kill(); } catch {} }
  cfProc = null; cfUrl = null; cfStartedAt = 0; cfStarting = null;
}

function startTunnel() {
  if (cfUrl) return Promise.resolve(cfUrl);
  if (cfStarting) return cfStarting;
  cfStarting = new Promise((resolve, reject) => {
    let settled = false, proc;
    try {
      proc = spawn(cloudflaredPath(),
        ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`],
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
  });
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

// Ferme totalement l'IDE. Sous Electron Linux/macOS, la fenetre observe l'arret
// du serveur et quitte aussi l'app; sous Windows, on ferme le shell WebView.
app.post('/api/app/close', (req, res) => {
  res.json({ success: true });
  setTimeout(() => {
    try { if (engineProc) engineProc.kill(); } catch {}
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/f', '/im', 'zaalis.exe'], {
          detached: true, stdio: 'ignore', windowsHide: true
        }).unref();
      } catch {}
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
  if (process.platform !== 'win32') return;
  try {
    await fetch('http://127.0.0.1:11434/api/tags');
    return; // already running -> do nothing
  } catch {}
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'ollama',
  ];
  // Only try executables that actually exist on disk (skip the bare 'ollama'
  // fallback unless it's the only candidate, AND it resolves in PATH).
  const exe = candidates.find((p) => {
    if (p === 'ollama') return false; // skip bare name; checked below
    return p && fs.existsSync(p);
  });
  if (!exe) return; // Ollama not installed -> silently skip
  try {
    const child = spawn(exe, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // CREATE_NO_WINDOW (0x08000000) prevents any console window from
      // flashing when Ollama starts in the background.
      ...(process.platform === 'win32' ? { shell: false } : {})
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
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (local access only)`);
  startOllamaIfNeeded();
});
