'use strict';
/* =============================================================================
 *  Gestionnaire de mots de passe (façon Gestionnaire de mots de passe Google)
 * -----------------------------------------------------------------------------
 *  - Stockage chiffré par profil (safeStorage / DPAPI), jamais en navigation
 *    privée ; aucun service tiers.
 *  - Script de contenu : preload-content.js, section « Mots de passe et
 *    remplissage automatique ». Chaque requête est validée ici selon l'origine
 *    réelle de la frame émettrice (event.senderFrame).
 *  - Correspondance comme Chrome : remplissage automatique uniquement sur
 *    l'origine exacte ; sous-domaines / domaine parent proposés mais jamais
 *    remplis automatiquement ; un identifiant enregistré en https n'est jamais
 *    proposé sur http (l'inverse est permis : migration vers https).
 *  - Bulle « Enregistrer / Mettre à jour / Jamais » ancrée à la barre
 *    d'adresse (interface/pw-bubble.js), page interne passwords.html.
 * =========================================================================== */

const { execFile } = require('child_process');

// Suffixes publics à deux niveaux les plus courants (approximation maison de
// la Public Suffix List, suffisante pour regrouper les sous-domaines).
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'co.kr', 'or.kr', 'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.cn',
  'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'co.in', 'net.in', 'org.in', 'co.za', 'co.il',
  'com.tr', 'com.ua', 'com.pl', 'co.th', 'com.vn', 'com.ph', 'com.eg', 'com.sa', 'gouv.fr', 'asso.fr',
  'nom.fr', 'tm.fr', 'com.fr', 'gov.fr', 'ac.be', 'qc.ca', 'gc.ca', 'github.io', 'gitlab.io', 'blogspot.com',
  'herokuapp.com', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'azurewebsites.net', 'cloudfront.net', 'appspot.com', 'myshopify.com', 'wordpress.com', 'wixsite.com',
]);

function siteOf(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const p = host.split('.');
  const last2 = p.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(last2) && p.length >= 3) return p.slice(-3).join('.');
  return last2;
}

function parseOrigin(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    return { origin: x.origin, scheme: x.protocol, host: x.hostname.toLowerCase(), port: x.port };
  } catch { return null; }
}

// 'exact' | 'upgrade' (http enregistré, page https même hôte) | 'site' | null
function matchKind(savedOrigin, currentOrigin) {
  const s = parseOrigin(savedOrigin), c = parseOrigin(currentOrigin);
  if (!s || !c) return null;
  if (s.origin === c.origin) return 'exact';
  if (s.scheme === 'https:' && c.scheme === 'http:') return null;          // jamais https -> http
  if (s.host === c.host && s.scheme === 'http:' && c.scheme === 'https:' && (s.port === c.port || (!s.port && !c.port))) return 'upgrade';
  if (siteOf(s.host) === siteOf(c.host) && siteOf(s.host).includes('.')) return 'site';
  return null;
}

