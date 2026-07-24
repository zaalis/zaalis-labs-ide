const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { exec, execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const { runAgentTurn, TOOL_CATALOG, COMPUTER_FUNCTION_TOOL, nativeComputerCallsAsText } = require('./agent-engine');
const brainMcp = require('./brain-mcp-client');
const { AutomationManager } = require('./automation-manager');
const { TerminalManager } = require('./terminal-manager');
const { buildKimiPayload, parseKimiResponse } = require('./kimi-provider');
const responseIntegrity = require('./response-integrity');
const { ExecutionBroker } = require('./execution-broker');
const { SessionStore } = require('./session-store');
const { ApprovalStore, normaliseRules, evaluate: evaluatePermission } = require('./permission-policy');
const securityPipeline = require('./security-pipeline');
const { profile: agentProfile } = require('./agent-profiles');
const { openAIFunctionTools, anthropicTools, geminiTools } = require('./tool-registry');
const skillsRegistry = require('./skills-registry');
const languageService = require('./language-service');
const mcpRegistry = require('./mcp-registry');
const projectInspector = require('./project-inspector');
// QR generation for the phone remote-control pairing. Guarded so a missing
// install never prevents the server from booting.
let QRCode = null;
try { QRCode = require('qrcode'); } catch {}

const app = express();
const PORT = Number(process.env.ZAALIS_PORT || process.env.PORT) || 3000;
const automationManager = new AutomationManager({
  bridgeUrl: process.env.ZAALIS_COMPUTER_BRIDGE_URL || '',
  bridgeSecret: process.env.ZAALIS_COMPUTER_BRIDGE_SECRET || '',
});
const terminalManager = new TerminalManager();
const approvalStore = new ApprovalStore();

// Base directory for static assets and writable data.
// When packaged into an .exe (pkg), __dirname points inside the read-only
// snapshot, so we use the folder next to the executable instead.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const COMMAND_TIMEOUT_MS = Math.max(30_000, Number(process.env.ZAALIS_COMMAND_TIMEOUT_MS) || 10 * 60_000);
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024;
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
  // Useful for isolated diagnostics/tests; normal desktop installs never set
  // this and therefore always use the durable per-user location below.
  if (process.env.ZAALIS_DATA_DIR) return path.resolve(process.env.ZAALIS_DATA_DIR);
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
const sessionStore = new SessionStore({ dataDir: DATA_DIR });
const executionBroker = new ExecutionBroker({
  // An explicit development escape hatch is useful on unsupported platforms,
  // but production builds remain fail-closed when no isolation backend exists.
  requireSandbox: process.env.ZAALIS_ALLOW_UNSANDBOXED !== '1',
});

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
// BROWSER BRIDGE — accès restreint pour zaalis browser (même machine).
// Un secret partagé est écrit dans le dossier per-user stable (le même que
// DATA_DIR en mode packagé). zaalis browser le lit sur disque et l'envoie via
// l'en-tête x-zaalis-browser. Requêtes loopback uniquement (déjà garanti par
// le middleware global) et limitées au chat — jamais fichiers/exec/tunnel.
// Modèle de confiance identique au fichier `secret` : tout processus local du
// même utilisateur peut le lire ; on n'expose rien de plus que ce que le
// vault local permet déjà.
// ---------------------------------------------------------------------------
function browserBridgeDir() {
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
function browserUser(req) {
  const header = String(req.headers['x-zaalis-browser'] || '');
  if (!header || !safeEqual(header, BROWSER_SECRET)) return null;
  const users = loadUsers();
  if (!users.length) return null;
  // Compte le plus récemment connecté, sinon le premier créé.
  return users.slice().sort((a, b) =>
    String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || ''))
  )[0];
}
// Le navigateur n'a accès qu'au chat, à la liste des modèles locaux (pour
// remplir ses menus) et aux briques vocales locales (STT/TTS du mode vocal) —
// jamais aux fichiers, à l'exec ni aux clés.
function browserAllowed(p) {
  return p === '/chat' || p === '/ollama-models' || p === '/gguf-models' ||
         p === '/stt' || p === '/tts' || p === '/voice-status' || p === '/voice-options';
}
function chatsFile(userId, kind) {
  // kind: 'chat' (single chat) or 'agents' (multi-agent). Kept in separate files.
  const k = kind === 'agents' ? 'agents' : 'chat';
  return path.join(CHATS_DIR, `${userId}__${k}.json`);
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

const SHARED_CONFIG_DEFAULTS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  ggufCtx: 8192,
  ggufVariant: '',
  ggufGpuLayers: '',
  // Personal preferences applied to every model request. This is deliberately
  // bounded: it is a preference field, not an unbounded prompt transport.
  customSystemInstructions: '',
  toolPermissions: { allow: [], ask: [], deny: [] }
};
const GGUF_VARIANTS = new Set(['', 'metal', 'cpu']);

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
  if ('ggufGpuLayers' in src) {
    const raw = src.ggufGpuLayers;
    out.ggufGpuLayers = (raw === '' || raw === undefined || raw === null)
      ? ''
      : Math.max(0, Math.min(999, parseInt(raw, 10) || 0));
  }
  if ('customSystemInstructions' in src) {
    out.customSystemInstructions = String(src.customSystemInstructions || '').trim().slice(0, 12000);
  }
  if ('toolPermissions' in src) out.toolPermissions = normaliseRules(src.toolPermissions);
  else out.toolPermissions = normaliseRules(out.toolPermissions);
  return out;
}

function sharedConfigForUser(user) {
  return sanitizeSharedConfig(user && user.sharedConfig);
}

function mergeCustomSystemInstructions(systemPrompt, config) {
  const custom = String(config && config.customSystemInstructions || '').trim().slice(0, 12000);
  if (!custom) return systemPrompt || '';
  // Keep the product's safety, permission and tool boundaries authoritative.
  // The user text is still sent as system context so tone and working style
  // are consistent across providers.
  return `${systemPrompt || ''}\n\n[USER PREFERENCES]\nApply these preferences when they do not conflict with higher-priority safety, security, permission, or tool-use rules:\n${custom}`;
}
function brainMcpForUser(user) {
  const saved = user && user.brainMcp;
  if (!saved || !saved.enabled) return null;
  // A malformed or legacy encrypted value must never make the settings screen
  // unavailable. Treat it as a disconnected Brain configuration instead.
  try {
    return brainMcp.validateConfig({ endpoint: saved.endpoint, token: saved.token ? decryptSecret(saved.token) : '' });
  } catch {
    return null;
  }
}
function mcpServersForUser(user) {
  const servers = Array.isArray(user && user.mcpServers) ? user.mcpServers : [];
  return servers.map((saved) => {
    const base = mcpRegistry.normaliseServer(saved);
    if (!base) return null;
    return { ...base, token: saved.token ? decryptSecret(saved.token) : '' };
  }).filter(Boolean);
}
function mcpServerForUser(user, id) {
  const wanted = mcpRegistry.safeId(id);
  return mcpServersForUser(user).find((server) => server.id === wanted && server.enabled) || null;
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
  // Mémorise la dernière connexion (utilisée par le pont zaalis browser).
  try {
    const users = loadUsers();
    const i = users.findIndex((u) => u.id === user.id);
    if (i >= 0) { users[i].lastLoginAt = new Date().toISOString(); saveUsers(users); }
  } catch {}
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

// Used by the Electron launcher to avoid reusing an old server left behind by
// a previous IDE installation. Keep it public and deliberately content-free.
app.get('/api/health', (_req, res) => {
  // Electron uses this revision to make sure it never attaches a freshly
  // installed UI to a server process left behind by an older installation.
  res.json({ ok: true, apiRevision: 'desktop-launcher-v2', version: APP_VERSION });
});

// ---------------------------------------------------------------------------
// AUTH GUARD — every other /api/* route requires a valid session
// ---------------------------------------------------------------------------
// Electron's dock is not a web client and therefore cannot carry a user cookie.
// Its random per-launch bridge secret is the only accepted credential here.
app.post('/api/automation/stop-bridge', async (req, res) => {
  if (!process.env.ZAALIS_COMPUTER_BRIDGE_SECRET || req.headers['x-zaalis-computer'] !== process.env.ZAALIS_COMPUTER_BRIDGE_SECRET) return res.status(403).json({ error: 'Forbidden' });
  await automationManager.stop(undefined, 'Arrêt demandé depuis le dock macOS.');
  res.json({ ok: true });
});
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
  // Pont zaalis browser : secret local partagé, endpoints chat uniquement.
  const bUser = browserUser(req);
  if (bUser) {
    if (!browserAllowed(req.path)) return res.status(403).json({ error: 'Action indisponible pour le navigateur.' });
    req.user = bUser;
    req.isBrowser = true;
    return next();
  }
  return res.status(401).json({ error: 'Authentification requise.' });
});

// ---------------------------------------------------------------------------
// MACOS COMPUTER CONTROL API
// ---------------------------------------------------------------------------
app.get('/api/automation/status', (req, res) => {
  const active = automationManager.active;
  if (active && active.userId !== req.user.id) return res.status(409).json({ active: true, state: 'busy' });
  res.json(automationManager.snapshot(active));
});

app.post('/api/automation/permissions', async (req, res) => {
  if (req.isMobile || req.isBrowser) return res.status(403).json({ error: 'Action indisponible dans ce mode.' });
  const result = await automationManager.bridge({ action: 'request_permissions' });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/automation/stop', async (req, res) => {
  const active = automationManager.active;
  if (active && active.userId !== req.user.id) return res.status(403).json({ error: 'Cette tâche appartient à un autre utilisateur.' });
  res.json(await automationManager.stop(active, 'Arrêt demandé dans l’IDE.'));
});

