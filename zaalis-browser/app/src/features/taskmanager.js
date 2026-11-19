'use strict';
/* =============================================================================
 *  Gestionnaire de tâches (Maj+Échap, comme Chrome)
 * -----------------------------------------------------------------------------
 *  Petite fenêtre (ou onglet zaalis://taskmanager) listant chaque processus :
 *  navigateur, GPU, utilitaires, chaque onglet (titre + favicon), interface,
 *  extensions et service workers identifiables. Mémoire, CPU, PID ; tri par
 *  colonne ; « Arrêter le processus » plante volontairement le rendu de
 *  l'onglet, qui affiche alors la page « Oups » habituelle.
 * =========================================================================== */

const TYPE_LABELS = {
  Browser: 'Navigateur', GPU: 'Processus GPU', Utility: 'Utilitaire', Zygote: 'Zygote',
  'Sandbox helper': 'Assistant bac à sable', Pepper: 'Plug-in', Unknown: 'Processus',
};
const UTILITY_NAMES = {
  'network.mojom.NetworkService': 'Service réseau',
  'storage.mojom.StorageService': 'Service de stockage',
  'audio.mojom.AudioService': 'Service audio',
  'video_capture.mojom.VideoCaptureService': 'Service de capture vidéo',
  'data_decoder.mojom.DataDecoderService': 'Décodeur de données',
  'proxy_resolver.mojom.ProxyResolverFactory': 'Résolution de proxy',
  'media.mojom.CdmServiceBroker': 'Module de contenu protégé (Widevine)',
  'media.mojom.MediaFoundationServiceBroker': 'Service multimédia',
  'tracing.mojom.TracingService': 'Service de traçage',
  'unzip.mojom.Unzipper': 'Décompression',
  'chrome.mojom.UtilWin': 'Utilitaires Windows',
  'device.mojom.XRDeviceService': 'Service de réalité virtuelle',
};

