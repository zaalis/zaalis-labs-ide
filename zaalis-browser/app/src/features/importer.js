'use strict';
/* =============================================================================
 *  Import depuis Google Chrome et Microsoft Edge (100 % maison)
 * -----------------------------------------------------------------------------
 *  - Profils détectés dans %LOCALAPPDATA%\Google\Chrome\User Data et
 *    %LOCALAPPDATA%\Microsoft\Edge\User Data (noms lus dans « Local State »).
 *  - Favoris : fichier JSON « Bookmarks ».
 *  - Historique : base SQLite « History », copiée puis lue avec le module
 *    intégré node:sqlite (aucune dépendance).
 *  - Mots de passe : base « Login Data » ; la clé AES-256 de « Local State »
 *    (os_crypt.encrypted_key) est déchiffrée par DPAPI (PowerShell,
 *    ProtectedData.Unprotect, compte Windows courant), puis chaque valeur
 *    v10/v11 est déchiffrée en AES-256-GCM. Les valeurs « v20 »
 *    (chiffrement lié à l'application, Chrome 127+) ne sont déchiffrables que
 *    par Chrome lui-même : on l'explique et on propose l'export CSV.
 * =========================================================================== */

const { execFile } = require('child_process');

const BROWSERS = [
  { key: 'chrome', name: 'Google Chrome', rel: ['Google', 'Chrome', 'User Data'] },
  { key: 'edge', name: 'Microsoft Edge', rel: ['Microsoft', 'Edge', 'User Data'] },
  { key: 'brave', name: 'Brave', rel: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
];

// Microsecondes depuis le 1er janvier 1601 (format Chromium) -> ms Unix.
const chromeTime = (t) => { const n = Number(t) || 0; return n > 11644473600000000 ? Math.round(n / 1000 - 11644473600000) : 0; };

function dpapiUnprotect(buf) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('DPAPI indisponible hors Windows'));
    const ps = 'Add-Type -AssemblyName System.Security; ' +
      '$b = [Convert]::FromBase64String($env:ZX_IN); ' +
      '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { env: { ...process.env, ZX_IN: Buffer.from(buf).toString('base64') }, windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err) return reject(new Error('déchiffrement DPAPI impossible'));
        resolve(Buffer.from(String(out || '').trim(), 'base64'));
      });
  });
}

