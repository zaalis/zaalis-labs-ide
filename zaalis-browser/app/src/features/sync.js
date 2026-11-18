'use strict';
/* =============================================================================
 *  Synchronisation entre appareils, sans serveur (voir lib/syncengine.js)
 * -----------------------------------------------------------------------------
 *  Favoris, historique (500 dernières adresses), raccourcis de l'accueil,
 *  onglets ouverts, réglages choisis, mots de passe et adresses (si les
 *  modules correspondants sont présents). Synchro au démarrage, toutes les
 *  minutes, quand un autre appareil écrit dans le dossier, et à la fermeture.
 * =========================================================================== */

const { SyncEngine, unlockVault, vaultExists, eraseVault, vaultDir } = require('./lib/syncengine');

const COLLECTIONS = {
  bookmarks: 'Favoris', history: 'Historique', shortcuts: 'Raccourcis de l\'accueil', tabs: 'Onglets ouverts',
  settings: 'Réglages (thème, moteur de recherche, sécurité)', passwords: 'Mots de passe', addresses: 'Adresses et formulaires',
};
const SYNCED_SETTINGS = {
  theme: (v) => ['setTheme', [v]],
  searchEngine: (v) => ['setSearchEngine', [v]],
  safeSearch: (v) => ['setSafeSearch', [v ? '1' : '0']],
  httpsOnly: (v) => ['setHttpsOnly', [v ? '1' : '0']],
  showBookmarks: (v) => ['setShowBookmarks', [v ? '1' : '0']],
};
const HISTORY_LIMIT = 500;

