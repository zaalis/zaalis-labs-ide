'use strict';
/* =============================================================================
 *  Extensions Chrome (100 % maison)
 * -----------------------------------------------------------------------------
 *  - Chargement par profil (session persist:zaalis-*), jamais en navigation
 *    privée, via session.extensions.loadExtension (Chromium d'Electron).
 *  - Installation : Chrome Web Store (bouton « Ajouter à zaalis » injecté par
 *    preload-content.js), fichier .crx local, dossier décompressé (mode
 *    développeur). Les .crx sont vérifiés (signatures CRX3/CRX2, identifiant
 *    dérivé de la clé) et décompressés par nos propres lecteurs CRX / ZIP.
 *  - Confirmation des autorisations avant installation, comme Chrome.
 *  - Mises à jour automatiques des extensions du Web Store (protocole update2).
 *  - Barre d'outils : icônes épinglées, menu « puzzle », popups d'action,
 *    badges ; API chrome.* complétées par preload-ext.js + extensions/api.js.
 *  Données : <profil>/extensions/registry.json et <profil>/extensions/<id>/.
 * =========================================================================== */

const { parseCrx, isExtensionId } = require('./extensions/crx');
const { readZip, extractZip } = require('./extensions/zip');
const M = require('./extensions/manifest');
const { createApi } = require('./extensions/api');
const { createDnr, validateRule, applyHeaderOps } = require('./extensions/dnr');

const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1000;
const FIRST_UPDATE_DELAY_MS = 2 * 60 * 1000;
const MAX_CRX_BYTES = 256 * 1024 * 1024;
const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);

