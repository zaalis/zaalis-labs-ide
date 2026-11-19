'use strict';
/* =============================================================================
 *  Économiseur de mémoire (« Memory Saver » de Chrome)
 * -----------------------------------------------------------------------------
 *  Un onglet inactif depuis N minutes est mis en veille : sa page est fermée
 *  (le processus de rendu disparaît vraiment) et remplacée par une vue vide
 *  qui ne lance aucun processus. L'onglet reste dans la barre (estompé, avec
 *  « Mémoire libérée : X Mo ») ; à sa sélection, un nouveau contenu est créé
 *  et l'historique de navigation complet est restauré
 *  (navigationHistory.restore, position de défilement comprise).
 *
 *  Jamais mis en veille : l'onglet actif, la vue fractionnée, un onglet qui
 *  joue du son, en plein écran ou capturé, une page avec un formulaire
 *  modifié, les pages encore en chargement et les sites exclus.
 * =========================================================================== */

const MINUTES = [5, 15, 30, 60, 120];
const SCAN_MS = 30 * 1000;

const DIRTY_FORM_JS = `(() => {
  try {
    for (const e of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),textarea,select')) {
      if (e.type === 'checkbox' || e.type === 'radio') { if (e.checked !== e.defaultChecked) return true; }
      else if (e.tagName === 'SELECT') { for (const o of e.options) if (o.selected !== o.defaultSelected) return true; }
      else if (e.value !== e.defaultValue && e.value !== '') return true;
    }
    const a = document.activeElement;
    if (a && a.isContentEditable && (a.textContent || '').trim()) return true;
  } catch (e) {}
  return false;
})()`;

function hostMatches(host, pattern) {
  host = String(host || '').toLowerCase();
  pattern = String(pattern || '').toLowerCase().trim().replace(/^\*\./, '');
  if (!host || !pattern) return false;
  return host === pattern || host.endsWith('.' + pattern);
}

