#!/usr/bin/env node
'use strict';
// zaalis Glyphes server: one process, behind Caddy (HTTPS), on a small VM.
// Serves the web app, the JSON API, the live event stream and runs the Glyphs.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const DATA_DIR = process.env.GLYPHES_DATA || path.join(__dirname, 'data');
const WEB_DIR = process.env.GLYPHES_WEB || [path.join(__dirname, 'web'), path.join(__dirname, '..', '..', 'interface', 'glyphes')].find(d => fs.existsSync(path.join(d, 'index.html')));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
process.env.PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE = process.env.PUBLIC_URL.startsWith('https://');

const db = require('./db');
const secrets = require('./secrets');
db.open(DATA_DIR);
secrets.init(DATA_DIR);
const google = require('./google');
const models = require('./models');
const events = require('./events');
const push = require('./push');
const agent = require('./agent');
const scheduler = require('./scheduler');
const tools = require('./tools');
push.init();
agent.init(DATA_DIR);

const VARIANTS = ['nova', 'iris', 'corail', 'ambre', 'jade', 'azur', 'onyx', 'perle', 'sakura', 'menthe', 'solar', 'cobalt'];
const SESSION_COOKIE = SECURE ? '__Host-glyphes' : 'glyphes';
const STATE_COOKIE = SECURE ? '__Host-glyphes-oauth' : 'glyphes-oauth';
const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

