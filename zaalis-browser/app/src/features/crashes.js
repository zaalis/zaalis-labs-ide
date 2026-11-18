'use strict';
/* =============================================================================
 *  Rapports de plantage locaux (chrome://crashes)
 * -----------------------------------------------------------------------------
 *  crashReporter (Crashpad) écrit des minidumps dans le dossier crashDumps de
 *  l'application ; rien n'est jamais envoyé (uploadToServer: false). En plus,
 *  chaque fin anormale de processus (onglet, GPU, utilitaire) est consignée
 *  dans un petit journal JSON. La page zaalis://crashes liste le tout.
 * =========================================================================== */

const MAX_LOG = 200;

// À appeler le plus tôt possible (avant app.whenReady) depuis main.js : un
// processus lancé avant le démarrage du collecteur ne serait pas surveillé.
function startEarly(app, crashReporter) {
  if (!crashReporter) return false;
  try {
    crashReporter.start({
      productName: 'zaalis Browser',
      companyName: 'zaalis',
      submitURL: '',
      uploadToServer: false,
      compress: true,
      ignoreSystemCrashHandler: true,
      globalExtra: { version: app.getVersion() },
    });
    return true;
  } catch (e) { console.error('[crashes] collecteur indisponible :', e.message); return false; }
}

// Type de processus inscrit par Crashpad dans le minidump (annotation « ptype »).
function guessProcessType(buf) {
  const s = buf.toString('latin1');
  const i = s.indexOf('ptype');
  if (i >= 0) {
    const m = /ptype[\x00-\x20]*[\x00-\x1f]*([a-z][a-z-]{2,30})/.exec(s.slice(i, i + 200));
    if (m) return m[1];
  }
  for (const k of ['renderer', 'gpu-process', 'utility', 'browser', 'ppapi']) if (s.includes(k)) return k;
  return '';
}
const PTYPE_LABELS = { renderer: 'Onglet (rendu)', 'gpu-process': 'GPU', utility: 'Utilitaire', browser: 'Navigateur', ppapi: 'Plug-in' };

function init(ctx) {
  const { app, fs, path, electron } = ctx;
  const { shell } = electron;
  const logFile = () => path.join(ctx.dataFolder, 'crash-log.json');
  let log = ctx.readJson(logFile(), []);
  if (!Array.isArray(log)) log = [];

  function record(entry) {
    log.push(Object.assign({ at: Date.now() }, entry));
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    ctx.writeJson(logFile(), log);
  }

  app.on('render-process-gone', (_e, wc, details) => {
    if (!details || details.reason === 'clean-exit') return;
    let url = '', title = '';
    try { url = wc.getURL(); title = wc.getTitle(); } catch {}
    const tab = (() => { try { return ctx.tabOfWebContents(wc); } catch { return null; } })();
    record({ kind: 'renderer', reason: details.reason, exitCode: details.exitCode, url: tab && tab.incognito ? '' : url, title: tab && tab.incognito ? 'Onglet privé' : title });
  });
  app.on('child-process-gone', (_e, details) => {
    if (!details || details.reason === 'clean-exit') return;
    record({ kind: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name || details.serviceName || '' });
  });

  function dumpsDir() { try { return app.getPath('crashDumps'); } catch { return ''; } }

  function listDumps() {
    const root = dumpsDir();
    const out = [];
    const walk = (d, depth) => {
      if (!d || depth > 3 || !fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.dmp$/i.test(e.name)) {
          try {
            const st = fs.statSync(p);
            let ptype = '';
            try {
              const fd = fs.openSync(p, 'r');
              const len = Math.min(st.size, 512 * 1024);
              const buf = Buffer.alloc(len);
              fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
              fs.closeSync(fd);
              ptype = guessProcessType(buf);
            } catch {}
            out.push({
              id: path.relative(root, p).replace(/\\/g, '/'),
              name: e.name.replace(/\.dmp$/i, ''),
              state: path.basename(path.dirname(p)),
              at: st.mtimeMs, size: st.size,
              type: PTYPE_LABELS[ptype] || ptype || '—',
            });
          } catch {}
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.at - a.at);
  }

  function resolveDump(id) {
    const root = dumpsDir();
    const p = path.resolve(root, String(id || ''));
    if (!root || !p.startsWith(path.resolve(root) + path.sep) || !/\.dmp$/i.test(p)) throw new Error('Rapport introuvable.');
    return p;
  }

  const opts = { pages: ['crashes.html'] };
  ctx.rpc('crashList', () => ({ dumps: listDumps(), log: log.slice().reverse(), dir: dumpsDir(), collector: !!electron.crashReporter }), opts);
  ctx.rpc('crashDelete', (p) => {
    if (p.all) {
      for (const d of listDumps()) { try { fs.unlinkSync(resolveDump(d.id)); } catch {} }
      log = []; ctx.writeJson(logFile(), log);
      return true;
    }
    if (p.id) fs.unlinkSync(resolveDump(p.id));
    return true;
  }, opts);
  ctx.rpc('crashOpenFolder', async (p) => {
    const dir = dumpsDir();
    if (p.id) shell.showItemInFolder(resolveDump(p.id));
    else { fs.mkdirSync(dir, { recursive: true }); await shell.openPath(dir); }
    return true;
  }, opts);
  ctx.alias('crashes', 'crashes.html');

  return { listDumps, record, get log() { return log; } };
}

module.exports = { init, startEarly, guessProcessType };