function init(ctx) {
  const { app, fs, path, crypto, electron } = ctx;
  const { net, dialog, WebContentsView, nativeImage, Menu, ipcMain } = electron;
  const PRELOAD = path.join(__dirname, 'extensions', 'preload-ext.js');
  const chromeVersion = process.versions.chrome || '150.0.0.0';

  // ----- Profils et registres -------------------------------------------------
  const sessions = new Map();     // partition -> info { ses, partition, dir, exts:Map, workers:Map, ready:Promise }
  function profileDirOf(partition) {
    const m = /^persist:zaalis-profile-(.+)$/.exec(partition);
    return m ? path.join(ctx.dataFolder, 'profiles', m[1]) : ctx.dataFolder;
  }
  const extRoot = (info) => path.join(info.dir, 'extensions');
  const registryFile = (info) => path.join(extRoot(info), 'registry.json');
  function registry(info) {
    if (!info.registry) {
      const r = ctx.readJson(registryFile(info), null) || {};
      info.registry = { devMode: !!r.devMode, list: Array.isArray(r.list) ? r.list.filter(e => e && isExtensionId(e.id)) : [] };
    }
    return info.registry;
  }
  function saveRegistry(info) { ctx.writeJson(registryFile(info), registry(info)); }
  const entryOf = (info, id) => registry(info).list.find(e => e.id === id) || null;
  function currentInfo() {
    const p = ctx.browserPartition();
    if (!sessions.has(p)) ctx.setupSession(p);
    return sessions.get(p) || null;
  }
  const extApi = (ses) => ses.extensions || ses;

  // ----- État des boutons d'action (badge, titre, icône par onglet) ----------
  const actionStates = new Map();   // id -> { global:{}, tabs:Map(wcId -> {}) }
  const actionState = (id) => {
    if (!actionStates.has(id)) actionStates.set(id, { global: {}, tabs: new Map() });
    return actionStates.get(id);
  };
  const menus = new Map();          // partition|id -> Map(menuId -> props)
  const swListeners = new Map();    // partition|id -> Set(eventName)
  const frameSubs = new Map();      // id -> Set(webContents)
  const activeTabGrants = new Map();// id -> Set(origin)

  // Icône 32 px en data: URL (redimensionnée pour garder l'état léger).
  const iconCache = new Map();
  function normalizeIcon(dataUrl) {
    try {
      const img = nativeImage.createFromDataURL(dataUrl);
      if (img.isEmpty()) return null;
      const s = img.getSize();
      return (s.width > 32 || s.height > 32 ? img.resize({ width: 32, height: 32, quality: 'best' }) : img).toDataURL();
    } catch { return null; }
  }
  function iconFromFile(ext, rel) {
    if (!rel) return null;
    const file = path.resolve(ext.path, String(rel).replace(/^\/+/, ''));
    if (!file.startsWith(path.resolve(ext.path) + path.sep)) return null;
    const key = file + '|' + (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);
    if (iconCache.has(key)) return iconCache.get(key);
    let url = null;
    try {
      if (/\.svg$/i.test(file)) url = 'data:image/svg+xml;base64,' + fs.readFileSync(file).toString('base64');
      else {
        const img = nativeImage.createFromPath(file);
        if (!img.isEmpty()) url = (img.getSize().width > 32 ? img.resize({ width: 32, height: 32, quality: 'best' }) : img).toDataURL();
      }
    } catch {}
    iconCache.set(key, url);
    return url;
  }
  function defaultIcon(ext) { return iconFromFile(ext, M.toolbarIconPath(ext.manifest)); }
  function bigIcon(ext) {
    const rel = M.pickIcon(ext.manifest.icons, 48) || M.toolbarIconPath(ext.manifest);
    if (!rel) return null;
    try {
      const file = path.resolve(ext.path, String(rel).replace(/^\/+/, ''));
      if (!file.startsWith(path.resolve(ext.path) + path.sep)) return null;
      if (/\.svg$/i.test(file)) return 'data:image/svg+xml;base64,' + fs.readFileSync(file).toString('base64');
      const img = nativeImage.createFromPath(file);
      return img.isEmpty() ? null : (img.getSize().width > 64 ? img.resize({ width: 64, height: 64, quality: 'best' }) : img).toDataURL();
    } catch { return null; }
  }

  let uiTimer = null;
  function uiChanged() {
    if (uiTimer) return;
    uiTimer = setTimeout(() => { uiTimer = null; ctx.pushState(); notifyPages(); }, 40);
  }
  function notifyPages() {
    for (const t of ctx.tabs) {
      try {
        const wc = t.view.webContents;
        if (!wc.isDestroyed() && wc.getURL().startsWith('zaalis://home/extensions.html')) wc.send('zaalis:message', { type: 'extensions-changed' });
      } catch {}
    }
  }

  // ----- Chargement / déchargement --------------------------------------------
  function readExtInfo(dir) {
    const manifest = M.readManifestDir(dir);
    const loc = M.localizedInfo(manifest, M.dirReader(dir));
    return { manifest, name: loc.name, description: loc.description, version: String(manifest.version || '0') };
  }
  async function loadEntry(info, entry) {
    const api = extApi(info.ses);
    try { if (api.getExtension(entry.id)) api.removeExtension(entry.id); } catch {}
    const loaded = await api.loadExtension(entry.path, { allowFileAccess: false });
    const meta = readExtInfo(entry.path);
    const ext = { id: loaded.id, path: entry.path, manifest: loaded.manifest || meta.manifest, name: meta.name, description: meta.description, version: meta.version, url: loaded.url };
    info.exts.set(ext.id, ext);
    notifyInstalled(info, entry, ext);
    loadDnr(info, ext).catch(e => console.error('[extensions:dnr]', e));
    return ext;
  }
  // runtime.onInstalled : « install » la première fois, « update » quand la
  // version change (mise à jour du Web Store, rechargement d'une extension).
  function notifyInstalled(info, entry, ext) {
    if (entry.notifiedVersion === ext.version) return;
    const details = entry.notifiedVersion ? { reason: 'update', previousVersion: entry.notifiedVersion } : { reason: 'install' };
    entry.notifiedVersion = ext.version;
    saveRegistry(info);
    setTimeout(() => dispatch(info, ext.id, 'runtime.onInstalled', [details], true), 300);
  }
  function unloadExt(info, id) {
    try { extApi(info.ses).removeExtension(id); } catch {}
    info.exts.delete(id);
    menus.delete(info.partition + '|' + id);
    actionStates.delete(id);
    wrRegs.delete(info.partition + '|' + id);
    unloadDnr(info, id);
    if (popup && popup.extId === id) closePopup();
  }
  async function loadAll(info) {
    const reg = registry(info);
    for (const entry of reg.list) {
      if (!entry.enabled) continue;
      if (!fs.existsSync(path.join(entry.path || '', 'manifest.json'))) { entry.enabled = false; entry.disabledReason = 'missing'; continue; }
      try { await loadEntry(info, entry); entry.error = ''; }
      catch (e) { entry.error = String(e && e.message || e); console.error('[extensions] chargement', entry.id, entry.error); }
    }
    saveRegistry(info);
    uiChanged();
  }

  // ----- Sessions (hook) -------------------------------------------------------
  ctx.on('session', (ses, partition) => {
    if (partition === ctx.INCOGNITO_PARTITION || !/^persist:zaalis-/.test(partition) || sessions.has(partition)) return;
    const info = { ses, partition, dir: profileDirOf(partition), exts: new Map(), workers: new Map() };
    sessions.set(partition, info);
    try {
      ses.registerPreloadScript({ type: 'frame', id: 'zaalis-ext-frame', filePath: PRELOAD });
      ses.registerPreloadScript({ type: 'service-worker', id: 'zaalis-ext-sw', filePath: PRELOAD });
    } catch (e) { console.error('[extensions] preload', e.message); }
    try {
      ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
        let w = null;
        try { w = ses.serviceWorkers.getWorkerFromVersionID(versionId); } catch {}
        if (!w) return;
        if (runningStatus === 'starting' || runningStatus === 'running') attachWorker(info, w);
        else if (runningStatus === 'stopped' || runningStatus === 'stopping') detachWorker(info, w);
      });
    } catch (e) { console.error('[extensions] service workers', e.message); }
    info.ready = loadAll(info);
  });

  // Worker arrêté : le prochain démarrage réattache un gestionnaire IPC neuf.
  function detachWorker(info, w) {
    if (!w.__zaalisExt) return;
    w.__zaalisExt = false;
    try { w.ipc.removeHandler('zaalis:ext'); } catch {}
    for (const [id, x] of info.workers) if (x === w) info.workers.delete(id);
  }
  function attachWorker(info, w) {
    if (!w || w.__zaalisExt || (w.isDestroyed && w.isDestroyed())) return;
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(w.scope || '');
    if (!m) return;
    w.__zaalisExt = true;
    const id = m[1];
    info.workers.set(id, w);
    resetWorkerRegs(info, id);
    try {
      try { w.ipc.removeHandler('zaalis:ext'); } catch {}
      w.ipc.handle('zaalis:ext', async (_e, msg) => callApi(info, id, msg, { kind: 'sw', worker: w }));
    } catch (e) { console.error('[extensions] ipc worker', e.message); }
  }

  // ----- IPC des pages d'extension (popups, options, onglets) ----------------
  async function callApi(info, id, msg, src) {
    const ext = info.exts.get(id);
    if (!ext) return { __zxError: 'Extension inconnue ou désactivée' };
    try {
      const value = await api.handle(info, ext, msg && msg.method, msg && msg.args, src);
      return { value: value === undefined ? null : value };
    } catch (e) { return { __zxError: String(e && e.message || e) }; }
  }
  ipcMain.handle('zaalis:ext', async (event, msg) => {
    const frameUrl = (event.senderFrame && event.senderFrame.url) || '';
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(frameUrl);
    if (!m) return { __zxError: 'Contexte non autorisé' };
    const info = [...sessions.values()].find(i => i.ses === event.sender.session);
    if (!info) return { __zxError: 'Session inconnue' };
    return callApi(info, m[1], msg, { kind: 'frame', wc: event.sender });
  });

  // ----- Événements vers les extensions ---------------------------------------
  function noteListener(info, id, name, src) {
    if (src.kind === 'sw') {
      const k = info.partition + '|' + id;
      if (!swListeners.has(k)) swListeners.set(k, new Set());
      swListeners.get(k).add(name);
    } else if (src.wc) noteHello(info, id, src);
  }
  function noteHello(info, id, src) {
    if (src.kind !== 'frame' || !src.wc) return;
    if (!frameSubs.has(id)) frameSubs.set(id, new Set());
    const set = frameSubs.get(id);
    if (!set.has(src.wc)) { set.add(src.wc); src.wc.once('destroyed', () => set.delete(src.wc)); }
  }
  async function dispatch(info, id, name, args, wake) {
    const ext = info.exts.get(id);
    if (!ext) return;
    for (const wc of frameSubs.get(id) || []) {
      try { if (!wc.isDestroyed() && wc.session === info.ses) wc.send('zaalis:ext-event', name, args); } catch {}
    }
    const sw = ext.manifest.background && ext.manifest.background.service_worker;
    if (!sw) return;
    let w = info.workers.get(id);
    if (w && w.isDestroyed && w.isDestroyed()) { info.workers.delete(id); w = null; }
    const listening = (swListeners.get(info.partition + '|' + id) || new Set()).has(name);
    if (!w && (wake || listening)) {
      try {
        w = await info.ses.serviceWorkers.startWorkerForScope('chrome-extension://' + id + '/');
        attachWorker(info, w);
        await new Promise(r => setTimeout(r, 30));
      } catch { return; }   // worker en cours d'arrêt / extension rechargée
    }
    if (!w) return;
    try { w.send('zaalis:ext-event', name, args); } catch {}
  }
  function broadcast(info, name, makeArgs, wake) {
    for (const ext of info.exts.values()) {
      let args;
      try { args = makeArgs(ext); } catch { continue; }
      if (args) dispatch(info, ext.id, name, args, wake);
    }
  }
  const sessionOfTab = (t) => {
    if (!t || t.incognito || !t.view) return null;
    if (!t.__extSession) { try { t.__extSession = t.view.webContents.session; } catch { return null; } }
    return t.__extSession;
  };
  const infoOfTab = (t) => { const ses = sessionOfTab(t); return ses ? [...sessions.values()].find(i => i.ses === ses) || null : null; };

  // Hooks d'onglets -> chrome.tabs.on*
  ctx.on('tabCreated', (tab, wc) => {
    sessionOfTab(tab);
    const info = infoOfTab(tab);
    if (!info) return;
    const wcId = wc.id;
    setTimeout(() => { if (!wc.isDestroyed()) broadcast(info, 'tabs.onCreated', ext => [api.tabInfo(info, ext, tab)]); }, 0);
    const upd = (change) => {
      if (wc.isDestroyed() || !ctx.tabs.includes(tab)) return;
      broadcast(info, 'tabs.onUpdated', (ext) => {
        const ti = api.tabInfo(info, ext, tab);
        const c = Object.assign({}, change);
        if ('url' in c && ti.url == null) delete c.url;
        if ('title' in c && ti.title == null) delete c.title;
        return Object.keys(c).length ? [wcId, c, ti] : null;
      });
    };
    wc.on('did-start-loading', () => upd({ status: 'loading' }));
    wc.on('did-navigate', (_e, u) => { clearGrants(wcId); upd({ status: 'loading', url: u }); });
    wc.on('did-navigate-in-page', (_e, u, isMain) => { if (isMain) upd({ url: u }); });
    wc.on('page-title-updated', (_e, title) => upd({ title }));
    wc.on('did-stop-loading', () => upd({ status: 'complete' }));
    wc.on('audio-state-changed', (e) => upd({ audible: !!(e && e.audible) }));
  });
  ctx.on('tabActivated', (tab) => {
    const info = infoOfTab(tab);
    if (popup) closePopup();
    if (info) broadcast(info, 'tabs.onActivated', () => [{ tabId: tab.view.webContents.id, windowId: (ctx.mainWin && ctx.mainWin.id) || 1 }]);
    uiChanged();
  });
  ctx.on('tabClosed', (tab) => {
    const info = infoOfTab(tab);
    let wcId = -1;
    try { wcId = tab.view.webContents.id; } catch {}
    for (const st of actionStates.values()) st.tabs.delete(wcId);
    clearGrants(wcId);
    if (info) broadcast(info, 'tabs.onRemoved', () => [wcId, { windowId: (ctx.mainWin && ctx.mainWin.id) || 1, isWindowClosing: false }]);
  });

  // ----- activeTab : accès temporaire après un geste de l'utilisateur ---------
  const grantKey = (id) => id;
  function grantActiveTab(extId, tab) {
    if (!tab) return;
    const ext = [...sessions.values()].map(i => i.exts.get(extId)).find(Boolean);
    if (!ext || !M.apiPermissions(ext.manifest).includes('activeTab')) return;
    const origin = ctx.originOf(tab.view.webContents.getURL());
    if (!origin) return;
    if (!activeTabGrants.has(grantKey(extId))) activeTabGrants.set(grantKey(extId), new Map());
    activeTabGrants.get(grantKey(extId)).set(tab.view.webContents.id, origin);
  }
  function clearGrants(wcId) { for (const m of activeTabGrants.values()) m.delete(wcId); }
  function hasActiveTabGrant(extId, url) {
    const m = activeTabGrants.get(grantKey(extId));
    if (!m) return false;
    const origin = ctx.originOf(url);
    for (const o of m.values()) if (o === origin) return true;
    return false;
  }

  // ----- Popups d'action ------------------------------------------------------
  let popup = null;   // { view, extId, info, closedAt }
  let lastClosed = { id: '', at: 0 };
  function closePopup() {
    if (!popup) return;
    const p = popup; popup = null;
    lastClosed = { id: p.extId, at: Date.now() };
    try { ctx.mainWin && ctx.mainWin.contentView.removeChildView(p.view); } catch {}
    try { if (!p.view.webContents.isDestroyed()) p.view.webContents.close(); } catch {}
    uiChanged();
  }
  function openPopup(info, ext, popupUrl, anchor) {
    closePopup();
    if (!ctx.mainWin) return false;
    const view = new WebContentsView({
      webPreferences: { partition: info.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, enablePreferredSizeMode: true },
    });
    view.setBackgroundColor('#ffffff');
    const p = { view, extId: ext.id, info, anchor: anchor || null, shown: false };
    popup = p;
    const wc = view.webContents;
    const [winW, winH] = ctx.mainWin.getContentSize();
    const place = (w, h) => {
      if (popup !== p) return;
      w = Math.max(25, Math.min(800, Math.ceil(w || 0))); h = Math.max(25, Math.min(600, Math.ceil(h || 0)));
      const right = anchor && anchor.right ? anchor.right : winW - 12;
      const top = anchor && anchor.bottom ? anchor.bottom + 4 : (ctx.contentTop || 95);
      const x = Math.max(4, Math.min(winW - w - 4, Math.round(right - w)));
      view.setBounds({ x, y: Math.round(top), width: w, height: Math.min(h, Math.max(25, winH - top - 8)) });
      if (!p.shown) { p.shown = true; view.setVisible(true); try { wc.focus(); } catch {} }
    };
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    ctx.mainWin.contentView.addChildView(view);
    wc.on('preferred-size-changed', (_e, size) => place(size.width, size.height));
    wc.on('did-finish-load', () => {
      setTimeout(() => {
        if (popup !== p || wc.isDestroyed()) return;
        wc.executeJavaScript('(() => { const d = document.documentElement, b = document.body; return [Math.max(d.scrollWidth, b ? b.scrollWidth : 0), Math.max(d.scrollHeight, b ? b.scrollHeight : 0)]; })()', true)
          .then(([w, h]) => { const b = p.shown ? view.getBounds() : { width: 0, height: 0 }; place(Math.max(w, b.width), Math.max(h, b.height)); })
          .catch(() => { if (!p.shown) place(300, 200); });
      }, 120);
    });
    wc.on('blur', () => setTimeout(() => { if (popup === p && !wc.isDestroyed() && !wc.isFocused() && !wc.isDevToolsOpened()) closePopup(); }, 80));
    wc.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') closePopup(); });
    wc.on('destroyed', () => { if (popup === p) { popup = null; uiChanged(); } });
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:|^chrome-extension:/i.test(url)) ctx.createTab(url, true, {}); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (!url.startsWith('chrome-extension://' + ext.id + '/')) { e.preventDefault(); if (/^https?:/i.test(url)) ctx.createTab(url, true, {}); } });
    wc.on('context-menu', (_e, params) => {
      Menu.buildFromTemplate([
        ...(params.isEditable ? [{ role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' }, { type: 'separator' }] : (params.selectionText ? [{ role: 'copy', label: 'Copier' }, { type: 'separator' }] : [])),
        { label: 'Inspecter la fenêtre pop-up', click: () => wc.openDevTools({ mode: 'detach' }) },
      ]).popup({ window: ctx.mainWin });
    });
    wc.loadURL(popupUrl).catch(() => {});
    uiChanged();
    return true;
  }
  function popupFor(ext, tabWcId) {
    const st = actionState(ext.id);
    const tab = tabWcId != null ? st.tabs.get(tabWcId) : null;
    const p = tab && 'popup' in tab ? tab.popup : ('popup' in st.global ? st.global.popup : ((M.actionOf(ext.manifest) || {}).default_popup || ''));
    return p ? new URL(String(p), 'chrome-extension://' + ext.id + '/').toString() : '';
  }
  // Clic sur l'icône d'une extension (barre d'outils ou menu puzzle).
  function activateAction(id, anchor) {
    const info = currentInfo();
    const ext = info && info.exts.get(id);
    if (!ext) return false;
    if (popup && popup.extId === id) { closePopup(); return true; }
    if (lastClosed.id === id && Date.now() - lastClosed.at < 300) return true;   // le clic a fermé le popup
    const tab = ctx.activeTab();
    const wcId = tab && !tab.incognito ? tab.view.webContents.id : null;
    const st = actionState(id);
    const enabled = (wcId != null && st.tabs.get(wcId) && 'enabled' in st.tabs.get(wcId)) ? st.tabs.get(wcId).enabled : st.global.enabled;
    if (enabled === false) return false;
    if (tab && !tab.incognito) grantActiveTab(id, tab);
    const url = popupFor(ext, wcId);
    if (url) return openPopup(info, ext, url, anchor);
    if (tab && !tab.incognito && tab.view.webContents.session === info.ses) {
      dispatch(info, id, 'action.onClicked', [api.tabInfo(info, ext, tab)], true);
      return true;
    }
    return false;
  }
  function openPopupForActive(info, ext) {
    const tab = ctx.activeTab();
    const url = popupFor(ext, tab ? tab.view.webContents.id : null);
    if (!url) throw new Error('Cette extension n\'a pas de popup.');
    const anchor = toolbarAnchors.get(ext.id) || null;
    openPopup(info, ext, url, anchor);
  }
  function windowClose(info, ext, src) {
    if (src.kind !== 'frame' || !src.wc) return false;
    if (popup && popup.view.webContents === src.wc) { closePopup(); return true; }
    const t = ctx.tabOfWebContents(src.wc);
    if (t) { ctx.closeTab(t.id); return true; }
    return false;
  }

  const RESOURCE_TYPES = { mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font',
    object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other' };

  // ----- declarativeNetRequest (moteur maison, extensions/dnr.js) ------------
  // Le DNR natif est court-circuité par Electron dès qu'une écoute
  // ses.webRequest existe (Client Hints…) : zaalis applique les règles.
  const MAX_DYNAMIC = 30000, MAX_SESSION = 5000, STATIC_LIMIT = 330000;
  const dnrFile = (info, id) => path.join(extRoot(info), 'dnr', id + '.json');
  const ruleResources = (ext) => {
    const rr = ext.manifest.declarative_net_request && ext.manifest.declarative_net_request.rule_resources;
    return Array.isArray(rr) ? rr.filter(r => r && r.id != null && r.path) : [];
  };
  const engineOf = (info) => info.dnr || (info.dnr = createDnr());
  const dnrState = new Map();    // partition|id -> { enabled:[], dynamic:[], disabledStatic:{rid:[ids]} }
  async function readRuleset(ext, res) {
    const file = path.resolve(ext.path, String(res.path).replace(/^\/+/, ''));
    if (!file.startsWith(path.resolve(ext.path) + path.sep)) return [];
    try {
      const list = M.parseJsonLoose(await fs.promises.readFile(file, 'utf8'));
      return Array.isArray(list) ? list.filter(r => { try { validateRule(r); return true; } catch { return false; } }) : [];
    } catch (e) { console.error('[extensions:dnr] ruleset', res.id, e.message); return []; }
  }
  async function loadDnr(info, ext) {
    const resources = ruleResources(ext);
    const key = info.partition + '|' + ext.id;
    const saved = ctx.readJson(dnrFile(info, ext.id), null) || {};
    const st = {
      enabled: Array.isArray(saved.enabled) ? saved.enabled.map(String) : resources.filter(r => r.enabled).map(r => String(r.id)),
      dynamic: Array.isArray(saved.dynamic) ? saved.dynamic : [],
      disabledStatic: saved.disabledStatic && typeof saved.disabledStatic === 'object' ? saved.disabledStatic : {},
      options: saved.options || {},
    };
    if (!resources.length && !st.dynamic.length && !M.apiPermissions(ext.manifest).some(p => /^declarativeNetRequest/.test(p))) return;
    dnrState.set(key, st);
    const rulesets = new Map();
    for (const res of resources) if (st.enabled.includes(String(res.id))) rulesets.set(String(res.id), await readRuleset(ext, res));
    if (!info.exts.has(ext.id)) return;   // déchargée entre-temps
    const prev = engineOf(info).get(ext.id);
    engineOf(info).setExtension(ext.id, {
      rulesets, enabled: st.enabled, dynamic: st.dynamic, options: st.options,
      session: prev ? prev.session : [],
      disabledStatic: new Map(Object.entries(st.disabledStatic).map(([k, v]) => [k, new Set(v)])),
    });
    hookDnr();
    (info.dnrDone = info.dnrDone || new Set()).add(ext.id);
    const r = info.dnrReady && info.dnrReady.get(ext.id);
    if (r) { info.dnrReady.delete(ext.id); r(); }
  }
  function saveDnr(info, id) {
    const st = dnrState.get(info.partition + '|' + id);
    if (st) ctx.writeJson(dnrFile(info, id), st);
  }
  function whenDnrReady(info, id, ms) {
    return new Promise((resolve) => {
      if (info.dnrDone && info.dnrDone.has(id)) { resolve(true); return; }
      const t = setTimeout(() => resolve(false), ms || 8000);
      (info.dnrReady = info.dnrReady || new Map()).set(id, () => { clearTimeout(t); resolve(true); });
    });
  }
  function unloadDnr(info, id) {
    if (info.dnr) info.dnr.removeExtension(id);
    if (info.dnrDone) info.dnrDone.delete(id);
  }

  // Requêtes -> moteur DNR (répartiteur webRequest partagé).
  const dnrPending = new Map();   // requestId -> résultat (modifyHeaders)
  let dnrHooked = false;
  function requestContext(d) {
    let ses = null, tabId = -1, tabUrl = '';
    const t = d.webContentsId != null ? ctx.tabs.find(x => { try { return x.view.webContents.id === d.webContentsId; } catch { return false; } }) : null;
    if (t) { if (t.incognito) return null; tabId = d.webContentsId; ses = sessionOfTab(t); try { tabUrl = t.view.webContents.getURL(); } catch {} }
    else if (d.webContents && !d.webContents.isDestroyed()) { ses = d.webContents.session; try { tabUrl = d.webContents.getURL(); } catch {} }
    if (!ses) return null;
    const info = [...sessions.values()].find(i => i.ses === ses);
    if (!info || !info.dnr || !info.dnr.exts.size) return null;
    const type = RESOURCE_TYPES[d.resourceType] || 'other';
    let initiator = d.referrer ? ctx.originOf(d.referrer) : '';
    if (!initiator && type !== 'main_frame' && /^https?:/.test(tabUrl)) initiator = ctx.originOf(tabUrl);
    return { info, req: { url: d.url, method: d.method, type, tabId, initiator } };
  }
  function hookDnr() {
    if (dnrHooked) return;
    const wr = ctx.module('webrequest');
    if (!wr) { console.error('[extensions:dnr] répartiteur webRequest absent'); return; }
    dnrHooked = true;
    wr.onBeforeRequest((d) => {
      const c = requestContext(d);
      if (!c) return undefined;
      let res = null;
      try { res = c.info.dnr.match(c.req); } catch (e) { console.error('[extensions:dnr]', e); return undefined; }
      if (c.req.type === 'main_frame') resetBadgeCounts(c.info, c.req.tabId);
      if (!res) return undefined;
      noteMatches(c.info, c.req, res);
      if (res.requestHeaders.length || res.responseHeaders.length) {
        dnrPending.set(d.id, res);
        if (dnrPending.size > 4000) dnrPending.delete(dnrPending.keys().next().value);
      }
      if (res.action === 'block') return { cancel: true };
      if (res.action === 'redirect' && res.redirectUrl) return { redirectURL: res.redirectUrl };
      return undefined;
    });
    wr.onBeforeSendHeaders((d, headers) => {
      const res = dnrPending.get(d.id);
      if (!res || !res.requestHeaders.length) return undefined;
      return applyHeaderOps(headers, res.requestHeaders, false) ? true : undefined;
    });
    wr.onHeadersReceived((d, headers) => {
      const res = dnrPending.get(d.id);
      if (!res) return undefined;
      dnrPending.delete(d.id);
      if (!res.responseHeaders.length) return undefined;
      return applyHeaderOps(headers, res.responseHeaders, true) ? true : undefined;
    });
    if (wr.onErrorOccurred) wr.onErrorOccurred((d) => { dnrPending.delete(d.id); });
  }
  // getMatchedRules + compteur d'actions en badge (setExtensionActionOptions).
  function noteMatches(info, req, res) {
    const now = Date.now();
    for (const m of res.matched) {
      const e = info.dnr.get(m.extId);
      if (!e) continue;
      e.matched.push({ rule: { ruleId: m.ruleId, rulesetId: m.rulesetId }, tabId: req.tabId, timeStamp: now });
      if (e.matched.length > 1000) e.matched.splice(0, e.matched.length - 1000);
      if ((m.action === 'block' || m.action === 'redirect' || m.action === 'upgradeScheme') && e.options && e.options.displayActionCountAsBadgeText && req.tabId >= 0) {
        e.counts = e.counts || new Map();
        const n = (e.counts.get(req.tabId) || 0) + 1;
        e.counts.set(req.tabId, n);
        const st = actionState(m.extId);
        if (!st.tabs.has(req.tabId)) st.tabs.set(req.tabId, {});
        st.tabs.get(req.tabId).badgeText = String(n > 999 ? '999+' : n);
        uiChanged();
      }
    }
  }
  function resetBadgeCounts(info, tabId) {
    if (tabId < 0 || !info.dnr) return;
    info.dnr.clearTab(tabId);
    for (const [id, e] of info.dnr.exts) {
      if (e.counts && e.counts.delete(tabId) && e.options && e.options.displayActionCountAsBadgeText) {
        const t = actionState(id).tabs.get(tabId);
        if (t) delete t.badgeText;
      }
    }
  }
  // API chrome.declarativeNetRequest (appelée par le shim).
  async function dnrCall(info, ext, fn, args) {
    const key = info.partition + '|' + ext.id;
    if (!dnrState.has(key)) { dnrState.set(key, { enabled: [], dynamic: [], disabledStatic: {}, options: {} }); }
    const st = dnrState.get(key);
    const eng = engineOf(info);
    if (!eng.get(ext.id)) eng.setExtension(ext.id, { rulesets: new Map(), enabled: [], dynamic: st.dynamic });
    const e = eng.get(ext.id);
    const a = args[0] || {};
    const filterIds = (list) => (Array.isArray(a.ruleIds) ? list.filter(r => a.ruleIds.includes(r.id)) : list);
    const update = (list, max) => {
      const remove = new Set(a.removeRuleIds || []);
      const next = list.filter(r => !remove.has(r.id));
      for (const r of a.addRules || []) {
        validateRule(r);
        if (next.some(x => x.id === r.id)) throw new Error('Rule with id ' + r.id + ' does not have a unique ID.');
        next.push(JSON.parse(JSON.stringify(r)));
      }
      if (next.length > max) throw new Error('Dynamic rule count exceeded.');
      return next;
    };
    switch (fn) {
      case 'updateDynamicRules': st.dynamic = update(st.dynamic, MAX_DYNAMIC); e.dynamic = st.dynamic; eng.rebuild(e); saveDnr(info, ext.id); hookDnr(); return;
      case 'getDynamicRules': return filterIds(st.dynamic);
      case 'updateSessionRules': e.session = update(e.session, MAX_SESSION); eng.rebuild(e); hookDnr(); return;
      case 'getSessionRules': return filterIds(e.session);
      case 'getEnabledRulesets': return st.enabled.slice();
      case 'updateEnabledRulesets': {
        const resources = ruleResources(ext);
        const known = new Set(resources.map(r => String(r.id)));
        for (const id of [...(a.enableRulesetIds || []), ...(a.disableRulesetIds || [])]) if (!known.has(String(id))) throw new Error('Invalid ruleset id: ' + id + '.');
        const enabled = new Set(st.enabled);
        for (const id of a.disableRulesetIds || []) enabled.delete(String(id));
        for (const id of a.enableRulesetIds || []) enabled.add(String(id));
        st.enabled = [...enabled];
        for (const id of st.enabled) if (!e.rulesets.has(id)) e.rulesets.set(id, await readRuleset(ext, resources.find(r => String(r.id) === id)));
        e.enabled = new Set(st.enabled);
        eng.rebuild(e); saveDnr(info, ext.id); hookDnr();
        return;
      }
      case 'updateStaticRules': {
        const rid = String(a.rulesetId || '');
        const set = new Set(st.disabledStatic[rid] || []);
        for (const id of a.disableRuleIds || []) set.add(id);
        for (const id of a.enableRuleIds || []) set.delete(id);
        st.disabledStatic[rid] = [...set];
        e.disabledStatic.set(rid, set);
        eng.rebuild(e); saveDnr(info, ext.id);
        return;
      }
      case 'getDisabledRuleIds': return (st.disabledStatic[String(a.rulesetId || '')] || []).slice();
      case 'getAvailableStaticRuleCount': {
        let n = 0; for (const id of st.enabled) n += (e.rulesets.get(id) || []).length;
        return Math.max(0, STATIC_LIMIT - n);
      }
      case 'isRegexSupported': try { new RegExp(String(a.regex || '')); return { isSupported: true }; } catch { return { isSupported: false, reason: 'syntaxError' }; }
      case 'testMatchOutcome': {
        const res = eng.match({ url: a.url, method: a.method || 'get', type: a.type || 'other', tabId: a.tabId == null ? -1 : a.tabId, initiator: a.initiator || '' }, ext.id);
        return { matchedRules: res ? res.matched.map(m => ({ ruleId: m.ruleId, rulesetId: m.rulesetId })) : [] };
      }
      case 'getMatchedRules': {
        if (!M.apiPermissions(ext.manifest).some(p => p === 'declarativeNetRequestFeedback' || p === 'activeTab')) throw new Error('L\'autorisation « declarativeNetRequestFeedback » est requise.');
        const min = a.minTimeStamp || 0;
        return { rulesMatchedInfo: e.matched.filter(m => m.timeStamp >= min && (a.tabId == null || m.tabId === a.tabId)) };
      }
      case 'setExtensionActionOptions': {
        if (a.displayActionCountAsBadgeText != null) { e.options = Object.assign({}, e.options, { displayActionCountAsBadgeText: !!a.displayActionCountAsBadgeText }); st.options = e.options; saveDnr(info, ext.id); }
        if (a.tabUpdate && Number.isInteger(a.tabUpdate.tabId)) {
          e.counts = e.counts || new Map();
          const n = Math.max(0, (e.counts.get(a.tabUpdate.tabId) || 0) + (a.tabUpdate.increment | 0));
          e.counts.set(a.tabUpdate.tabId, n);
          const t = actionState(ext.id); if (!t.tabs.has(a.tabUpdate.tabId)) t.tabs.set(a.tabUpdate.tabId, {});
          t.tabs.get(a.tabUpdate.tabId).badgeText = n ? String(n) : '';
          uiChanged();
        }
        return;
      }
      default: throw new Error('API non prise en charge : chrome.declarativeNetRequest.' + fn);
    }
  }

  // ----- chrome.webRequest (observation, relayée par zaalis) -----------------
  // Electron n'émet pas ces événements vers les extensions : on les observe
  // via le répartiteur webRequest partagé (src/features/webrequest.js) et on
  // les relaie aux écoutes enregistrées par le shim. Non bloquant (comme
  // webRequest en Manifest V3) ; le blocage passe par declarativeNetRequest.
  const wrRegs = new Map();     // partition|id -> Map(listenerId -> { event, filter, extra, src })
  let wrHooked = false;
  function hookWebRequest() {
    if (wrHooked) return;
    const wr = ctx.module('webrequest');
    if (!wr) return;
    wrHooked = true;
    const relay = (event) => (details, headers) => { try { relayWebRequest(event, details, headers); } catch (e) { console.error('[extensions:webRequest]', e); } return undefined; };
    wr.onBeforeRequest(relay('onBeforeRequest'));
    wr.onBeforeSendHeaders(relay('onBeforeSendHeaders'));
    wr.onHeadersReceived(relay('onHeadersReceived'));
    if (wr.onCompleted) {
      wr.onSendHeaders(relay('onSendHeaders'));
      wr.onResponseStarted(relay('onResponseStarted'));
      wr.onBeforeRedirect(relay('onBeforeRedirect'));
      wr.onCompleted(relay('onCompleted'));
      wr.onErrorOccurred(relay('onErrorOccurred'));
    }
  }
  const headerArray = (h) => Object.keys(h || {}).flatMap(name => [].concat(h[name]).map(value => ({ name, value: String(value) })));
  function relayWebRequest(event, d, headers) {
    if (!wrRegs.size) return;
    let wcSes = null, tabId = -1;
    const t = d.webContentsId != null ? ctx.tabs.find(x => { try { return x.view.webContents.id === d.webContentsId; } catch { return false; } }) : null;
    if (t) { if (t.incognito) return; tabId = d.webContentsId; wcSes = sessionOfTab(t); }
    else if (d.webContents && !d.webContents.isDestroyed()) wcSes = d.webContents.session;
    if (!wcSes) return;
    const info = [...sessions.values()].find(i => i.ses === wcSes);
    if (!info) return;
    const type = RESOURCE_TYPES[d.resourceType] || 'other';
    for (const [key, regs] of wrRegs) {
      if (!key.startsWith(info.partition + '|') || !regs.size) continue;
      const id = key.slice(info.partition.length + 1);
      const ext = info.exts.get(id);
      if (!ext) continue;
      if (!M.hostPatterns(ext.manifest).some(p => M.matchPattern(p, d.url))) continue;
      for (const [lid, r] of regs) {
        if (r.event !== event) continue;
        const f = r.filter || {};
        if (Array.isArray(f.urls) && f.urls.length && !f.urls.some(p => M.matchPattern(p, d.url))) continue;
        if (Array.isArray(f.types) && f.types.length && !f.types.includes(type)) continue;
        if (f.tabId != null && f.tabId !== tabId) continue;
        const out = {
          requestId: String(d.id), url: d.url, method: d.method, type, tabId, frameId: type === 'main_frame' ? 0 : -1, parentFrameId: -1,
          timeStamp: d.timestamp || Date.now(), documentLifecycle: 'active', frameType: 'outermost_frame',
        };
        if (d.referrer) { const o = ctx.originOf(d.referrer); if (o) out.initiator = o; }
        if (d.statusCode != null) { out.statusCode = d.statusCode; out.statusLine = d.statusLine || ''; }
        if (d.fromCache != null) out.fromCache = !!d.fromCache;
        if (d.ip) out.ip = d.ip;
        if (d.error) out.error = d.error;
        if (d.redirectURL) out.redirectUrl = d.redirectURL;
        const extra = r.extra || [];
        if (extra.includes('requestHeaders')) out.requestHeaders = headerArray(headers || d.requestHeaders);
        if (extra.includes('responseHeaders')) out.responseHeaders = headerArray(headers || d.responseHeaders);
        sendToSource(info, ext, r.src, 'webRequest.' + event, [lid, out]);
      }
    }
  }
  function sendToSource(info, ext, src, name, args) {
    if (src.kind === 'frame') { try { if (!src.wc.isDestroyed()) src.wc.send('zaalis:ext-event', name, args); } catch {} return; }
    let w = info.workers.get(ext.id);
    if (w && w.isDestroyed && w.isDestroyed()) w = null;
    if (w) { try { w.send('zaalis:ext-event', name, args); } catch {} return; }
    // Service worker arrêté : réveillé ; il réenregistre ses écoutes de premier niveau.
    info.ses.serviceWorkers.startWorkerForScope('chrome-extension://' + ext.id + '/').then((nw) => { attachWorker(info, nw); }).catch(() => {});
  }
  function wrAdd(info, ext, src, args) {
    const [event, lid, filter, extra] = args;
    if (!M.apiPermissions(ext.manifest).includes('webRequest')) throw new Error('L\'autorisation « webRequest » est requise.');
    const key = info.partition + '|' + ext.id;
    if (!wrRegs.has(key)) wrRegs.set(key, new Map());
    const regs = wrRegs.get(key);
    regs.set(String(lid), { event: String(event), filter: filter || {}, extra: Array.isArray(extra) ? extra : [], src: src.kind === 'frame' ? { kind: 'frame', wc: src.wc } : { kind: 'sw' } });
    if (src.kind === 'frame' && src.wc) src.wc.once('destroyed', () => regs.delete(String(lid)));
    hookWebRequest();
  }
  function wrRemove(info, ext, lid) { const regs = wrRegs.get(info.partition + '|' + ext.id); if (regs) regs.delete(String(lid)); }
  // Nouveau service worker : ses écoutes de premier niveau vont être réenregistrées.
  function resetWorkerRegs(info, id) {
    const regs = wrRegs.get(info.partition + '|' + id);
    if (regs) for (const [k, r] of regs) if (r.src.kind === 'sw') regs.delete(k);
  }

  // ----- API chrome.* ---------------------------------------------------------
  const core = {
    dnrCall, wrAdd, wrRemove,
    ctx, menus, actionState, uiChanged, normalizeIcon, iconFromFile, hasActiveTabGrant,
    entry: (info, id) => entryOf(info, id),
    openPopupForActive, windowClose, noteListener, noteHello,
  };
  const api = createApi(core);

  // ----- Menus contextuels des pages -------------------------------------------
  ctx.on('contextMenu', (items, tab, params, sep) => {
    const info = infoOfTab(tab);
    if (!info) return;
    const pageUrl = tab.view.webContents.getURL();
    const present = new Set(['all']);
    if (params.linkURL) present.add('link');
    if (params.selectionText) present.add('selection');
    if (params.isEditable) present.add('editable');
    if (params.mediaType === 'image') present.add('image');
    if (params.mediaType === 'video') present.add('video');
    if (params.mediaType === 'audio') present.add('audio');
    if (params.frameURL) present.add('frame');
    if (present.size === 1 || (present.size === 2 && present.has('frame'))) present.add('page');
    const target = params.linkURL || params.srcURL || '';
    const visibleItem = (it) => it.visible !== false &&
      (it.contexts || ['page']).some(c => present.has(c)) &&
      (!it.documentUrlPatterns || it.documentUrlPatterns.some(p => M.matchPattern(p, pageUrl))) &&
      (!it.targetUrlPatterns || !target || it.targetUrlPatterns.some(p => M.matchPattern(p, target)));
    const groups = [];
    for (const ext of info.exts.values()) {
      const map = menus.get(info.partition + '|' + ext.id);
      if (!map || !map.size) continue;
      const all = [...map.values()];
      const build = (parentId) => all.filter(it => (it.parentId == null ? null : it.parentId) === parentId && visibleItem(it)).map((it) => {
        if (it.type === 'separator') return { type: 'separator' };
        const title = String(it.title || '').replace(/%s/g, String(params.selectionText || '').slice(0, 40));
        const kids = build(it.id);
        const mi = { label: title.replace(/&/g, '&&'), enabled: it.enabled !== false };
        if (kids.length) mi.submenu = kids;
        else {
          if (it.type === 'checkbox' || it.type === 'radio') { mi.type = it.type; mi.checked = !!it.checked; }
          mi.click = () => {
            const was = !!it.checked;
            if (it.type === 'checkbox') it.checked = !was;
            if (it.type === 'radio') { for (const o of all) if (o.type === 'radio' && o.parentId === it.parentId) o.checked = false; it.checked = true; }
            grantActiveTab(ext.id, tab);
            const clickInfo = {
              menuItemId: it.id, editable: !!params.isEditable, pageUrl, frameId: 0,
              ...(it.parentId != null ? { parentMenuItemId: it.parentId } : {}),
              ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
              ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
              ...(params.frameURL ? { frameUrl: params.frameURL } : {}),
              ...(params.selectionText ? { selectionText: params.selectionText } : {}),
              ...(params.mediaType && params.mediaType !== 'none' ? { mediaType: params.mediaType } : {}),
              ...(it.type === 'checkbox' || it.type === 'radio' ? { wasChecked: was, checked: !!it.checked } : {}),
            };
            dispatch(info, ext.id, 'contextMenus.onClicked', [clickInfo, api.tabInfo(info, ext, tab)], true);
          };
        }
        return mi;
      });
      const top = build(null).filter(x => x.type !== 'separator' || true);
      if (!top.length) continue;
      const icon = defaultIcon(ext);
      let img;
      try { img = icon ? nativeImage.createFromDataURL(icon).resize({ width: 16, height: 16 }) : undefined; } catch {}
      if (top.length === 1 && top[0].type !== 'separator') groups.push(Object.assign(top[0], img ? { icon: img } : {}));
      else groups.push({ label: ext.name.replace(/&/g, '&&'), submenu: top, ...(img ? { icon: img } : {}) });
    }
    if (!groups.length) return;
    // Comme Chrome : juste avant « Inspecter » / à la fin des actions de page.
    const at = items.findIndex(i => i && i.label === 'Inspecter');
    const block = [{ type: 'separator' }, ...groups, { type: 'separator' }];
    if (at > 0) items.splice(at, 0, ...block); else { sep(); items.push(...groups); }
  });

  // ----- Installation ---------------------------------------------------------
  function zipManifest(files) {
    const buf = files.get('manifest.json');
    if (!buf) throw new Error('manifest.json absent du paquet');
    const manifest = M.parseJsonLoose(buf.toString('utf8'));
    const loc = M.localizedInfo(manifest, (rel) => files.get(rel) || null);
    return { manifest, name: loc.name, description: loc.description, version: String(manifest.version || '0') };
  }
  async function confirmInstall(name, warnings, verb) {
    if (!ctx.mainWin) return true;
    const detail = warnings.length ? 'Elle pourra :\n\n' + warnings.map(w => '•  ' + w).join('\n') : 'Elle ne demande aucune autorisation particulière.';
    const r = await dialog.showMessageBox(ctx.mainWin, {
      type: 'question', buttons: [verb || 'Ajouter l\'extension', 'Annuler'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'zaalis Browser', message: 'Ajouter « ' + name + ' » ?', detail,
    });
    return r.response === 0;
  }
  function removeDirSafe(p, root) {
    const abs = path.resolve(p);
    if (!abs.startsWith(path.resolve(root) + path.sep)) return;
    // Windows garde parfois les fichiers verrouillés juste après le déchargement.
    const rm = () => { try { fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {} return !fs.existsSync(abs); };
    if (!rm()) { let n = 0; const t = setInterval(() => { if (rm() || ++n > 20) clearInterval(t); }, 500); if (t.unref) t.unref(); }
  }
  // Installe (ou met à jour) un paquet CRX déjà vérifié.
  async function installParsedCrx(info, parsed, source, opts) {
    opts = opts || {};
    const files = readZip(parsed.zip);
    const meta = zipManifest(files);
    const old = entryOf(info, parsed.id);
    const warnings = M.permissionWarnings(meta.manifest);
    if (opts.confirm !== false) {
      const ok = await confirmInstall(meta.name, warnings, old ? 'Mettre à jour' : 'Ajouter l\'extension');
      if (!ok) return null;
    }
    const base = path.join(extRoot(info), parsed.id);
    const dir = path.join(base, meta.version.replace(/[^0-9a-zA-Z._-]/g, '_') + '_' + crypto.randomBytes(3).toString('hex'));
    extractZip(parsed.zip, dir);
    // La clé publique du paquet garde l'identifiant officiel (Chrome fait de même).
    const mf = M.readManifestDir(dir);
    mf.key = parsed.publicKey.toString('base64');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
    const entry = old || { id: parsed.id, installedAt: Date.now(), pinned: false };
    const prevPath = old && old.path;
    Object.assign(entry, { path: dir, source, enabled: true, version: meta.version, name: meta.name, updatedAt: Date.now(), disabledReason: '', error: '', warnings, pending: null });
    if (!old) registry(info).list.push(entry);
    try {
      const ext = await loadEntry(info, entry);
      if (ext.id !== parsed.id) { unloadExt(info, ext.id); throw new Error('identifiant inattendu après chargement'); }
    } catch (e) {
      if (!old) registry(info).list = registry(info).list.filter(x => x !== entry);
      else if (prevPath) { entry.path = prevPath; try { await loadEntry(info, entry); } catch {} }
      removeDirSafe(dir, extRoot(info));
      saveRegistry(info);
      throw e;
    }
    saveRegistry(info);
    // Anciennes versions supprimées.
    try { for (const d of fs.readdirSync(base)) if (path.join(base, d) !== dir) removeDirSafe(path.join(base, d), extRoot(info)); } catch {}
    uiChanged();
    return entry;
  }
  async function downloadCrx(urlStr) {
    const res = await net.fetch(urlStr, { redirect: 'follow', cache: 'no-store', headers: { 'user-agent': ctx.chromeUserAgent() } });
    if (!res.ok) throw new Error('Téléchargement impossible (HTTP ' + res.status + ')');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_CRX_BYTES) throw new Error('Extension trop volumineuse');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_CRX_BYTES) throw new Error('Extension trop volumineuse');
    return buf;
  }
  const storeCrxUrl = (id) => 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=' + chromeVersion +
    '&acceptformat=crx2,crx3&x=' + encodeURIComponent('id=' + id + '&uc');
  async function installFromStore(id) {
    if (!isExtensionId(id)) throw new Error('Identifiant d\'extension invalide');
    const info = currentInfo();
    if (!info) throw new Error('Profil indisponible');
    ctx.toast('Téléchargement de l\'extension…');
    const parsed = parseCrx(await downloadCrx(storeCrxUrl(id)), id);
    const entry = await installParsedCrx(info, parsed, 'store');
    if (entry) {
      entry.pinned = entry.pinned || registry(info).list.filter(e => e.pinned).length < 4;
      saveRegistry(info); uiChanged();
      ctx.toast('« ' + entry.name + ' » a été ajoutée à zaalis Browser.');
    }
    return entry;
  }
  async function installCrxFile(file) {
    const info = currentInfo();
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_CRX_BYTES) throw new Error('Fichier trop volumineux');
    const parsed = parseCrx(buf);
    const entry = await installParsedCrx(info, parsed, 'crx');
    if (entry) ctx.toast('« ' + entry.name + ' » a été ajoutée à zaalis Browser.');
    return entry;
  }
  async function loadUnpacked(dir) {
    const info = currentInfo();
    const meta = readExtInfo(dir);   // vérifie manifest.json
    const existing = registry(info).list.find(e => e.source === 'unpacked' && path.resolve(e.path) === path.resolve(dir));
    const entry = existing || { installedAt: Date.now(), pinned: true };
    Object.assign(entry, { path: dir, source: 'unpacked', enabled: true, version: meta.version, name: meta.name, updatedAt: Date.now(), error: '', disabledReason: '', warnings: M.permissionWarnings(meta.manifest) });
    const ext = await extApi(info.ses).loadExtension(dir, { allowFileAccess: false });
    if (existing && existing.id !== ext.id) unloadExt(info, existing.id);
    entry.id = ext.id;
    const other = entryOf(info, ext.id);
    if (other && other !== entry) {
      if (other.source !== 'unpacked') { try { extApi(info.ses).removeExtension(ext.id); } catch {} throw new Error('Une extension avec le même identifiant est déjà installée.'); }
      registry(info).list = registry(info).list.filter(x => x !== other);
    }
    const extObj = { id: ext.id, path: dir, manifest: ext.manifest || meta.manifest, name: meta.name, description: meta.description, version: meta.version, url: ext.url };
    info.exts.set(ext.id, extObj);
    if (!registry(info).list.includes(entry)) registry(info).list.push(entry);
    notifyInstalled(info, entry, extObj);
    loadDnr(info, extObj).catch(e => console.error('[extensions:dnr]', e));
    saveRegistry(info); uiChanged();
    return entry;
  }
  async function setEnabled(id, enabled) {
    const info = currentInfo();
    const entry = entryOf(info, id);
    if (!entry) throw new Error('Extension introuvable');
    if (enabled && entry.pending) {
      // Mise à jour en attente d'autorisations : l'accepter réactive l'extension.
      const ok = await confirmInstall(entry.name, entry.pending.warnings || [], 'Accepter les autorisations');
      if (!ok) return entry;
      const old = entry.path;
      entry.path = entry.pending.path; entry.version = entry.pending.version; entry.warnings = entry.pending.warnings; entry.pending = null;
      removeDirSafe(old, extRoot(info));
    }
    entry.enabled = !!enabled;
    entry.disabledReason = enabled ? '' : (entry.disabledReason === 'permissions' ? 'permissions' : 'user');
    if (enabled) {
      try { await loadEntry(info, entry); entry.error = ''; }
      catch (e) { entry.enabled = false; entry.error = String(e.message || e); saveRegistry(info); uiChanged(); throw e; }
    } else unloadExt(info, id);
    saveRegistry(info); uiChanged();
    return entry;
  }
  async function removeExt(id) {
    const info = currentInfo();
    const entry = entryOf(info, id);
    if (!entry) throw new Error('Extension introuvable');
    unloadExt(info, id);
    registry(info).list = registry(info).list.filter(e => e !== entry);
    saveRegistry(info);
    if (entry.source !== 'unpacked') removeDirSafe(path.join(extRoot(info), id), extRoot(info));
    // Données de l'extension (stockage local, IndexedDB…) effacées comme dans Chrome.
    try { await info.ses.clearStorageData({ origin: 'chrome-extension://' + id }); } catch {}
    uiChanged();
    return true;
  }
  async function reloadExt(id) {
    const info = currentInfo();
    const entry = entryOf(info, id);
    if (!entry || !entry.enabled) throw new Error('Extension désactivée');
    unloadExt(info, id);
    const meta = readExtInfo(entry.path);
    Object.assign(entry, { version: meta.version, name: meta.name, warnings: M.permissionWarnings(meta.manifest) });
    await loadEntry(info, entry);
    saveRegistry(info); uiChanged();
    return entry;
  }
  function dirSize(p) {
    let n = 0;
    try {
      for (const d of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, d.name);
        n += d.isDirectory() ? dirSize(q) : (d.isFile() ? fs.statSync(q).size : 0);
      }
    } catch {}
    return n;
  }

  // ----- Mises à jour du Web Store ---------------------------------------------
  let updating = null;
  async function checkUpdates(info, manual) {
    if (updating) return updating;
    updating = (async () => {
      const list = registry(info).list.filter(e => e.source === 'store');
      const out = { checked: list.length, updated: [], pending: [], errors: [] };
      if (!list.length) return out;
      const url = 'https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=' + chromeVersion + '&acceptformat=crx2,crx3' +
        list.map(e => '&x=' + encodeURIComponent('id=' + e.id + '&v=' + (e.version || '0') + '&uc')).join('');
      let xml = '';
      try {
        const res = await net.fetch(url, { cache: 'no-store', headers: { 'user-agent': ctx.chromeUserAgent() } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        xml = await res.text();
      } catch (e) { out.errors.push(String(e.message || e)); return out; }
      for (const m of xml.matchAll(/<app\b[^>]*appid="([a-p]{32})"[^>]*>([\s\S]*?)<\/app>/g)) {
        const id = m[1];
        const uc = /<updatecheck\b([^>]*)\/?>/.exec(m[2]);
        if (!uc) continue;
        const attr = (n) => { const r = new RegExp('\\b' + n + '="([^"]*)"').exec(uc[1]); return r ? r[1].replace(/&amp;/g, '&') : ''; };
        const entry = entryOf(info, id);
        if (!entry || attr('status') !== 'ok' || !attr('codebase') || M.compareVersions(attr('version'), entry.version) <= 0) continue;
        try {
          const codebase = new URL(attr('codebase'));
          if (codebase.protocol !== 'https:') throw new Error('mise à jour servie sans HTTPS');
          const parsed = parseCrx(await downloadCrx(codebase.toString()), id);
          const files = readZip(parsed.zip);
          const meta = zipManifest(files);
          const newWarnings = M.permissionWarnings(meta.manifest).filter(w => !(entry.warnings || []).includes(w));
          if (newWarnings.length) {
            // Nouvelles autorisations : comme Chrome, l'extension est désactivée
            // jusqu'à ce que l'utilisateur les accepte.
            const dir = path.join(extRoot(info), id, meta.version.replace(/[^0-9a-zA-Z._-]/g, '_') + '_' + crypto.randomBytes(3).toString('hex'));
            extractZip(parsed.zip, dir);
            const mf = M.readManifestDir(dir); mf.key = parsed.publicKey.toString('base64');
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
            entry.pending = { path: dir, version: meta.version, warnings: M.permissionWarnings(meta.manifest) };
            entry.enabled = false; entry.disabledReason = 'permissions';
            unloadExt(info, id);
            saveRegistry(info);
            out.pending.push(entry.name);
          } else {
            await installParsedCrx(info, parsed, 'store', { confirm: false });
            out.updated.push(entry.name);
          }
        } catch (e) { out.errors.push(entry.name + ' : ' + (e.message || e)); }
      }
      uiChanged();
      if (out.pending.length && !manual) ctx.toast('Une extension a été désactivée : elle demande de nouvelles autorisations.');
      return out;
    })();
    try { return await updating; } finally { updating = null; }
  }

  // ----- État pour la barre d'outils -----------------------------------------
  const toolbarAnchors = new Map();   // id -> { right, bottom }
  ctx.state('chrome', () => {
    const info = sessions.get(ctx.browserPartition());
    if (!info) return { extensions: [] };
    const tab = ctx.activeTab();
    const wcId = tab && !tab.incognito ? tab.view.webContents.id : null;
    const incognito = !!(tab && tab.incognito);
    const list = [];
    for (const entry of registry(info).list) {
      const ext = info.exts.get(entry.id);
      if (!ext) continue;
      const a = M.actionOf(ext.manifest);
      const st = actionState(ext.id);
      const tabSt = wcId != null ? st.tabs.get(wcId) || {} : {};
      const pick = (k) => (k in tabSt ? tabSt[k] : st.global[k]);
      list.push({
        id: ext.id, name: ext.name, pinned: !!entry.pinned, hasAction: !!a,
        icon: pick('icon') || defaultIcon(ext) || '',
        title: pick('title') || (a && a.default_title) || ext.name,
        badge: pick('badgeText') || '', badgeBg: pick('badgeBg') || '', badgeColor: pick('badgeColor') || '',
        enabled: !incognito && pick('enabled') !== false,
        popupOpen: !!(popup && popup.extId === ext.id),
      });
    }
    return { extensions: list, extensionsIncognito: incognito };
  });

  function extMenu(id, anchor) {
    const info = currentInfo();
    const entry = entryOf(info, id);
    const ext = info && info.exts.get(id);
    if (!entry || !ext) return;
    const optionsPage = (ext.manifest.options_ui && ext.manifest.options_ui.page) || ext.manifest.options_page;
    const items = [
      { label: ext.name.replace(/&/g, '&&'), enabled: false },
      { type: 'separator' },
      { label: entry.pinned ? 'Retirer de la barre d\'outils' : 'Épingler', click: () => { entry.pinned = !entry.pinned; saveRegistry(info); uiChanged(); } },
    ];
    if (optionsPage) items.push({ label: 'Options', click: () => ctx.createTab('chrome-extension://' + id + '/' + String(optionsPage).replace(/^\/+/, ''), true, {}) });
    if (entry.source === 'store') items.push({ label: 'Voir dans le Chrome Web Store', click: () => ctx.createTab('https://chromewebstore.google.com/detail/' + id, true, {}) });
    items.push({ label: 'Gérer l\'extension', click: () => ctx.openInternal('extensions.html#' + id) });
    items.push({ type: 'separator' });
    items.push({ label: 'Supprimer de zaalis Browser…', click: async () => {
      const r = await dialog.showMessageBox(ctx.mainWin, { type: 'warning', buttons: ['Supprimer', 'Annuler'], defaultId: 1, cancelId: 1, noLink: true,
        title: 'zaalis Browser', message: 'Supprimer « ' + ext.name + ' » ?', detail: 'L\'extension et ses données seront supprimées.' });
      if (r.response === 0) removeExt(id).catch(e => ctx.toast(e.message));
    } });
    if (entry.source === 'unpacked') items.splice(3, 0, { label: 'Recharger', click: () => reloadExt(id).catch(e => ctx.toast(e.message)) });
    if (popup && popup.extId === id) items.push({ type: 'separator' }, { label: 'Inspecter la fenêtre pop-up', click: () => popup && popup.view.webContents.openDevTools({ mode: 'detach' }) });
    Menu.buildFromTemplate(items).popup({ window: ctx.mainWin || undefined, ...(anchor ? { x: Math.round(anchor.left || 0), y: Math.round(anchor.bottom || 0) } : {}) });
  }

  // ----- Actions du chrome (barre d'outils) ------------------------------------
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  ctx.action('extActionClick', (args) => {
    const anchor = { left: num(args[1]), right: num(args[2]), bottom: num(args[3]) };
    toolbarAnchors.set(args[0], anchor);
    activateAction(args[0], anchor);
  });
  ctx.action('extIconMenu', (args) => extMenu(args[0], { left: num(args[1]), bottom: num(args[2]) }));
  ctx.action('extPin', (args) => {
    const info = currentInfo(); const e = info && entryOf(info, args[0]);
    if (e) { e.pinned = args[1] === '1'; saveRegistry(info); uiChanged(); }
  });
  ctx.action('extManage', () => ctx.openInternal('extensions'));
  ctx.action('extOpenStore', () => ctx.createTab('https://chromewebstore.google.com/category/extensions', true, {}));

  // ----- Page interne zaalis://extensions --------------------------------------
  ctx.alias('extensions', 'extensions.html');
  const P = { pages: ['extensions.html'] };
  function describe(info, entry, withSize) {
    const ext = info.exts.get(entry.id);
    let meta = null;
    try { meta = ext ? { manifest: ext.manifest, name: ext.name, description: ext.description, version: ext.version } : readExtInfo(entry.path); } catch {}
    const mf = (meta && meta.manifest) || {};
    const iconExt = { path: entry.path, manifest: mf };
    const optionsPage = (mf.options_ui && mf.options_ui.page) || mf.options_page;
    return {
      id: entry.id, name: (meta && meta.name) || entry.name || entry.id, description: (meta && meta.description) || '',
      version: (meta && meta.version) || entry.version || '', enabled: !!entry.enabled && !!ext, source: entry.source,
      pinned: !!entry.pinned, hasAction: !!M.actionOf(mf), icon: bigIcon(iconExt) || '', path: entry.path,
      warnings: M.permissionWarnings(mf), permissions: M.apiPermissions(mf), hosts: M.hostPatterns(mf),
      disabledReason: entry.disabledReason || '', error: entry.error || '', pending: entry.pending ? { version: entry.pending.version, warnings: entry.pending.warnings } : null,
      optionsUrl: optionsPage ? 'chrome-extension://' + entry.id + '/' + String(optionsPage).replace(/^\/+/, '') : '',
      homepage: mf.homepage_url || '', manifestVersion: mf.manifest_version || 2,
      installedAt: entry.installedAt || 0, updatedAt: entry.updatedAt || 0,
      ...(withSize ? { size: dirSize(entry.path) } : {}),
    };
  }
  ctx.rpc('extList', async () => {
    const info = currentInfo();
    if (!info) return { extensions: [], devMode: false };
    if (info.ready) await info.ready;
    return { devMode: registry(info).devMode, extensions: registry(info).list.map(e => describe(info, e, false)), profile: ctx.currentProfileId || '' };
  }, P);
  ctx.rpc('extDetails', ({ id }) => { const info = currentInfo(); const e = entryOf(info, id); if (!e) throw new Error('Extension introuvable'); return describe(info, e, true); }, P);
  ctx.rpc('extSetEnabled', ({ id, enabled }) => setEnabled(id, enabled).then(() => true), P);
  ctx.rpc('extRemove', ({ id }) => removeExt(id), P);
  ctx.rpc('extReload', ({ id }) => reloadExt(id).then(() => true), P);
  ctx.rpc('extPin', ({ id, pinned }) => { const info = currentInfo(); const e = entryOf(info, id); if (e) { e.pinned = !!pinned; saveRegistry(info); uiChanged(); } return true; }, P);
  ctx.rpc('extSetDevMode', ({ on }) => { const info = currentInfo(); registry(info).devMode = !!on; saveRegistry(info); return true; }, P);
  ctx.rpc('extLoadUnpacked', async () => {
    const r = await dialog.showOpenDialog(ctx.mainWin, { title: 'Sélectionner le dossier de l\'extension', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return describe(currentInfo(), await loadUnpacked(r.filePaths[0]), false);
  }, P);
  ctx.rpc('extInstallCrxFile', async () => {
    const r = await dialog.showOpenDialog(ctx.mainWin, { title: 'Installer une extension (.crx)', properties: ['openFile'], filters: [{ name: 'Extension Chrome', extensions: ['crx'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const e = await installCrxFile(r.filePaths[0]);
    return e ? describe(currentInfo(), e, false) : null;
  }, P);
  ctx.rpc('extCheckUpdates', () => checkUpdates(currentInfo(), true), P);
  ctx.rpc('extOpenOptions', ({ id }) => {
    const info = currentInfo(); const ext = info.exts.get(id);
    if (!ext) throw new Error('Extension désactivée');
    return api.handle(info, ext, 'runtime.openOptionsPage', [], { kind: 'ui' });
  }, P);
  ctx.rpc('extOpenUrl', ({ url }) => { if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com)\//.test(String(url)) || /^https?:\/\//.test(String(url))) ctx.createTab(String(url), true, {}); return true; }, P);
  ctx.rpc('extShowFolder', ({ id }) => { const e = entryOf(currentInfo(), id); if (e) electron.shell.openPath(e.path); return true; }, P);

  // ----- Ligne d'URL chrome-extension:// dans les onglets ----------------------
  // Pages d'options et onglets ouverts par une extension (chrome.tabs.create).
  if (typeof ctx.allowUrl === 'function') {
    ctx.allowUrl((u) => {
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(u);
      if (!m) return false;
      const info = sessions.get(ctx.browserPartition());
      return !!(info && info.exts.has(m[1]));
    });
  }

  // ----- Chrome Web Store (preload-content.js) ---------------------------------
  function storeIdFromPage(c) {
    if (!c.isMainFrame) return null;
    let u;
    try { u = new URL(c.frameUrl); } catch { return null; }
    if (u.protocol !== 'https:' || !STORE_HOSTS.has(u.hostname)) return null;
    if (u.hostname === 'chrome.google.com' && !u.pathname.startsWith('/webstore/')) return null;
    const m = /\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(u.pathname);
    return m ? m[1] : null;
  }
  ctx.page('extStoreState', (p, c) => {
    const id = storeIdFromPage(c);
    if (!id || (p.id && p.id !== id) || c.tab.incognito) return { supported: !c.tab.incognito && !!id, installed: false };
    const info = infoOfTab(c.tab);
    const e = info && entryOf(info, id);
    return { supported: true, id, installed: !!e, enabled: !!(e && e.enabled), name: e ? e.name : '' };
  });
  ctx.page('extStoreInstall', async (p, c) => {
    const id = storeIdFromPage(c);
    if (!id || p.id !== id) return { ok: false, error: 'Page non reconnue' };
    if (c.tab.incognito) { ctx.toast('Les extensions ne sont pas disponibles en navigation privée.'); return { ok: false }; }
    try { const e = await installFromStore(id); return { ok: !!e, installed: !!e }; }
    catch (e) { ctx.toast('Impossible d\'ajouter l\'extension : ' + (e.message || e)); return { ok: false, error: String(e.message || e) }; }
  });
  ctx.page('extStoreRemove', async (p, c) => {
    const id = storeIdFromPage(c);
    if (!id || p.id !== id) return { ok: false };
    const info = infoOfTab(c.tab); const e = info && entryOf(info, id);
    if (!e) return { ok: true };
    const r = await dialog.showMessageBox(ctx.mainWin, { type: 'warning', buttons: ['Supprimer', 'Annuler'], defaultId: 1, cancelId: 1, noLink: true, title: 'zaalis Browser', message: 'Supprimer « ' + e.name + ' » ?' });
    if (r.response !== 0) return { ok: false };
    await removeExt(id);
    return { ok: true, installed: false };
  });

  // ----- Démarrage / mises à jour périodiques ---------------------------------
  let timer = null;
  ctx.on('ready', () => {
    const run = () => { for (const info of sessions.values()) checkUpdates(info, false).catch(() => {}); };
    const t = setTimeout(run, FIRST_UPDATE_DELAY_MS); if (t.unref) t.unref();
    timer = setInterval(run, UPDATE_INTERVAL_MS); if (timer.unref) timer.unref();
  });
  ctx.on('quit', () => { if (timer) clearInterval(timer); closePopup(); });

  return {
    sessions, currentInfo, installFromStore, installCrxFile, installParsedCrx, loadUnpacked, setEnabled, removeExt, reloadExt,
    activateAction, closePopup, get popup() { return popup; }, checkUpdates, whenDnrReady, dispatch, api, actionState, menus,
  };
}

module.exports = { init };
