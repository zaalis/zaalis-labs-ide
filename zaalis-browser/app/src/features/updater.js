'use strict';
/* =============================================================================
 *  Mises à jour automatiques (100 % maison, sans service tiers)
 * -----------------------------------------------------------------------------
 *  Comme Google Chrome : vérification silencieuse au démarrage puis toutes les
 *  quelques heures, téléchargement en arrière-plan, bouton « Mettre à jour »
 *  dans la barre d'outils, installation au redémarrage (ou à la fermeture).
 *
 *  Chaîne de confiance (aucune dépendance) :
 *   1. Le flux `zaalis-update.json` est signé en Ed25519 (`.sig` à côté). La
 *      clé publique est embarquée (src/update-key.pub.pem) ; la clé privée ne
 *      quitte jamais la machine de publication (scripts/release-manifest.js).
 *   2. Le manifeste donne la taille et l'empreinte SHA-512 de l'installeur ;
 *      le fichier téléchargé est refusé à la moindre différence.
 *   3. Si l'exécutable installé est signé Authenticode, l'installeur doit
 *      l'être aussi, par le même éditeur.
 *   4. Jamais de retour à une version plus ancienne (anti-rollback).
 * =========================================================================== */

const { spawn, execFile } = require('child_process');

const DEFAULT_FEED = 'https://github.com/zaalis/zaalis-browser/releases/latest/download/zaalis-update.json';
const FIRST_CHECK_DELAY_MS = 45 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 60 * 1000;   // 5 h, comme Chrome
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

// ----- Versions --------------------------------------------------------------
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}
// <0 si a<b, 0 si égales, >0 si a>b (SemVer 2.0, pré-versions comprises).
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return NaN;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p - +q; }
    else if (pn) return -1;
    else if (qn) return 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// ----- Signature du manifeste ----------------------------------------------
function verifyManifest(crypto, publicKeyPem, manifestBuf, signatureText) {
  if (!publicKeyPem) throw new Error('clé publique de mise à jour absente');
  const sig = Buffer.from(String(signatureText || '').trim(), 'base64');
  if (sig.length !== 64) throw new Error('signature du manifeste invalide');
  const key = crypto.createPublicKey(publicKeyPem);
  if (!crypto.verify(null, manifestBuf, key, sig)) throw new Error('signature du manifeste incorrecte');
  let m;
  try { m = JSON.parse(manifestBuf.toString('utf8')); } catch { throw new Error('manifeste illisible'); }
  if (!m || typeof m !== 'object') throw new Error('manifeste illisible');
  if (m.product !== 'zaalis-browser') throw new Error('manifeste d\'un autre produit');
  if (!parseVersion(m.version)) throw new Error('version du manifeste invalide');
  const inst = m.installer || {};
  if (!inst.url || !/^[A-Za-z0-9+/]{86}==$/.test(String(inst.sha512 || ''))) throw new Error('installeur mal décrit');
  if (!(inst.size > 0 && inst.size <= MAX_INSTALLER_BYTES)) throw new Error('taille d\'installeur invalide');
  return m;
}