function init(ctx) {
  const { app, path, electron } = ctx;
  const { BrowserWindow, webContents: allWebContents } = electron;
  let win = null;

  function tabLabel(t) {
    if (t.discarded) return t.discarded.title || t.discarded.url;
    const wc = t.view.webContents;
    return wc.getTitle() || wc.getURL() || 'Nouvel onglet';
  }

  // Associe chaque PID aux contenus qu'il héberge.
  function snapshot() {
    const metrics = app.getAppMetrics();
    const byPid = new Map();
    const owners = (pid) => { if (!byPid.has(pid)) byPid.set(pid, []); return byPid.get(pid); };
    const tabWcs = new Set();
    for (const t of ctx.tabs) {
      if (t.discarded) continue;
      const wc = t.view && t.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      tabWcs.add(wc);
      const pid = wc.getOSProcessId();
      if (pid) owners(pid).push({ kind: 'tab', tabId: t.id, title: (t.incognito ? 'Onglet privé : ' : 'Onglet : ') + tabLabel(t), url: wc.getURL() });
    }
    const ui = new Set([ctx.chromeView, ctx.panelView].filter(Boolean).map(v => v.webContents));
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed() || tabWcs.has(wc)) continue;
      const pid = wc.getOSProcessId();
      if (!pid) continue;
      const u = wc.getURL() || '';
      let title;
      if (ui.has(wc) || u.startsWith('zaalis://home/')) title = win && wc === win.webContents ? 'Gestionnaire de tâches' : 'Interface du navigateur';
      else if (u.startsWith('chrome-extension://')) title = 'Extension : ' + (wc.getTitle() || u.split('/')[2]);
      else if (u.startsWith('devtools://')) title = 'Outils de développement';
      else if (wc.getType() === 'backgroundPage') title = 'Extension : ' + (wc.getTitle() || u);
      else title = 'Sous-cadre : ' + (wc.getTitle() || u || 'page');
      owners(pid).push({ kind: 'other', title, url: u });
    }
    const rows = metrics.map(m => {
      const o = byPid.get(m.pid) || [];
      let title;
      if (m.type === 'Tab') {
        title = o.length ? o.map(x => x.title).join(' · ') : (m.serviceName === 'service-worker' || /worker/i.test(m.name || '') ? 'Service worker' : 'Processus de rendu');
      } else if (m.type === 'Utility') {
        title = 'Utilitaire : ' + (UTILITY_NAMES[m.serviceName] || m.name || m.serviceName || 'service');
      } else {
        title = TYPE_LABELS[m.type] || m.type;
      }
      const tab = o.find(x => x.kind === 'tab');
      return {
        pid: m.pid,
        type: m.type,
        title,
        url: tab ? tab.url : (o[0] && o[0].url) || '',
        tabId: tab ? tab.tabId : 0,
        memoryKB: (m.memory && (m.memory.privateBytes || m.memory.workingSetSize)) || 0,
        workingSetKB: (m.memory && m.memory.workingSetSize) || 0,
        cpu: m.cpu ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : 0,
        sandboxed: m.sandboxed !== false,
        killable: m.type !== 'Browser',
      };
    });
    // Onglets en veille : listés sans processus (mémoire libérée).
    for (const t of ctx.tabs) {
      if (!t.discarded) continue;
      rows.push({ pid: 0, type: 'Discarded', title: 'Onglet en veille : ' + tabLabel(t), url: t.discarded.url, tabId: t.id,
        memoryKB: 0, workingSetKB: 0, cpu: 0, killable: false, freedMB: t.discarded.freedMB || 0 });
    }
    return { rows, theme: ctx.settings.theme, at: Date.now() };
  }

  function kill(pid) {
    pid = parseInt(pid, 10);
    if (!pid || pid === process.pid) throw new Error('Ce processus ne peut pas être arrêté.');
    const m = app.getAppMetrics().find(x => x.pid === pid);
    if (!m) throw new Error('Processus introuvable.');
    if (m.type === 'Browser') throw new Error('Le processus du navigateur ne peut pas être arrêté.');
    // Rendu d'un contenu : arrêt propre côté Chromium (la page « Oups » s'affiche).
    let done = false;
    for (const wc of allWebContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.getOSProcessId() === pid) { try { wc.forcefullyCrashRenderer(); done = true; } catch {} }
    }
    if (!done) { try { process.kill(pid); done = true; } catch (e) { throw new Error('Arrêt impossible : ' + e.message); } }
    return true;
  }

  function open() {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); return win; }
    const dark = ctx.settings.theme === 'dark';
    win = new BrowserWindow({
      width: 780, height: 520, minWidth: 520, minHeight: 300,
      title: 'Gestionnaire de tâches - zaalis Browser',
      backgroundColor: dark ? '#202124' : '#f8f9fa',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', '..', 'assets', 'zaalis.ico'),
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload-chrome.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    ctx.trustView(wc, 'taskmanager');
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, u) => { if (!String(u).startsWith('zaalis://home/taskmanager.html')) e.preventDefault(); });
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !input.shift) win.close();
    });
    win.on('closed', () => { win = null; });
    wc.loadURL('zaalis://home/taskmanager.html?window=1').catch(() => {});
    return win;
  }

  const opts = { pages: ['taskmanager.html'], views: ['taskmanager'] };
  ctx.rpc('taskList', () => snapshot(), opts);
  ctx.rpc('taskKill', (p) => kill(p.pid), opts);
  ctx.action('taskFocusTab', (args) => {
    const t = ctx.tabById(parseInt(args[0], 10));
    if (t) { ctx.selectTab(t.id); if (ctx.mainWin) { ctx.mainWin.show(); ctx.mainWin.focus(); } }
  }, opts);
  ctx.action('openTaskManager', () => open(), { pages: ['*'] });
  ctx.alias('taskmanager', 'taskmanager.html');
  ctx.alias('task-manager', 'taskmanager.html');
  ctx.on('quit', () => { if (win && !win.isDestroyed()) win.destroy(); });

  return { open, snapshot, kill, get window() { return win; } };
}

module.exports = { init };