function normalizeSite(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return '';
  try { if (/^[a-z]+:\/\//.test(s)) s = new URL(s).hostname; } catch { return ''; }
  s = s.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return /^[a-z0-9.-]+$/.test(s) && s.includes('.') || s === 'localhost' ? s : '';
}

function init(ctx) {
  const { app, path, electron } = ctx;
  const { WebContentsView } = electron;

  const prefsFile = () => path.join(ctx.dataFolder, 'memory-saver.json');
  const prefs = Object.assign({ enabled: true, minutes: 30, exclusions: [] }, ctx.readJson(prefsFile(), {}));
  if (!MINUTES.includes(prefs.minutes)) prefs.minutes = 30;
  if (!Array.isArray(prefs.exclusions)) prefs.exclusions = [];
  let thresholdMs = prefs.minutes * 60 * 1000;   // modifiable par les tests
  const lastActive = new WeakMap();                // tab -> horodatage
  let totalFreedMB = 0;
  let timer = null;

  const save = () => ctx.writeJson(prefsFile(), prefs);

  function memoryOfPid(pid) {
    if (!pid) return 0;
    const m = app.getAppMetrics().find(x => x.pid === pid);
    // workingSetSize en Ko.
    return m && m.memory ? Math.round((m.memory.privateBytes || m.memory.workingSetSize || 0) / 1024) : 0;
  }

  async function eligible(t, force) {
    if (!t || t.discarded || t.closing || !t.view) return false;
    const wc = t.view.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if (ctx.activeTab() === t) return false;
    const split = ctx.splitPair;
    if (split && split.includes(t.id)) return false;
    if (t.dev) return false;                                  // outils de développement ouverts
    if (wc.isLoading()) return false;
    try { if (wc.isCurrentlyAudible()) return false; } catch {}
    try { if (wc.isBeingCaptured && wc.isBeingCaptured()) return false; } catch {}
    try { if (wc.isDevToolsOpened()) return false; } catch {}
    if (t.mediaCapture) return false;                         // caméra / micro / écran signalés par les permissions
    const url = wc.getURL();
    if (!url) return false;
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (prefs.exclusions.some(p => hostMatches(host, p))) return false;
    if (!force) {
      const since = lastActive.get(t) || 0;
      if (!since || Date.now() - since < thresholdMs) return false;
    }
    // Formulaire en cours de saisie : on ne perd jamais une saisie.
    try {
      const dirty = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(1016, [{ code: DIRTY_FORM_JS }], false),
        new Promise(r => setTimeout(() => r(true), 1500)),
      ]);
      if (dirty) return false;
    } catch { return false; }
    return true;
  }

  // Met l'onglet en veille. Renvoie le nombre de Mo libérés (ou -1).
  async function discard(t, force) {
    if (!(await eligible(t, force))) return -1;
    const wc = t.view.webContents;
    let entries = [], index = 0;
    try { entries = wc.navigationHistory.getAllEntries(); index = wc.navigationHistory.getActiveIndex(); } catch {}
    const pid = wc.getOSProcessId();
    const mb = memoryOfPid(pid);
    const info = {
      url: wc.getURL(), title: wc.getTitle() || '', entries, index, pid,
      freedMB: mb, at: Date.now(), zoom: (() => { try { return wc.getZoomFactor(); } catch { return 1; } })(),
    };
    // Vue de remplacement : aucune page chargée => aucun processus de rendu.
    const stub = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    stub.setBackgroundColor('#00000000');
    const old = t.view;
    t.discarded = info;
    t.view = stub;
    try { ctx.mainWin.contentView.addChildView(stub); stub.setVisible(false); } catch {}
    try { ctx.mainWin.contentView.removeChildView(old); } catch {}
    // Le hook « destroyed » de createTab ne doit pas retirer l'onglet.
    t.closing = true;
    old.webContents.once('destroyed', () => { t.closing = false; });
    try { old.webContents.close(); } catch { t.closing = false; }
    ctx.raiseOverlays();
    totalFreedMB += mb;
    ctx.pushState();
    return mb;
  }

  // Réveille l'onglet : crée un vrai contenu à la même place (même id).
  function restore(t) {
    if (!t || !t.discarded) return null;
    const info = t.discarded;
    const stub = t.view;
    // Onglet créé sans chargement (« about:blank » n'est pas autorisé par
    // guardedLoad) ; l'historique est restauré juste après.
    const nt = ctx.createTab('about:blank', false, { incognito: !!t.incognito, loadOptions: {}, restoreOf: t });
    // Le nouvel onglet prend l'identité de l'ancien.
    for (const k of ['pinned', 'group', 'openerId', 'lastGestureAt']) if (t[k] !== undefined) nt[k] = t[k];
    nt.id = t.id;
    ctx.replaceTab(t, nt);
    t.discarded = null;
    t.closing = true;
    try { ctx.mainWin.contentView.removeChildView(stub); } catch {}
    try { stub.webContents.close(); } catch {}
    const wc = nt.view.webContents;
    let restored = false;
    if (Array.isArray(info.entries) && info.entries.length && wc.navigationHistory.restore) {
      try {
        const p = wc.navigationHistory.restore({ entries: info.entries, index: Math.max(0, Math.min(info.entries.length - 1, info.index || 0)) });
        if (p && p.catch) p.catch(() => { if (!wc.isDestroyed()) wc.loadURL(info.url).catch(() => {}); });
        restored = true;
      } catch {}
    }
    if (!restored && info.url) wc.loadURL(info.url).catch(() => {});
    if (info.zoom && info.zoom !== 1) wc.once('did-finish-load', () => { try { wc.setZoomFactor(info.zoom); } catch {} });
    lastActive.set(nt, Date.now());
    return nt;
  }

  async function scan() {
    if (!prefs.enabled) return;
    for (const t of ctx.tabs.slice()) {
      try { await discard(t, false); } catch (e) { console.error('[memorysaver]', e.message); }
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { scan(); }, SCAN_MS);
    if (timer.unref) timer.unref();
  }

  // ----- Points d'accroche -------------------------------------------------
  ctx.on('tabCreated', (tab) => { lastActive.set(tab, Date.now()); });
  ctx.on('tabActivated', (tab, previous) => {
    if (previous && previous !== tab) lastActive.set(previous, Date.now());
    // Appelé dans selectTab avant le placement : le contenu est recréé au même
    // index, selectTab enchaîne donc directement sur le nouvel onglet.
    if (tab && tab.discarded) restore(tab);
  });
  ctx.on('ready', schedule);
  ctx.on('quit', () => {
    if (timer) clearInterval(timer);
    for (const t of ctx.tabs) if (t.discarded) { try { t.view.webContents.close(); } catch {} }
  });

  ctx.tabState((t) => t.discarded ? {
    discarded: true, title: t.discarded.title, url: t.discarded.url, freedMB: t.discarded.freedMB,
  } : {});

  const panelInfo = () => ({
    memorySaver: {
      enabled: prefs.enabled, minutes: prefs.minutes, choices: MINUTES, exclusions: prefs.exclusions.slice(),
      sleeping: ctx.tabs.filter(t => t.discarded).length, freedMB: totalFreedMB,
    },
  });
  ctx.state('panel', panelInfo);

  ctx.action('memSaverSet', (args) => {
    if (args[0] === 'enabled') prefs.enabled = args[1] === '1';
    else if (args[0] === 'minutes') { const m = parseInt(args[1], 10); if (MINUTES.includes(m)) { prefs.minutes = m; thresholdMs = m * 60000; } }
    save(); ctx.pushPanelState();
  });
  ctx.action('memSaverExclude', (args) => {
    const site = normalizeSite(args[1]);
    if (args[0] === 'add' && site && !prefs.exclusions.includes(site) && prefs.exclusions.length < 200) prefs.exclusions.push(site);
    else if (args[0] === 'remove') prefs.exclusions = prefs.exclusions.filter(s => s !== String(args[1] || ''));
    save(); ctx.pushPanelState();
  });
  ctx.action('memSaverDiscard', (args) => {     // depuis le gestionnaire de tâches ou le menu d'onglet
    const t = ctx.tabById(parseInt(args[0], 10));
    if (t) discard(t, true).then(mb => { if (mb < 0) ctx.toast('Cet onglet ne peut pas être mis en veille pour le moment.'); });
  }, { pages: ['taskmanager.html'], views: ['taskmanager'] });

  return {
    prefs, discard, restore, scan, eligible, normalizeSite, hostMatches,
    setThresholdMs: (ms) => { thresholdMs = ms; },
    touch: (t, ts) => lastActive.set(t, ts),
  };
}

module.exports = { init, hostMatches, normalizeSite };