function init(ctx) {
  const { app, fs, path, crypto, electron } = ctx;
  const { net } = electron;

  let publicKeyPem = '';
  try { publicKeyPem = fs.readFileSync(path.join(__dirname, '..', 'update-key.pub.pem'), 'utf8'); } catch {}

  const state = {
    status: 'idle',         // idle | disabled | checking | uptodate | downloading | ready | error
    current: app.getVersion(),
    latest: '',
    notes: '',
    releaseDate: '',
    progress: 0,
    error: '',
    lastCheck: 0,
    file: '',
  };
  const prefsFile = () => path.join(ctx.dataFolder, 'updates.json');
  let prefs = { auto: true, lastCheck: 0, feed: '' };
  let timer = null;
  let busy = null;
  let installOnQuit = false;

  const feedUrl = () => process.env.ZAALIS_UPDATE_FEED || prefs.feed || DEFAULT_FEED;
  // En développement (electron .), pas de vérification sauf demande explicite.
  const enabled = () => app.isPackaged || process.env.ZAALIS_UPDATE_FORCE === '1';
  const updatesDir = () => path.join(app.getPath('userData'), 'updates');

  function publicState() {
    return {
      status: state.status, current: state.current, latest: state.latest, notes: state.notes,
      releaseDate: state.releaseDate, progress: state.progress, error: state.error,
      lastCheck: state.lastCheck, auto: prefs.auto, packaged: app.isPackaged, enabled: enabled(),
    };
  }
  function changed() {
    ctx.pushState();
    ctx.pushPanelState();
    for (const t of ctx.tabs) {
      try {
        const u = t.view.webContents.getURL();
        if (u.startsWith('zaalis://home/about.html')) t.view.webContents.send('zaalis:message', { type: 'update', state: publicState() });
      } catch {}
    }
  }
  function setStatus(status, extra) { Object.assign(state, { status }, extra || {}); changed(); }

  async function fetchLimited(u, limit) {
    const res = await net.fetch(u, { cache: 'no-store', redirect: 'follow', headers: { 'user-agent': 'zaalis-browser-updater/' + state.current } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' sur ' + new URL(u).host);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error('réponse trop volumineuse');
    return buf;
  }

  // Signature Authenticode d'un fichier (PowerShell, sans dépendance).
  function authenticode(file) {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve({ status: 'NotSupported', subject: '' });
      const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:ZX_FILE; ' +
        '[Console]::Out.Write(($s.Status.ToString()) + "|" + ($(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { "" })))';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, ZX_FILE: file }, windowsHide: true, timeout: 30000 }, (err, out) => {
          if (err) return resolve({ status: 'Unknown', subject: '' });
          const [status, subject] = String(out || '').split('|');
          resolve({ status: status || 'Unknown', subject: subject || '' });
        });
    });
  }

  async function download(m) {
    const base = feedUrl();
    const target = new URL(m.installer.url, base);
    if (target.protocol !== 'https:' && !(process.env.ZAALIS_UPDATE_FORCE === '1' && target.protocol === 'http:')) {
      throw new Error('installeur servi sans HTTPS');
    }
    fs.mkdirSync(updatesDir(), { recursive: true });
    const safeName = ('zaalisBrowser-' + m.version + '-setup.exe').replace(/[^A-Za-z0-9._-]/g, '_');
    const finalPath = path.join(updatesDir(), safeName);
    // Déjà téléchargé et intact : rien à refaire.
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size === m.installer.size) {
      const h = crypto.createHash('sha512').update(fs.readFileSync(finalPath)).digest('base64');
      if (h === m.installer.sha512) return finalPath;
    }
    const partPath = finalPath + '.part';
    const res = await net.fetch(target.toString(), { cache: 'no-store', redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error('téléchargement refusé (HTTP ' + res.status + ')');
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(partPath);
    let received = 0, lastPush = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > m.installer.size) throw new Error('installeur plus gros qu\'annoncé');
        hash.update(value);
        if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
        const now = Date.now();
        if (now - lastPush > 400) { lastPush = now; state.progress = Math.round(received * 100 / m.installer.size); changed(); }
      }
    } finally {
      await new Promise(r => out.end(r));
    }
    if (received !== m.installer.size) { try { fs.unlinkSync(partPath); } catch {} throw new Error('téléchargement incomplet'); }
    if (hash.digest('base64') !== m.installer.sha512) { try { fs.unlinkSync(partPath); } catch {} throw new Error('empreinte SHA-512 incorrecte : fichier rejeté'); }
    // Éditeur identique à l'exécutable en place (si celui-ci est signé).
    if (app.isPackaged) {
      const self = await authenticode(process.execPath);
      if (self.status === 'Valid') {
        const inst = await authenticode(partPath);
        if (inst.status !== 'Valid' || inst.subject !== self.subject) {
          try { fs.unlinkSync(partPath); } catch {}
          throw new Error('signature Authenticode de l\'installeur absente ou d\'un autre éditeur');
        }
      }
    }
    try { fs.unlinkSync(finalPath); } catch {}
    fs.renameSync(partPath, finalPath);
    return finalPath;
  }

  function cleanOldInstallers(keep) {
    try {
      for (const f of fs.readdirSync(updatesDir())) {
        const p = path.join(updatesDir(), f);
        if (p !== keep) { try { fs.unlinkSync(p); } catch {} }
      }
    } catch {}
  }

  async function check(manual) {
    if (busy) return busy;
    if (!enabled()) { setStatus('disabled', { error: '' }); return publicState(); }
    if (state.status === 'ready') return publicState();
    busy = (async () => {
      setStatus('checking', { error: '', progress: 0 });
      try {
        const feed = feedUrl();
        const [manifestBuf, sigBuf] = await Promise.all([
          fetchLimited(feed, MAX_MANIFEST_BYTES),
          fetchLimited(feed + '.sig', 1024),
        ]);
        const m = verifyManifest(crypto, publicKeyPem, manifestBuf, sigBuf.toString('utf8'));
        state.lastCheck = prefs.lastCheck = Date.now();
        ctx.writeJson(prefsFile(), prefs);
        if (!(compareVersions(m.version, state.current) > 0)) {
          cleanOldInstallers('');
          setStatus('uptodate', { latest: m.version, notes: '', releaseDate: m.releaseDate || '' });
          return publicState();
        }
        setStatus('downloading', { latest: m.version, notes: String(m.notes || '').slice(0, 4000), releaseDate: m.releaseDate || '', progress: 0 });
        const file = await download(m);
        cleanOldInstallers(file);
        setStatus('ready', { file, progress: 100 });
        if (!manual) ctx.toast('Une mise à jour de zaalis Browser (' + m.version + ') est prête. Redémarrez pour l\'installer.');
      } catch (e) {
        state.lastCheck = Date.now();
        setStatus('error', { error: String(e && e.message || e) });
      }
      return publicState();
    })();
    try { return await busy; } finally { busy = null; }
  }

  function launchInstaller(relaunch) {
    if (!state.file || !fs.existsSync(state.file)) return false;
    // NSIS (electron-builder) : /S silencieux, --updated pour l'installeur,
    // --force-run relance le navigateur à la fin.
    const args = ['/S', '--updated'];
    if (relaunch) args.push('--force-run');
    try {
      const child = spawn(state.file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    } catch (e) {
      setStatus('error', { error: 'lancement de l\'installeur impossible : ' + e.message });
      return false;
    }
  }

  function installNow() {
    if (state.status !== 'ready') return false;
    if (!launchInstaller(true)) return false;
    installOnQuit = false;
    state.status = 'installing';   // le hook « quit » ne relance pas l'installeur
    app.quit();
    return true;
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    if (!prefs.auto || !enabled()) return;
    timer = setInterval(() => { check(false); }, CHECK_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  // ----- Points d'accroche -------------------------------------------------
  prefs = Object.assign(prefs, ctx.readJson(prefsFile(), {}));
  state.lastCheck = prefs.lastCheck || 0;
  if (!enabled()) state.status = 'disabled';

  ctx.alias('about', 'about.html');
  ctx.alias('help', 'about.html');
  ctx.alias('version', 'about.html');

  ctx.state('chrome', () => ({ update: { status: state.status, latest: state.latest } }));
  ctx.state('panel', () => ({ update: { status: state.status, latest: state.latest, current: state.current } }));

  ctx.rpc('updateState', () => publicState(), { pages: ['about.html'] });
  ctx.rpc('updateCheck', () => check(true), { pages: ['about.html'] });
  ctx.rpc('updateSetAuto', (p) => {
    prefs.auto = !!p.auto; ctx.writeJson(prefsFile(), prefs); schedule();
    if (prefs.auto && enabled() && Date.now() - state.lastCheck > CHECK_INTERVAL_MS) check(false);
    return publicState();
  }, { pages: ['about.html'] });
  ctx.action('updateInstall', () => { installNow(); }, { pages: ['about.html'] });

  ctx.on('ready', () => {
    schedule();
    if (prefs.auto && enabled()) {
      const t = setTimeout(() => check(false), FIRST_CHECK_DELAY_MS);
      if (t.unref) t.unref();
    }
  });
  // Mise à jour prête mais non appliquée : installée silencieusement à la
  // fermeture, comme Chrome (sans relancer le navigateur).
  ctx.on('quit', () => {
    if (state.status === 'ready' && prefs.auto) installOnQuit = true;
    if (installOnQuit) launchInstaller(false);
  });

  // Tests e2e uniquement : clé de test (jamais modifiable en production).
  const _setPublicKey = (pem) => { if (process.env.ZAALIS_E2E) publicKeyPem = pem; };
  const _reset = () => { if (process.env.ZAALIS_E2E) Object.assign(state, { status: 'idle', latest: '', file: '', error: '', progress: 0 }); };
  return { _setPublicKey, _reset, check, installNow, publicState, compareVersions, verifyManifest: (b, s) => verifyManifest(crypto, publicKeyPem, b, s), _state: state, _prefs: prefs };
}

module.exports = { init, compareVersions, parseVersion, verifyManifest };