function init(ctx) {
  const { fs, path, os } = ctx;
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch {}

  function roots() {
    // Tests : racines factices (jamais les vrais profils de l'utilisateur).
    if (process.env.ZAALIS_E2E && process.env.ZAALIS_IMPORT_ROOTS) {
      try { return JSON.parse(process.env.ZAALIS_IMPORT_ROOTS); } catch { return []; }
    }
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return BROWSERS.map(b => ({ browser: b.key, name: b.name, root: path.join(base, ...b.rel) }));
  }

  function listSources() {
    const out = [];
    for (const r of roots()) {
      if (!r.root || !fs.existsSync(r.root)) continue;
      let info = {};
      try { info = JSON.parse(fs.readFileSync(path.join(r.root, 'Local State'), 'utf8')).profile.info_cache || {}; } catch {}
      let dirs = Object.keys(info);
      try {
        for (const d of fs.readdirSync(r.root)) if ((d === 'Default' || /^Profile \d+$/.test(d)) && !dirs.includes(d)) dirs.push(d);
      } catch {}
      for (const d of dirs) {
        const dir = path.join(r.root, d);
        if (!fs.existsSync(dir)) continue;
        const has = {
          bookmarks: fs.existsSync(path.join(dir, 'Bookmarks')),
          history: fs.existsSync(path.join(dir, 'History')),
          passwords: fs.existsSync(path.join(dir, 'Login Data')),
        };
        if (!has.bookmarks && !has.history && !has.passwords) continue;
        out.push({
          id: r.browser + ':' + d, browser: r.browser, browserName: r.name || r.browser,
          profile: (info[d] && (info[d].name || info[d].shortcut_name)) || d, dir: d, has,
        });
      }
    }
    return out;
  }
  function sourceById(id) {
    const [browser, dir] = String(id || '').split(/:(.+)/);
    const r = roots().find(x => x.browser === browser);
    if (!r || !dir || /[\\/]|\.\./.test(dir)) return null;
    const meta = listSources().find(s => s.id === id);
    return meta ? Object.assign({ root: r.root, path: path.join(r.root, dir) }, meta) : null;
  }

  // Copie d'une base verrouillée par le navigateur en cours d'exécution.
  function snapshotDb(file) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-import-'));
    const dest = path.join(tmp, path.basename(file));
    try { fs.copyFileSync(file, dest); }
    catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('Fichier verrouillé : fermez ' + path.basename(path.dirname(path.dirname(file))) + ' puis réessayez.');
    }
    for (const ext of ['-wal', '-journal']) { try { if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, dest + ext); } catch {} }
    return { file: dest, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }
  function query(file, sql) {
    if (!sqlite) throw new Error('lecteur SQLite indisponible');
    const snap = snapshotDb(file);
    let db;
    try {
      db = new sqlite.DatabaseSync(snap.file, { readOnly: true });
      const st = db.prepare(sql);
      st.setReadBigInts(true);   // horodatages Chromium (µs depuis 1601) > 2^53
      return st.all();
    } finally {
      try { if (db) db.close(); } catch {}
      snap.done();
    }
  }

  // ----- Favoris -----------------------------------------------------------
  function readBookmarks(src) {
    const data = JSON.parse(fs.readFileSync(path.join(src.path, 'Bookmarks'), 'utf8'));
    const out = [];
    const walk = (node, trail) => {
      if (!node) return;
      if (node.type === 'url' && /^https?:/i.test(node.url || '')) out.push({ url: node.url, title: node.name || node.url, folder: trail.join(' › ') });
      for (const c of node.children || []) walk(c, node.type === 'folder' && node.name ? trail.concat(node.name) : trail);
    };
    for (const v of Object.values((data && data.roots) || {})) {
      if (!v || typeof v !== 'object' || !v.children) continue;
      for (const c of v.children) walk(c, []);
    }
    return out;
  }
  function importBookmarks(src) {
    const items = readBookmarks(src);
    const tag = src.browser === 'edge' ? 'Edge' : src.browser === 'brave' ? 'Brave' : 'Chrome';
    const list = ctx.bookmarks;
    const known = new Set(list.map(b => b.url));
    let added = 0, skipped = 0;
    for (const b of items) {
      if (known.has(b.url)) { skipped++; continue; }
      known.add(b.url);
      // Préfixe identifiable : « [Chrome › Dossier] Titre ».
      list.push({ url: b.url, title: '[' + tag + (b.folder ? ' › ' + b.folder : '') + '] ' + String(b.title).replace(/[\t\r\n]+/g, ' ').slice(0, 300) });
      added++;
    }
    if (added) { ctx.bookmarks = list; ctx.saveBookmarks(); ctx.pushState(); ctx.pushPanelState(); }
    return { added, skipped, total: items.length };
  }

  // ----- Historique --------------------------------------------------------
  function importHistory(src) {
    const rows = query(path.join(src.path, 'History'),
      'SELECT url, title, last_visit_time AS t FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 2000');
    const cur = ctx.history.slice();
    const known = new Set(cur.map(h => h.url));
    const fresh = [];
    for (const r of rows) {
      const u = String(r.url || '');
      if (!/^https?:/i.test(u) || known.has(u)) continue;
      known.add(u);
      fresh.push({ url: u, title: String(r.title || u).replace(/[\t\r\n]+/g, ' ').slice(0, 300), t: chromeTime(r.t) });
    }
    fresh.sort((a, b) => a.t - b.t);
    // Les entrées importées sont plus anciennes : placées avant l'historique
    // local, limite de 2000 entrées (les plus récentes sont conservées).
    let merged = fresh.map(({ url, title }) => ({ url, title })).concat(cur);
    if (merged.length > 2000) merged = merged.slice(merged.length - 2000);
    const added = Math.max(0, merged.length - cur.length);
    ctx.history = merged; ctx.saveHistory(); ctx.pushPanelState();
    return { added, total: rows.length };
  }

  // ----- Mots de passe -----------------------------------------------------
  async function masterKey(src) {
    const ls = JSON.parse(fs.readFileSync(path.join(src.root, 'Local State'), 'utf8'));
    const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
    if (!enc) throw new Error('clé de chiffrement absente de « Local State »');
    const raw = Buffer.from(enc, 'base64');
    if (raw.subarray(0, 5).toString() !== 'DPAPI') throw new Error('format de clé inconnu');
    const key = await dpapiUnprotect(raw.subarray(5));
    if (key.length !== 32) throw new Error('clé AES invalide');
    return key;
  }
  function decryptValue(buf, key) {
    buf = Buffer.from(buf || []);
    const prefix = buf.subarray(0, 3).toString('latin1');
    if (prefix === 'v10' || prefix === 'v11') {
      const iv = buf.subarray(3, 15), tag = buf.subarray(buf.length - 16), data = buf.subarray(15, buf.length - 16);
      const d = ctx.crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    }
    if (prefix === 'v20') { const e = new Error('app-bound'); e.code = 'APP_BOUND'; throw e; }
    return null;   // ancien format DPAPI brut : traité à part
  }
  async function importPasswords(src) {
    const pw = ctx.module('passwords');
    if (!pw) throw new Error('gestionnaire de mots de passe indisponible');
    const rows = query(path.join(src.path, 'Login Data'),
      'SELECT origin_url, signon_realm, username_value AS u, password_value AS p, blacklisted_by_user AS b, date_created AS c, date_last_used AS lu, times_used AS n FROM logins');
    const res = { added: 0, updated: 0, skipped: 0, appBound: 0, failed: 0, total: rows.length };
    if (!rows.length) return res;
    let key = null;
    try { key = await masterKey(src); } catch (e) { res.keyError = e.message; }
    const logins = [], never = [];
    for (const r of rows) {
      let origin = '';
      try { origin = new URL(String(r.origin_url || r.signon_realm)).origin; } catch {}
      if (!/^https?:/.test(origin)) { res.skipped++; continue; }
      if (Number(r.b)) { never.push(origin); continue; }
      let pass = null;
      try {
        if (!key) throw new Error('clé');
        pass = decryptValue(r.p, key);
        if (pass === null && r.p && r.p.length) pass = (await dpapiUnprotect(Buffer.from(r.p))).toString('utf8');
      } catch (e) {
        if (e.code === 'APP_BOUND') res.appBound++; else res.failed++;
        continue;
      }
      if (!pass) { res.skipped++; continue; }
      logins.push({ origin, url: String(r.origin_url || origin), username: String(r.u || ''), password: pass,
        created: chromeTime(r.c) || Date.now(), updated: chromeTime(r.c) || Date.now(), lastUsed: chromeTime(r.lu), timesUsed: Number(r.n) || 0 });
    }
    const out = pw.importAll({ logins, never }, { merge: true });
    res.added = out.added; res.updated = out.updated; res.skipped += out.skipped;
    return res;
  }

  async function run(params) {
    const src = sourceById(params.id);
    if (!src) throw new Error('Profil introuvable.');
    const result = { source: src.browserName + ' — ' + src.profile, warnings: [] };
    if (params.bookmarks && src.has.bookmarks) {
      try { result.bookmarks = importBookmarks(src); } catch (e) { result.warnings.push('Favoris : ' + e.message); }
    }
    if (params.history && src.has.history) {
      try { result.history = importHistory(src); } catch (e) { result.warnings.push('Historique : ' + e.message); }
    }
    if (params.passwords && src.has.passwords) {
      try {
        result.passwords = await importPasswords(src);
        if (result.passwords.appBound) {
          result.warnings.push(result.passwords.appBound + ' mot(s) de passe utilisent le chiffrement « lié à l\'application » de ' + src.browserName +
            ' (version 127 et suivantes), que seul ce navigateur peut lire. Exportez-les depuis ' + src.browserName +
            ' (Paramètres › Mots de passe › Exporter) puis importez le fichier CSV dans le gestionnaire de mots de passe.');
        }
        if (result.passwords.keyError) result.warnings.push('Mots de passe : ' + result.passwords.keyError);
      } catch (e) { result.warnings.push('Mots de passe : ' + e.message); }
    }
    return result;
  }

  const PAGES = { pages: ['import.html'] };
  ctx.rpc('impSources', () => ({ sources: listSources(), sqlite: !!sqlite }), PAGES);
  ctx.rpc('impRun', (p) => run(p || {}), PAGES);
  ctx.alias('import', 'import.html');
  ctx.alias('importdata', 'import.html');

  return { listSources, run, readBookmarks: (id) => readBookmarks(sourceById(id)), decryptValue, dpapiUnprotect, chromeTime };
}

module.exports = { init, chromeTime };
