'use strict';

// zaalis Browser inside zaalis IDE.
//
// The native shell (native/browser/BrowserHost.cpp) owns the WebView2 views and
// opens a private named pipe before starting this server; the pipe name and a
// one-time token arrive through ZAALIS_BROWSER_PIPE / ZAALIS_BROWSER_TOKEN.
// This module speaks that pipe (newline-delimited JSON), runs the vendored
// zaalis Browser main process (app/main.js) on the Electron-compatible surface
// of electron-shim.js, and exposes what the IDE needs: open, search, reveal
// and the page tools of the browser's own agent.
//
// Nothing here depends on the standalone zaalis Browser being installed.

const fs = require('fs');
const net = require('net');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { createElectron } = require('./electron-shim');

const APP_DIR = path.join(__dirname, 'app');
const DATA_FILES = [
  'settings.txt', 'bookmarks.tsv', 'shortcuts.tsv', 'history.tsv', 'profiles.json', 'launcher.json',
  'aichats.json', 'permissions.json', 'downloads.json',
];
const DATA_DIRS = ['profiles', 'avatars'];

class BrowserHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipePath = options.pipePath || process.env.ZAALIS_BROWSER_PIPE || '';
    this.token = options.token || process.env.ZAALIS_BROWSER_TOKEN || '';
    this.dataDir = options.dataDir || '';
    this.secretFile = options.secretFile || '';
    this.idePort = options.idePort || 3000;
    this.log = options.log || ((line) => console.error(line));
    this.socket = null;
    this.buffer = '';
    this.connected = false;
    this.nextId = 1;
    this.pending = new Map();
    this.panelVisible = false;
    this.core = null;
    this.starting = null;
    this.lastTabs = [];
    this.agentBorderTimer = null;
    this.shim = createElectron({
      command: (op, params) => this.command(op, params),
      send: (op, params) => this.send(op, params),
      log: (line) => this.log(line),
    }, {
      onPost: (wc, data) => this.observePost(wc, data),
      onWebMessage: (wc, message) => this.observeWebMessage(wc, message),
    });
  }

  // The shell is the pipe server: it exists before this process starts, but
  // the connection is retried in case the server comes up first in dev runs.
  connect() {
    if (!this.pipePath || !this.token) return false;
    const attempt = (tries) => {
      const socket = net.connect(this.pipePath);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        this.socket = socket;
        this.writeLine({ op: 'hello', token: this.token });
      });
      socket.on('data', (chunk) => this.consume(chunk));
      socket.on('error', (error) => {
        if (!this.socket && tries < 120) setTimeout(() => attempt(tries + 1), 500).unref?.();
        else if (this.socket) this.log(`[zaalis browser] canal natif : ${error.message}`);
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.connected = false;
        for (const { reject } of this.pending.values()) reject(new Error('navigateur intégré fermé'));
        this.pending.clear();
      });
    };
    attempt(0);
    return true;
  }

  available() { return this.connected; }

  writeLine(message) {
    if (!this.socket) return false;
    try { this.socket.write(JSON.stringify(message) + '\n'); return true; } catch { return false; }
  }

  send(op, params) {
    if (!this.connected) return;
    this.writeLine({ op, ...(params || {}) });
  }

  command(op, params, timeoutMs = 30000) {
    if (!this.connected) return Promise.reject(new Error('navigateur intégré indisponible'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${op} : délai dépassé`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.writeLine({ op, id, ...(params || {}) });
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      try { this.dispatch(message); } catch (error) { this.log(`[zaalis browser] ${error && error.stack || error}`); }
    }
  }

  dispatch(message) {
    if (message.re !== undefined) {
      const entry = this.pending.get(message.re);
      if (!entry) return;
      this.pending.delete(message.re);
      if (message.ok === false) entry.reject(new Error(String(message.error || 'erreur navigateur')));
      else entry.resolve(message.result);
      return;
    }
    switch (message.ev) {
      case 'welcome':
        this.connected = true;
        this.shim.setFolders(message.folders || {});
        this.shim.setSize(message.width, message.height);
        this.emit('available');
        return;
      case 'panel':
        this.panelVisible = !!message.visible;
        if (message.visible) this.ensureStarted().catch((error) => this.log(`[zaalis browser] démarrage : ${error.message}`));
        return;
      case 'ideCommand':
        this.handleIdeCommand(message).catch((error) => this.log(`[zaalis browser] commande IDE : ${error.message}`));
        return;
      default:
        this.shim.handleEvent(message);
    }
  }

  // ----- Start-up --------------------------------------------------------------
  importStandaloneData() {
    // First run of the integrated browser: bring over the user's existing
    // zaalis Browser data (bookmarks, history, profiles, AI chats) once. The
    // standalone install is only read, never modified or required afterwards.
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(path.join(this.dataDir, 'settings.txt'))) return;
      const legacy = path.join(process.env.APPDATA || '', 'zaalis browser');
      if (!process.env.APPDATA || !fs.existsSync(path.join(legacy, 'settings.txt'))) return;
      for (const file of DATA_FILES) {
        const from = path.join(legacy, file);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(this.dataDir, file));
      }
      for (const dir of DATA_DIRS) {
        const from = path.join(legacy, dir);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(this.dataDir, dir), { recursive: true, force: false });
      }
      this.log('[zaalis browser] données du navigateur autonome importées.');
    } catch (error) {
      this.log(`[zaalis browser] import des données ignoré : ${error.message}`);
    }
  }

  ensureStarted() {
    if (this.core) return Promise.resolve(this.core);
    if (!this.connected) return Promise.reject(new Error('navigateur intégré indisponible'));
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.importStandaloneData();
      process.env.ZAALIS_BROWSER_EMBEDDED = '1';
      process.env.ZAALIS_BROWSER_DATA = this.dataDir;
      if (this.secretFile) process.env.ZAALIS_BROWSER_SECRET_FILE = this.secretFile;
      process.env.ZAALIS_IDE_PORT = String(this.idePort);
      const electron = this.shim.electron;
      const load = Module._load;
      // `require('electron')` from the vendored browser resolves to the shim,
      // including the lazy require inside its context-menu handler.
      Module._load = function zaalisElectron(request, parent, isMain) {
        if (request === 'electron' && parent && String(parent.filename || '').startsWith(APP_DIR)) return electron;
        return load.call(this, request, parent, isMain);
      };
      const core = require('./app/main.js');
      this.shim.markReady();
      await electron.app.whenReady();
      // createWindow() runs in the whenReady continuation of main.js.
      await new Promise((resolve) => setImmediate(resolve));
      this.core = core;
      return core;
    })();
    this.starting.catch(() => { this.starting = null; });
    return this.starting;
  }

  // ----- Observers (state for the IDE, toolbar overlay clipping) -------------
  observePost(wc, data) {
    if (!data || data.type !== 'state' || !Array.isArray(data.tabs)) return;
    this.lastTabs = data.tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: !!tab.active }));
    this.send('ideState', { tabs: this.lastTabs });
  }

  // The toolbar view grows over the page while a popup is open; the shell
  // clips it to the toolbar strip plus the popup box, as the standalone
  // Windows browser does, since native views cannot blend with each other.
  observeWebMessage(wc, message) {
    if (typeof message !== 'string' || !message.startsWith('chromeHeight\x1f')) return;
    const parts = message.split('\x1f').slice(1).map((value) => parseInt(value, 10));
    const [height, top, left, rectTop, right, bottom] = parts;
    const overlay = parts.length > 5 ? { left, top: rectTop, right, bottom } : null;
    this.send('chromeRegion', { view: wc.id, height: height || 0, top: top || height || 0, overlay });
  }

  // ----- IDE-facing API ------------------------------------------------------------
  reveal() { this.send('reveal', {}); }

  async open(url, { background = false, reveal = true } = {}) {
    const core = await this.ensureStarted();
    const target = core.resolveQuery(String(url || ''));
    core.createTab(target, !background);
    if (reveal && !background) this.reveal();
    return { url: target, background };
  }

  async search(query, { newTab = true, reveal = true } = {}) {
    const core = await this.ensureStarted();
    const target = core.resolveQuery(String(query || ''));
    if (newTab || !core.activeTab()) core.createTab(target, true);
    else core.navigateActive(target);
    if (reveal) this.reveal();
    return { url: target };
  }

  tabs() {
    const core = this.core;
    if (!core) return [];
    const active = core.activeTab();
    return core.tabs.map((tab) => ({
      id: tab.id, title: tab.view.webContents.getTitle(), url: tab.view.webContents.getURL(),
      active: tab === active, loading: !!tab.loading,
    }));
  }

  // The integrated browser's own page tools (read_page, click, fill, navigate,
  // execute_js, read_console, read_network), plus tab management and a
  // screenshot, for the IDE agent. The halo and animated cursor of the browser
  // agent show every action. Every tool answers text, except `screenshot`:
  // { text, image } where image is a base64 JPEG of the visible page.
  async agentTool(tool, args = {}) {
    const core = await this.ensureStarted();
    this.reveal();
    if (tool === 'tabs') return JSON.stringify(this.tabs());
    if (tool === 'open') {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) return 'Erreur : seules les URL http(s) sont acceptées.';
      core.createTab(url, true);
      const tab = core.activeTab();
      if (tab) await core.waitLoad(tab.view.webContents, 8000);
      return `Onglet ouvert : ${tab ? tab.view.webContents.getURL() : url}`;
    }
    if (tool === 'search') {
      const query = String(args.query || '').trim();
      if (!query) return 'Erreur : "query" requis.';
      const target = core.resolveQuery(query);
      if (args.new_tab === false && core.activeTab()) core.navigateActive(target); else core.createTab(target, true);
      const tab = core.activeTab();
      if (tab) await core.waitLoad(tab.view.webContents, 8000);
      return `Recherche affichée : ${tab ? tab.view.webContents.getURL() : target}`;
    }
    if (tool === 'select_tab') {
      const id = Number(args.id);
      if (!core.tabs.some((tab) => tab.id === id)) return `Onglet ${id} introuvable.`;
      core.selectTab(id);
      return `Onglet ${id} actif.`;
    }
    if (tool === 'close_tab') {
      const id = Number(args.id);
      if (!core.tabs.some((tab) => tab.id === id)) return `Onglet ${id} introuvable.`;
      core.closeTab(id);
      return `Onglet ${id} fermé.`;
    }
    if (tool === 'page_text') {
      const tab = core.activeTab();
      if (!tab) return 'Aucune page active.';
      return (await core.quickPageContext(tab)) || 'Page illisible pour le moment.';
    }
    if (tool === 'screenshot') {
      const tab = core.activeTab();
      if (!tab) return 'Aucune page active.';
      const shot = await tab.view.webContents.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      if (!shot || typeof shot.data !== 'string' || !shot.data) return 'Capture de la page impossible pour le moment.';
      return { text: `Capture de la partie visible de ${tab.view.webContents.getURL()} (jointe au message suivant).`, image: shot.data };
    }
    const tab = core.activeTab();
    if (!tab) return 'Aucune page web active.';
    clearTimeout(this.agentBorderTimer);
    try {
      await core.setAiControlBorder(tab, true);
      await core.agentHoldCursor(tab.view.webContents, 'IA de zaalis IDE');
    } catch {}
    try {
      return await core.runAgentTool(tab, tool, args);
    } finally {
      // The halo stays while the agent keeps working, then fades out.
      this.agentBorderTimer = setTimeout(() => core.setAiControlBorder(null, false).catch(() => {}), 6000);
      this.agentBorderTimer.unref?.();
    }
  }

  async handleIdeCommand(message) {
    const url = String(message.url || '');
    if (message.action === 'navigate' && url) await this.open(url, { reveal: false });
    else if (message.action === 'newTab') await this.open(url || '', { reveal: false });
  }
}

module.exports = { BrowserHost };