// ----- Générateur ------------------------------------------------------------
const LOWER = 'abcdefghijkmnopqrstuvwxyz';      // sans l (confusion avec 1)
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';       // sans I, O
const DIGITS = '23456789';                      // sans 0, 1
const SYMBOLS = '-_.!@#$%*?';
function randomFrom(crypto, set) {
  // Tirage sans biais (rejet).
  const max = 256 - (256 % set.length);
  for (;;) { const b = crypto.randomBytes(1)[0]; if (b < max) return set[b % set.length]; }
}
function generatePassword(crypto, opts) {
  opts = opts || {};
  let len = 16;
  const min = Number(opts.minLength) || 0, max = Number(opts.maxLength) || 0;
  if (min > len) len = Math.min(min, 64);
  if (max > 0 && max < len) len = max;
  len = Math.max(4, len);
  let re = null;
  if (opts.pattern) { try { re = new RegExp('^(?:' + opts.pattern + ')$', 'v'); } catch { try { re = new RegExp('^(?:' + opts.pattern + ')$'); } catch { re = null; } } }
  const attempts = [[LOWER, UPPER, DIGITS, SYMBOLS], [LOWER, UPPER, DIGITS], [LOWER, DIGITS], [DIGITS]];
  for (const classes of attempts) {
    for (let tries = 0; tries < 60; tries++) {
      const all = classes.join('');
      const chars = classes.map(c => randomFrom(crypto, c));                 // une de chaque classe
      while (chars.length < len) chars.push(randomFrom(crypto, all));
      for (let i = chars.length - 1; i > 0; i--) {                          // mélange Fisher-Yates
        const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      const pw = chars.slice(0, len).join('');
      if (!re || re.test(pw)) return pw;
    }
  }
  return null;
}

// ----- Robustesse (analyse locale) -------------------------------------------
const COMMON = new Set(['123456', '123456789', 'password', 'azerty', 'qwerty', '12345678', '111111', '123123',
  'motdepasse', 'soleil', 'doudou', 'loulou', 'admin', 'welcome', 'iloveyou', 'abc123', '000000', 'password1',
  'azertyuiop', 'qwertyuiop', '1234567890', 'marseille', 'chocolat', 'bonjour', 'princesse', 'football', 'dragon']);
function strength(pw) {
  pw = String(pw || '');
  if (!pw) return 0;
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  if (/^(?:\d+|[a-z]+|[A-Z]+)$/.test(pw)) bits *= 0.7;
  if (/(012|123|234|345|456|567|678|789|abc|bcd|azer|qwer)/i.test(pw)) bits -= 10;
  return bits < 40 ? 1 : bits < 60 ? 2 : 3;   // 1 faible, 2 moyen, 3 fort
}

// ----- CSV (format Chrome : name,url,username,password,note) -----------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
const csvCell = (s) => { s = String(s == null ? '' : s); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCsv(logins) {
  const lines = ['name,url,username,password,note'];
  for (const l of logins) lines.push([parseOrigin(l.origin) ? parseOrigin(l.origin).host : l.origin, l.url || l.origin, l.username, l.password, l.note || ''].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

function init(ctx) {
  const { fs, path, crypto, electron } = ctx;
  const E2E = !!process.env.ZAALIS_E2E;

  // ----- Stockage ----------------------------------------------------------
  let store = null, storeProfile = null;
  const file = () => path.join(ctx.profileDataDir(), 'passwords.json');
  function load() {
    if (store && storeProfile === ctx.currentProfileId) return store;
    storeProfile = ctx.currentProfileId;
    const d = ctx.readJson(file(), null, true) || {};
    store = {
      version: 1,
      logins: Array.isArray(d.logins) ? d.logins : [],
      never: Array.isArray(d.never) ? d.never : [],
      settings: Object.assign({ offer: true, autoSignIn: true }, d.settings || {}),
    };
    return store;
  }
  function save() {
    ctx.writeJson(file(), store, true);
    notifyPages();
    ctx.pushState();
  }
  function notifyPages() {
    for (const t of ctx.tabs) {
      try { if (t.view.webContents.getURL().startsWith('zaalis://home/passwords.html')) t.view.webContents.send('zaalis:message', { type: 'pwChanged' }); } catch {}
    }
  }
  const newId = () => 'l' + crypto.randomBytes(8).toString('hex');
  function findLogin(origin, username) {
    return load().logins.find(l => l.origin === origin && l.username === username) || null;
  }
  function upsert(entry, opts) {
    opts = opts || {};
    const s = load();
    const o = parseOrigin(entry.origin || entry.url);
    if (!o || !entry.password) return null;
    const now = Date.now();
    let l = findLogin(o.origin, String(entry.username || ''));
    if (l) {
      if (opts.keepNewer && (l.updated || 0) > (entry.updated || 0)) return { login: l, status: 'skipped' };
      const changed = l.password !== entry.password || (entry.note != null && entry.note !== l.note);
      l.password = String(entry.password);
      if (entry.note != null) l.note = String(entry.note);
      if (changed) l.updated = entry.updated || now;
      return { login: l, status: changed ? 'updated' : 'unchanged' };
    }
    l = {
      id: newId(), origin: o.origin, url: String(entry.url || o.origin).slice(0, 2048),
      username: String(entry.username || '').slice(0, 512), password: String(entry.password).slice(0, 4096),
      note: String(entry.note || '').slice(0, 4096),
      created: entry.created || now, updated: entry.updated || now, lastUsed: entry.lastUsed || 0, timesUsed: entry.timesUsed || 0,
    };
    s.logins.push(l);
    return { login: l, status: 'added' };
  }

  // ----- Vérification de l'identité Windows -------------------------------
  let authUntil = 0;
  const VERIFY_PS = [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    '$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]',
    '$a = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()))',
    '$a.Wait(); if ($a.Result.ToString() -ne "Available") { [Console]::Out.Write("UNAVAILABLE"); exit }',
    '$t = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:ZX_MSG)))',
    '$t.Wait(); [Console]::Out.Write($t.Result.ToString())',
  ].join('; ');
  // -> 'verified' | 'unavailable' | 'denied'
  function verifyUser(reason) {
    if (E2E) return Promise.resolve('verified');
    if (Date.now() < authUntil) return Promise.resolve('verified');
    if (process.platform !== 'win32') return Promise.resolve('unavailable');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', VERIFY_PS],
        { env: { ...process.env, ZX_MSG: reason || 'zaalis Browser veut vérifier votre identité' }, windowsHide: true, timeout: 120000 },
        (err, out) => {
          const r = String(out || '').trim();
          if (r === 'Verified') { authUntil = Date.now() + 60000; resolve('verified'); }
          else if (err || r === 'UNAVAILABLE' || r === 'DeviceNotPresent' || r === 'NotConfiguredForUser' || r === 'DisabledByPolicy') resolve('unavailable');
          else resolve('denied');
        });
    });
  }
  // Sans Windows Hello : la page demande une confirmation explicite
  // (params.confirmed) avant de révéler / exporter.
  async function requireAuth(params, reason) {
    const r = await verifyUser(reason);
    if (r === 'verified') return true;
    if (r === 'unavailable' && params && params.confirmed) { authUntil = Date.now() + 60000; return true; }
    if (r === 'unavailable') { const e = new Error('confirmation requise'); e.code = 'NEED_CONFIRM'; throw e; }
    throw new Error('Vérification de l\'identité refusée.');
  }

  // ----- Invitation « Enregistrer / Mettre à jour » -------------------------
  const pending = new Map();   // tabId -> { kind, origin, url, username, password, loginId }
  function sendPrompt(tab, p) {
    ctx.sendChrome({
      type: 'pwPrompt', tabId: tab.id,
      prompt: { kind: p.kind, host: parseOrigin(p.origin).host, username: p.username, password: p.password, accounts: p.accounts || [] },
    });
    ctx.pushState();
  }
  function onSubmitted(payload, info) {
    const { tab, origin, frameUrl } = info;
    if (!tab || tab.incognito || !parseOrigin(origin)) return null;
    const s = load();
    if (!s.settings.offer || s.never.includes(origin)) return null;
    const username = String(payload.username || '').trim().slice(0, 512);
    const current = String(payload.password || '').slice(0, 4096);
    const fresh = String(payload.newPassword || '').slice(0, 4096);
    const pw = fresh || current;
    if (!pw) return null;
    const mine = s.logins.filter(l => l.origin === origin);
    let target = null;
    if (username) target = mine.find(l => l.username === username) || null;
    else if (current) target = mine.find(l => l.password === current) || null;
    if (!target && !username && mine.length === 1 && fresh) target = mine[0];
    if (target && target.password === pw) {
      target.lastUsed = Date.now(); target.timesUsed = (target.timesUsed || 0) + 1;
      ctx.writeJson(file(), s, true);
      return null;
    }
    const p = {
      kind: target ? 'update' : 'save', origin, url: String(frameUrl || origin).split('#')[0].slice(0, 2048),
      username: target ? target.username : username, password: pw, loginId: target ? target.id : null,
      accounts: !target && !username && mine.length > 1 ? mine.map(l => l.username) : [],
    };
    pending.set(tab.id, p);
    setTimeout(() => { if (pending.get(tab.id) === p && ctx.tabs.includes(tab)) sendPrompt(tab, p); }, 250);
    return { prompted: p.kind };
  }

  function savePending(tabId, edited) {
    const p = pending.get(tabId);
    if (!p) return null;
    pending.delete(tabId);
    const username = edited && typeof edited.username === 'string' ? edited.username.trim().slice(0, 512) : p.username;
    const password = edited && typeof edited.password === 'string' && edited.password ? edited.password.slice(0, 4096) : p.password;
    let res;
    const existing = p.loginId ? load().logins.find(l => l.id === p.loginId) : null;
    if (existing && existing.username === username) {
      existing.password = password; existing.updated = Date.now(); existing.lastUsed = Date.now();
      res = { login: existing, status: 'updated' };
    } else {
      res = upsert({ origin: p.origin, url: p.url, username, password });
    }
    save();
    ctx.toast(res && res.status === 'added' ? 'Mot de passe enregistré.' : 'Mot de passe mis à jour.');
    return res;
  }

  // ----- Canal des scripts de contenu --------------------------------------
  function suggestionsFor(origin) {
    const out = [];
    for (const l of load().logins) {
      const k = matchKind(l.origin, origin);
      if (k) out.push({ l, k });
    }
    const rank = { exact: 0, upgrade: 1, site: 2 };
    out.sort((a, b) => rank[a.k] - rank[b.k] || (b.l.lastUsed || 0) - (a.l.lastUsed || 0) || a.l.username.localeCompare(b.l.username));
    return out;
  }
  ctx.page('pwSubmitted', (payload, info) => onSubmitted(payload, info));
  ctx.page('pwSuggest', (_p, info) => ({
    items: suggestionsFor(info.origin).slice(0, 20).map(({ l, k }) => ({
      id: l.id, username: l.username, exact: k === 'exact',
      site: k === 'exact' ? '' : parseOrigin(l.origin).host,
    })),
  }));
  ctx.page('pwFill', (p, info) => {
    const l = load().logins.find(x => x.id === String(p.id || ''));
    if (!l || !matchKind(l.origin, info.origin)) return null;
    l.lastUsed = Date.now(); l.timesUsed = (l.timesUsed || 0) + 1;
    ctx.writeJson(file(), store, true);
    return { username: l.username, password: l.password };
  });
  ctx.page('pwAutofill', (_p, info) => {
    const s = load();
    if (!s.settings.autoSignIn || info.tab.incognito) return null;
    const exact = s.logins.filter(l => l.origin === info.origin);
    if (exact.length !== 1) return null;
    return { username: exact[0].username, password: exact[0].password };
  });
  ctx.page('pwGenerate', (p) => {
    const password = generatePassword(crypto, { minLength: p.minLength, maxLength: p.maxLength, pattern: String(p.pattern || '').slice(0, 500) });
    return password ? { password } : null;
  });
  ctx.page('pwManage', () => { ctx.openInternal('passwords'); return true; });

  // ----- Actions du chrome (bulle) -----------------------------------------
  ctx.action('pwSave', (args) => { savePending(parseInt(args[0], 10), { username: args[1], password: args[2] }); });
  ctx.action('pwNever', (args) => {
    const id = parseInt(args[0], 10);
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const s = load();
    if (!s.never.includes(p.origin)) s.never.push(p.origin);
    save();
  });
  ctx.action('pwDismiss', (args) => { pending.delete(parseInt(args[0], 10)); ctx.pushState(); });
  ctx.action('pwKey', () => {
    const t = ctx.activeTab();
    if (!t) return;
    const p = pending.get(t.id);
    if (p) sendPrompt(t, p);
    else {
      let host = '';
      try { host = new URL(t.view.webContents.getURL()).hostname; } catch {}
      ctx.openInternal('passwords' + (host ? '#q=' + encodeURIComponent(host) : ''));
    }
  });
  ctx.on('tabClosed', (t) => pending.delete(t.id));
  ctx.state('chrome', () => {
    const t = ctx.activeTab();
    if (!t) return { pw: { key: false, pending: false } };
    let origin = '';
    try { origin = new URL(t.view.webContents.getURL()).origin; } catch {}
    const has = !!origin && /^https?:/.test(origin) && load().logins.some(l => matchKind(l.origin, origin) === 'exact');
    return { pw: { key: has || pending.has(t.id), pending: pending.has(t.id) } };
  });

  // ----- Page passwords.html -----------------------------------------------
  const PAGES = { pages: ['passwords.html'] };
  function listPayload() {
    const s = load();
    const counts = new Map();
    for (const l of s.logins) counts.set(l.password, (counts.get(l.password) || 0) + 1);
    return {
      logins: s.logins.map(l => ({
        id: l.id, origin: l.origin, host: (parseOrigin(l.origin) || {}).host || l.origin, url: l.url, username: l.username,
        note: l.note || '', created: l.created, updated: l.updated, lastUsed: l.lastUsed, timesUsed: l.timesUsed || 0,
        strength: strength(l.password), reused: counts.get(l.password) > 1,
      })).sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username)),
      never: s.never.slice().sort(),
      settings: s.settings,
      sealed: ctx.sealAvailable(),
    };
  }
  ctx.rpc('pwList', () => listPayload(), PAGES);
  ctx.rpc('pwReveal', async (p) => {
    await requireAuth(p, 'Afficher un mot de passe enregistré');
    const l = load().logins.find(x => x.id === p.id);
    if (!l) throw new Error('Identifiant introuvable.');
    return { password: l.password };
  }, PAGES);
  ctx.rpc('pwUpdate', async (p) => {
    const l = load().logins.find(x => x.id === p.id);
    if (!l) throw new Error('Identifiant introuvable.');
    if (typeof p.password === 'string' && p.password !== l.password) {
      await requireAuth(p, 'Modifier un mot de passe enregistré');
      if (!p.password) throw new Error('Le mot de passe ne peut pas être vide.');
      l.password = p.password.slice(0, 4096);
    }
    if (typeof p.username === 'string') {
      const u = p.username.trim().slice(0, 512);
      if (u !== l.username && findLogin(l.origin, u)) throw new Error('Un identifiant identique existe déjà pour ce site.');
      l.username = u;
    }
    if (typeof p.note === 'string') l.note = p.note.slice(0, 4096);
    l.updated = Date.now();
    save();
    return listPayload();
  }, PAGES);
  ctx.rpc('pwAdd', (p) => {
    let url = String(p.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!parseOrigin(url)) throw new Error('Adresse du site invalide.');
    if (!p.password) throw new Error('Le mot de passe est obligatoire.');
    const r = upsert({ origin: url, url, username: p.username, password: p.password, note: p.note });
    if (!r) throw new Error('Identifiant invalide.');
    if (r.status === 'unchanged') throw new Error('Cet identifiant existe déjà pour ce site.');
    save();
    return listPayload();
  }, PAGES);
  ctx.rpc('pwDelete', (p) => {
    const s = load();
    const ids = new Set([].concat(p.ids || p.id || []));
    s.logins = s.logins.filter(l => !ids.has(l.id));
    save();
    return listPayload();
  }, PAGES);
  ctx.rpc('pwNeverRemove', (p) => { const s = load(); s.never = s.never.filter(o => o !== p.origin); save(); return listPayload(); }, PAGES);
  ctx.rpc('pwSettings', (p) => {
    const s = load();
    if (typeof p.offer === 'boolean') s.settings.offer = p.offer;
    if (typeof p.autoSignIn === 'boolean') s.settings.autoSignIn = p.autoSignIn;
    save();
    return listPayload();
  }, PAGES);
  ctx.rpc('pwGenerate', (p) => ({ password: generatePassword(crypto, p || {}) }), PAGES);
  ctx.rpc('pwExport', async (p) => {
    await requireAuth(p, 'Exporter vos mots de passe');
    const csv = toCsv(load().logins);
    let target = p.path && E2E ? p.path : '';
    if (!target) {
      const r = await electron.dialog.showSaveDialog(ctx.mainWin, {
        title: 'Exporter les mots de passe', defaultPath: path.join(ctx.app.getPath('documents'), 'Mots de passe zaalis.csv'),
        filters: [{ name: 'Fichier CSV', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      target = r.filePath;
    }
    fs.writeFileSync(target, '﻿' + csv, 'utf8');
    return { count: load().logins.length, path: target };
  }, PAGES);
  function importCsvText(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('Fichier CSV vide.');
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = (names) => head.findIndex(h => names.includes(h));
    let iUrl = col(['url', 'origin', 'login_uri', 'website', 'site']);
    let iUser = col(['username', 'login', 'login_username', 'user', 'identifiant', 'email']);
    let iPw = col(['password', 'login_password', 'mot de passe']);
    let iNote = col(['note', 'notes', 'extra', 'comment']);
    let body = rows.slice(1);
    if (iUrl < 0 || iPw < 0) {
      if (head.length >= 4) { iUrl = 1; iUser = 2; iPw = 3; iNote = 4; body = rows; }
      else throw new Error('Colonnes « url » et « password » introuvables.');
    }
    const res = { added: 0, updated: 0, skipped: 0 };
    for (const r of body) {
      let url = String(r[iUrl] || '').trim();
      if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
      const pw = r[iPw] || '';
      if (!parseOrigin(url) || !pw) { res.skipped++; continue; }
      const x = upsert({ origin: url, url, username: iUser >= 0 ? r[iUser] : '', password: pw, note: iNote >= 0 ? r[iNote] : '' });
      if (!x) res.skipped++;
      else if (x.status === 'added') res.added++;
      else if (x.status === 'updated') res.updated++;
      else res.skipped++;
    }
    save();
    return res;
  }
  ctx.rpc('pwImportCsv', async (p) => {
    let text = typeof p.text === 'string' ? p.text : '';
    if (!text) {
      const r = await electron.dialog.showOpenDialog(ctx.mainWin, {
        title: 'Importer des mots de passe (CSV)', properties: ['openFile'],
        filters: [{ name: 'Fichier CSV', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true };
      const st = fs.statSync(r.filePaths[0]);
      if (st.size > 20 * 1024 * 1024) throw new Error('Fichier trop volumineux.');
      text = fs.readFileSync(r.filePaths[0], 'utf8');
    }
    return importCsvText(text);
  }, PAGES);
  ctx.rpc('pwCheckup', () => {
    const s = load();
    const groups = new Map();
    for (const l of s.logins) { if (!groups.has(l.password)) groups.set(l.password, []); groups.get(l.password).push(l.id); }
    return {
      total: s.logins.length,
      weak: s.logins.filter(l => strength(l.password) <= 1).map(l => l.id),
      reused: [...groups.values()].filter(g => g.length > 1),
    };
  }, PAGES);

  ctx.alias('passwords', 'passwords.html');
  ctx.alias('password-manager', 'passwords.html');
  ctx.alias('autofill', 'passwords.html#addresses');

  // ----- API publique (synchronisation, import) -----------------------------
  return {
    exportAll() {
      const s = load();
      return { logins: s.logins.map(l => Object.assign({}, l)), never: s.never.slice() };
    },
    importAll(data, opts) {
      opts = Object.assign({ merge: true }, opts || {});
      const s = load();
      if (!opts.merge) { s.logins = []; s.never = []; }
      const res = { added: 0, updated: 0, skipped: 0 };
      for (const l of (data && data.logins) || []) {
        const r = upsert(l, { keepNewer: opts.merge });
        if (!r) res.skipped++; else if (r.status === 'added') res.added++; else if (r.status === 'updated') res.updated++; else res.skipped++;
      }
      for (const o of (data && data.never) || []) if (parseOrigin(o) && !s.never.includes(o)) s.never.push(o);
      save();
      return res;
    },
    // Suppression ciblée (synchronisation : propagation des suppressions).
    removeWhere(pred) {
      const s = load();
      const before = s.logins.length;
      s.logins = s.logins.filter(l => { try { return !pred(l); } catch { return true; } });
      if (s.logins.length !== before) save();
      return before - s.logins.length;
    },
    importCsvText,
    toCsv: () => toCsv(load().logins),
    pendingFor: (tabId) => pending.get(tabId) || null,
    savePending,
    list: () => listPayload(),
    matchKind, siteOf, strength, generatePassword: (o) => generatePassword(crypto, o), parseCsv,
  };
}

module.exports = { init, matchKind, siteOf, strength, parseCsv, generatePassword };
