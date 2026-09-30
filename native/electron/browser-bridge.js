'use strict';
// Same private JSON protocol as the Windows WebView2 host, backed by Electron.
const { app, WebContentsView, ipcMain, session, Menu, dialog, shell, clipboard, nativeImage, protocol } = require('electron');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
protocol.registerSchemesAsPrivileged([{ scheme: 'zaalis', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

class ElectronBrowserBridge {
  constructor() {
    this.token = crypto.randomBytes(32).toString('hex');
    this.pipe = path.join(os.tmpdir(), `zaalis-browser-${process.pid}-${crypto.randomBytes(8).toString('hex')}.sock`);
    this.views = new Map(); this.pending = new Map(); this.counter = 0;
    this.window = null; this.panel = { x: 0, y: 0, width: 0, height: 0 }; this.visible = false;
    this.sessions = new Set(); this.socket = null;
    ipcMain.on('browser-view-message', (event, message) => {
      const entry = [...this.views.values()].find(v => v.view.webContents === event.sender);
      if (entry) this.send({ ev: 'webMessage', view: entry.id, message: String(message) });
    });
    ipcMain.on('ide-native-message', (event, message) => {
      if (event.sender !== this.window?.webContents || message?.type !== 'browser') return;
      if (message.action === 'show') {
        this.panel = message.bounds; this.visible = true;
      } else if (message.action === 'hide') this.visible = false;
      else this.send({ ev: 'ideCommand', ...message });
      this.layout();
      this.send({ ev: 'panel', visible: this.visible });
      this.send({ ev: 'resize', width: this.panel.width, height: this.panel.height });
    });
    ipcMain.handle('ide-native-capabilities', event => {
      if (event.sender === this.window?.webContents) return { type: 'nativeCapabilities', browser: !!this.socket };
      return {};
    });
  }
  async start() {
    this.server = net.createServer(socket => {
      if (this.socket) { socket.destroy(); return; }
      let authenticated = false, buffer = '';
      socket.setEncoding('utf8');
      const timeout = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
      socket.on('error', () => {});
      socket.on('data', data => {
        buffer += data;
        if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let msg; try { msg = JSON.parse(line); } catch { socket.destroy(); return; }
          if (!authenticated) {
            if (msg.op !== 'hello' || msg.token !== this.token) { socket.destroy(); return; }
            authenticated = true; clearTimeout(timeout); this.socket = socket;
            this.send({ ev: 'welcome', width: this.panel.width, height: this.panel.height, folders: {
              userData: path.join(app.getPath('appData'), 'zaalis', 'Browser'), home: os.homedir(),
              downloads: app.getPath('downloads'), temp: os.tmpdir(), desktop: app.getPath('desktop'),
            } });
            this.notify({ type: 'nativeCapabilities', browser: true });
            continue;
          }
          this.handle(msg).then(result => { if (msg.id != null) this.send({ re: msg.id, result }); }, error => {
            if (msg.id != null) this.send({ re: msg.id, ok: false, error: error.message });
            else console.error('[browser bridge]', msg.op, error.message);
          });
        }
      });
      socket.on('close', () => {
        clearTimeout(timeout);
        if (this.socket !== socket) return;
        this.socket = null; this.visible = false; this.layout();
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser server closed')); }
        this.pending.clear(); this.notify({ type: 'browserState', available: false });
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.pipe, resolve); });
    fs.chmodSync(this.pipe, 0o600);
    return { ZAALIS_BROWSER_PIPE: this.pipe, ZAALIS_BROWSER_TOKEN: this.token };
  }
  attach(window) {
    this.window = window;
    window.webContents.on('did-finish-load', () => this.notify({ type: 'nativeCapabilities', browser: !!this.socket }));
  }
  notify(message) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send('ide-native-event', message); }
  send(message) { if (this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify(message) + '\n'); }
  request(ev, params) {
    const req = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req); reject(new Error(`${ev} timeout`)); }, 30000);
      this.pending.set(req, { resolve, reject, timer }); this.send({ ev, req, ...params });
    });
  }
  layout() {
    for (const v of this.views.values()) {
      v.view.setVisible(this.visible && v.visible);
      const b = v.bounds || { x: 0, y: 0, width: 0, height: 0 };
      v.view.setBounds({ x: Math.round((this.panel.x || 0) + b.x), y: Math.round((this.panel.y || 0) + b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(v.regionHeight == null ? b.height : Math.min(b.height, v.regionHeight))) });
    }
  }
  setupSession(ses) {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    ses.protocol.handle('zaalis', async request => {
      const result = await this.request('resource', { url: request.url, method: request.method });
      return new Response(Buffer.from(result.body || '', 'base64'), { status: result.status || 404, headers: result.headers });
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const v = [...this.views.values()].find(v => v.view.webContents === wc);
      const kinds = { media: 2, geolocation: 3, notifications: 4, 'clipboard-read': 6 };
      this.request('permission', { view: v?.id, kind: kinds[permission] || 0, uri: details.requestingUrl || wc.getURL() })
        .then(result => callback(!!result.allow), () => callback(false));
    });
    ses.on('will-download', (_event, item, wc) => {
      const v = [...this.views.values()].find(v => v.view.webContents === wc);
      this.request('downloadStarting', { view: v?.id, url: item.getURL(), path: item.getFilename(), total: item.getTotalBytes(), mime: item.getMimeType() })
        .then(result => { if (result.path) item.setSavePath(result.path); }, () => item.cancel());
      item.on('updated', (_event, state) => this.send({ ev: 'download', req: item._zaalisReq, state, received: item.getReceivedBytes(), total: item.getTotalBytes() }));
      item.on('done', (_event, state) => this.send({ ev: 'download', req: item._zaalisReq, state, received: item.getReceivedBytes(), total: item.getTotalBytes() }));
      item._zaalisReq = this.counter;
      this.downloads ||= new Map(); this.downloads.set(item._zaalisReq, item);
      item.once('done', () => this.downloads.delete(item._zaalisReq));
    });
  }
  create(msg) {
    if (!this.window) throw new Error('IDE window unavailable');
    const partition = msg.inPrivate ? `zaalis-private-${msg.profile || 'guest'}` : `persist:zaalis-browser-${msg.profile || 'default'}`;
    const ses = session.fromPartition(partition); this.setupSession(ses);
    const view = new WebContentsView({ webPreferences: { session: ses, preload: path.join(__dirname, 'browser-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: msg.backgroundThrottling } });
    view.setBackgroundColor(msg.kind === 'tab' ? '#ffffff' : '#00000000');
    const v = { id: msg.view, kind: msg.kind, view, visible: true }; this.views.set(msg.view, v);
    this.window.contentView.addChildView(view); view.setVisible(false);
    const wc = view.webContents;
    const emit = (ev, fields = {}) => this.send({ ev, view: msg.view, ...fields });
    wc.on('did-start-navigation', (_e, url, inPlace, main) => { if (main) emit('navStarting', { url, self: true }); });
    wc.on('will-navigate', (_e, url) => emit('navStarting', { url, self: false }));
    wc.on('did-navigate', (_e, url, code) => emit('committed', { url, httpStatus: code }));
    wc.on('did-navigate-in-page', (_e, url, main) => { if (main) emit('sourceChanged', { url, newDocument: false }); });
    wc.on('dom-ready', () => emit('domReady'));
    wc.on('did-finish-load', () => { emit('completed', { url: wc.getURL(), ok: true, httpStatus: 200 }); emit('history', { canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() }); });
    wc.on('did-fail-load', (_e, code, error, url, main) => { if (main) emit('completed', { url, ok: false, error, code }); });
    wc.on('page-title-updated', (_e, title) => emit('title', { title }));
    wc.on('audio-state-changed', () => emit('audible', { audible: wc.isCurrentlyAudible() }));
    wc.on('console-message', (_e, details) => emit('console', { level: details.level, text: details.message, line: details.lineNumber, source: details.sourceId }));
    wc.on('context-menu', (_e, p) => emit('contextMenu', { x: p.x, y: p.y, link: p.linkURL, selection: p.selectionText, editable: p.isEditable }));
    wc.setWindowOpenHandler(({ url }) => { emit('newWindow', { url }); return { action: 'deny' }; });
    wc.on('render-process-gone', () => emit('crashed'));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const aliases = { arrowleft: 'Left', arrowright: 'Right', tab: 'Tab', '+': '=', '=': '=' };
      const shortcut = { key: aliases[input.key.toLowerCase()] || input.key.toUpperCase(), ctrl: !!(input.control || input.meta), alt: !!input.alt, shift: !!input.shift };
      if ((this.accelerators || []).some(k => k.key === shortcut.key && k.ctrl === shortcut.ctrl && k.alt === shortcut.alt && k.shift === shortcut.shift)) {
        event.preventDefault(); emit('accelerator', shortcut);
      }
    });
  }
  async handle(m) {
    const v = this.views.get(m.view), wc = v?.view.webContents;
    switch (m.op) {
      case 'createView': return this.create(m);
      case 'destroyView': if (v) { this.window?.contentView.removeChildView(v.view); wc.close(); this.views.delete(m.view); } return;
      case 'setBounds': if (v) { v.bounds = { x: m.x, y: m.y, width: m.width, height: m.height }; this.layout(); } return;
      case 'setVisible': if (v) { v.visible = m.visible; this.layout(); } return;
      case 'raise': if (v) this.window.contentView.addChildView(v.view); return;
      case 'navigate': wc?.loadURL(m.url).catch(() => {}); return;
      case 'goBack': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return;
      case 'goForward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return;
      case 'reload': wc?.reload(); return;
      case 'stop': wc?.stop(); return;
      case 'focus': wc?.focus(); return;
      case 'post': wc?.send('browser-post', m.json); return;
      case 'setZoom': wc?.setZoomFactor(m.factor); return;
      case 'setMuted': wc?.setAudioMuted(m.muted); return;
      case 'openDevTools': wc?.openDevTools({ mode: 'detach' }); return;
      case 'setBackground': v?.view.setBackgroundColor(v.kind === 'tab' && m.color === '#00000000' ? '#ffffff' : m.color); return;
      case 'cdp': if (!wc) throw new Error('Unknown browser view'); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); return wc.debugger.sendCommand(m.method, m.params || {});
      case 'cookies': return { cookies: await wc.session.cookies.get(m.url ? { url: m.url } : {}) };
      case 'resourceReply': case 'permissionReply': case 'downloadReply': {
        const p = this.pending.get(m.req); if (p) { clearTimeout(p.timer); this.pending.delete(m.req); p.resolve(m); } return;
      }
      case 'downloadCancel': this.downloads?.get(m.req)?.cancel(); return;
      case 'ideState': this.notify({ type: 'browserState', available: true, tabs: m.tabs }); return;
      case 'reveal': this.notify({ type: 'browserReveal' }); return;
      case 'menu': return new Promise(resolve => {
        let selected = false;
        const menu = Menu.buildFromTemplate((m.items || []).map((item, index) => item.type === 'separator' ? { type: 'separator' } : { label: item.label, enabled: item.enabled !== false, type: item.type || 'normal', checked: !!item.checked, click: () => { selected = true; resolve({ index }); } }));
        menu.popup({ window: this.window, callback: () => { if (!selected) resolve({ index: -1 }); } });
      });
      case 'messageBox': return dialog.showMessageBox(this.window, m);
      case 'openFile': { const result = await dialog.showOpenDialog(this.window, { title: m.title, properties: ['openFile'], filters: m.filters }); return { path: result.canceled ? '' : result.filePaths[0] }; }
      case 'fileIcon': return { dataUrl: (await app.getFileIcon(m.path)).toDataURL() };
      case 'squareImage': { const img = nativeImage.createFromPath(m.source).resize({ width: m.size, height: m.size }); fs.writeFileSync(m.target, img.toPNG()); return { ok: true }; }
      case 'shell': if (m.action === 'openExternal') { if (/^https?:\/\//i.test(m.path)) await shell.openExternal(m.path); } else if (m.action === 'showItemInFolder') shell.showItemInFolder(m.path); else if (m.action === 'openPath') await shell.openPath(m.path); return;
      case 'clipboard': clipboard.writeText(m.text); return;
      case 'chromeRegion': if (v) { v.regionHeight = Math.max(m.top || m.height || 0, m.overlay?.bottom || 0); this.layout(); } return;
      case 'accelerators': this.accelerators = m.keys || []; return;
      case 'setPanelBackground': return;
      default: throw new Error(`Unknown browser operation: ${m.op}`);
    }
  }
  close() {
    this.socket?.destroy(); this.server?.close();
    for (const v of this.views.values()) { try { v.view.webContents.close(); } catch {} }
    this.views.clear(); try { fs.unlinkSync(this.pipe); } catch {}
  }
}
module.exports = { ElectronBrowserBridge };