app.post('/api/automation/:id/answer', async (req, res) => {
  try { res.json(await automationManager.answer(req.user.id, String(req.params.id || ''), req.body && req.body.answer)); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// Persistent, interactive terminal sessions for the IDE. They are scoped to a
// logged-in user and only bind to the project folder selected by that user.
app.post('/api/terminal/sessions', (req, res) => {
  try {
    if (req.isMobile || req.isBrowser) return res.status(403).json({ error: 'Terminal indisponible dans ce mode.' });
    const cwd = resolveBase((req.body && req.body.cwd) || APP_DIR);
    const session = terminalManager.create({ userId: req.user.id, cwd });
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
    config: sharedConfigForUser(req.user)
  });
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

// The Zaalis Brain bearer token stays encrypted on this server. It is never
// returned to the browser/CLI; only this local process speaks MCP with Brain.
app.get('/api/brain-mcp', async (req, res) => {
  const saved = req.user && req.user.brainMcp;
  const config = brainMcpForUser(req.user);
  if (!config) return res.json({ configured: !!(saved && saved.endpoint && saved.token), enabled: !!(saved && saved.enabled), state: 'disconnected', detail: 'Configuration MCP Zaalis Brain absente.' });
  try {
    const result = await brainMcp.check(config);
    res.json({ configured: true, enabled: true, state: 'connected', detail: `${result.tools.length} outils Zaalis Brain disponibles.`, tools: result.tools, endpoint: saved.endpoint });
  } catch (err) {
    res.json({ configured: true, enabled: true, state: 'error', detail: err.message, endpoint: saved.endpoint });
  }
});

app.put('/api/brain-mcp', async (req, res) => {
  try {
    if (req.isMobile || req.isBrowser) return res.status(403).json({ error: 'Action indisponible dans ce mode.' });
    const body = req.body || {}, users = loadUsers(), index = users.findIndex((u) => u.id === req.user.id);
    if (index < 0) return res.status(404).json({ error: 'Utilisateur non trouve.' });
    const current = users[index].brainMcp || {};
    const enabled = body.enabled === undefined ? !!current.enabled : !!body.enabled;
    const endpoint = body.endpoint === undefined ? String(current.endpoint || '') : String(body.endpoint || '').trim();
    const suppliedToken = body.token === undefined ? '' : String(body.token || '').trim();
    const token = suppliedToken || (current.token ? decryptSecret(current.token) : '');
    if (enabled && !brainMcp.validateConfig({ endpoint, token })) return res.status(400).json({ error: 'Route ou jeton MCP Zaalis Brain invalide.' });
    users[index].brainMcp = { enabled, endpoint, token: token ? encryptSecret(token) : '' };
    saveUsers(users);
    if (!enabled) return res.json({ configured: !!(endpoint && token), enabled: false, state: 'disconnected', detail: 'MCP Zaalis Brain désactivé dans l’IDE.' });
    try {
      const result = await brainMcp.check(brainMcpForUser(users[index]));
      res.json({ configured: true, enabled: true, state: 'connected', detail: `${result.tools.length} outils Zaalis Brain disponibles.`, tools: result.tools, endpoint });
    } catch (err) {
      // The configuration was saved successfully even when the local Brain
      // service is offline. Returning a normal status prevents this optional
      // integration from blocking API-key or general settings saves.
      res.json({ configured: true, enabled: true, state: 'error', detail: err.message || 'Connexion MCP Zaalis Brain impossible.', endpoint });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Configuration MCP Zaalis Brain impossible.' });
  }
});

// Generic MCP servers. Tokens remain encrypted in users.json and are never
// returned to a browser/CLI; only this loopback server speaks MCP.
app.get('/api/mcp', async (req, res) => {
  const rows = mcpServersForUser(req.user).map((server) => ({ id: server.id, name: server.name, endpoint: server.endpoint, enabled: server.enabled, allow: server.allow, deny: server.deny }));
  res.json({ servers: rows });
});

app.put('/api/mcp', (req, res) => {
  try {
    if (req.isMobile || req.isBrowser) return res.status(403).json({ error: 'Action indisponible dans ce mode.' });
    const incoming = Array.isArray(req.body && req.body.servers) ? req.body.servers.slice(0, 20) : [];
    const current = new Map((Array.isArray(req.user.mcpServers) ? req.user.mcpServers : []).map((item) => [item.id, item]));
    const servers = [];
    for (const item of incoming) {
      const server = mcpRegistry.normaliseServer(item); if (!server) return res.status(400).json({ error: 'Configuration MCP invalide.' });
      const supplied = String(item.token || '').trim(); const previous = current.get(server.id);
      servers.push({ ...server, token: supplied ? encryptSecret(supplied) : (previous && previous.token || '') });
    }
    const users = loadUsers(); const index = users.findIndex((user) => user.id === req.user.id);
    if (index < 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    users[index].mcpServers = servers; saveUsers(users);
    res.json({ servers: servers.map(({ token, ...server }) => server) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mcp/:id/tools', async (req, res) => {
  try {
    const server = mcpServerForUser(req.user, req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur MCP introuvable ou désactivé.' });
    const tools = await mcpRegistry.tools(server);
    res.json({ server: { id: server.id, name: server.name }, tools: tools.filter((tool) => tool && mcpRegistry.allowed(server, tool.name)).map((tool) => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || tool.input_schema || {} })) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});


// ---------------------------------------------------------------------------
// API KEYS API (protected) — write-only vault with masked read-back
// ---------------------------------------------------------------------------
// GET  /api/keys -> { keys: { openai: { set, last4 }, ... } }   (never the key)
// A mobile session reaches the API over an internet-facing tunnel, so it only
// gets the boolean presence flag — never the last4 fragment of a key.
app.get('/api/keys', (req, res) => {
  const status = apiKeysStatus(req.user);
  if (req.isMobile) {
    for (const p of Object.keys(status)) status[p] = { set: !!status[p].set, last4: '' };
  }
  res.json({ keys: status });
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
    if (!Array.isArray(conversations)) return res.status(400).json({ error: 'Conversations invalides.' });
    writeJsonAtomic(chatsFile(req.user.id, req.body && req.body.kind), conversations);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DURABLE AGENT SESSIONS — SQLite index + append-only JSONL logs
// ---------------------------------------------------------------------------
app.get('/api/agent-sessions', (req, res) => {
  try {
    res.json({ sessions: sessionStore.list({
      userId: req.user.id,
      cwd: req.query.root ? resolveBase(req.query.root) : '',
      includeArchived: req.query.archived === 'true',
      query: req.query.query || '',
      limit: req.query.limit,
    }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent-sessions', (req, res) => {
  try {
    const body = req.body || {};
    const session = sessionStore.create({ userId: req.user.id, cwd: resolveBase(body.root || body.cwd), title: body.title, model: body.model, submodel: body.submodel });
    res.status(201).json({ session });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/agent-sessions/:id', (req, res) => {
  const session = sessionStore.get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Conversation introuvable.' });
  res.json({ session, events: sessionStore.events(session.id, req.user.id) || [] });
});

app.patch('/api/agent-sessions/:id', (req, res) => {
  const session = sessionStore.update(req.params.id, req.user.id, req.body || {});
  if (!session) return res.status(404).json({ error: 'Conversation introuvable.' });
  res.json({ session });
});

app.post('/api/agent-sessions/:id/fork', (req, res) => {
  const session = sessionStore.fork(req.params.id, req.user.id, { title: req.body && req.body.title });
  if (!session) return res.status(404).json({ error: 'Conversation introuvable.' });
  res.status(201).json({ session });
});

app.get('/api/agent-sessions/:id/export', (req, res) => {
  const exported = sessionStore.export(req.params.id, req.user.id);
  if (!exported) return res.status(404).json({ error: 'Conversation introuvable.' });
  res.setHeader('Content-Disposition', `attachment; filename="${exported.session.id}.json"`);
  res.json(exported);
});

// ---------------------------------------------------------------------------
// PROJECT SKILLS + LANGUAGE SERVICE
// ---------------------------------------------------------------------------
app.get('/api/skills', (req, res) => {
  try {
    const root = resolveBase(req.query.root);
    res.json({ skills: skillsRegistry.discover(root).map(({ instructions, ...skill }) => skill) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/lsp/:action', (req, res) => {
  try {
    const action = String(req.params.action || ''); const root = resolveBase(req.query.root);
    if (action === 'symbols') return res.json({ symbols: languageService.symbols({ root, file: req.query.path }) });
    if (action === 'diagnostics') return res.json({ diagnostics: languageService.diagnostics({ root, file: req.query.path }) });
    if (action === 'references') return res.json({ references: languageService.references({ root, symbol: req.query.symbol, limit: req.query.limit }) });
    if (action === 'definition') return res.json({ definition: languageService.definition({ root, symbol: req.query.symbol }) });
    if (action === 'rename') return res.json({ plan: languageService.renamePlan({ root, symbol: req.query.symbol, replacement: req.query.replacement }) });
    return res.status(404).json({ error: 'Action LSP inconnue.' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Exhaustive project inspection is separate from the convenience glob/grep
// routes: it never silently truncates the whole result set, exposes every
// exclusion, and lets callers resume with a cursor.
app.get('/api/audit/:action', (req, res) => {
  try {
    const action = String(req.params.action || '').toLowerCase();
    if (!['inventory', 'glob', 'grep'].includes(action)) return res.status(404).json({ error: 'Action audit inconnue.' });
    const root = resolveBase(req.query.root);
    if (action === 'grep' && !String(req.query.pattern || '')) return res.status(400).json({ error: 'Le motif grep est requis.' });
    const result = projectInspector[action]({
      root, pattern: req.query.pattern, includeIgnored: req.query.includeIgnored === 'true',
      cursor: req.query.cursor, limit: req.query.limit,
    });
    res.json({ action, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// SECURITY REVIEW WORKSPACE — durable job + real-time staged progress
// ---------------------------------------------------------------------------
const securityReviews = new Map();
const SECURITY_REVIEW_STAGES = Object.freeze([
  { id: 'preparing', label: 'Préparation de la revue', profile: 'explorer' },
  { id: 'mapping_attack_surface', label: 'Cartographie de la surface d’attaque', profile: 'secrets' },
  { id: 'reviewing_code', label: 'Revue du code', profile: 'source_to_sink' },
  { id: 'validating_findings', label: 'Validation des constats', profile: 'validator' },
  { id: 'tracing_impact', label: 'Traçage de l’impact', profile: 'dependencies' },
  { id: 'building_report', label: 'Construction du rapport', profile: 'verifier' },
]);

function reviewSnapshot(review) {
  const result = review.report ? {
    summary: review.report.summary,
    scope: review.report.scope,
    threatModel: review.report.threatModel,
    findings: (review.report.findings || []).slice(0, 300),
    dependencies: review.report.dependencies,
    scanners: review.report.scanners,
    generatedAt: review.report.generatedAt,
  } : null;
  return {
    id: review.id, sessionId: review.sessionId, root: review.root, workflow: review.workflow,
    status: review.status, stage: review.stage, startedAt: review.startedAt, completedAt: review.completedAt || null,
    stages: SECURITY_REVIEW_STAGES.map((stage) => ({ ...stage, status: review.stageStatus[stage.id] || 'pending' })),
    agents: Object.values(review.agents), result, error: review.error || null,
  };
}

function publishSecurityReview(review, event) {
  const payload = { id: `security_event_${crypto.randomUUID()}`, ts: Date.now(), ...event };
  review.events.push(payload); if (review.events.length > 400) review.events.shift();
  review.emitter.emit('review', payload);
  try { sessionStore.append(review.sessionId, { type: 'security_review_event', reviewId: review.id, event: payload }); } catch {}
}

function sleepReview(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function reviewActivity(stage, profile, phase, report) {
  const total = report && report.summary ? Number(report.summary.total || 0) : 0;
  const high = report && report.summary ? Number(report.summary.high || 0) : 0;
  const noun = total > 1 ? 'constats' : 'constat';
  if (phase === 'started') return `${profile.label} démarre : ${stage.label.toLowerCase()}.`;
  if (phase === 'completed') {
    if (stage.id === 'mapping_attack_surface') return `${profile.label} a cartographié le périmètre et identifié ${total} ${noun} candidat(s).`;
    if (stage.id === 'validating_findings') return `${profile.label} a vérifié les preuves et le contexte des ${total} ${noun}.`;
    if (stage.id === 'tracing_impact') return `${profile.label} a enrichi l’impact et la remédiation de chaque constat.`;
    if (stage.id === 'building_report') return `${profile.label} a finalisé le rapport${high ? ` (${high} de sévérité élevée)` : ''}.`;
    return `${profile.label} a terminé : ${stage.label.toLowerCase()}.`;
  }
  return `${profile.label} traite ${stage.label.toLowerCase()}.`;
}
function findingsForProfile(report, profile) {
  const findings = report && Array.isArray(report.findings) ? report.findings : [];
  if (profile === 'secrets') return findings.filter((item) => String(item.rule).startsWith('secret.'));
  if (profile === 'source_to_sink') return findings.filter((item) => /child_process|eval|sql|path/.test(String(item.rule)));
  if (profile === 'dependencies') return Object.keys(report && report.dependencies && report.dependencies.direct || {}).map((name) => ({ rule: 'dependency.inventory', file: 'package.json', message: name }));
  return findings;
}

async function runSecurityReview(review) {
  review.status = 'running';
  publishSecurityReview(review, { type: 'status', status: review.status, activity: 'La revue sécurité démarre et prépare le périmètre du projet.', snapshot: reviewSnapshot(review) });
  try {
    // The local scanner is only a baseline. Every deep stage below delegates
    // to the real agent loop, which must read files and use its tools.
    review.report = securityPipeline.scan({ root: review.root, mode: review.workflow, includeIgnored: review.workflow === 'deep' });
    for (const stage of SECURITY_REVIEW_STAGES) {
      if (review.cancelRequested) throw Object.assign(new Error('Revue annulée.'), { code: 'cancelled' });
      review.stage = stage.id; review.stageStatus[stage.id] = 'active';
      const profile = agentProfile(stage.profile);
      // A profile may participate in more than one phase (the explorer first
      // prepares the scope, then maps attack surface). Keep each sub-agent
      // visible as its own completed unit instead of overwriting it.
      const agentId = `security-${stage.id}`;
      review.agents[agentId] = { id: agentId, profile: stage.profile, label: profile.label, tools: profile.tools, status: 'running', findings: 0, stage: stage.id };
      publishSecurityReview(review, { type: 'stage', stage: stage.id, status: 'active', agent: review.agents[agentId], activity: reviewActivity(stage, profile, 'started', review.report), snapshot: reviewSnapshot(review) });
      if (!review.callModel) throw new Error('Modèle requis pour une revue sécurité approfondie.');
      const baseline = (review.report.findings || []).slice(0, 80).map((f) => `${f.id} ${f.severity} ${f.file}:${f.line} ${f.message}`).join('\n');
      const mission = `Revue sécurité, étape: ${stage.label}. Lis les fichiers pertinents avec les outils avant toute conclusion. Analyse uniquement le périmètre sécurité. Les constats locaux suivants sont des CANDIDATS, pas des vulnérabilités confirmées:\n${baseline || '(aucun candidat)'}.\nRends un rapport concis avec preuves fichier:ligne, constats à confirmer/écarter, impact, remédiation proposée et test éventuel. Ne modifie aucun fichier.`;
      const agentResult = await runAgentTurn({ root: review.root, sessionId: review.sessionId, turnId: `security_${review.id}_${stage.id}`, agentId, model: review.model, submodel: review.submodel, message: mission, config: review.config, reasoningLevel: review.reasoningLevel, permissionMode: review.permissionMode, language: 'fr', callModel: review.callModel, securityPipeline, projectInspector, languageService, executionBroker, emitEvent: (event) => publishSecurityReview(review, { type: 'agent_event', stage: stage.id, agent: agentId, activity: `${profile.label} · ${event.type}`, detail: event, snapshot: reviewSnapshot(review) }) });
      review.agents[agentId] = { ...review.agents[agentId], toolsUsed: (agentResult.toolResults || []).map((item) => item.tool), report: String(agentResult.response || '').slice(0, 5000), findings: (agentResult.toolResults || []).length };
      // The local baseline stays candidate-only. A model report can recommend
      // confirmation, but no regex hit is promoted automatically.
      if (stage.id === 'tracing_impact') for (const finding of review.report.findings) {
        finding.impact = finding.impact || 'À confirmer dans le chemin d’attaque indiqué par les agents.';
        finding.remediation = finding.remediation || 'Correctif proposé dans le rapport des agents ; appliquer uniquement après validation.';
      }
      if (stage.id === 'building_report') review.report.markdown = securityPipeline.toMarkdown(review.report);
      const reviewed = findingsForProfile(review.report, stage.profile);
      review.agents[agentId] = { ...review.agents[agentId], status: 'completed', findings: reviewed.length };
      review.stageStatus[stage.id] = 'completed';
      publishSecurityReview(review, { type: 'stage', stage: stage.id, status: 'completed', agent: review.agents[agentId], activity: reviewActivity(stage, profile, 'completed', review.report), snapshot: reviewSnapshot(review) });
    }
    review.status = 'completed'; review.completedAt = new Date().toISOString();
    const summary = review.report && review.report.summary || {};
    publishSecurityReview(review, { type: 'completed', status: review.status, activity: `Review terminée : ${summary.total || 0} constat(s), dont ${summary.high || 0} élevé(s) et ${summary.medium || 0} moyen(s).`, snapshot: reviewSnapshot(review) });
  } catch (error) {
    review.status = error && error.code === 'cancelled' ? 'cancelled' : 'failed';
    review.error = review.status === 'failed' ? (error.message || String(error)) : null;
    review.completedAt = new Date().toISOString();
    if (review.stage && review.stageStatus[review.stage] === 'active') review.stageStatus[review.stage] = review.status;
    publishSecurityReview(review, { type: review.status, status: review.status, error: review.error, activity: review.status === 'cancelled' ? 'La revue sécurité a été annulée.' : `La revue sécurité a échoué : ${review.error}`, snapshot: reviewSnapshot(review) });
  } finally {
    setTimeout(() => securityReviews.delete(review.id), 30 * 60_000).unref();
  }
}

function createSecurityReview({ userId, root, workflow = 'deep', model, submodel, callModel, config, reasoningLevel, permissionMode }) {
  if (!model) throw new Error('Modèle requis pour une revue sécurité approfondie.');
  const session = sessionStore.create({ userId, cwd: root, title: `Review sécurité · ${workflow}`, model, submodel });
  const review = { id: `security_review_${crypto.randomUUID()}`, userId, sessionId: session.id, root, workflow, status: 'starting', stage: 'preparing', stageStatus: {}, agents: {}, events: [], emitter: new EventEmitter(), startedAt: new Date().toISOString(), completedAt: null, cancelRequested: false, report: null, error: null, model, submodel, callModel, config: config || {}, reasoningLevel: Number(reasoningLevel || 0), permissionMode: permissionMode || 'supervised' };
  securityReviews.set(review.id, review);
  publishSecurityReview(review, { type: 'created', activity: 'Revue IA approfondie créée.', snapshot: reviewSnapshot(review) });
  setImmediate(() => { runSecurityReview(review); });
  return review;
}

app.post('/api/security/reviews', (req, res) => {
  try {
    const body = req.body || {}; const workflow = String(body.workflow || 'scan').toLowerCase();
    if (body.source !== 'slash') return res.status(403).json({ error: 'La revue sécurité est disponible uniquement via une commande slash.' });
    if (!['diff', 'scan', 'deep'].includes(workflow)) return res.status(400).json({ error: 'Workflow de revue invalide.' });
    const root = resolveBase(body.root || body.projectRoot);
    const model = String(body.model || ''); const submodel = String(body.submodel || '');
    if (!model) return res.status(400).json({ error: 'Sélectionnez un modèle pour la revue approfondie.' });
    const cookie = req.headers.cookie || '';
    const callModel = async (payload) => fetchJSON(`http://127.0.0.1:${PORT}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(payload) });
    const review = createSecurityReview({ userId: req.user.id, root, workflow, model, submodel, callModel, config: { ...sharedConfigForUser(req.user), ...(body.config && typeof body.config === 'object' ? body.config : {}) }, reasoningLevel: body.reasoningLevel, permissionMode: body.permissionMode });
    res.status(202).json({ review: reviewSnapshot(review) });
  } catch (error) { res.status(400).json({ error: error.message || String(error) }); }
});

app.get('/api/security/reviews/:id', (req, res) => {
  const review = securityReviews.get(String(req.params.id || ''));
  if (!review || review.userId !== req.user.id) return res.status(404).json({ error: 'Review sécurité introuvable.' });
  res.json({ review: reviewSnapshot(review), events: review.events });
});

app.get('/api/security/reviews/:id/stream', (req, res) => {
  const review = securityReviews.get(String(req.params.id || ''));
  if (!review || review.userId !== req.user.id) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  const send = (event) => { try { res.write(`event: review\ndata: ${JSON.stringify(event)}\n\n`); } catch {} };
  send({ type: 'snapshot', snapshot: reviewSnapshot(review) });
  const listener = (event) => send(event);
  review.emitter.on('review', listener);
  req.on('close', () => review.emitter.removeListener('review', listener));
});

app.post('/api/security/reviews/:id/cancel', (req, res) => {
  const review = securityReviews.get(String(req.params.id || ''));
  if (!review || review.userId !== req.user.id) return res.status(404).json({ error: 'Review sécurité introuvable.' });
  if (['completed', 'failed', 'cancelled'].includes(review.status)) return res.json({ review: reviewSnapshot(review) });
  review.cancelRequested = true;
  review.status = 'cancelling';
  publishSecurityReview(review, { type: 'cancelling', status: 'cancelling', snapshot: reviewSnapshot(review) });
  res.json({ review: reviewSnapshot(review) });
});

// ---------------------------------------------------------------------------
// SECURITY PIPELINE — deterministic local baseline, JSON and SARIF output
// ---------------------------------------------------------------------------
app.post('/api/security/:action', (req, res) => {
  try {
    const action = String(req.params.action || '').toLowerCase();
    if (!['diff', 'scan', 'deep', 'validate', 'fix', 'report'].includes(action)) return res.status(404).json({ error: 'Workflow sécurité inconnu.' });
    const body = req.body || {};
    if (body.source !== 'slash') return res.status(403).json({ error: 'Le scan sécurité est disponible uniquement via une commande slash.' });
    const root = resolveBase(body.root || body.projectRoot);
    let report = securityPipeline.scan({ root, mode: action, includeIgnored: action === 'deep' || body.includeIgnored === true });
    if (action === 'validate') report = securityPipeline.validate(report, body.findingIds || []);
    const output = action === 'fix' ? securityPipeline.fixPlan(report, body.findingIds || []) : (body.format === 'sarif' ? report.sarif : (body.format === 'markdown' ? report.markdown : report));
    res.json({ report: output, summary: report.summary, generatedAt: report.generatedAt, workflow: action });
  } catch (err) { res.status(400).json({ error: err.message }); }
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

// Replays a supervised image_download after the IDE or CLI has shown its
// approval prompt. The id is valid only for a recent image_search result, so
// this endpoint never acts as a general-purpose URL downloader.
app.post('/api/agent-image-download', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id || !body.path) return res.status(400).json({ error: 'id and path are required' });
    const result = await downloadProjectImage({
      id: body.id,
      path: body.path,
      root: resolveBase(body.root || body.projectRoot),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function approvedProjectFile(root, relative) {
  const base = fs.realpathSync(resolveBase(root));
  const value = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Chemin de projet invalide.');
  const full = path.resolve(base, value);
  if (!isInsideBase(base, full)) throw new Error('Chemin hors projet refusé.');
  // Existing symlinks are refused: approving project/foo must never overwrite
  // a target outside the project through a link created between two turns.
  let cursor = base;
  for (const part of value.split('/')) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Lien symbolique refusé.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { base, full, relative: value };
}

function atomicProjectWrite(full, content) {
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  const temp = `${full}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, String(content || ''), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, full);
}

function approvedEdit(content, hunks) {
  let next = String(content || '');
  for (const hunk of (Array.isArray(hunks) ? hunks : [])) {
    const search = String(hunk && hunk.search || ''); const replace = String(hunk && hunk.replace || '');
    if (!search) throw new Error('SEARCH vide refusé.');
    const first = next.indexOf(search); const last = next.lastIndexOf(search);
    if (first < 0) throw new Error('SEARCH introuvable.');
    if (first !== last) throw new Error('SEARCH apparaît plusieurs fois.');
    next = next.slice(0, first) + replace + next.slice(first + search.length);
  }
  return next;
}

function approvedGitCommand(input) {
  const value = input && typeof input === 'object' ? input : {};
  const quote = (item) => `'${String(item || '').replace(/'/g, "'\\''")}'`;
  const action = String(value.action || '');
  const branch = String(value.branch || '');
  if (action === 'branch_create' && branch) return { command: `git switch -c ${quote(branch)}`, network: false };
  if (action === 'worktree_create' && branch) {
    const safeName = branch.replace(/[^A-Za-z0-9._-]/g, '-');
    return { command: `mkdir -p .zaalis/worktrees && git worktree add ${quote(`.zaalis/worktrees/${safeName}`)} -b ${quote(branch)}`, network: false };
  }
  if (action === 'commit' && value.message && Array.isArray(value.paths) && value.paths.length) return { command: `git add -- ${value.paths.map(quote).join(' ')} && git commit -m ${quote(value.message)}`, network: false };
  if (action === 'push' && branch) return { command: `git push ${quote(value.remote || 'origin')} ${quote(branch)}`, network: true };
  throw new Error('Action Git approuvée invalide.');
}

function approvedGitPush(root, input) {
  const remote = String(input && input.remote || 'origin');
  const branch = String(input && input.branch || '');
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(remote) || !/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) throw new Error('Remote ou branche Git invalide.');
  // This is a deliberately narrow privileged bridge: the exact remote and
  // branch were bound to a single-use user approval, and no shell is invoked.
  // It may access Git/SSH/Keychain credentials already configured by the user,
  // something the general sandbox intentionally cannot do.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    LANG: process.env.LANG || 'en_US.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
    const done = (extra = {}) => {
      if (settled) return; settled = true;
      resolve({ stdout: stdout.slice(0, MAX_COMMAND_OUTPUT), stderr: stderr.slice(0, MAX_COMMAND_OUTPUT), timedOut, ...extra });
    };
    let child;
    try { child = spawn('git', ['-C', root, 'push', remote, branch], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (error) { done({ exitCode: 1, error: error.message }); return; }
    const append = (which, chunk) => { if (which === 'out') stdout += String(chunk); else stderr += String(chunk); };
    child.stdout.on('data', (chunk) => append('out', chunk)); child.stderr.on('data', (chunk) => append('err', chunk));
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, Math.min(COMMAND_TIMEOUT_MS, 120_000));
    child.on('error', (error) => { clearTimeout(timer); done({ exitCode: 1, error: error.message }); });
    child.on('close', (exitCode) => { clearTimeout(timer); done({ exitCode: exitCode == null ? 1 : exitCode }); });
  });
}

// Single-use approvals are bound to a user, session, call and exact JSON
// input. This endpoint is the only supervised replay path; direct /api/file
// and /api/exec calls cannot turn a policy deny into an approval.
app.post('/api/agent-approval/execute', async (req, res) => {
  try {
    const body = req.body || {}; const tool = String(body.tool || '').toLowerCase(); const input = body.input && typeof body.input === 'object' ? body.input : {};
    const valid = approvalStore.consume({ approvalId: body.approvalId, token: body.token, sessionId: body.sessionId, callId: body.callId, tool, input, userId: req.user.id });
    if (!valid.ok) return res.status(403).json({ error: valid.reason, code: 'approval_required' });
    const policy = evaluatePermission({ tool, input, mode: 'auto', rules: valid.context.rules });
    if (policy.decision === 'deny') return res.status(403).json({ error: policy.reason, code: 'permission_denied' });
    const root = valid.context.root;
    let result;
    if (tool === 'run') {
      result = await executionBroker.run({ command: String(input.command || ''), root, write: input.write !== false, network: input.network === true });
    } else if (tool === 'git_write') {
      const git = approvedGitCommand(input);
      result = input.action === 'push'
        ? await approvedGitPush(root, input)
        : await executionBroker.run({ command: git.command, root, write: true, network: git.network });
    } else if (tool === 'write') {
      result = executionBroker.writeFile({ root, path: input.path, content: input.content });
    } else if (tool === 'edit') {
      result = executionBroker.editFile({ root, path: input.path, hunks: input.hunks });
    } else if (tool === 'image_download') {
      result = { success: true, ...(await downloadProjectImage({ id: input.id, path: input.path, root })) };
    } else return res.status(400).json({ error: 'Outil non approuvable.' });
    approvalStore.prune();
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message || String(err), code: 'tool_failure' }); }
});

// ---------------------------------------------------------------------------
// EXEC API
// ---------------------------------------------------------------------------

// GUI-launched apps (Finder / Electron) inherit a minimal PATH that omits
// Homebrew and other common tool locations, so node/npm/python3/git often fail
// with "command not found". Append the usual bin dirs. Windows is left as-is.
function execEnv() {
  if (process.platform === 'win32') return process.env;
  const extra = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(os.homedir(), '.local', 'bin'),
  ];
  const seen = new Set();
  const merged = [];
  for (const d of [...String(process.env.PATH || '').split(':'), ...extra]) {
    if (d && !seen.has(d)) { seen.add(d); merged.push(d); }
  }
  return { ...process.env, PATH: merged.join(':') };
}

function runShellCommand(command, cwd) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, outputTruncated = false, settled = false;
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd, env: execEnv(), detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (current, chunk) => {
      const text = chunk.toString();
      const remaining = MAX_COMMAND_OUTPUT - Buffer.byteLength(current);
      if (remaining <= 0) { outputTruncated = true; return current; }
      if (Buffer.byteLength(text) > remaining) { outputTruncated = true; return current + Buffer.from(text).subarray(0, remaining).toString(); }
      return current + text;
    };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') child.kill('SIGTERM');
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
      setTimeout(() => {
        if (child.exitCode != null) return;
        if (process.platform === 'win32') child.kill('SIGKILL');
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }, 5000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, COMMAND_TIMEOUT_MS);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut, outputTruncated, timeoutMs: COMMAND_TIMEOUT_MS });
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish({ exitCode: 1, error: error.message }));
    child.once('close', (code, signal) => finish({ exitCode: timedOut ? 124 : (Number.isInteger(code) ? code : 1), signal, error: '' }));
  });
}

// POST /api/exec  { command, cwd }. Always returns the exit status: a command
// that writes an error must never be presented to the user or an AI as success.
app.post('/api/exec', async (req, res) => {
  const { command, cwd, write, network } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command is required' });
  try {
    res.json(await executionBroker.run({
      command: String(command), root: resolveBase(cwd || APP_DIR),
      write: write !== false, network: network === true,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ZAALIS BROWSER + DEEP SEARCH API
// ---------------------------------------------------------------------------
const ZAALIS_BROWSER_PING = 'http://127.0.0.1:8715/zaalis/ping';
const SEARCH_USER_AGENT = process.platform === 'darwin'
  ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 zaalis/1.0'
  : process.platform === 'linux'
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 zaalis/1.0'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 zaalis/1.0';

function browserLaunchCandidates() {
  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA ? { file: path.join(process.env.LOCALAPPDATA, 'Programs', 'zaalis browser', 'zaalis-browser.exe') } : null,
      { file: 'zaalis-browser.exe', pathLookup: true },
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [
      { file: 'open', args: ['-a', 'zaalis browser'], pathLookup: true },
      { file: path.join(os.homedir(), 'Applications', 'zaalis browser.app', 'Contents', 'MacOS', 'zaalis browser') },
      { file: '/Applications/zaalis browser.app/Contents/MacOS/zaalis browser' },
      { file: 'zaalis-browser', pathLookup: true },
    ];
  }
  return [
    { file: '/opt/zaalis-browser/zaalis-browser' },
    { file: '/opt/zaalis browser/zaalis-browser' },
    { file: '/usr/local/bin/zaalis-browser' },
    { file: '/usr/bin/zaalis-browser' },
    { file: 'zaalis-browser', pathLookup: true },
  ];
}

function spawnBrowserCandidate(candidate) {
  if (!candidate || !candidate.file) return false;
  if (!candidate.pathLookup && !fs.existsSync(candidate.file)) return false;
  try {
    const child = spawn(candidate.file, candidate.args || [], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

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

let launchingBrowser = null;
async function ensureZaalisBrowserRunning() {
  if (await pingZaalisBrowser(800)) return true;
  if (launchingBrowser) return launchingBrowser;

  launchingBrowser = (async () => {
    let tried = false;
    for (const candidate of browserLaunchCandidates()) {
      if (!spawnBrowserCandidate(candidate)) continue;
      tried = true;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await pingZaalisBrowser(800)) {
          await new Promise((r) => setTimeout(r, 700));
          return true;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return tried && await pingZaalisBrowser(800);
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

// ---------------------------------------------------------------------------
// OPEN-LICENSED IMAGE SEARCH + LOCAL ASSET DOWNLOAD
// ---------------------------------------------------------------------------
// The cache deliberately contains only results that our server just received
// from Openverse or Wikimedia Commons. image_download accepts an opaque result
// id rather than an arbitrary URL, which keeps the SSRF and licensing boundary
// on the server instead of trusting model-generated URLs.
const IMAGE_SEARCH_TTL_MS = 30 * 60 * 1000;
const MAX_CACHED_IMAGE_RESULTS = 480;
const MAX_IMAGE_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const imageSearchResults = new Map();

const IMAGE_TYPE_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
});

function compactImageText(value, max = 500) {
  return stripHtml(String(value || ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function imageFileType(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^image\//, '').replace(/^\./, '');
  if (raw === 'jpeg' || raw === 'jpg') return 'jpg';
  return ['png', 'webp', 'gif', 'avif'].includes(raw) ? raw : '';
}

function imageFileTypeFromUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return imageFileType(match && match[1]);
  } catch {
    return '';
  }
}

function imageMimeFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /^(avif|avis)$/i.test(bytes.subarray(8, 12).toString('ascii'))) return 'image/avif';
  return '';
}

function allowedImageDestinationType(relativePath) {
  return imageFileType(path.extname(relativePath));
}

function cacheImageSearchResult(result) {
  const now = Date.now();
  for (const [key, cached] of imageSearchResults) {
    if (!cached || cached.expiresAt <= now) imageSearchResults.delete(key);
  }
  while (imageSearchResults.size >= MAX_CACHED_IMAGE_RESULTS) {
    const oldest = imageSearchResults.keys().next().value;
    if (!oldest) break;
    imageSearchResults.delete(oldest);
  }
  const record = { ...result, expiresAt: now + IMAGE_SEARCH_TTL_MS };
  imageSearchResults.set(record.id, record);
  return {
    id: record.id,
    title: record.title,
    imageUrl: record.imageUrl,
    thumb: record.thumb,
    sourcePage: record.sourcePage,
    license: record.license,
    licenseUrl: record.licenseUrl,
    attribution: record.attribution,
    width: record.width,
    height: record.height,
    fileType: record.fileType,
    provider: record.provider,
  };
}

function normaliseOpenverseImage(row) {
  const imageUrl = publicHttpUrl(row && row.url);
  const sourcePage = publicHttpUrl(row && row.foreign_landing_url) || publicHttpUrl(row && row.detail_url);
  const fileType = imageFileType(row && row.filetype) || imageFileTypeFromUrl(imageUrl);
  const licenseKey = String(row && row.license || '').toLowerCase();
  if (!imageUrl || !sourcePage || !fileType || !['cc0', 'pdm', 'by', 'by-sa'].includes(licenseKey)) return null;
  const title = compactImageText(row.title || 'Image Openverse', 180);
  const creator = compactImageText(row.creator, 180);
  return {
    id: `ov:${row.id}`,
    imageUrl,
    thumb: publicHttpUrl(row.thumbnail) || imageUrl,
    sourcePage,
    license: compactImageText(`${String(row.license || '').toUpperCase()}${row.license_version ? ' ' + row.license_version : ''}`, 80),
    licenseUrl: publicHttpUrl(row.license_url),
    attribution: compactImageText(row.attribution || [title, creator].filter(Boolean).join(' — ')),
    title,
    creator,
    width: Number(row.width) || undefined,
    height: Number(row.height) || undefined,
    fileType,
    provider: 'Openverse',
  };
}

async function searchOpenverseImages(query, limit) {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.searchParams.set('q', query);
  url.searchParams.set('page_size', String(Math.min(Math.max(limit * 2, 8), 24)));
  // Exclude NC/ND works so a generated website is not accidentally given an
  // asset that cannot be adapted or used commercially.
  url.searchParams.set('license', 'cc0,pdm,by,by-sa');
  url.searchParams.set('mature', 'false');
  const response = await fetchWithTimeout(url.toString(), 9000, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const payload = await response.json();
  return (Array.isArray(payload && payload.results) ? payload.results : [])
    .map(normaliseOpenverseImage)
    .filter(Boolean)
    .slice(0, limit);
}

function normaliseWikimediaImage(page) {
  const info = page && Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  if (!info) return null;
  const imageUrl = publicHttpUrl(info.thumburl) || (Number(info.size) <= MAX_IMAGE_DOWNLOAD_BYTES ? publicHttpUrl(info.url) : null);
  const sourcePage = publicHttpUrl(info.descriptionurl);
  const fileType = imageFileType(info.mime) || imageFileTypeFromUrl(imageUrl);
  const meta = info.extmetadata || {};
  const license = compactImageText((meta.LicenseShortName && meta.LicenseShortName.value) || (meta.License && meta.License.value) || (meta.UsageTerms && meta.UsageTerms.value), 100);
  if (!imageUrl || !sourcePage || !fileType || !license) return null;
  const title = compactImageText(String(page.title || 'Image Wikimedia Commons').replace(/^File:/i, ''), 180);
  const creator = compactImageText(meta.Artist && meta.Artist.value, 180);
  const attribution = compactImageText((meta.Attribution && meta.Attribution.value) || [title, creator].filter(Boolean).join(' — '));
  return {
    id: `commons:${page.pageid}`,
    imageUrl,
    thumb: publicHttpUrl(info.thumburl) || imageUrl,
    sourcePage,
    license,
    licenseUrl: publicHttpUrl(meta.LicenseUrl && meta.LicenseUrl.value),
    attribution,
    title,
    creator,
    width: Number(info.thumbwidth || info.width) || undefined,
    height: Number(info.thumbheight || info.height) || undefined,
    fileType,
    provider: 'Wikimedia Commons',
  };
}

async function searchWikimediaImages(query, limit) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', query);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', String(Math.min(Math.max(limit * 2, 8), 24)));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|mime|size|extmetadata');
  // The thumbnail is a web-appropriate asset; originals on Commons often
  // exceed practical website and download limits.
  url.searchParams.set('iiurlwidth', '1440');
  url.searchParams.set('format', 'json');
  const response = await fetchWithTimeout(url.toString(), 9000, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const payload = await response.json();
  return Object.values(payload && payload.query && payload.query.pages || {})
    .map(normaliseWikimediaImage)
    .filter(Boolean)
    .slice(0, limit);
}

async function searchOpenLicensedImages(query, limit = 8) {
  const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const max = Math.min(Math.max(Number(limit) || 8, 1), 12);
  if (!cleanQuery) return [];
  const settled = await Promise.allSettled([
    searchOpenverseImages(cleanQuery, max),
    searchWikimediaImages(cleanQuery, max),
  ]);
  const candidates = settled.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
  const seen = new Set();
  const results = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.imageUrl)) continue;
    seen.add(candidate.imageUrl);
    results.push(cacheImageSearchResult(candidate));
    if (results.length >= max) break;
  }
  return results;
}

function isPrivateIpAddress(address) {
  const value = String(address || '').toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) || (a === 203 && b === 0);
  }
  if (family === 6) {
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpAddress(mapped[1]);
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe80:') || value.startsWith('ff') || value.startsWith('2001:db8');
  }
  return true;
}

async function assertPublicImageTarget(rawUrl) {
  const safe = publicHttpUrl(rawUrl);
  if (!safe) throw new Error('URL image non publique ou invalide.');
  const host = new URL(safe).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIpAddress(host)) throw new Error('Hôte image privé bloqué.');
    return safe;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Hôte image introuvable.');
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error('Hôte image non public bloqué.');
  }
  return safe;
}

async function readImageResponseBytes(response) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new Error(`Image trop lourde (maximum ${Math.round(MAX_IMAGE_DOWNLOAD_BYTES / 1024 / 1024)} Mo).`);
  }
  if (!response.body) throw new Error('Réponse image vide.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_DOWNLOAD_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error(`Image trop lourde (maximum ${Math.round(MAX_IMAGE_DOWNLOAD_BYTES / 1024 / 1024)} Mo).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchPublicImageBytes(rawUrl) {
  let target = publicHttpUrl(rawUrl);
  if (!target) throw new Error('URL image non publique ou invalide.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    for (let redirectCount = 0; redirectCount <= 4; redirectCount++) {
      target = await assertPublicImageTarget(target);
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': SEARCH_USER_AGENT,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirection image invalide.');
        target = publicHttpUrl(new URL(location, target).toString());
        if (!target) throw new Error('Redirection vers une URL non publique bloquée.');
        continue;
      }
      if (!response.ok) throw new Error(`Téléchargement image HTTP ${response.status}.`);
      const bytes = await readImageResponseBytes(response);
      const mime = imageMimeFromBytes(bytes);
      if (!IMAGE_TYPE_BY_MIME[mime]) throw new Error('Le fichier téléchargé n’est pas une image raster prise en charge.');
      const declaredMime = String(response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      if (declaredMime.startsWith('image/') && IMAGE_TYPE_BY_MIME[declaredMime] && declaredMime !== mime) {
        throw new Error('Le type MIME déclaré ne correspond pas au contenu image.');
      }
      return { bytes, mime };
    }
    throw new Error('Trop de redirections image.');
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Téléchargement image expiré.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normaliseImageDestination(root, requestedPath) {
  const base = path.resolve(root);
  let relative = String(requestedPath || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/\\/g, '/');
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) throw new Error('Chemin image relatif requis.');
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Chemin image invalide.');
  relative = parts.join('/');
  if (!allowedImageDestinationType(relative)) throw new Error('L’image doit avoir une extension .jpg, .png, .webp, .gif ou .avif.');
  const full = path.resolve(base, relative);
  if (!isInsideBase(base, full)) throw new Error('Chemin image hors projet refusé.');
  return { base, relative, full };
}

function ensureSafeImageDestination(destination) {
  const baseReal = fs.realpathSync(destination.base);
  fs.mkdirSync(path.dirname(destination.full), { recursive: true });
  const parentReal = fs.realpathSync(path.dirname(destination.full));
  if (!isInsideBase(baseReal, parentReal)) throw new Error('Dossier image hors projet refusé.');
  if (fs.existsSync(destination.full) && fs.lstatSync(destination.full).isSymbolicLink()) {
    throw new Error('Lien symbolique image refusé.');
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function writeImageAttribution(destination, record) {
  const directory = path.posix.dirname(destination.relative);
  const relativePath = directory === '.' ? 'ATTRIBUTIONS.md' : `${directory}/ATTRIBUTIONS.md`;
  const fullPath = path.resolve(destination.base, relativePath);
  if (!isInsideBase(destination.base, fullPath)) throw new Error('Chemin d’attribution hors projet refusé.');
  if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isSymbolicLink()) throw new Error('Lien symbolique d’attribution refusé.');
  const start = `<!-- zaalis-image:${destination.relative.replace(/--/g, '-') } -->`;
  const end = '<!-- /zaalis-image -->';
  const lines = [
    start,
    `Image : ${compactImageText(record.title || destination.relative, 180)}`,
    `Source : ${record.sourcePage || record.imageUrl}`,
    `Licence : ${compactImageText(record.license || 'non précisée', 120)}${record.licenseUrl ? ` — ${record.licenseUrl}` : ''}`,
    `Attribution : ${compactImageText(record.attribution || record.creator || 'voir la page source', 500)}`,
    end,
  ];
  const block = lines.join('\n');
  let current = '';
  try { current = fs.readFileSync(fullPath, 'utf8'); } catch {}
  const existingBlock = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'g');
  const next = existingBlock.test(current)
    ? current.replace(existingBlock, block)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}# Image attributions\n\n${block}\n`;
  fs.writeFileSync(fullPath, next, 'utf8');
  return relativePath;
}

async function downloadProjectImage({ id, path: requestedPath, root }) {
  const record = imageSearchResults.get(String(id || ''));
  if (!record || record.expiresAt <= Date.now()) {
    if (record) imageSearchResults.delete(String(id || ''));
    throw new Error('Résultat image expiré : relance image_search avant le téléchargement.');
  }
  const destination = normaliseImageDestination(root, requestedPath);
  const { bytes, mime } = await fetchPublicImageBytes(record.imageUrl);
  const expectedType = allowedImageDestinationType(destination.relative);
  if (IMAGE_TYPE_BY_MIME[mime] !== expectedType) {
    throw new Error(`Extension ${path.extname(destination.relative)} incompatible avec l’image ${IMAGE_TYPE_BY_MIME[mime]}.`);
  }
  ensureSafeImageDestination(destination);
  fs.writeFileSync(destination.full, bytes);
  const attributionPath = writeImageAttribution(destination, record);
  return { path: destination.relative, bytes: bytes.length, mime, attributionPath };
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
  if (!q) return res.status(400).json({ error: 'Missing q' });

  const mode = String(req.query.mode || 'same').toLowerCase();
  const background = mode === 'background';
  const endpoint = mode === 'newtab' || background ? 'search-newtab?q=' : 'search?q=';
  const visibleParam = background ? '&background=1' : '';

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
    const url = `http://127.0.0.1:8715/zaalis/${endpoint}${encodeURIComponent(q)}${visibleParam}`;
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
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? 'zaalis browser ne repond pas'
      : 'zaalis browser est indisponible';
    res.status(502).json({ error: msg, detail: err.message });
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
        // execFile bypasses the shell, so it resolves `name` against this
        // process's PATH — which is minimal under Finder/Electron. Use the
        // augmented env so installed tools (git, python3, node…) are found.
        execFile(name, ['--version'], { timeout: 5000, env: execEnv() }, done);
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
      execFile('rg', args, { cwd: base, timeout: 15000, maxBuffer: 1024 * 1024 * 8, windowsHide: true, env: execEnv() }, (err, stdout, stderr) => {
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
      execFile('git', ['-C', base, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 * 16, windowsHide: true, env: execEnv() },
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

    const installerPaths = [
      path.join(APP_DIR, 'native', 'installer', 'zaalis-macos-universal-installer.tar.gz'),
      path.join(process.cwd(), 'native', 'installer', 'zaalis-macos-universal-installer.tar.gz'),
    ];
    const installer = installerPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });

    let scripts = [];
    try { const pj = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8')); scripts = Object.keys(pj.scripts || {}); } catch {}

    let projectGit = null;
    if (base && git.available) {
      projectGit = await new Promise((resolve) => {
        execFile('git', ['-C', base, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000, windowsHide: true, env: execEnv() },
          (e, so) => resolve(e ? null : String(so || '').trim()));
      });
    }

    res.json({
      version: APP_VERSION,
      node: process.version,
      npm, git, rg, ollama, gguf, installer,
      installerPath: 'native/installer/zaalis-macos-universal-installer.tar.gz',
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
  // In the packaged Electron app the renderer picks the folder through the
  // native IPC bridge (window.zaalisNative.pickFolder); this HTTP endpoint is
  // the browser/dev fallback. Provide a real dialog on macOS via osascript.
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "Choisissez le dossier du projet")';
    execFile('osascript', ['-e', script], { timeout: 180000, env: execEnv() }, (err, stdout) => {
      if (err) {
        // -128 / "User canceled" = the user dismissed the dialog: not an error.
        if (/User canceled|-128/i.test(err.message || '')) return res.json({ cancelled: true });
        return res.status(500).json({ error: err.message });
      }
      const selected = (stdout || '').trim();
      if (!selected) return res.json({ cancelled: true });
      res.json({ path: selected });
    });
    return;
  }
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'Folder picker only available on Windows/macOS.' });
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
    // Ollama is optional. An unavailable local runtime must not look like an
    // IDE server failure in DevTools, nor flood the console while polling.
    res.json({ models: [], unavailable: true });
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
// machine (Metal / CUDA / Vulkan / CPU) into the local zaalis engine dir, spawn it as a
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
  if (process.platform === 'darwin') { _gpuVariant = 'metal'; return _gpuVariant; }
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

function engineBinaryName() {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function normalizeEngineVariant(variant) {
  const v = String(variant || '').toLowerCase();
  if (process.platform === 'darwin') return (v === 'metal' || v === 'cpu') ? v : detectEngineVariant();
  if (process.platform === 'win32') return (v === 'cuda' || v === 'vulkan' || v === 'cpu') ? v : detectEngineVariant();
  return v === 'cpu' ? 'cpu' : detectEngineVariant();
}

function macosEngineArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function engineAssetUrls(variant) {
  variant = normalizeEngineVariant(variant);
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`;
  if (process.platform === 'darwin') {
    // The macOS release asset includes Metal support; CPU mode is enforced at launch with -ngl 0.
    return [base + `llama-${LLAMA_TAG}-bin-macos-${macosEngineArch()}.tar.gz`];
  }
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

function ensureExecutable(file) {
  if (process.platform === 'win32' || !file) return;
  try { fs.chmodSync(file, 0o755); } catch {}
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

// Extract a .zip or .tar.gz. Tricky on Windows:
//  - the SYSTEM tar (C:\Windows\System32\tar.exe = bsdtar) reads zip, but a bare
//    "tar" may resolve to Git's GNU tar (no zip support), so we call it by full
//    path. bsdtar also reads "C:\path" as host:path, so we cd into the folder
//    and pass a relative name (no colon).
//  - if that fails, fall back to PowerShell's Expand-Archive (always present).
function extractArchive(archivePath, destDir) {
  ensureDir(destDir);
  const { execSync } = require('child_process');
  if (/\.tar\.gz$/i.test(archivePath) || /\.tgz$/i.test(archivePath)) {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { timeout: 300000, windowsHide: true });
    return;
  }
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(sysTar)) {
    try {
      execSync(`"${sysTar}" -xf "${path.basename(archivePath)}" -C .`, {
        cwd: path.dirname(archivePath), timeout: 180000, windowsHide: true,
      });
      return;
    } catch { /* fall through to PowerShell */ }
  }
  const q = (s) => s.replace(/'/g, "''");
  const ps = `Expand-Archive -LiteralPath '${q(archivePath)}' -DestinationPath '${q(destDir)}' -Force`;
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, { timeout: 300000, windowsHide: true });
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
    const zip = path.join(vdir, path.basename(url));
    if (onLog) onLog({ stage: 'engine', pct: 0, part: i + 1, parts: urls.length });
    await downloadTo(url, zip, (rec, tot) => {
      if (onLog && tot) onLog({ stage: 'engine', pct: Math.round((rec / tot) * 100), part: i + 1, parts: urls.length });
    });
    if (onLog) onLog({ stage: 'extract', pct: 100, part: i + 1, parts: urls.length });
    extractArchive(zip, vdir);
    try { fs.unlinkSync(zip); } catch {}
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
    const variant = requestedVariant;
    const startVariant = async (v) => {
      const exe = await ensureEngineBinary(v);
      const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(ENGINE_PORT), '--ctx-size', String(ctx), '--jinja'];
      // CPU mode must not offload layers, even when the macOS binary includes Metal.
      if (v === 'cpu') args.push('-ngl', '0');
      else if (ngl > 0) args.push('-ngl', String(ngl));
      engineOpts = optsKey;
      const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore', cwd: path.dirname(exe) });
      proc.on('error', () => {});
      engineProc = proc; engineModelFile = modelFile; engineVariant = v; engineRequestedVariant = requestedVariant;
      proc.once('exit', () => {
        if (engineProc === proc) {
          engineProc = null; engineModelFile = null; engineVariant = null; engineRequestedVariant = null;
        }
      });
      await waitForHealth(ENGINE_PORT, 180000);
    };
    try {
      await startVariant(variant);
    } catch (e) {
      await stopEngine();
      if (variant === 'cpu') throw e;
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

// ---------------------------------------------------------------------------
// VOICE — briques locales du mode vocal du navigateur.
// Sur macOS, le transcripteur Speech est inclus dans l'application : ni
// Homebrew ni téléchargement d'un modèle n'est requis. Whisper reste un
// secours pour les anciennes installations et les autres plateformes.
// La synthèse repose sur les voix macOS déjà disponibles, ou Piper ailleurs.
// ---------------------------------------------------------------------------
const VOICE_DIR = path.join(DATA_DIR, 'voice');
const WHISPER_MODEL_FILE = 'ggml-small.bin';        // plan Intel : whisper small
const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + WHISPER_MODEL_FILE;

// Cherche un exécutable : d'abord dans DATA_DIR/voice (dépôt manuel), puis
// dans les emplacements Homebrew/usuels, puis via PATH.
function findVoiceBinary(names) {
  const dirs = [
    VOICE_DIR,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    path.join(os.homedir(), '.local', 'bin'),
  ];
  for (const n of names) {
    const inVoice = findExeRecursive(VOICE_DIR, n);
    if (inVoice) return inVoice;
    for (const d of dirs) {
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}
function whisperBinary() { return findVoiceBinary(['whisper-cli', 'whisper-cpp']); }
function piperBinary()   { return findVoiceBinary(['piper']); }
function whisperModelPath() { return path.join(VOICE_DIR, WHISPER_MODEL_FILE); }

function macSpeechHelper() {
  if (process.platform !== 'darwin') return null;
  // Dans l'application empaquetée, le serveur est dans Resources/app/bundle
  // et le binaire Speech est placé dans Resources/app. Le second chemin rend
  // aussi le lancement depuis une arborescence de développement tolérant.
  const candidates = [
    path.join(APP_DIR, '..', 'macos-speech-transcriber'),
    path.join(APP_DIR, 'macos-speech-transcriber'),
    path.join(APP_DIR, 'native', 'macos-speech-transcriber'),
  ];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function macSpeechLocale(language) {
  const lang = String(language || '').toLowerCase();
  if (lang === 'fr') return 'fr-FR';
  if (lang === 'en') return 'en-US';
  return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(lang) ? lang : 'fr-FR';
}

function transcribeWithMacSpeech(helper, wav, language) {
  return new Promise((resolve, reject) => {
    execFile(helper, ['--file', wav, '--language', macSpeechLocale(language)], {
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const events = String(stdout || '').split(/\r?\n/).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const transcript = events.reverse().find((event) => event.status === 'transcript' && event.text);
      if (transcript) return resolve(String(transcript.text).replace(/\s+/g, ' ').trim());
      const eventError = events.find((event) => event.status === 'error' && event.error);
      const reason = (eventError && eventError.error) || String(stderr || '').trim() ||
        (err && err.message) || 'speech-transcription-failed';
      reject(new Error(reason));
    });
  });
}

// Téléchargement (unique) du modèle whisper, dans l'esprit des pulls gguf.
let whisperPull = null;   // { status, completed, total, error }
function startWhisperModelPull() {
  if (whisperPull && whisperPull.status === 'downloading') return whisperPull;
  if (fs.existsSync(whisperModelPath())) return { status: 'success' };
  whisperPull = { status: 'downloading', completed: 0, total: 0, error: '' };
  const tmp = whisperModelPath() + '.part';
  ensureDir(VOICE_DIR);
  downloadTo(WHISPER_MODEL_URL, tmp, (rec, tot) => {
    whisperPull.completed = rec; whisperPull.total = tot;
  }).then(() => {
    fs.renameSync(tmp, whisperModelPath());
    whisperPull.status = 'success';
  }).catch((e) => {
    whisperPull.status = 'error';
    whisperPull.error = (e && e.message) || String(e);
    try { fs.unlinkSync(tmp); } catch {}
  });
  return whisperPull;
}

// Première voix française installée pour `say` (fallback voix système sinon).
let _sayVoice = null;
function macSayVoice() {
  if (_sayVoice !== null) return _sayVoice;
  _sayVoice = '';
  try {
    const out = execSyncSafe('say -v ? 2>/dev/null || true');
    for (const line of String(out).split('\n')) {
      if (/fr_FR|fr-FR/.test(line)) { _sayVoice = line.trim().split(/\s{2,}|\s(?=fr)/)[0].trim(); break; }
    }
  } catch {}
  return _sayVoice;
}

// Six voix françaises présentes par défaut sur les versions récentes de
// macOS. Le catalogue reste stable dans les réglages ; les voix réellement
// installées sont marquées disponibles afin de retomber sans erreur sur la
// voix système si une variante a été retirée par Apple.
const MAC_VOICE_CATALOG = [
  { id: 'amelie', name: 'Amélie', label: 'Amélie', gender: 'female' },
  { id: 'flo', name: 'Flo (Français (Canada))', label: 'Flo', gender: 'female' },
  { id: 'sandy', name: 'Sandy (Français (France))', label: 'Sandy', gender: 'female' },
  { id: 'thomas', name: 'Thomas', label: 'Thomas', gender: 'male' },
  { id: 'jacques', name: 'Jacques', label: 'Jacques', gender: 'male' },
  { id: 'eddy', name: 'Eddy (Français (France))', label: 'Eddy', gender: 'male' },
];

let _macVoices = null;
function macInstalledVoices() {
  if (_macVoices) return _macVoices;
  _macVoices = new Set();
  if (process.platform !== 'darwin') return _macVoices;
  try {
    const out = execSyncSafe('say -v ? 2>/dev/null || true');
    for (const line of String(out).split('\n')) {
      const match = line.match(/^(.*?)\s+fr_(?:FR|CA)\s+#/);
      if (match) _macVoices.add(match[1].trim());
    }
  } catch {}
  return _macVoices;
}

function macVoiceOptions() {
  const installed = macInstalledVoices();
  return MAC_VOICE_CATALOG.map((voice) => ({
    id: voice.id, label: voice.label, gender: voice.gender,
    available: installed.has(voice.name),
  }));
}

function macVoiceName(selection) {
  const wanted = MAC_VOICE_CATALOG.find((voice) => voice.id === String(selection || ''));
  if (wanted && macInstalledVoices().has(wanted.name)) return wanted.name;
  return macSayVoice();
}
// Voix Piper française : premier fichier *.onnx contenant "fr" dans voice/.
function piperVoicePath() {
  try {
    const files = fs.readdirSync(VOICE_DIR).filter((f) => f.endsWith('.onnx'));
    return files.length
      ? path.join(VOICE_DIR, files.find((f) => /(^|[-_])fr/i.test(f)) || files[0])
      : null;
  } catch { return null; }
}

function voiceStatusSnapshot() {
  const macSpeech = macSpeechHelper();
  const bin = whisperBinary();
  const model = fs.existsSync(whisperModelPath());
  const pull = whisperPull && whisperPull.status === 'downloading' ? {
    downloading: true, completed: whisperPull.completed, total: whisperPull.total,
  } : null;
  const piper = piperBinary();
  const piperVoice = piper ? piperVoicePath() : null;
  return {
    stt: {
      ready: !!macSpeech || !!(bin && model),
      engine: macSpeech ? 'macos-speech' : (bin ? 'whisper' : 'none'),
      binary: !!(macSpeech || bin), model, pull,
      hint: macSpeech ? '' : (bin ? (model ? '' : 'Modèle vocal en cours d\'installation…')
                                      : 'La reconnaissance vocale sera disponible après la mise à jour de zaalis labs IDE.'),
    },
    tts: {
      ready: process.platform === 'darwin' || !!(piper && piperVoice),
      engine: (piper && piperVoice) ? 'piper' : (process.platform === 'darwin' ? 'say' : 'none'),
      voices: process.platform === 'darwin' ? macVoiceOptions() : [],
    },
  };
}

// GET /api/voice-status -> état des briques vocales ; lance le téléchargement
// du modèle whisper si le binaire est là mais pas le modèle.
app.get('/api/voice-status', (req, res) => {
  try {
    if (!macSpeechHelper() && whisperBinary() && !fs.existsSync(whisperModelPath())) startWhisperModelPull();
    res.json(voiceStatusSnapshot());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/voice-options -> six voix proposées au navigateur avec leur état.
app.get('/api/voice-options', (_req, res) => {
  res.json({ voices: process.platform === 'darwin' ? macVoiceOptions() : [] });
});

// POST /api/stt { audio: <base64 WAV 16 kHz mono>, language? } -> { text }
app.post('/api/stt', async (req, res) => {
  const macSpeech = macSpeechHelper();
  const bin = whisperBinary();
  if (!macSpeech && !bin) return res.status(409).json({ error: 'stt-unavailable', hint: 'Mettez à jour zaalis labs IDE pour activer la reconnaissance vocale.' });
  if (!macSpeech && !fs.existsSync(whisperModelPath())) {
    const pull = startWhisperModelPull();
    return res.status(409).json({ error: 'model-downloading',
      completed: pull.completed || 0, total: pull.total || 0 });
  }
  const b64 = String((req.body && req.body.audio) || '');
  if (!b64) return res.status(400).json({ error: 'audio requis' });
  const lang = /^[a-z]{2}$/.test(String(req.body.language || '')) ? req.body.language : 'fr';
  ensureDir(VOICE_DIR);
  const wav = path.join(VOICE_DIR, 'stt-' + process.pid + '-' + Date.now() + '.wav');
  try {
    fs.writeFileSync(wav, Buffer.from(b64, 'base64'));
    let text;
    if (macSpeech) {
      text = await transcribeWithMacSpeech(macSpeech, wav, lang);
    } else {
      text = await new Promise((resolve, reject) => {
        execFile(bin, [
          '-m', whisperModelPath(), '-f', wav, '-l', lang,
          '-nt', '-np', '-t', String(Math.max(2, Math.min(8, os.cpus().length - 1))),
        ], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err); else resolve(String(stdout || ''));
        });
      });
    }
    res.json({ text: String(text).replace(/\s+/g, ' ').trim() });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || String(e) });
  } finally {
    try { fs.unlinkSync(wav); } catch {}
  }
});

// POST /api/tts { text } -> { audio: <base64 WAV> }
// Piper (voix neurale) si installé avec une voix, sinon `say` macOS.
app.post('/api/tts', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 1200);
  if (!text) return res.status(400).json({ error: 'text requis' });
  ensureDir(VOICE_DIR);
  const out = path.join(VOICE_DIR, 'tts-' + process.pid + '-' + Date.now() + '.wav');
  const { execFile } = require('child_process');
  const run = (cmd, args, input) => new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 60000 }, (err) => err ? reject(err) : resolve());
    if (input != null && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  });
  try {
    const piper = piperBinary();
    const voice = piper ? piperVoicePath() : null;
    if (piper && voice) {
      await run(piper, ['--model', voice, '--output_file', out], text);
    } else if (process.platform === 'darwin') {
      const args = ['-o', out, '--data-format=LEI16@22050'];
      const v = macVoiceName(req.body && req.body.voice);
      if (v) args.push('-v', v);
      args.push(text);
      await run('/usr/bin/say', args);
    } else {
      return res.status(409).json({ error: 'tts-missing', hint: 'Installez Piper (binaire + voix .onnx dans le dossier voice).' });
    }
    const audio = fs.readFileSync(out).toString('base64');
    res.json({ audio });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || String(e) });
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
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

// GET /api/gguf-engine-pull?variant=cpu|metal|cuda|vulkan -> download the engine, NDJSON progress
app.get('/api/gguf-engine-pull', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  try {
    const variant = normalizeEngineVariant(req.query.variant || detectEngineVariant());
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
app.get('/api/agent-tools', (req, res) => {
  res.json({ protocol: 'zaalis.tool.v1', tools: TOOL_CATALOG });
});

app.post('/api/agent-chat', async (req, res) => {
  let wantsStream = false;
  let streamOpen = false;
  let computerSession = null;
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
    const computerControl = b.computerControl === true;
    if (computerControl && req.isBrowser) return respondError(403, 'Le contrôle du Mac est indisponible depuis Zaalis Browser.');
    if (computerControl && !['codex', 'claude', 'gemini', 'grok', 'mistral', 'kimi', 'local', 'gguf'].includes(String(model))) {
      return respondError(400, 'Le contrôle du Mac est indisponible pour ce modèle.');
    }

    const root = resolveBase(b.root || b.projectRoot);
    const existingSession = b.sessionId ? sessionStore.get(String(b.sessionId), req.user.id) : null;
    const agentSession = existingSession || sessionStore.create({
      userId: req.user.id,
      cwd: root,
      title: String(message).replace(/\s+/g, ' ').trim().slice(0, 120),
      model,
      submodel: b.submodel,
    });
    const turnId = `turn_${crypto.randomUUID()}`;
    const suppliedRules = b.config && b.config.toolPermissions;
    const runtimeConfig = {
      ...sharedConfigForUser(req.user),
      ...(b.config && typeof b.config === 'object' ? b.config : {}),
      // The server is the authoritative enforcement point. A client may
      // narrow its own session rules, but malformed rules never reach tools.
      toolPermissions: normaliseRules(suppliedRules || sharedConfigForUser(req.user).toolPermissions),
    };
    runtimeConfig.customSystemInstructions = sharedConfigForUser(req.user).customSystemInstructions;
    sessionStore.append(agentSession.id, { type: 'message', role: 'user', turnId, content: message });
    const cookie = req.headers.cookie || '';
    const callModel = async (payload) => {
      const requestedTimeout = parseInt(payload.timeoutMs, 10);
      // A deep security audit carries a very large context and legitimately
      // needs several minutes. The old 120s ceiling silently overrode the
      // engine's own budget and killed healthy calls mid-report.
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.max(1000, Math.min(requestedTimeout, 300000))
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

    // The agent's `browser` tool previews a URL in the zaalis browser. Runs on
    // the same machine as the server (both talk to localhost:8715), so opening
    // server-side works identically for the desktop IDE and the CLI.
    const openBrowser = async (url) => {
      const r = await openInZaalisBrowser(url, { background: false });
      return r.ok ? { ok: true } : { ok: false, error: r.body && (r.body.message || r.body.error) };
    };
    const imageDownload = ({ id, path: imagePath }) => downloadProjectImage({ id, path: imagePath, root });
    const configuredMcpServers = mcpServersForUser(req.user).filter((server) => server.enabled);
    const agentMessage = configuredMcpServers.length
      ? `${message}\n\n[MCP CONFIGURÉS]\nUtilise l’outil mcp uniquement si nécessaire. Serveurs disponibles : ${configuredMcpServers.map((server) => `${server.id} (${server.name})`).join(', ')}. Demande tools/list mentalement via le contexte ou appelle seulement un outil dont le nom a été confirmé.`
      : message;
    const webFetch = async (url, maxChars = 12000) => {
      const target = new URL(String(url));
      if (target.protocol !== 'https:' || !target.hostname || target.username || target.password) throw new Error('Seules les URLs HTTPS publiques sont autorisées.');
      const addresses = await dns.lookup(target.hostname, { all: true });
      const privateAddress = (address) => {
        if (net.isIP(address) === 4) return /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/.test(address);
        const low = String(address).toLowerCase(); return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80:');
      };
      if (!addresses.length || addresses.some((row) => privateAddress(row.address))) throw new Error('Adresse privée ou locale refusée.');
      const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'zaalis-security-fetch/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.max(100, Math.min(Number(maxChars) || 12000, 50000)));
    };
    if (computerControl) {
      computerSession = await automationManager.start({ userId: req.user.id, permissionMode: b.permissionMode || 'supervised' });
      if (wantsStream) writeStreamEvent({ type: 'automation', session: automationManager.snapshot(computerSession) });
    }

    const emitAgentEvent = (event) => {
      sessionStore.append(agentSession.id, { type: 'agent_event', turnId, event });
      // Internal events (per-round model transcripts) are persisted for
      // post-mortem but never streamed: they are diagnostics, not UI.
      if (wantsStream && !(event && event.internal)) writeStreamEvent(event);
    };
    const result = await runAgentTurn({
      root,
      sessionId: agentSession.id,
      turnId,
      agentId: String(b.agentId || 'lead').slice(0, 128),
      model,
      submodel: b.submodel,
      message: agentMessage,
      config: runtimeConfig,
      reasoningLevel: b.reasoningLevel,
      images: Array.isArray(b.images) ? b.images : [],
      history: Array.isArray(b.history) ? b.history : [],
      permissionMode: b.permissionMode || 'supervised',
      language: b.language || 'fr',
      subAgentTimeoutMs: b.subAgentTimeoutMs,
      callModel,
      openBrowser,
      imageSearch: searchOpenLicensedImages,
      imageDownload,
      brainMcp: b.useBrain === true && brainMcpForUser(req.user)
        ? { callTool: (tool, args) => brainMcp.callTool(brainMcpForUser(req.user), tool, args) }
        : null,
      mcpRegistry: {
        callTool: (serverId, tool, args) => {
          const server = mcpServerForUser(req.user, serverId);
          if (!server) throw new Error('Serveur MCP non configuré ou désactivé.');
          return mcpRegistry.call(server, tool, args);
        },
      },
      languageService,
      projectInspector,
      computerControl: computerControl ? automationManager : null,
      computerSession,
      executionBroker,
      securityPipeline,
      webFetch,
      emitEvent: emitAgentEvent,
    });
    for (const toolResult of (Array.isArray(result.toolResults) ? result.toolResults : [])) {
      if (!toolResult || toolResult.code !== 'approval_required' || toolResult.terminal || !toolResult.callId) continue;
      toolResult.approval = approvalStore.issue({
        sessionId: agentSession.id,
        callId: toolResult.callId,
        tool: toolResult.tool,
        input: toolResult.input,
        userId: req.user.id,
        context: { root, rules: runtimeConfig.toolPermissions },
      });
    }
    sessionStore.append(agentSession.id, { type: 'message', role: 'assistant', turnId, content: result.response || '', toolResults: result.toolResults || [] });
    if (computerSession) await automationManager.complete(computerSession);
    if (wantsStream) {
      writeStreamEvent({ type: 'done', result });
      try { res.end(); } catch {}
    } else {
      res.json(result);
    }
  } catch (err) {
    if (computerSession) await automationManager.stop(computerSession, 'Tâche interrompue par une erreur.');
    if (wantsStream) {
      openStream(res.headersSent ? 200 : 500);
      try { res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n'); } catch {}
      try { res.end(); } catch {}
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

function boundedReasoningLevel(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function pickReasoningValue(values, level) {
  if (!Array.isArray(values) || !values.length) return undefined;
  return values[Math.min(boundedReasoningLevel(level), values.length - 1)];
}

function openAIReasoningEffort(modelName, level) {
  if (/^gpt-5\.6/.test(modelName)) return pickReasoningValue(['none', 'low', 'medium', 'high', 'xhigh', 'max'], level);
  if (/^gpt-5\.(5|4|2)/.test(modelName)) return pickReasoningValue(['none', 'low', 'medium', 'high', 'xhigh'], level);
  if (/^gpt-5\.1/.test(modelName)) return pickReasoningValue(['none', 'low', 'medium', 'high'], level);
  if (/^(o1|o3-mini)/.test(modelName)) return pickReasoningValue(['low', 'medium', 'high'], level);
  return undefined;
}

function xaiReasoningEffort(modelName, level) {
  if (modelName === 'grok-4.5') return pickReasoningValue(['low', 'medium', 'high'], level);
  if (modelName === 'grok-4.3') return pickReasoningValue(['none', 'low', 'medium', 'high'], level);
  if (modelName === 'grok-4.20-multi-agent-0309') return pickReasoningValue(['low', 'medium', 'high', 'xhigh'], level);
  return undefined;
}

function parseMistralContent(content) {
  if (typeof content === 'string') return { text: content, thinking: '' };
  if (!Array.isArray(content)) return { text: '', thinking: '' };
  const text = [], thinking = [];
  for (const chunk of content) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text' && typeof chunk.text === 'string') text.push(chunk.text);
    if (chunk.type === 'thinking') {
      if (typeof chunk.thinking === 'string') thinking.push(chunk.thinking);
      const pieces = Array.isArray(chunk.thinking) ? chunk.thinking : [];
      for (const piece of pieces) if (piece && typeof piece.text === 'string') thinking.push(piece.text);
    }
  }
  return { text: text.join(''), thinking: thinking.join('\n') };
}

// POST /api/chat  { model, submodel, message, systemPrompt, config, reasoningLevel, images }
// images: [{ mime, data(base64) }]  — sent to vision-capable models only.
app.post('/api/chat', async (req, res) => {
  try {
    const { model, submodel, message, systemPrompt, config, reasoningLevel } = req.body;
    const images = Array.isArray(req.body.images) ? req.body.images : [];
    // Prior conversation turns (memory). Each: { role: 'user'|'assistant', content: string }
    const history = Array.isArray(req.body.history)
      ? req.body.history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.role === 'assistant' && typeof m.reasoning_content === 'string'
              ? { reasoning_content: m.reasoning_content }
              : {}),
          }))
      : [];
    if (!model || !message) {
      return res.status(400).json({ error: 'model and message are required' });
    }

    // API keys come from the encrypted per-user vault. Keys still sent by an
    // older client (pre-1.0.9 localStorage) are accepted as a fallback only.
    const runtimeConfig = { ...sharedConfigForUser(req.user), ...(config && typeof config === 'object' ? config : {}) };
    // A saved preference is authoritative. This prevents an arbitrary web
    // client from silently supplying a different persistent instruction set.
    runtimeConfig.customSystemInstructions = sharedConfigForUser(req.user).customSystemInstructions;
    const effectiveSystemPrompt = mergeCustomSystemInstructions(systemPrompt, runtimeConfig);
    const keys = { ...(runtimeConfig.keys || {}), ...userApiKeys(req.user) };
    const ollamaUrl = runtimeConfig.ollamaUrl || 'http://127.0.0.1:11434';
    const ollamaModel = runtimeConfig.ollamaModel || 'llama3';
    // Native calls are preferred by every capable provider. The text protocol
    // remains a compatibility fallback for older/local models.
    const useNativeTools = req.body.nativeTools === true || req.body.computerTools === true;
    const computerOnlyTools = req.body.computerTools === true;
    const providerTools = () => openAIFunctionTools({ computerOnly: computerOnlyTools });

    let responseText = '';
    let thinkingText = '';
    let usage = null;
    let nativeToolCalls = [];
    // Why the provider stopped. Without it, an answer cut at the token ceiling
    // is indistinguishable from a finished one — every surface then treats a
    // truncated security report as complete.
    let finishReason = '';

    // ----- OpenAI (Codex) -----
    if (model === 'codex') {
      if (!keys.openai) return res.json({ response: '[OpenAI] Aucune cle API configuree.' });

      const messages = [];
      if (effectiveSystemPrompt) messages.push({ role: 'system', content: effectiveSystemPrompt });
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

      const openAIModel = submodel || 'gpt-5.6-sol';
      const payload = { model: openAIModel, messages, max_completion_tokens: responseIntegrity.MAX_OUTPUT_TOKENS };
      if (useNativeTools) {
        payload.tools = providerTools();
        payload.tool_choice = req.body.computerToolChoice === 'any' ? 'required' : 'auto';
        payload.parallel_tool_calls = !computerOnlyTools;
      }
      const openAIEffort = openAIReasoningEffort(openAIModel, reasoningLevel);
      if (openAIEffort) payload.reasoning_effort = openAIEffort;

      const data = await fetchJSON('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.openai}`,
        },
        body: JSON.stringify(payload),
      });

      const openAIMessage = data.choices?.[0]?.message || {};
      responseText = openAIMessage.content || '';
      nativeToolCalls = Array.isArray(openAIMessage.tool_calls) ? openAIMessage.tool_calls : [];
      finishReason = data.choices?.[0]?.finish_reason || '';
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
        model: submodel || 'claude-fable-5',
        max_tokens: 4096,
        messages: claudeMessages,
      };
      if (effectiveSystemPrompt) body.system = effectiveSystemPrompt;
      if (useNativeTools) {
        body.tools = anthropicTools({ computerOnly: computerOnlyTools });
        body.tool_choice = { type: req.body.computerToolChoice === 'any' ? 'any' : 'auto' };
      }

      const claudeModel = body.model;
      const claudeLevel = boundedReasoningLevel(reasoningLevel);
      if (claudeModel === 'claude-fable-5') {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        body.output_config = { effort: pickReasoningValue(['low', 'medium', 'high', 'xhigh', 'max'], claudeLevel) };
        body.max_tokens = 16000;
      } else if (claudeModel === 'claude-opus-4-8' || claudeModel === 'claude-sonnet-5') {
        if (claudeLevel > 0) {
          body.thinking = { type: 'adaptive', display: 'summarized' };
          body.output_config = { effort: pickReasoningValue(['low', 'low', 'medium', 'high', 'xhigh', 'max'], claudeLevel) };
          body.max_tokens = 16000;
        } else body.thinking = { type: 'disabled' };
      } else if (claudeModel === 'claude-haiku-4-5' && claudeLevel > 0) {
        const budget = pickReasoningValue([0, 1024, 2048, 4096, 8192], claudeLevel);
        body.max_tokens = 16000;
        body.thinking = { type: 'enabled', budget_tokens: budget };
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
      nativeToolCalls = (data.content || []).filter((c) => c.type === 'tool_use');
      thinkingText = (data.content || []).filter((c) => c.type === 'thinking').map((c) => c.thinking || '').join('\n');
      finishReason = data.stop_reason || '';
      if (data.usage) usage = { input: data.usage.input_tokens, output: data.usage.output_tokens };
    }

    // ----- Google Gemini -----
    else if (model === 'gemini') {
      if (!keys.google) return res.json({ response: '[Gemini] Aucune cle API configuree.' });

      const modelName = submodel || 'gemini-3.5-flash';

      const parts = [{ text: message }];
      images.forEach((img) => parts.push({ inline_data: { mime_type: img.mime, data: img.data } }));

      const contents = [];
      for (const h of history) contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
      contents.push({ role: 'user', parts });

      const payload = { contents };
      if (effectiveSystemPrompt) payload.system_instruction = { parts: [{ text: effectiveSystemPrompt }] };
      if (useNativeTools) {
        payload.tools = geminiTools({ computerOnly: computerOnlyTools });
        const geminiMode = req.body.computerToolChoice === 'any' ? 'ANY' : 'AUTO';
        payload.toolConfig = { functionCallingConfig: {
          mode: geminiMode,
          ...(geminiMode === 'ANY' ? { allowedFunctionNames: ['computer'] } : {}),
        } };
      }

      const geminiLevel = boundedReasoningLevel(reasoningLevel);
      if (modelName.startsWith('gemini-3')) {
        const levels = modelName === 'gemini-3.1-pro-preview'
          ? ['low', 'medium', 'high']
          : ['minimal', 'low', 'medium', 'high'];
        payload.generationConfig = {
          ...(payload.generationConfig || {}),
          thinkingConfig: { thinkingLevel: pickReasoningValue(levels, geminiLevel), includeThoughts: true },
        };
      } else if (modelName.startsWith('gemini-2.5')) {
        const budgets = modelName === 'gemini-2.5-pro'
          ? [1024, 8192, 24576]
          : [0, 1024, 8192, 24576];
        payload.generationConfig = {
          ...(payload.generationConfig || {}),
          thinkingConfig: { thinkingBudget: pickReasoningValue(budgets, geminiLevel), includeThoughts: true },
        };
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${keys.google}`;
      const data = await fetchJSON(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const geminiParts = data.candidates?.[0]?.content?.parts || [];
      responseText = geminiParts.filter((p) => !p.thought && !p.functionCall).map((p) => p.text || '').join('');
      nativeToolCalls = geminiParts.filter((p) => p.functionCall);
      thinkingText = geminiParts.filter((p) => p.thought).map((p) => p.text || '').join('\n');
      finishReason = data.candidates?.[0]?.finishReason || '';
      if (data.usageMetadata) usage = { input: data.usageMetadata.promptTokenCount, output: data.usageMetadata.candidatesTokenCount };
    }

    // ----- xAI (Grok) -----
    else if (model === 'grok') {
      if (!keys.grok) return res.json({ response: '[Grok] Aucune cle API configuree.' });

      const isImageModel = submodel && (submodel === 'grok-imagine-image-quality' || submodel === 'grok-imagine-image');

      if (isImageModel) {
        const grokPayload = {
          prompt: message,
          model: submodel,
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

        const generatedImage = data.data?.[0];
        const b64 = generatedImage?.b64_json;
        if (b64) {
          // Use the user's prompt as the image title (sanitized for markdown).
          const title = String(message || '').replace(/[\[\]()\r\n]+/g, ' ').trim().slice(0, 120);
          const mime = typeof generatedImage.mime_type === 'string' ? generatedImage.mime_type : 'image/jpeg';
          responseText = `![${title}](data:${mime};base64,${b64})`;
        } else {
          responseText = "Erreur: Aucune image n'a été générée par l'API.";
        }
      } else {
        const messages = [];
        if (effectiveSystemPrompt) messages.push({ role: 'system', content: effectiveSystemPrompt });
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

        const grokModel = submodel || 'grok-4.5';
        const grokPayload = { model: grokModel, messages, max_tokens: responseIntegrity.MAX_OUTPUT_TOKENS };
        if (useNativeTools) {
          grokPayload.tools = providerTools();
          grokPayload.tool_choice = req.body.computerToolChoice === 'any' ? 'required' : 'auto';
          grokPayload.parallel_tool_calls = !computerOnlyTools;
        }
        const grokEffort = xaiReasoningEffort(grokModel, reasoningLevel);
        if (grokEffort) grokPayload.reasoning_effort = grokEffort;

        const data = await fetchJSON('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${keys.grok}`,
          },
          body: JSON.stringify(grokPayload),
        });

        const grokMessage = data.choices?.[0]?.message || {};
        responseText = grokMessage.content || '';
        nativeToolCalls = Array.isArray(grokMessage.tool_calls) ? grokMessage.tool_calls : [];
        thinkingText = grokMessage.reasoning_content || '';
        finishReason = data.choices?.[0]?.finish_reason || '';
        if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
      }
    }

    // ----- Mistral (Le Chat) -----
    else if (model === 'mistral') {
      if (!keys.mistral) return res.json({ response: '[Mistral] Aucune cle API configuree.' });

      const messages = [];
      if (effectiveSystemPrompt) messages.push({ role: 'system', content: effectiveSystemPrompt });
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

      const mistralModel = submodel || 'mistral-medium-3-5';
      const mistralPayload = { model: mistralModel, messages, max_tokens: responseIntegrity.MAX_OUTPUT_TOKENS };
      if (useNativeTools) {
        mistralPayload.tools = providerTools();
        mistralPayload.tool_choice = req.body.computerToolChoice === 'any' ? 'any' : 'auto';
        // Desktop steps depend on the previous result (activate, observe,
        // interact), so ask for one ordered call at a time.
        mistralPayload.parallel_tool_calls = !computerOnlyTools;
      }
      if (mistralModel === 'mistral-medium-3-5' || mistralModel === 'mistral-small-latest') {
        mistralPayload.reasoning_effort = pickReasoningValue(['none', 'high'], reasoningLevel);
      }

      const data = await fetchJSON('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.mistral}`,
        },
        body: JSON.stringify(mistralPayload),
      });

      const mistralMessage = data.choices?.[0]?.message || {};
      const mistralContent = parseMistralContent(mistralMessage.content);
      responseText = mistralContent.text;
      nativeToolCalls = Array.isArray(mistralMessage.tool_calls) ? mistralMessage.tool_calls : [];
      thinkingText = mistralContent.thinking;
      finishReason = data.choices?.[0]?.finish_reason || '';
      if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
    }

    // ----- Moonshot AI (Kimi) -----
    else if (model === 'kimi') {
      if (!keys.moonshot) return res.json({ response: '[Kimi] Aucune cle API Moonshot configuree.' });

      const messages = [];
      if (effectiveSystemPrompt) messages.push({ role: 'system', content: effectiveSystemPrompt });
      for (const h of history) messages.push({
        role: h.role,
        content: h.content,
        ...(h.role === 'assistant' && h.reasoning_content ? { reasoning_content: h.reasoning_content } : {}),
      });
      messages.push({
        role: 'user',
        content: images.length
          ? [
              { type: 'text', text: message },
              ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
            ]
          : message,
      });

      const kimiModel = submodel || 'kimi-k3';
      const kimiPayload = buildKimiPayload({
        model: kimiModel,
        messages,
        reasoningLevel,
        tools: useNativeTools ? providerTools() : undefined,
        requireTool: req.body.computerToolChoice === 'any',
        maxTokens: responseIntegrity.MAX_OUTPUT_TOKENS,
      });

      const data = await fetchJSON('https://api.moonshot.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.moonshot}`,
        },
        body: JSON.stringify(kimiPayload),
      });

      const kimiResult = parseKimiResponse(data);
      responseText = kimiResult.content;
      nativeToolCalls = Array.isArray(kimiResult.toolCalls) ? kimiResult.toolCalls : [];
      thinkingText = kimiResult.thinking;
      finishReason = kimiResult.finishReason || '';
      usage = kimiResult.usage;
    }

    // ----- Ollama (Local) -----
    else if (model === 'local') {
      const messages = [];
      if (effectiveSystemPrompt) {
        messages.push({ role: 'system', content: effectiveSystemPrompt });
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
      if (useNativeTools) ollamaBody.tools = providerTools();

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
        nativeToolCalls = Array.isArray(data.message?.tool_calls) ? data.message.tool_calls : [];
        finishReason = data.done_reason || '';

        // deepseek-r1 etc. embed reasoning inside <think>...</think>.
        const tm = responseText.match(/<think>([\s\S]*?)<\/think>/i);
        if (tm) { thinkingText = tm[1].trim(); responseText = responseText.replace(/<think>[\s\S]*?<\/think>/i, '').trim(); }

        // Strip system prompt echo — some models regurgitate the instructions.
        // Detect and remove if the response starts with a large chunk of the system prompt.
        if (effectiveSystemPrompt && responseText.length > 0) {
          const sysNorm = effectiveSystemPrompt.replace(/\s+/g, ' ').slice(0, 200).toLowerCase();
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
                if (effectiveSystemPrompt.includes(lines[i].trim()) && lines[i].trim().length > 10) cut = i + 1;
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
      if (effectiveSystemPrompt) messages.push({ role: 'system', content: effectiveSystemPrompt });
      for (const h of history) messages.push({ role: h.role, content: h.content });
      messages.push({ role: 'user', content: message });

      const ggufAC = new AbortController();
      const ggufTimeout = setTimeout(() => ggufAC.abort(), 300000);
      try {
        const ggufBody = { model: 'local', messages, stream: false, temperature: 0.7, max_tokens: responseIntegrity.MAX_OUTPUT_TOKENS };
        if (useNativeTools) {
          ggufBody.tools = providerTools();
          ggufBody.tool_choice = req.body.computerToolChoice === 'any' ? 'required' : 'auto';
          ggufBody.parallel_tool_calls = !computerOnlyTools;
        }
        const data = await fetchJSON(`http://127.0.0.1:${ENGINE_PORT}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ggufBody),
          signal: ggufAC.signal,
        });
        clearTimeout(ggufTimeout);
        const ggufMessage = data.choices?.[0]?.message || {};
        responseText = ggufMessage.content || '';
        nativeToolCalls = Array.isArray(ggufMessage.tool_calls) ? ggufMessage.tool_calls : [];
        finishReason = data.choices?.[0]?.finish_reason || '';
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
    if (effectiveSystemPrompt && responseText) {
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

    // Integrity metadata travels with every answer so the three surfaces
    // (desktop chat, agent loop, CLI) apply the same rule instead of each
    // trusting the raw text. The text itself is returned untouched: the agent
    // loop still has to parse tool calls out of it.
    const integrity = responseIntegrity.analyzeAnswer(responseText);
    const truncated = responseIntegrity.isTruncated(finishReason);
    res.json({
      response: responseText,
      thinking: thinkingText || undefined,
      usage: usage || undefined,
      toolCalls: nativeToolCalls.length ? nativeToolCalls : undefined,
      finishReason: finishReason || undefined,
      truncated: truncated || undefined,
      degenerate: integrity.degenerate || undefined,
      degenerateReason: integrity.degenerate ? integrity.reason : undefined,
    });
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
    const asset = (release.assets || []).find(a => a.name === 'zaalis-macos-universal-installer.tar.gz');
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

    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const dest = path.join(fs.existsSync(downloadsDir) ? downloadsDir : os.tmpdir(), 'zaalis-macos-universal-installer.tar.gz');
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
    const installerPath = downloadedInstallerPath || path.join(os.homedir(), 'Downloads', 'zaalis-macos-universal-installer.tar.gz');
    if (!fs.existsSync(installerPath)) {
      return res.status(409).json({ error: 'Installer not downloaded yet.' });
    }

    // Ask Finder to open the downloaded installer archive.
    const child = spawn('open', [installerPath], {
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

// Where an auto-downloaded tunnel binary is cached (writable per-user dir).
const CF_DIR = path.join(DATA_DIR, 'bin');
const CF_EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

// Look for an already-present cloudflared: bundled next to the app, vendored in
// the repo, previously auto-downloaded, or installed system-wide (Homebrew…).
function findCloudflared() {
  const candidates = [
    path.join(APP_DIR, CF_EXE),
    path.join(APP_DIR, 'native', CF_EXE),
    path.join(CF_DIR, CF_EXE),
  ];
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared');
  } else if (process.platform === 'linux') {
    candidates.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared');
  }
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}

// Official cloudflared release asset for this OS/arch. macOS ships a .tgz;
// Linux/Windows ship a raw binary.
function cloudflaredDownloadUrl() {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  if (process.platform === 'darwin') {
    return base + (process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz');
  }
  if (process.platform === 'linux') {
    const a = process.arch === 'arm64' ? 'arm64' : (process.arch === 'arm' ? 'arm' : 'amd64');
    return base + 'cloudflared-linux-' + a;
  }
  return base + 'cloudflared-windows-amd64.exe';
}

// Return a usable cloudflared path, auto-downloading it into CF_DIR on first
// use if none is bundled or installed. Throws a user-actionable error on
// failure (e.g. offline) so the pairing modal can show it.
async function ensureCloudflared() {
  const existing = findCloudflared();
  if (existing) { ensureExecutable(existing); return existing; }
  ensureDir(CF_DIR);
  const url = cloudflaredDownloadUrl();
  const dest = path.join(CF_DIR, CF_EXE);
  try {
    if (/\.tgz$/i.test(url)) {
      const tgz = path.join(CF_DIR, 'cloudflared.tgz');
      await downloadTo(url, tgz);
      const { execSync } = require('child_process');
      execSync(`tar -xzf "${tgz}" -C "${CF_DIR}"`, { timeout: 120000 });
      try { fs.unlinkSync(tgz); } catch {}
    } else {
      await downloadTo(url, dest);
    }
  } catch (e) {
    const hint = process.platform === 'darwin'
      ? ' Installez-le manuellement : brew install cloudflared.'
      : '';
    throw new Error('Impossible de télécharger cloudflared.' + hint);
  }
  if (!fs.existsSync(dest)) throw new Error('cloudflared introuvable après installation.');
  ensureExecutable(dest);
  return dest;
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
  cfStarting = (async () => {
    const bin = await ensureCloudflared(); // may auto-download; throws if unavailable
    return await new Promise((resolve, reject) => {
      let settled = false, proc;
      try {
        proc = spawn(bin,
          ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`],
          { windowsHide: true });
      } catch (e) { return reject(e); }
      cfProc = proc;
      const onData = (buf) => {
        const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !settled) { settled = true; cfUrl = m[0]; cfStartedAt = Date.now(); resolve(cfUrl); }
      };
      proc.stdout && proc.stdout.on('data', onData);
      proc.stderr && proc.stderr.on('data', onData);
      proc.on('error', (e) => { if (!settled) { settled = true; cfProc = null; reject(e); } });
      proc.on('exit', () => {
        if (!settled) { settled = true; cfProc = null; reject(new Error('cloudflared exited')); }
        else { cfUrl = null; cfProc = null; } // tunnel died after being up
      });
      setTimeout(() => {
        if (!settled) { settled = true; try { proc.kill(); } catch {} cfProc = null; reject(new Error('Tunnel timeout (30s)')); }
      }, 30000);
    });
  })();
  // On any failure, clear the in-flight promise so the next attempt retries.
  cfStarting.catch(() => { cfStarting = null; });
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
