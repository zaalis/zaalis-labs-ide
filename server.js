const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Base directory for static assets and writable data.
// When packaged into an .exe (pkg), __dirname points inside the read-only
// snapshot, so we use the folder next to the executable instead.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// ---------------------------------------------------------------------------
// Local accounts + sessions (no external dependency)
// ---------------------------------------------------------------------------
// Accounts and per-user chats are stored as local files under server-data/.
// Passwords are hashed with scrypt; sessions are signed HttpOnly cookies.
const DATA_DIR = path.join(APP_DIR, 'server-data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const COOKIE_NAME = 'zaalis_session';

fs.mkdirSync(CHATS_DIR, { recursive: true });

// Persisted signing secret so sessions survive server restarts.
let SESSION_SECRET;
try {
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf-8');
} catch {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SESSION_SECRET);
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
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Never cache the app shell, so updates always load (no stale script.js).
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '50mb' }));
// The web interface (index.html, css, js) lives in the interface/ folder.
app.use(express.static(path.join(APP_DIR, 'interface')));

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
  };
  users.push(user);
  saveUsers(users);
  setSessionCookie(res, makeToken(user.id));
  res.json({ email: user.email });
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
  res.json({ email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  // Status check: always 200 so the browser console isn't polluted with a 401.
  const user = currentUser(req);
  res.json({ authenticated: !!user, email: user ? user.email : null });
});

// ---------------------------------------------------------------------------
// AUTH GUARD — every other /api/* route requires a valid session
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Authentification requise.' });
  req.user = user;
  next();
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
// Helpers
// ---------------------------------------------------------------------------
const FILTERED = new Set(['node_modules', '.git', '.env', '.DS_Store', 'server-data']);

function resolveBase(root) {
  return root ? path.resolve(root) : APP_DIR;
}

async function fetchJSON(url, options) {
  // Dynamic import of node-fetch is avoided; use the global fetch available
  // in Node 18+. For older versions, install node-fetch.
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    const errMsg =
      data.error?.message || data.error?.type || JSON.stringify(data.error) || res.statusText;
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
app.post('/api/exec', (req, res) => {
  try {
    const { command, cwd } = req.body;
    if (!command) return res.status(400).json({ error: 'command is required' });

    const execCwd = cwd || APP_DIR;

    exec(command, { cwd: execCwd, timeout: 30000, maxBuffer: 1024 * 1024 * 5, windowsHide: true }, (err, stdout, stderr) => {
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
  const cmd = `powershell -NoProfile -STA -Command "${ps.replace(/"/g, '\\"')}"`;

  exec(cmd, { timeout: 120000, windowsHide: false }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const selected = (stdout || '').trim();
    if (!selected) return res.json({ cancelled: true });
    res.json({ path: selected });
  });
});

// GET /api/ollama-models?url=...  -> { models: [names] }
app.get('/api/ollama-models', async (req, res) => {
  try {
    const url = (req.query.url || 'http://localhost:11434').replace(/\/+$/, '');
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
    const url = ((req.body && req.body.url) || 'http://localhost:11434').replace(/\/+$/, '');
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
      groups[quant] = (groups[quant] || 0) + (s.size || 0);
    }
    let quants = Object.entries(groups).map(([quant, size]) => ({ quant, size })).filter((x) => x.size > 0);
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
  const url = (req.query.url || 'http://localhost:11434').replace(/\/+$/, '');
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
// AI CHAT API
// ---------------------------------------------------------------------------

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

    const keys = config?.keys || {};
    const ollamaUrl = config?.ollamaUrl || 'http://localhost:11434';
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

      const payload = { model: submodel || 'gpt-4o', messages };

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

      const isThinkingModel = submodel && (submodel.includes('3-7') || submodel.includes('4.8'));
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

      if (reasoningLevel !== undefined && reasoningLevel > 0) {
        const budgets = [0, 1024, 2048, 4096];
        const budget = budgets[reasoningLevel] || 1024;
        if (budget > 0) {
          payload.thinkingConfig = { thinkingBudget: budget };
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

      const grokPayload = { model: submodel || 'grok-3', messages };
      // Only reasoning sub-models accept reasoning_effort (low | high).
      if (submodel && submodel.includes('reasoning') && reasoningLevel > 0) {
        grokPayload.reasoning_effort = reasoningLevel >= 2 ? 'high' : 'low';
      }

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
      // Set num_ctx to fit the prompt + room for the response, capped at 32k.
      const numCtx = Math.min(32768, Math.max(4096, estimatedTokens + 4096));
      // num_predict: leave room but don't exceed what the context allows.
      const numPredict = Math.min(8192, numCtx - estimatedTokens);

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
        throw ollamaErr;
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
let downloadProgress = 0;

app.post('/api/update/download', (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  
  const dest = path.join(os.tmpdir(), 'zaalis-update.exe');
  downloadProgress = 0;

  function downloadFile(fileUrl) {
    https.get(fileUrl, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadFile(response.headers.location);
      }
      if (response.statusCode !== 200) {
        // Return 500 but we already sent headers if we handled earlier async stuff, wait we haven't sent response yet.
        downloadProgress = -1;
        return;
      }
      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      
      const file = fs.createWriteStream(dest);
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
          downloadProgress = Math.round((downloadedSize / totalSize) * 100);
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        downloadProgress = 100;
      });
    }).on('error', (err) => {
      downloadProgress = -1;
      fs.unlink(dest, () => {});
    });
  }

  downloadFile(url);
  res.json({ success: true, dest });
});

app.get('/api/update/progress', (req, res) => {
  res.json({ progress: downloadProgress });
});

app.post('/api/update/install', (req, res) => {
  try {
    const installerPath = path.join(os.tmpdir(), 'zaalis-update.exe');
    const batPath = path.join(os.tmpdir(), 'zaalis-update.bat');
    
    const batContent = `
@echo off
timeout /t 2 /nobreak > NUL
taskkill /f /im zaalis.exe > NUL 2>&1
taskkill /f /im zaalis-server.exe > NUL 2>&1
start /wait "" "${installerPath}" /VERYSILENT /SUPPRESSMSGBOXES /FORCECLOSEAPPLICATIONS
start "" "%LOCALAPPDATA%\\Programs\\zaalis\\zaalis.exe"
del "%~f0"
`;
    fs.writeFileSync(batPath, batContent.trim());

    const child = spawn('cmd.exe', ['/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    res.json({ success: true });
    
    // Shut down the server gracefully to release locks
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auto-start Ollama in the background (only if it isn't already running).
// We never stop it on exit — if it was already up, we leave it untouched.
// ---------------------------------------------------------------------------
async function startOllamaIfNeeded() {
  if (process.platform !== 'win32') return;
  try {
    await fetch('http://localhost:11434/api/tags');
    return; // already running -> do nothing
  } catch {}
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'ollama',
  ];
  const exe = candidates.find((p) => p === 'ollama' || (p && fs.existsSync(p))) || 'ollama';
  try {
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
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