// ---------------------------------------------------------------- small HTTP toolkit
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function cookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}${SECURE ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(fail(413, 'Fichier ou message trop volumineux.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req, 1024 * 1024);
  if (!raw.length) return {};
  try { const v = JSON.parse(raw.toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch { throw fail(400, 'JSON invalide.'); }
}
const buckets = new Map();
function rateLimit(req, key, perMinute) {
  const id = key + ':' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), b = buckets.get(id) || { n: 0, t: now };
  if (now - b.t > 60000) { b.n = 0; b.t = now; }
  if (++b.n > perMinute) throw fail(429, 'Trop de demandes, réessaie dans une minute.');
  buckets.set(id, b);
}
setInterval(() => { const cut = Date.now() - 120000; for (const [k, b] of buckets) if (b.t < cut) buckets.delete(k); }, 60000).unref();

// ---------------------------------------------------------------- sessions
function createSession(userId, kind, label) {
  const token = (kind === 'device' ? 'gly_' : '') + secrets.token(32);
  const ttl = kind === 'device' ? 365 : 90;
  db.run('INSERT INTO sessions (token_hash, user_id, kind, label, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    secrets.hash(token), userId, kind, label || null, db.now(), db.now(), db.now() + ttl * 86400000);
  return token;
}
function sessionOf(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.get('SELECT * FROM sessions WHERE token_hash = ?', secrets.hash(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (Date.now() - (row.last_seen || 0) > 300000) db.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', Date.now(), row.token_hash);
  return { ...row, bearer: auth.startsWith('Bearer '), token };
}
function requireUser(req) {
  const session = sessionOf(req);
  if (!session) throw fail(401, 'Connexion requise.');
  // Cookie sessions must prove the call comes from the app itself (a cross-site
  // form cannot set this header, and CORS is closed).
  if (!session.bearer && !['GET', 'HEAD'].includes(req.method) && req.headers['x-glyphes'] !== '1') throw fail(403, 'Requête refusée.');
  const user = db.get('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user) throw fail(401, 'Compte introuvable.');
  user.session = session;
  return user;
}
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, picture: user.picture, settings: db.json(user.settings, {}) };
}
function upsertUser(profile) {
  const existing = db.get('SELECT * FROM users WHERE id = ?', profile.id);
  if (existing) {
    db.run('UPDATE users SET email = ?, name = ?, picture = ?, last_seen = ? WHERE id = ?', profile.email, profile.name, profile.picture, db.now(), profile.id);
    return { user: db.get('SELECT * FROM users WHERE id = ?', profile.id), created: false };
  }
  db.run('INSERT INTO users (id, email, name, picture, settings, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    profile.id, profile.email, profile.name, profile.picture, JSON.stringify({ theme: 'system', font: 'system', haptics: true, notifications: true, location: false, timezone: 'Europe/Paris' }), db.now(), db.now());
  createGlyph(profile.id, { name: 'Nova', variant: 'nova', mode: 'supervised', instructions: '' });
  return { user: db.get('SELECT * FROM users WHERE id = ?', profile.id), created: true };
}

// ---------------------------------------------------------------- glyphs
function cleanGlyph(input, partial) {
  const out = {};
  if (!partial || input.name !== undefined) { const name = String(input.name || '').trim().slice(0, 40); if (!name) throw fail(400, 'Donne un nom au Glyphe.'); out.name = name; }
  if (!partial || input.variant !== undefined) out.variant = VARIANTS.includes(input.variant) ? input.variant : 'nova';
  if (!partial || input.mode !== undefined) out.mode = input.mode === 'autonomous' ? 'autonomous' : 'supervised';
  if (!partial || input.model !== undefined) out.model = input.model ? String(input.model).slice(0, 160) : null;
  if (!partial || input.instructions !== undefined) out.instructions = String(input.instructions || '').slice(0, 6000);
  return out;
}
function createGlyph(userId, input) {
  const count = db.get('SELECT COUNT(*) AS n FROM glyphs WHERE user_id = ?', userId).n;
  if (count >= 30) throw fail(400, 'Limite de 30 Glyphes atteinte.');
  const g = cleanGlyph(input, false), id = db.newId('g');
  db.run('INSERT INTO glyphs (id, user_id, name, variant, mode, model, instructions, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, userId, g.name, g.variant, g.mode, g.model, g.instructions, 'idle', db.now(), db.now());
  return agent.publicGlyph(db.get('SELECT * FROM glyphs WHERE id = ?', id));
}
function listMessages(userId, glyphId, before) {
  agent.glyphRow(userId, glyphId);
  const rows = db.all(`SELECT * FROM messages WHERE glyph_id = ? AND user_id = ? AND role != 'tool' ${before ? 'AND created_at < ?' : ''} ORDER BY created_at DESC LIMIT 80`,
    ...[glyphId, userId, ...(before ? [Number(before)] : [])]);
  return rows.reverse().map(agent.publicMessage).filter(m => m.role !== 'assistant' || m.content.trim());
}

// ---------------------------------------------------------------- Google sign-in
function startGoogle(req, res, url) {
  rateLimit(req, 'auth', 30);
  const session = sessionOf(req);
  const user = session && db.get('SELECT * FROM users WHERE id = ?', session.user_id);
  const plugins = String(url.searchParams.get('plugins') || '').split(',').filter(p => google.PLUGINS[p]);
  const scopes = plugins.flatMap(p => google.PLUGINS[p].scopes);
  const back = String(url.searchParams.get('return') || '/');
  const state = secrets.token(18);
  const value = JSON.stringify({ state, back: back.startsWith('/') && !back.startsWith('//') ? back : '/', t: Date.now() });
  res.writeHead(302, { Location: google.authUrl({ state, scopes, loginHint: user && user.email }), 'Set-Cookie': cookie(STATE_COOKIE, value + '.' + secrets.hmac(value, 'oauth'), { maxAge: 900 }), 'Cache-Control': 'no-store' });
  res.end();
}
async function googleCallback(req, res, url) {
  rateLimit(req, 'auth', 30);
  const raw = cookies(req)[STATE_COOKIE] || '';
  const dot = raw.lastIndexOf('.');
  const value = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const saved = sig && secrets.hmac(value, 'oauth') === sig ? db.json(value, null) : null;
  if (!saved || saved.state !== url.searchParams.get('state') || Date.now() - saved.t > 900000) return page(res, 400, 'Connexion expirée', 'Recommence la connexion depuis l’app.');
  if (url.searchParams.get('error')) return redirect(res, saved.back, [cookie(STATE_COOKIE, '', { maxAge: 0 })]);
  const { tokens, profile } = await google.exchangeCode(url.searchParams.get('code'));
  const current = sessionOf(req);
  if (current && current.user_id !== profile.id && !current.bearer) {
    // Signed in as someone else in this browser: switch accounts cleanly.
    db.run('DELETE FROM sessions WHERE token_hash = ?', current.token_hash);
  }
  const { user } = upsertUser(profile);
  google.saveTokens(user.id, tokens);
  const headers = [cookie(STATE_COOKIE, '', { maxAge: 0 })];
  if (!current || current.user_id !== user.id) headers.push(cookie(SESSION_COOKIE, createSession(user.id, 'web', String(req.headers['user-agent'] || '').slice(0, 120)), { maxAge: 90 * 86400 }));
  events.emit(user.id, 'plugins', google.pluginStatus(user.id));
  redirect(res, saved.back, headers);
}
function redirect(res, location, setCookies = []) { res.writeHead(302, { Location: location, 'Set-Cookie': setCookies, 'Cache-Control': 'no-store' }); res.end(); }
const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(res, status, title, text, extra = '') {
  send(res, status, `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#ececf1;font:16px -apple-system,"Segoe UI",Inter,system-ui,sans-serif}
main{max-width:380px;padding:32px;text-align:center}h1{font-size:22px;margin:16px 0 8px}p{color:#9a9aa6;line-height:1.5}
button,a.btn{display:inline-block;margin:8px 4px 0;padding:12px 22px;border-radius:999px;border:0;font:600 15px inherit;cursor:pointer;text-decoration:none}
.ok{background:#5f62e8;color:#fff}.no{background:#22222b;color:#ececf1}img{width:72px;height:72px}</style></head>
<body><main><img src="/icons/glyph-192.png" alt=""><h1>${esc(title)}</h1><p>${text}</p>${extra}</main></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
}

// ---------------------------------------------------------------- IDE linking (device flow)
async function linkStart(req, res) {
  rateLimit(req, 'link', 10);
  const body = await readJson(req);
  const code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[require('node:crypto').randomInt(32)]).join('');
  const poll = secrets.token(24);
  db.run('DELETE FROM link_codes WHERE created_at < ?', Date.now() - 900000);
  db.run('INSERT INTO link_codes (code, label, status, token, created_at) VALUES (?, ?, ?, ?, ?)', code, String(body.label || 'zaalis Labs IDE').slice(0, 60), 'pending', secrets.hash(poll), db.now());
  send(res, 200, { code, poll, url: `${process.env.PUBLIC_URL}/link?code=${code}`, expiresIn: 900 });
}
function linkPage(req, res, url) {
  const code = String(url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const row = db.get('SELECT * FROM link_codes WHERE code = ?', code);
  if (!row || row.status !== 'pending' || Date.now() - row.created_at > 900000) return page(res, 400, 'Lien expiré', 'Relance la connexion depuis zaalis Labs IDE.');
  const session = sessionOf(req);
  if (!session) return redirect(res, `/auth/google/start?return=${encodeURIComponent('/link?code=' + code)}`);
  const user = db.get('SELECT * FROM users WHERE id = ?', session.user_id);
  const csrf = secrets.hmac(session.token_hash + code, 'link');
  page(res, 200, 'Relier zaalis Labs IDE ?', `<b>${esc(row.label)}</b> pourra voir et piloter tes Glyphes avec le compte <b>${esc(user.email)}</b>.`,
    `<form method="post" action="/link"><input type="hidden" name="code" value="${code}"><input type="hidden" name="csrf" value="${csrf}">
     <button class="no" name="decision" value="deny">Refuser</button><button class="ok" name="decision" value="allow">Autoriser</button></form>`);
}
async function linkDecide(req, res) {
  const session = sessionOf(req);
  if (!session) return page(res, 401, 'Connexion requise', 'Ouvre à nouveau le lien depuis zaalis Labs IDE.');
  const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'));
  const code = String(form.get('code') || '');
  if (form.get('csrf') !== secrets.hmac(session.token_hash + code, 'link')) return page(res, 403, 'Requête refusée', 'Recommence depuis zaalis Labs IDE.');
  const row = db.get("SELECT * FROM link_codes WHERE code = ? AND status = 'pending'", code);
  if (!row || Date.now() - row.created_at > 900000) return page(res, 400, 'Lien expiré', 'Relance la connexion depuis zaalis Labs IDE.');
  if (form.get('decision') !== 'allow') {
    db.run("UPDATE link_codes SET status = 'denied' WHERE code = ?", code);
    return page(res, 200, 'Connexion refusée', 'zaalis Labs IDE n’a pas accès à tes Glyphes.');
  }
  db.run("UPDATE link_codes SET status = 'approved', user_id = ? WHERE code = ?", session.user_id, code);
  page(res, 200, 'C’est relié', 'Retourne dans zaalis Labs IDE : tes Glyphes s’y affichent maintenant. Tu peux fermer cet onglet.');
}
async function linkPoll(req, res) {
  rateLimit(req, 'poll', 40);
  const body = await readJson(req);
  const row = db.get('SELECT * FROM link_codes WHERE code = ?', String(body.code || ''));
  if (!row || row.token !== secrets.hash(String(body.poll || ''))) throw fail(404, 'Code inconnu.');
  if (Date.now() - row.created_at > 900000) return send(res, 200, { status: 'expired' });
  if (row.status !== 'approved') return send(res, 200, { status: row.status });
  db.run("UPDATE link_codes SET status = 'used', token = '' WHERE code = ?", row.code);
  const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
  send(res, 200, { status: 'approved', token: createSession(user.id, 'device', row.label), user: publicUser(user) });
}

// ---------------------------------------------------------------- dictation (whisper.cpp on the VM)
function transcribe(audio, mime) {
  const bin = process.env.WHISPER_BIN, model = process.env.WHISPER_MODEL;
  if (!bin || !model || !fs.existsSync(bin) || !fs.existsSync(model)) throw fail(501, 'La dictée n’est pas installée sur ce serveur.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphes-voice-'));
  const input = path.join(dir, 'in' + (/mp4|m4a|aac/.test(mime) ? '.m4a' : /ogg/.test(mime) ? '.ogg' : '.webm')), wav = path.join(dir, 'in.wav');
  fs.writeFileSync(input, audio);
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(out)));
  return run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
    .then(() => run(bin, ['-m', model, '-f', wav, '-l', 'auto', '-nt', '-np', '-t', String(Math.max(1, os.cpus().length))]))
    .then(out => String(out).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim())
    .catch(() => { throw fail(500, 'La transcription a échoué.'); })
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/health') return send(res, 200, { ok: true, version: 1 });
  if (p === '/api/link/start' && m === 'POST') return linkStart(req, res);
  if (p === '/api/link/poll' && m === 'POST') return linkPoll(req, res);
  if (p === '/api/push/key') return send(res, 200, { key: push.publicKey() });
  if (p === '/api/config') return send(res, 200, { google: !!process.env.GOOGLE_CLIENT_ID, push: push.available, dictation: !!process.env.WHISPER_BIN && fs.existsSync(process.env.WHISPER_BIN || '-'), variants: VARIANTS });

  const user = requireUser(req);
  const uid = user.id;
  let match;
  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: publicUser(user), plugins: google.pluginStatus(uid), device: user.session.kind });
  if (p === '/api/events' && m === 'GET') return events.attach(uid, req, res);
  if (p === '/api/auth/logout' && m === 'POST') {
    db.run('DELETE FROM sessions WHERE token_hash = ?', user.session.token_hash);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
  }
  if (p === '/api/settings' && m === 'PATCH') {
    const body = await readJson(req), s = db.json(user.settings, {});
    const allowed = { theme: ['system', 'dark', 'black', 'light'], font: ['system', 'rounded', 'serif', 'mono'] };
    for (const [k, list] of Object.entries(allowed)) if (body[k] !== undefined && list.includes(body[k])) s[k] = body[k];
    for (const k of ['haptics', 'notifications', 'location']) if (typeof body[k] === 'boolean') s[k] = body[k];
    if (typeof body.timezone === 'string' && body.timezone.length < 60) { try { new Intl.DateTimeFormat('fr', { timeZone: body.timezone }); s.timezone = body.timezone; } catch {} }
    if (body.defaultModel !== undefined) s.defaultModel = body.defaultModel ? String(body.defaultModel).slice(0, 160) : null;
    if (body.location === false) db.run('DELETE FROM locations WHERE user_id = ?', uid);
    db.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), uid);
    return send(res, 200, { settings: s });
  }
  if (p === '/api/plugins' && m === 'GET') return send(res, 200, { plugins: google.pluginStatus(uid) });
  if (p === '/api/google' && m === 'DELETE') { await google.revoke(uid); return send(res, 200, { plugins: google.pluginStatus(uid) }); }
  if (p === '/api/location' && m === 'POST') {
    const b = await readJson(req), lat = Number(b.lat), lng = Number(b.lng);
    if (!db.json(user.settings, {}).location) throw fail(403, 'Active d’abord la localisation dans les paramètres.');
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw fail(400, 'Position invalide.');
    db.run('INSERT INTO locations (user_id, lat, lng, accuracy, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, at = excluded.at',
      uid, lat, lng, Number(b.accuracy) || null, db.now());
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/subscribe' && m === 'POST') { push.subscribe(uid, (await readJson(req)).subscription); return send(res, 200, { ok: true }); }
  if (p === '/api/push/unsubscribe' && m === 'POST') { push.unsubscribe(uid, String((await readJson(req)).endpoint || '')); return send(res, 200, { ok: true }); }
  if (p === '/api/push/test' && m === 'POST') return send(res, 200, { sent: await push.notify(uid, { title: 'Glyphes', body: 'Les notifications fonctionnent.', tag: 'test' }) });
  if (p === '/api/usage' && m === 'GET') {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return send(res, 200, { usage: db.all('SELECT day, model, input, output, calls FROM usage WHERE user_id = ? AND day >= ? ORDER BY day DESC', uid, since) });
  }
  // models
  if (p === '/api/models' && m === 'GET') return send(res, 200, { providers: models.catalog(uid), defaultModel: models.defaultModel(uid) });
  if ((match = p.match(/^\/api\/models\/([a-z0-9:_-]+)$/i))) {
    const provider = match[1];
    if (m === 'DELETE') { models.removeCredentials(uid, provider); return send(res, 200, { providers: models.catalog(uid) }); }
    if (m === 'PUT') {
      const b = await readJson(req);
      const baseUrl = String(b.baseUrl || (models.BUILTIN[provider] && models.BUILTIN[provider].baseUrl) || '');
      if (!/^https:\/\/[^\s]+$/.test(baseUrl)) throw fail(400, 'Adresse https du fournisseur requise.');
      await require('./web').assertPublic(baseUrl);
      if (!String(b.key || '').trim()) throw fail(400, 'Clé manquante.');
      models.saveCredentials(uid, provider, { label: b.label || (models.BUILTIN[provider] || {}).label || provider, data: { baseUrl, key: String(b.key).trim() }, models: Array.isArray(b.models) ? b.models : [] });
      return send(res, 200, { providers: models.catalog(uid) });
    }
  }
  if (p === '/api/models-chatgpt/start' && m === 'POST') return send(res, 200, await models.startChatgpt(uid));
  if (p === '/api/models-chatgpt/poll' && m === 'POST') return send(res, 200, await models.pollChatgpt(uid));
  // glyphs
  if (p === '/api/glyphs' && m === 'GET') return send(res, 200, { glyphs: db.all('SELECT * FROM glyphs WHERE user_id = ? ORDER BY updated_at DESC', uid).map(agent.publicGlyph) });
  if (p === '/api/glyphs' && m === 'POST') { const glyph = createGlyph(uid, await readJson(req)); agent.intro(uid, glyph.id); return send(res, 201, { glyph }); }
  if ((match = p.match(/^\/api\/glyphs\/(g_[\w-]+)(?:\/(\w+))?$/))) {
    const [, gid, sub] = match;
    const g = agent.glyphRow(uid, gid);
    if (!sub && m === 'PATCH') {
      const patch = cleanGlyph(await readJson(req), true);
      if (Object.keys(patch).length) agent.setGlyph(uid, gid, patch);
      return send(res, 200, { glyph: agent.publicGlyph(db.get('SELECT * FROM glyphs WHERE id = ?', gid)) });
    }
    if (!sub && m === 'DELETE') {
      db.run('DELETE FROM glyphs WHERE id = ? AND user_id = ?', gid, uid);
      events.emit(uid, 'glyph-deleted', { id: gid });
      return send(res, 200, { ok: true });
    }
    if (sub === 'messages' && m === 'GET') return send(res, 200, { messages: listMessages(uid, gid, url.searchParams.get('before')), actions: db.all("SELECT * FROM actions WHERE glyph_id = ? AND status = 'pending' ORDER BY created_at", gid).map(agent.publicAction) });
    if (sub === 'messages' && m === 'POST') { const b = await readJson(req); return send(res, 201, { message: agent.userMessage(uid, gid, b.text, b.files, b.reply) }); }
    if (sub === 'read' && m === 'POST') { if (g.unread) agent.setGlyph(uid, gid, { unread: 0 }); return send(res, 200, { ok: true }); }
    if (sub === 'pause' && m === 'POST') { agent.setGlyph(uid, gid, { status: 'paused' }); return send(res, 200, { ok: true }); }
    if (sub === 'resume' && m === 'POST') { agent.setGlyph(uid, gid, { status: 'idle' }); return send(res, 200, { ok: true }); }
    if (sub === 'clear' && m === 'POST') {
      agent.cancelPending(uid, gid);
      db.run('DELETE FROM messages WHERE glyph_id = ? AND user_id = ?', gid, uid);
      agent.setGlyph(uid, gid, { status: 'idle', task_label: '', unread: 0 });
      return send(res, 200, { ok: true });
    }
    if (sub === 'jobs' && m === 'GET') return send(res, 200, { jobs: db.all("SELECT id, kind, payload, due_at, repeat FROM jobs WHERE glyph_id = ? AND status = 'scheduled' ORDER BY due_at", gid).map(j => ({ id: j.id, kind: j.kind, ...db.json(j.payload, {}), at: j.due_at, repeat: j.repeat })) });
  }
  if ((match = p.match(/^\/api\/jobs\/(j_[\w-]+)$/)) && m === 'DELETE') { db.run("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND user_id = ?", match[1], uid); return send(res, 200, { ok: true }); }
  if (p === '/api/actions' && m === 'GET') return send(res, 200, { actions: db.all("SELECT * FROM actions WHERE user_id = ? AND status = 'pending' ORDER BY created_at", uid).map(agent.publicAction) });
  if ((match = p.match(/^\/api\/actions\/(a_[\w-]+)$/)) && m === 'POST') { const b = await readJson(req); return send(res, 200, { action: await agent.decide(uid, match[1], b.approve === true) }); }
  // files
  if (p === '/api/files' && m === 'POST') {
    const data = await readBody(req, 15 * 1024 * 1024);
    if (!data.length) throw fail(400, 'Fichier vide.');
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'fichier')).replace(/[\\/\r\n]/g, '_').slice(0, 120);
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
    const id = db.newId('f'), dir = path.join(agent.FILES_DIR(), uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), data);
    db.run('INSERT INTO files (id, user_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, uid, name, mime, data.length, db.now());
    return send(res, 201, { file: { id, name, mime, size: data.length } });
  }
  if ((match = p.match(/^\/api\/files\/(f_[\w-]+)$/)) && m === 'GET') {
    const row = db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', match[1], uid);
    const file = row && path.join(agent.FILES_DIR(), uid, row.id);
    if (!row || !fs.existsSync(file)) throw fail(404, 'Fichier introuvable.');
    const safe = /^image\/(png|jpeg|webp|gif)$/.test(row.mime);
    res.writeHead(200, { 'Content-Type': safe ? row.mime : 'application/octet-stream', 'Content-Disposition': `${safe ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/api/transcribe' && m === 'POST') {
    rateLimit(req, 'voice', 30);
    const audio = await readBody(req, 12 * 1024 * 1024);
    return send(res, 200, { text: await transcribe(audio, String(req.headers['content-type'] || '')) });
  }
  if (p === '/api/account' && m === 'DELETE') {
    const b = await readJson(req);
    if (b.confirm !== user.email) throw fail(400, 'Tape ton adresse e-mail pour confirmer la suppression du compte.');
    await google.revoke(uid);
    fs.rmSync(path.join(agent.FILES_DIR(), uid), { recursive: true, force: true });
    db.run('DELETE FROM users WHERE id = ?', uid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
  }
  throw fail(404, 'Route inconnue.');
}

// ---------------------------------------------------------------- static web app
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/privacy' || rel === '/terms') rel += '.html';
  else if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Introuvable');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream',
    // Code is revalidated on every load so a deploy reaches phones at once; images may be cached.
    'Cache-Control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=3600', ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
  fs.createReadStream(file).pipe(res);
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.googleusercontent.com; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, process.env.PUBLIC_URL);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/auth/google/start') return startGoogle(req, res, url);
    if (url.pathname === '/auth/google/callback') return await googleCallback(req, res, url);
    if (url.pathname === '/link' && req.method === 'GET') return linkPage(req, res, url);
    if (url.pathname === '/link' && req.method === 'POST') return await linkDecide(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Méthode refusée');
    return serveStatic(req, res, url);
  } catch (error) {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error('[glyphes]', req.method, url.pathname, error);
    if (res.headersSent) return res.end();
    if (url.pathname.startsWith('/auth/')) return page(res, status, 'Connexion impossible', esc(error.message));
    send(res, status, { error: status === 500 ? 'Erreur interne du serveur.' : error.message, ...(error.plugin ? { plugin: error.plugin } : {}), ...(error.setup ? { setup: true } : {}) });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`[glyphes] ${process.env.PUBLIC_URL} (écoute ${HOST}:${PORT}, web ${WEB_DIR})`));
  scheduler.start();
  // Runs interrupted by a restart: put their Glyphs back to rest.
  db.run("UPDATE glyphs SET status = 'idle' WHERE status = 'working'");
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { scheduler.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
module.exports = { server, createSession, upsertUser, createGlyph };
