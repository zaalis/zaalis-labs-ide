'use strict';

// Electron counterpart of the Windows WebView2 host. The browser's main
// process stays in zaalis-server; this authenticated Unix socket carries its
// view commands and events to Electron's WebContentsView instances.
const electron = require('electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

electron.protocol.registerSchemesAsPrivileged([{
  scheme: 'zaalis',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'zaalis:', 'about:', 'data:', 'blob:']);
const PERMISSION_KINDS = {
  media: 1, audioCapture: 2, geolocation: 3, notifications: 4,
  sensors: 5, 'clipboard-read': 6, 'automatic-downloads': 7,
  fileSystem: 8, autoplay: 9, 'local-fonts': 10, midiSysex: 11,
  'window-management': 12,
};

class BrowserBridge {
  constructor({ getWindow, log }) {
    this.getWindow = getWindow;
    this.log = log || (() => {});
    this.token = crypto.randomBytes(32).toString('hex');
    this.socketPath = path.join(os.tmpdir(), `zaalis-browser-${process.pid}.sock`);
    this.server = null;
    this.socket = null;
    this.buffer = '';
    this.views = new Map();
    this.sessions = new Set();
    this.pending = new Map();
    this.permissions = new Map();
    this.downloads = new Map();
    this.nextRequest = 1;
    this.panel = { x: 0, y: 0, width: 0, height: 0 };
    this.visible = false;
    this.tabs = [];
    this.accelerators = [];
    this.registerPreloadMessages();
  }

  registerPreloadMessages() {
    electron.ipcMain.on('zaalis-browser-post', (event, value) => {
      const entry = [...this.views.values()].find((candidate) => candidate.view.webContents === event.sender);
      if (!entry || !event.sender.getURL().startsWith('zaalis://home/')) return;
      if (typeof value !== 'string' || value.length > 65536) return;
      this.send({ ev: 'webMessage', view: entry.id, message: value });
    });
  }

  async start() {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
    fs.chmodSync(this.socketPath, 0o600);
    return { path: this.socketPath, token: this.token };
  }

  close() {
    try { this.socket?.destroy(); } catch {}
    try { this.server?.close(); } catch {}
    try { fs.unlinkSync(this.socketPath); } catch {}
    for (const entry of this.views.values()) {
      try { this.getWindow()?.contentView.removeChildView(entry.view); } catch {}
      try { entry.view.webContents.close(); } catch {}
    }
    this.views.clear();
  }

  async flushCookies() {
    await Promise.allSettled([...this.sessions].map((session) => session.cookies.flushStore()));
  }

  rendererSend(message) {
    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('zaalis-browser-event', message);
  }

  state() {
    const ready = !!this.socket;
    this.rendererSend({ type: 'browserState', available: ready, browser: ready,
      ready, visible: this.visible, tabs: this.tabs });
  }

  uiMessage(message) {
    if (!message || message.type !== 'browser') return;
    const action = String(message.action || '');
    if (action === 'state') { this.state(); return; }
    if (action === 'show' || action === 'bounds') {
      const bounds = message.bounds || {};
      this.panel = {
        x: Math.max(0, Math.round(Number(bounds.x) || 0)),
        y: Math.max(0, Math.round(Number(bounds.y) || 0)),
        width: Math.max(0, Math.round(Number(bounds.width) || 0)),
        height: Math.max(0, Math.round(Number(bounds.height) || 0)),
      };
      const wasVisible = this.visible;
      if (action === 'show') this.visible = true;
      this.layout();
      this.send({ ev: 'resize', width: this.panel.width, height: this.panel.height });
      if (!wasVisible && this.visible) this.send({ ev: 'panel', visible: true });
      return;
    }
    if (action === 'hide') {
      if (this.visible) {
        this.visible = false;
        this.layout();
        this.send({ ev: 'panel', visible: false });
      }
      return;
    }
    this.send({ ev: 'ideCommand', action, url: String(message.url || ''), tabId: Number(message.tabId) || -1 });
  }

  accept(socket) {
    let authenticated = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!authenticated) {
          if (message.op !== 'hello' || message.token !== this.token || this.socket) {
            socket.destroy(); return;
          }
          authenticated = true;
          this.socket = socket;
          this.send({ ev: 'welcome', folders: {
            downloads: electron.app.getPath('downloads'),
            desktop: electron.app.getPath('desktop'),
            appData: electron.app.getPath('appData'),
          }, width: this.panel.width, height: this.panel.height, visible: this.visible });
          if (this.visible) this.send({ ev: 'panel', visible: true });
          this.state();
          continue;
        }
        this.operation(message).catch((error) => this.reply(message.id, null, error));
      }
    });
    socket.on('error', (error) => this.log(`browser socket: ${error.message}`));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const pending of this.pending.values()) pending.reject(new Error('browser socket closed'));
      this.pending.clear();
      this.state();
    });
  }

  send(message) {
    if (!this.socket) return;
    try { this.socket.write(JSON.stringify(message) + '\n'); }
    catch (error) { this.log(`browser send: ${error.message}`); }
  }

  reply(id, result, error) {
    if (!Number.isInteger(id) || id <= 0) return;
    this.send(error ? { re: id, ok: false, error: String(error.message || error) }
      : { re: id, ok: true, result: result === undefined ? {} : result });
  }

  request(kind, message, timeoutMs = 30000) {
    const req = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req); reject(new Error(`${kind} timed out`)); }, timeoutMs);
      this.pending.set(req, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      this.send({ ev: kind, req, ...message });
    });
  }

  async resource(request) {
    if (!this.socket) return new Response('browser unavailable', { status: 503 });
    try {
      const answer = await this.request('resource', { url: request.url, method: request.method });
      return new Response(Buffer.from(answer.body || '', 'base64'), {
        status: answer.status || 200, headers: answer.headers || {},
      });
    } catch (error) {
      return new Response(String(error.message || error), { status: 502 });
    }
  }

  attachSession(session) {
    if (this.sessions.has(session)) return;
    this.sessions.add(session);
    session.protocol.handle('zaalis', (request) => this.resource(request));
    session.setPermissionCheckHandler((_webContents, permission, origin) => {
      if (String(origin).startsWith('zaalis://') && permission === 'media') return true;
      return this.permissions.get(`${origin}|${permission}`) === true;
    });
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const uri = String(details?.requestingUrl || webContents?.getURL() || '');
      if (uri.startsWith('zaalis://') && (permission === 'media' || permission === 'audioCapture')) return callback(true);
      const view = [...this.views.values()].find((entry) => entry.view.webContents === webContents);
      const req = this.nextRequest++;
      const kind = PERMISSION_KINDS[permission] || 0;
      const timer = setTimeout(() => { this.pending.delete(req); callback(false); }, 30000);
      this.pending.set(req, { resolve: (allow) => {
        clearTimeout(timer);
        let origin = uri;
        try { origin = new URL(uri).origin; } catch {}
        this.permissions.set(`${origin}|${permission}`, !!allow);
        callback(!!allow);
      }, reject: () => { clearTimeout(timer); callback(false); } });
      this.send({ ev: 'permission', req, view: view?.id || 0, uri, kind });
    });
    session.on('will-download', (_event, item, webContents) => {
      const view = [...this.views.values()].find((entry) => entry.view.webContents === webContents);
      const req = this.nextRequest++;
      this.downloads.set(req, item);
      this.send({ ev: 'downloadStarting', req, view: view?.id || 0,
        url: item.getURL(), path: item.getFilename(), total: item.getTotalBytes(), mime: item.getMimeType() });
      item.on('updated', (_event, state) => this.send({ ev: 'download', req, state,
        received: item.getReceivedBytes(), total: item.getTotalBytes() }));
      item.once('done', (_event, state) => {
        this.downloads.delete(req);
        this.send({ ev: 'download', req, state,
          received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
    });
  }

  createView(message) {
    const id = Number(message.view);
    if (!Number.isInteger(id) || id <= 0 || this.views.has(id)) return;
    const name = String(message.profile || 'zaalis-ui').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    const partition = message.inPrivate ? `zaalis-private-${process.pid}` : `persist:${name}`;
    const session = electron.session.fromPartition(partition);
    this.attachSession(session);
    const view = new electron.WebContentsView({ webPreferences: {
      partition, preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: message.backgroundThrottling !== false,
    } });
    const entry = { id, view, kind: String(message.kind || ''), visible: true, attached: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 }, selfNavigation: false };
    this.views.set(id, entry);
    const webContents = view.webContents;
    const emit = (ev, fields = {}) => this.send({ ev, view: id, ...fields });
    webContents.on('will-navigate', (event, url) => {
      let allowed = false;
      try { allowed = ALLOWED_SCHEMES.has(new URL(url).protocol); } catch {}
      if (!allowed) { event.preventDefault(); return; }
      emit('navStarting', { url, self: false, redirect: false });
    });
    webContents.on('did-start-loading', () => emit('navStarting', {
      url: webContents.getURL(), self: entry.selfNavigation, redirect: false,
    }));
    webContents.on('did-navigate', (_event, url) => {
      emit('committed', { url });
      emit('sourceChanged', { url, newDocument: true });
    });
    webContents.on('did-navigate-in-page', (_event, url) => emit('sourceChanged', { url, newDocument: false }));
    webContents.on('dom-ready', () => emit('domReady'));
    webContents.on('did-finish-load', () => {
      entry.selfNavigation = false;
      emit('completed', { ok: true, httpStatus: 200, url: webContents.getURL() });
      emit('history', { canBack: webContents.navigationHistory.canGoBack(),
        canForward: webContents.navigationHistory.canGoForward() });
    });
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (isMainFrame === false) return;
      entry.selfNavigation = false;
      emit('completed', { ok: false, status: errorCode, url,
        message: errorDescription, httpStatus: 0 });
    });
    webContents.on('page-title-updated', (_event, title) => emit('title', { title }));
    webContents.on('render-process-gone', () => emit('crashed'));
    webContents.on('console-message', (event, level, text, line, source) => {
      const details = level && typeof level === 'object' && 'message' in level ? level
        : event && typeof event === 'object' && 'message' in event ? event : null;
      emit('console', { level: details?.level || level, text: details?.message || text,
        line: details?.lineNumber || line, source: details?.sourceId || source });
    });
    webContents.setWindowOpenHandler(({ url }) => { emit('newWindow', { url }); return { action: 'deny' }; });
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toUpperCase();
      const hit = this.accelerators.find((item) => item.key === key &&
        !!item.ctrl === !!(input.meta || input.control) &&
        !!item.shift === !!input.shift && !!item.alt === !!input.alt);
      if (hit) { event.preventDefault(); emit('accelerator', { ...hit }); }
    });
    this.layoutOne(entry);
  }

  layout() { for (const entry of this.views.values()) this.layoutOne(entry); }

  layoutOne(entry) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    const shouldShow = this.visible && entry.visible && this.panel.width > 0 && this.panel.height > 0;
    if (!shouldShow) {
      if (entry.attached) { window.contentView.removeChildView(entry.view); entry.attached = false; }
      return;
    }
    const b = entry.bounds;
    const regionHeight = entry.chromeRegion
      ? Math.max(entry.chromeRegion.top || 0, entry.chromeRegion.overlay?.bottom || 0)
      : b.height;
    entry.view.setBounds({ x: this.panel.x + b.x, y: this.panel.y + b.y,
      width: Math.max(0, Math.min(b.width, this.panel.width - b.x)),
      height: Math.max(0, Math.min(b.height, regionHeight, this.panel.height - b.y)) });
    if (!entry.attached) { window.contentView.addChildView(entry.view); entry.attached = true; }
  }

  async operation(message) {
    const op = String(message.op || '');
    const id = Number(message.id) || 0;
    if (op === 'createView') { this.createView(message); return; }
    if (op === 'destroyView') {
      const entry = this.views.get(Number(message.view));
      if (entry) {
        if (entry.attached) this.getWindow()?.contentView.removeChildView(entry.view);
        entry.view.webContents.close(); this.views.delete(entry.id);
      }
      return;
    }
    if (op === 'resourceReply' || op === 'permissionReply') {
      const pending = this.pending.get(Number(message.req));
      if (pending) { this.pending.delete(Number(message.req)); pending.resolve(op === 'permissionReply' ? !!message.allow : message); }
      return;
    }
    if (op === 'downloadReply') {
      const item = this.downloads.get(Number(message.req));
      if (item && message.path) item.setSavePath(String(message.path));
      return;
    }
    if (op === 'downloadCancel') { this.downloads.get(Number(message.req))?.cancel(); return; }
    if (op === 'ideState') { this.tabs = Array.isArray(message.tabs) ? message.tabs : []; this.state(); return; }
    if (op === 'reveal') { this.rendererSend({ type: 'browserReveal' }); return; }
    if (op === 'accelerators') { this.accelerators = Array.isArray(message.keys) ? message.keys : []; return; }
    if (op === 'setPanelBackground') return;
    if (op === 'clipboard') { electron.clipboard.writeText(String(message.text || '')); return; }
    if (op === 'shell') {
      const target = String(message.path || '');
      if (message.action === 'showItemInFolder' && fs.existsSync(target)) electron.shell.showItemInFolder(target);
      else if (message.action === 'openPath' && fs.existsSync(target)) await electron.shell.openPath(target);
      else if (message.action === 'openExternal' && /^https?:\/\//i.test(target)) await electron.shell.openExternal(target);
      return;
    }
    if (op === 'messageBox') {
      const result = await electron.dialog.showMessageBox(this.getWindow(), {
        title: String(message.title || 'zaalis browser'), message: String(message.message || ''),
        detail: String(message.detail || ''), type: message.type || 'info',
        buttons: Array.isArray(message.buttons) ? message.buttons : ['OK'],
        defaultId: Number(message.defaultId) || 0, cancelId: Number(message.cancelId) || 0,
      });
      this.reply(id, { response: result.response }); return;
    }
    if (op === 'openFile') {
      const result = await electron.dialog.showOpenDialog(this.getWindow(), {
        title: String(message.title || ''), properties: ['openFile'],
        filters: Array.isArray(message.filters) ? message.filters : [],
      });
      this.reply(id, { path: result.filePaths?.[0] || '' }); return;
    }
    if (op === 'fileIcon') {
      const image = await electron.app.getFileIcon(String(message.path || ''));
      this.reply(id, { dataUrl: image.toDataURL() }); return;
    }
    if (op === 'squareImage') {
      const image = electron.nativeImage.createFromPath(String(message.source || ''));
      if (image.isEmpty()) throw new Error('image illisible');
      const size = Math.max(16, Math.min(1024, Number(message.size) || 256));
      const dimensions = image.getSize();
      const side = Math.min(dimensions.width, dimensions.height);
      const square = image.crop({ x: Math.floor((dimensions.width - side) / 2),
        y: Math.floor((dimensions.height - side) / 2), width: side, height: side }).resize({ width: size, height: size });
      fs.writeFileSync(String(message.target || ''), square.toPNG());
      this.reply(id, {}); return;
    }
    if (op === 'menu') {
      const entries = Array.isArray(message.items) ? message.items : [];
      const result = await new Promise((resolve) => {
        let chosen = -1;
        const menu = electron.Menu.buildFromTemplate(entries.map((item, index) => item.separator
          ? { type: 'separator' } : { label: String(item.label || ''), enabled: item.enabled !== false,
            click: () => { chosen = index; } }));
        menu.popup({ window: this.getWindow(), callback: () => resolve({ index: chosen }) });
      });
      this.reply(id, result); return;
    }

    const entry = this.views.get(Number(message.view));
    if (!entry) { this.reply(id, null, new Error('vue inconnue')); return; }
    const webContents = entry.view.webContents;
    if (op === 'setBounds') {
      entry.bounds = { x: Math.round(Number(message.x) || 0), y: Math.round(Number(message.y) || 0),
        width: Math.max(0, Math.round(Number(message.width) || 0)),
        height: Math.max(0, Math.round(Number(message.height) || 0)) };
      this.layoutOne(entry); return;
    }
    if (op === 'setVisible') { entry.visible = !!message.visible; this.layoutOne(entry); return; }
    if (op === 'raise') {
      const window = this.getWindow();
      if (entry.attached && window) {
        window.contentView.removeChildView(entry.view);
        window.contentView.addChildView(entry.view);
      }
      return;
    }
    if (op === 'setBackground') { entry.view.setBackgroundColor?.(String(message.color || '#fff')); return; }
    if (op === 'chromeRegion') {
      entry.chromeRegion = { top: Number(message.top) || 0, overlay: message.overlay || null };
      this.layoutOne(entry);
      return;
    }
    if (op === 'navigate') {
      const url = String(message.url || '');
      if (!ALLOWED_SCHEMES.has(new URL(url).protocol)) throw new Error('URL refusée');
      entry.selfNavigation = true;
      webContents.loadURL(url).catch((error) => this.log(`browser navigate: ${error.message}`));
      return;
    }
    if (op === 'goBack') { if (webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack(); return; }
    if (op === 'goForward') { if (webContents.navigationHistory.canGoForward()) webContents.navigationHistory.goForward(); return; }
    if (op === 'reload') { webContents.reload(); return; }
    if (op === 'stop') { webContents.stop(); return; }
    if (op === 'focus') { webContents.focus(); return; }
    if (op === 'post') {
      if (webContents.getURL().startsWith('zaalis://')) {
        webContents.send('zaalis-browser-message', JSON.parse(String(message.json || 'null')));
      }
      return;
    }
    if (op === 'setZoom') { webContents.setZoomFactor(Number(message.factor) || 1); return; }
    if (op === 'setMuted') { webContents.setAudioMuted(!!message.muted); return; }
    if (op === 'openDevTools') { webContents.openDevTools({ mode: 'detach' }); return; }
    if (op === 'cookies') {
      const cookies = await webContents.session.cookies.get(message.url ? { url: String(message.url) } : {});
      this.reply(id, { cookies }); return;
    }
    if (op === 'cdp') {
      if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
      const result = await webContents.debugger.sendCommand(String(message.method || ''), message.params || {});
      this.reply(id, result); return;
    }
    this.reply(id, null, new Error('operation inconnue'));
  }
}

module.exports = { BrowserBridge };