function init(ctx) {
  const { fs, path, os, crypto, electron } = ctx;
  const cfgFile = () => path.join(ctx.profileDataDir(), 'sync-config.json');
  const keyFile = () => path.join(ctx.profileDataDir(), 'sync-key');
  const stateFile = () => path.join(ctx.profileDataDir(), 'sync-state.json');

  let cfg = null, engine = null, timer = null, watcher = null, debounce = null;
  let status = { state: 'off', lastSync: 0, error: '', report: null };

  function defaults() {
    return { enabled: false, folder: '', deviceId: crypto.randomUUID(), deviceName: os.hostname(), collections: Object.fromEntries(Object.keys(COLLECTIONS).map(k => [k, true])) };
  }
  function loadCfg() { cfg = Object.assign(defaults(), ctx.readJson(cfgFile(), {}, ctx.sealAvailable())); }
  function saveCfg() { ctx.writeJson(cfgFile(), cfg, ctx.sealAvailable()); }
  function loadKey() { try { return Buffer.from(ctx.sealRead(keyFile()).trim(), 'base64'); } catch { return null; } }
  function storeKey(key) { ctx.sealWrite(keyFile(), key.toString('base64')); }
  function suggestFolder() {
    const cands = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial,
      path.join(os.homedir(), 'Google Drive'), path.join(os.homedir(), 'Dropbox'), path.join(os.homedir(), 'iCloudDrive')].filter(Boolean);
    return cands.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) || '';
  }

  // ----- Adaptateurs de collections ---------------------------------------
  const keyed = (list) => { const m = {}; for (const e of list) if (e && e.url) m[e.url] = { url: e.url, title: e.title || '' }; return m; };
  function applyList(getList, setList, records, keys) {
    let list = getList().slice();
    const del = new Set(), upd = new Map();
    for (const k of keys) { const r = records[k]; if (!r) continue; if (r.del) del.add(k); else upd.set(k, r.v); }
    list = list.filter(e => !del.has(e.url));
    for (const e of list) if (upd.has(e.url)) { e.title = upd.get(e.url).title || e.title; upd.delete(e.url); }
    const added = [...upd.values()].sort((a, b) => (records[a.url].ts - records[b.url].ts));
    setList(list.concat(added.map(v => ({ url: v.url, title: v.title || v.url }))));
  }
  function moduleAdapter(name) {
    const mod = () => { const m = ctx.module(name); return m && typeof m.exportAll === 'function' && typeof m.importAll === 'function' ? m : null; };
    // passwords : exportAll() -> { logins, never } ; autofill : { profiles }.
    // Clé stable entre appareils : origine + identifiant pour un mot de passe
    // (les id locaux diffèrent d'un appareil à l'autre), id conservé pour une adresse.
    const listKey = name === 'passwords' ? 'logins' : 'profiles';
    const keyOf = name === 'passwords'
      ? (e) => JSON.stringify([e.origin || e.url || '', e.username || ''])
      : (e) => String(e.id || JSON.stringify([e.name || '', e.street || e.address || '', e.postal || '']));
    const entries = (data) => Array.isArray(data) ? data : ((data && data[listKey]) || []);
    return {
      available: () => !!mod(),
      collect() { const m = mod(); if (!m) return {}; const out = {}; for (const e of entries(m.exportAll())) out[keyOf(e)] = e; return out; },
      apply(records, keys) {
        const m = mod(); if (!m) return;
        const put = [], del = new Set();
        for (const k of keys) { const r = records[k]; if (!r) continue; if (r.del) del.add(k); else put.push(r.v); }
        if (put.length) m.importAll({ [listKey]: put }, { merge: true, fromSync: true });
        if (del.size && typeof m.removeWhere === 'function') {
          try { m.removeWhere(e => del.has(keyOf(e))); } catch {}
        }
      },
    };
  }
  function adapters() {
    const all = {
      bookmarks: {
        collect: () => keyed(ctx.bookmarks),
        apply: (rec, keys) => { applyList(() => ctx.bookmarks, (l) => { ctx.bookmarks = l; }, rec, keys); ctx.saveBookmarks(); ctx.pushState(); },
      },
      shortcuts: {
        collect: () => keyed(ctx.shortcuts),
        apply: (rec, keys) => { applyList(() => ctx.shortcuts, (l) => { ctx.shortcuts = l; }, rec, keys); ctx.saveShortcuts(); },
      },
      history: {
        maxRecords: HISTORY_LIMIT * 2,
        collect: () => {
          const out = {}, h = ctx.history;
          for (let i = h.length - 1; i >= 0 && Object.keys(out).length < HISTORY_LIMIT; i--) {
            const e = h[i]; if (e && e.url && !out[e.url]) out[e.url] = { url: e.url, title: e.title || '' };
          }
          return out;
        },
        exists: (k) => ctx.history.some(e => e.url === k),
        apply: (rec, keys) => {
          const del = new Set(), add = [];
          for (const k of keys) { const r = rec[k]; if (!r) continue; if (r.del) del.add(k); else if (!ctx.history.some(e => e.url === k)) add.push(r); }
          let h = ctx.history.filter(e => !del.has(e.url));
          add.sort((a, b) => a.ts - b.ts).forEach(r => h.push({ url: r.v.url, title: r.v.title || r.v.url }));
          if (h.length > 2000) h = h.slice(h.length - 2000);
          ctx.history = h; ctx.saveHistory();
        },
      },
      settings: {
        collect: () => { const o = {}; for (const k of Object.keys(SYNCED_SETTINGS)) o[k] = ctx.settings[k]; return o; },
        apply: (rec, keys) => {
          for (const k of keys) {
            const r = rec[k]; if (!r || r.del || !SYNCED_SETTINGS[k] || ctx.settings[k] === r.v) continue;
            const [a, args] = SYNCED_SETTINGS[k](r.v);
            ctx.handleAction(a, args, null);
          }
        },
      },
      passwords: moduleAdapter('passwords'),
      addresses: moduleAdapter('autofill'),
    };
    const out = {};
    for (const [k, a] of Object.entries(all)) if (cfg.collections[k] !== false && (!a.available || a.available())) out[k] = a;
    return out;
  }
  function openTabs() {
    if (!cfg.collections.tabs) return [];
    return ctx.tabs.filter(t => !t.incognito).map(t => ({ url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() }))
      .filter(t => /^https?:/i.test(t.url)).slice(0, 100);
  }

  function makeEngine(key) {
    return new SyncEngine({
      folder: cfg.folder, key, deviceId: cfg.deviceId, deviceName: cfg.deviceName, adapters: adapters(), getTabs: openTabs,
      state: { load: () => ctx.readJson(stateFile(), { records: {} }, ctx.sealAvailable()), save: (s) => ctx.writeJson(stateFile(), s, ctx.sealAvailable()) },
    });
  }

  let bootedFor = '';
  function runSync(reason) {
    // Changement de profil : chaque profil a sa propre configuration.
    if (bootedFor !== ctx.profileDataDir()) boot();
    if (!cfg || !cfg.enabled || !engine) return status;
    if (!fs.existsSync(path.join(vaultDir(cfg.folder), 'vault.json'))) {
      status = { ...status, state: 'error', error: 'Le dossier de synchronisation est introuvable (lecteur déconnecté ?).' };
      push(); return status;
    }
    try {
      engine.adapters = adapters();
      engine.deviceName = cfg.deviceName;
      const report = engine.run();
      status = { state: 'ok', lastSync: Date.now(), error: '', report, reason };
    } catch (e) {
      status = { ...status, state: 'error', error: String(e && e.message || e) };
    }
    push();
    return status;
  }
  function schedule(ms) {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; runSync('watch'); }, ms || 3000);
  }
  function startLoops() {
    stopLoops();
    if (!cfg.enabled || !engine) return;
    timer = setInterval(() => runSync('interval'), 60 * 1000);
    if (timer.unref) timer.unref();
    try {
      const dir = path.join(vaultDir(cfg.folder), 'devices');
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: false }, (_e, f) => { if (f && !String(f).startsWith(cfg.deviceId)) schedule(2500); });
      watcher.on('error', () => {});
    } catch {}
  }
  function stopLoops() {
    if (timer) clearInterval(timer); timer = null;
    if (watcher) { try { watcher.close(); } catch {} } watcher = null;
    if (debounce) clearTimeout(debounce); debounce = null;
  }

  function publicState() {
    return {
      enabled: !!cfg.enabled, folder: cfg.folder, deviceId: cfg.deviceId, deviceName: cfg.deviceName,
      collections: Object.entries(COLLECTIONS).map(([k, label]) => ({
        key: k, label, on: cfg.collections[k] !== false,
        available: k === 'passwords' ? !!ctx.module('passwords') : k === 'addresses' ? !!ctx.module('autofill') : true,
      })),
      status, devices: engine ? engine.devices() : [], suggestedFolder: suggestFolder(), sealAvailable: ctx.sealAvailable(),
    };
  }
  function push() {
    for (const t of ctx.tabs) {
      try { if (t.view.webContents.getURL().startsWith('zaalis://home/sync.html')) t.view.webContents.send('zaalis:message', { type: 'syncState', state: publicState() }); } catch {}
    }
  }

  function boot() {
    bootedFor = ctx.profileDataDir();
    loadCfg();
    engine = null; stopLoops();
    if (!cfg.enabled || !cfg.folder) { status = { state: 'off', lastSync: 0, error: '', report: null }; return; }
    const key = loadKey();
    if (!key) { status = { state: 'error', error: 'Clé de synchronisation absente : saisissez de nouveau la phrase secrète.' }; return; }
    engine = makeEngine(key);
    startLoops();
  }

  // ----- Points d'accroche -------------------------------------------------
  ctx.alias('sync', 'sync.html');
  ctx.alias('settings/syncSetup', 'sync.html');
  ctx.on('ready', () => { boot(); runSync('startup'); });
  ctx.on('quit', () => runSync('quit'));
  ctx.on('tabClosed', () => { if (engine) schedule(5000); });

  const opts = { pages: ['sync.html'] };
  ctx.rpc('syncState', () => publicState(), opts);
  ctx.rpc('syncChooseFolder', async () => {
    const r = await electron.dialog.showOpenDialog(ctx.mainWin, {
      title: 'Dossier de synchronisation', properties: ['openDirectory', 'createDirectory'],
      defaultPath: suggestFolder() || os.homedir(),
    });
    return r.canceled ? '' : (r.filePaths[0] || '');
  }, opts);
  ctx.rpc('syncEnable', async (p) => {
    const folder = String(p.folder || '').trim();
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Choisissez un dossier existant.');
    const { key, created } = unlockVault(folder, p.passphrase || '');
    loadCfg();
    cfg.enabled = true; cfg.folder = folder;
    if (p.deviceName) cfg.deviceName = String(p.deviceName).slice(0, 60);
    saveCfg(); storeKey(key);
    boot();
    const st = runSync('enable');
    return { created, ...publicState(), status: st };
  }, opts);
  ctx.rpc('syncNow', () => { runSync('manual'); return publicState(); }, opts);
  ctx.rpc('syncSet', (p) => {
    if (p.deviceName) cfg.deviceName = String(p.deviceName).trim().slice(0, 60) || cfg.deviceName;
    if (p.collections && typeof p.collections === 'object') for (const k of Object.keys(COLLECTIONS)) if (k in p.collections) cfg.collections[k] = !!p.collections[k];
    saveCfg(); runSync('settings');
    return publicState();
  }, opts);
  ctx.rpc('syncDisable', () => {
    stopLoops(); engine = null;
    cfg.enabled = false; saveCfg();
    try { fs.unlinkSync(keyFile()); } catch {}
    status = { state: 'off', lastSync: 0, error: '', report: null };
    return publicState();
  }, opts);
  ctx.rpc('syncErase', () => {
    if (!cfg.folder) throw new Error('Aucun dossier de synchronisation.');
    stopLoops(); engine = null;
    eraseVault(cfg.folder);
    cfg.enabled = false; saveCfg();
    try { fs.unlinkSync(keyFile()); } catch {}
    try { fs.unlinkSync(stateFile()); } catch {}
    status = { state: 'off', lastSync: 0, error: '', report: null };
    return publicState();
  }, opts);
  ctx.rpc('syncOpenTab', (p) => { if (/^https?:\/\//i.test(String(p.url || ''))) ctx.createTab(String(p.url), true); return true; }, opts);

  return { runSync, publicState, boot, vaultExists };
}

module.exports = { init };
