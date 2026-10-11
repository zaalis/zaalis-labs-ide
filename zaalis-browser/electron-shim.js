'use strict';

// Electron-compatible surface for zaalis Browser running inside zaalis-server.
//
// zaalis-browser/app/main.js is the real zaalis Browser main process. Here it
// does not drive Chromium through Electron but WebView2 views owned by the IDE
// shell (native/browser/BrowserHost.cpp), through the private channel managed
// by host.js. Only the parts of Electron the browser actually uses exist, with
// Electron's semantics: views, webContents, sessions, ipcMain, menus, dialogs.

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Chromium net error codes as Electron reports them in did-fail-load, indexed
// by COREWEBVIEW2_WEB_ERROR_STATUS.
const WEB_ERROR_CODES = {
  0: -2, 1: -200, 2: -201, 3: -110, 4: -206, 5: -207, 6: -109, 7: -118, 8: -320,
  9: -103, 10: -101, 11: -106, 12: -102, 13: -105, 14: -3, 15: -310, 16: -9,
  17: -338, 18: -127, 19: -129, 20: -130,
};
const WEB_ERROR_NAMES = {
  '-2': 'ERR_FAILED', '-3': 'ERR_ABORTED', '-9': 'ERR_UNEXPECTED', '-101': 'ERR_CONNECTION_RESET',
  '-102': 'ERR_CONNECTION_REFUSED', '-103': 'ERR_CONNECTION_ABORTED', '-105': 'ERR_NAME_NOT_RESOLVED',
  '-106': 'ERR_INTERNET_DISCONNECTED', '-109': 'ERR_ADDRESS_UNREACHABLE', '-118': 'ERR_CONNECTION_TIMED_OUT',
  '-200': 'ERR_CERT_COMMON_NAME_INVALID', '-201': 'ERR_CERT_DATE_INVALID', '-207': 'ERR_CERT_INVALID',
  '-310': 'ERR_TOO_MANY_REDIRECTS', '-320': 'ERR_INVALID_RESPONSE',
};

// WebView2 permission kinds -> Electron permission names.
const PERMISSION_NAMES = {
  1: 'media', 2: 'media', 3: 'geolocation', 4: 'notifications', 5: 'sensors',
  6: 'clipboard-read', 7: 'automatic-downloads', 8: 'fileSystem', 9: 'autoplay',
  10: 'local-fonts', 11: 'midiSysex', 12: 'window-management',
};

// Keys the browser's agent may press through sendInputEvent.
const KEYS = {
  Return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

// A promise that never produces an unhandled rejection: Electron callers often
// fire loadURL/executeJavaScript without awaiting, and inside zaalis-server an
// unhandled rejection would take the whole IDE backend down.
function quiet(promise) {
  promise.catch(() => {});
  return promise;
}

function createElectron(host, hooks = {}) {
  const views = new Map();
  const sessions = new Map();
  const protocolHandlers = new Map();
  let nextViewId = 1;
  let windowSize = [0, 0];
  let mainWindow = null;
  let menuAccelerators = [];

  // ----- Sessions -----------------------------------------------------------
  class Cookies {
    constructor(session) { this.session = session; }
    get(filter) {
      const view = this.session.anyView();
      if (!view) return Promise.resolve([]);
      return quiet(host.command('cookies', { view: view.id, url: String(filter && filter.url || '') })
        .then((result) => (result && result.cookies) || []));
    }
  }

  class Session extends EventEmitter {
    constructor(partition) {
      super();
      this.partition = partition;
      this.cookies = new Cookies(this);
      this.permissionRequestHandler = null;
      this.permissionCheckHandler = null;
      this.protocol = { handle: (scheme, handler) => protocolHandlers.set(scheme, handler) };
    }
    anyView() {
      for (const view of views.values()) {
        if (!view.webContents.isDestroyed() && view.session === this) return view;
      }
      return null;
    }
    setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
    setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
    clearStorageData(options) {
      const view = this.anyView();
      const origin = options && options.origin;
      if (!view || !origin) return Promise.resolve();
      return quiet(host.command('cdp', { view: view.id, method: 'Storage.clearDataForOrigin',
        params: { origin, storageTypes: 'all' } }).then(() => undefined));
    }
  }

  function sessionFor(partition) {
    const key = String(partition || '');
    if (!sessions.has(key)) sessions.set(key, new Session(key));
    return sessions.get(key);
  }

  // WebView2 profile of a partition: persistent partitions map to a named
  // profile, anything else (incognito) is InPrivate.
  function profileOf(partition) {
    const value = String(partition || '');
    if (!value) return { profile: 'zaalis-ui', inPrivate: false };
    if (!value.startsWith('persist:')) return { profile: 'zaalis-private', inPrivate: true };
    return { profile: value.slice(8).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'zaalis-browser', inPrivate: false };
  }

  // ----- webContents ----------------------------------------------------------
  class WebContents extends EventEmitter {
    constructor(view, preferences) {
      super();
      this.view = view;
      this.id = view.id;
      this.url = '';
      this.title = '';
      this.loading = false;
      this.canBack = false;
      this.canForward = false;
      this.audible = false;
      this.zoom = 1;
      this.destroyed = false;
      this.devToolsOpened = false;
      this.windowOpenHandler = null;
      this.mainFrame = { routingId: view.id };
      this.session = view.session;
      this.pendingLoads = [];
      this.isolatedWorlds = new Map();
      const self = this;
      this.navigationHistory = {
        canGoBack: () => self.canBack,
        canGoForward: () => self.canForward,
        goBack: () => host.send('goBack', { view: self.id }),
        goForward: () => host.send('goForward', { view: self.id }),
      };
      void preferences;
    }
    getURL() { return this.url; }
    getTitle() { return this.title || ''; }
    isDestroyed() { return this.destroyed; }
    isLoading() { return this.loading; }
    isCurrentlyAudible() { return this.audible; }
    isDevToolsOpened() { return this.devToolsOpened; }
    getZoomFactor() { return this.zoom; }

    loadURL(url) {
      if (this.destroyed) return quiet(Promise.reject(new Error('webContents détruit')));
      const target = String(url || '');
      this.url = this.url || target;
      host.send('navigate', { view: this.id, url: target });
      return quiet(new Promise((resolve, reject) => this.pendingLoads.push({ resolve, reject })));
    }
    settleLoads(error) {
      const pending = this.pendingLoads.splice(0);
      for (const entry of pending) error ? entry.reject(error) : entry.resolve();
    }
    reload() { host.send('reload', { view: this.id }); }
    reloadIgnoringCache() {
      quiet(host.command('cdp', { view: this.id, method: 'Page.reload', params: { ignoreCache: true } }));
    }
    stop() { host.send('stop', { view: this.id }); }
    focus() { host.send('focus', { view: this.id }); }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      host.send('destroyView', { view: this.id });
      views.delete(this.id);
      this.settleLoads(new Error('webContents fermé'));
      this.emit('destroyed');
    }
    send(channel, data) {
      if (this.destroyed || channel !== 'zaalis:message') return;
      let json;
      try { json = JSON.stringify(data); } catch { return; }
      host.send('post', { view: this.id, json });
      if (hooks.onPost) { try { hooks.onPost(this, data); } catch {} }
    }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    setZoomFactor(factor) {
      const value = Number(factor);
      if (!Number.isFinite(value) || value <= 0) return;
      this.zoom = value;
      host.send('setZoom', { view: this.id, factor: value });
    }
    setAudioMuted(muted) { host.send('setMuted', { view: this.id, muted: !!muted }); }
    openDevTools() { this.devToolsOpened = true; host.send('openDevTools', { view: this.id }); }
    closeDevTools() { this.devToolsOpened = false; }
    inspectElement() { this.openDevTools(); }
    insertCSS(css) {
      return this.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(String(css))};` +
        ' (document.head || document.documentElement).appendChild(s); })()');
    }

    cdp(method, params) {
      if (this.destroyed) return quiet(Promise.reject(new Error('webContents détruit')));
      return quiet(host.command('cdp', { view: this.id, method, params: params || {} }));
    }

    // Runtime.evaluate awaits promises (ExecuteScript does not) and returns the
    // value itself, which is what Electron's executeJavaScript resolves to.
    executeJavaScript(code, userGesture) {
      return quiet(this.cdp('Runtime.evaluate', {
        expression: String(code), awaitPromise: true, returnByValue: true,
        userGesture: userGesture !== false, allowUnsafeEvalBlockedByCSP: true,
      }).then((result) => evaluationValue(result)));
    }

    // A dedicated isolated world per document: same DOM, separate JavaScript
    // context, so the page can neither read nor tamper with the agent's refs.
    async executeJavaScriptInIsolatedWorld(worldId, scripts, userGesture) {
      const code = (scripts || []).map((script) => script.code).join(';\n');
      for (let attempt = 0; attempt < 2; attempt++) {
        let contextId = this.isolatedWorlds.get(worldId);
        if (!contextId) {
          const tree = await this.cdp('Page.getFrameTree', {});
          const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
          const world = await this.cdp('Page.createIsolatedWorld', { frameId, worldName: `zaalis-agent-${worldId}` });
          contextId = world && world.executionContextId;
          if (!contextId) throw new Error('monde isolé indisponible');
          this.isolatedWorlds.set(worldId, contextId);
        }
        try {
          const result = await this.cdp('Runtime.evaluate', {
            expression: code, contextId, awaitPromise: true, returnByValue: true, userGesture: userGesture !== false,
          });
          return evaluationValue(result);
        } catch (error) {
          this.isolatedWorlds.delete(worldId);
          if (attempt === 1 || !/context/i.test(String(error && error.message))) throw error;
        }
      }
      return undefined;
    }

    insertText(text) {
      return this.cdp('Input.insertText', { text: String(text) }).then(() => undefined);
    }

    // Electron input events in DIP; the DevTools protocol wants CSS pixels.
    sendInputEvent(event) {
      const type = event && event.type;
      const scale = this.zoom || 1;
      if (type === 'mouseMove' || type === 'mouseDown' || type === 'mouseUp') {
        const names = { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased' };
        this.cdp('Input.dispatchMouseEvent', {
          type: names[type], x: Number(event.x || 0) / scale, y: Number(event.y || 0) / scale,
          button: type === 'mouseMove' ? 'none' : (event.button || 'left'),
          clickCount: type === 'mouseMove' ? 0 : (event.clickCount || 1),
        });
        return;
      }
      if (type === 'keyDown' || type === 'keyUp' || type === 'char') {
        const key = KEYS[event.keyCode] || { key: String(event.keyCode || ''), code: '', vk: 0, text: String(event.keyCode || '') };
        if (type === 'char') {
          if (key.text) this.cdp('Input.dispatchKeyEvent', { type: 'char', text: key.text, unmodifiedText: key.text });
          return;
        }
        this.cdp('Input.dispatchKeyEvent', {
          type: type === 'keyDown' ? 'rawKeyDown' : 'keyUp', key: key.key, code: key.code,
          windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk,
        });
      }
    }
  }

  function evaluationValue(result) {
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || 'Erreur JavaScript';
      throw new Error(String(text));
    }
    return result && result.result ? result.result.value : undefined;
  }

  // ----- Views -------------------------------------------------------------------
  class WebContentsView {
    constructor(options) {
      const preferences = (options && options.webPreferences) || {};
      this.id = nextViewId++;
      this.session = sessionFor(preferences.partition || '');
      this.webContents = new WebContents(this, preferences);
      this.bounds = null;
      this.visible = true;
      this.kind = /preload-content/.test(String(preferences.preload || '')) ? 'tab' : 'ui';
      views.set(this.id, this);
      const { profile, inPrivate } = profileOf(preferences.partition);
      host.send('createView', {
        view: this.id, kind: this.kind, profile, inPrivate,
        backgroundThrottling: preferences.backgroundThrottling !== false,
      });
    }
    setBounds(bounds) {
      const next = {
        x: Math.round(bounds.x || 0), y: Math.round(bounds.y || 0),
        width: Math.max(0, Math.round(bounds.width || 0)), height: Math.max(0, Math.round(bounds.height || 0)),
      };
      if (this.bounds && this.bounds.x === next.x && this.bounds.y === next.y &&
          this.bounds.width === next.width && this.bounds.height === next.height) return;
      this.bounds = next;
      host.send('setBounds', { view: this.id, ...next });
    }
    getBounds() { return { ...(this.bounds || { x: 0, y: 0, width: 0, height: 0 }) }; }
    setVisible(visible) {
      if (this.visible === !!visible) return;
      this.visible = !!visible;
      host.send('setVisible', { view: this.id, visible: this.visible });
    }
    setBackgroundColor(color) { host.send('setBackground', { view: this.id, color: String(color || '') }); }
  }

  const contentView = {
    // Electron stacks the last added view on top.
    addChildView(view) {
      if (!view) return;
      host.send('raise', { view: view.id });
      if (!view.visible) view.setVisible(true);
    },
    removeChildView(view) { if (view) view.setVisible(false); },
  };

  class BaseWindow extends EventEmitter {
    constructor() {
      super();
      this.contentView = contentView;
      mainWindow = this;
    }
    getContentSize() { return windowSize.slice(); }
    show() {}
    focus() {}
    maximize() {}
    unmaximize() {}
    isMaximized() { return false; }
    setBackgroundColor(color) { host.send('setPanelBackground', { color: String(color || '') }); }
  }

  // ----- Menus ---------------------------------------------------------------------
  class MenuImpl {
    constructor(template) { this.items = template || []; }
    popup() {
      const flat = this.items.filter((item) => item && item.visible !== false);
      const entries = flat.map((item) => item.type === 'separator'
        ? { separator: true }
        : { label: String(host.translate ? host.translate(item.label || roleLabel(item.role)) : item.label || roleLabel(item.role)), enabled: item.enabled !== false });
      quiet(host.command('menu', { items: entries }).then((result) => {
        const index = result && Number.isInteger(result.index) ? result.index : -1;
        const item = flat[index];
        if (!item || item.type === 'separator' || item.enabled === false) return;
        if (typeof item.click === 'function') item.click();
        else if (item.role === 'copy' && contextMenuTarget) contextMenuTarget.executeJavaScript('document.execCommand("copy")');
      }));
    }
  }
  let contextMenuTarget = null;
  function roleLabel(role) { return role === 'copy' ? 'Copier' : String(role || ''); }

  function collectAccelerators(items, out) {
    for (const item of items || []) {
      if (!item) continue;
      if (item.submenu) collectAccelerators(Array.isArray(item.submenu) ? item.submenu : item.submenu.items, out);
      if (item.accelerator && typeof item.click === 'function') out.push(item);
    }
    return out;
  }

  // "CmdOrCtrl+Shift+T" -> { ctrl, shift, alt, key: 'T' } matching the shell's
  // AcceleratorKeyPressed events (virtual-key names).
  function parseAccelerator(accelerator) {
    const parts = String(accelerator).split('+');
    const out = { ctrl: false, shift: false, alt: false, key: '' };
    for (const raw of parts) {
      const part = raw.trim();
      const lower = part.toLowerCase();
      if (['cmdorctrl', 'commandorcontrol', 'ctrl', 'control', 'cmd', 'command'].includes(lower)) out.ctrl = true;
      else if (lower === 'shift') out.shift = true;
      else if (lower === 'alt' || lower === 'option') out.alt = true;
      else if (part === '' && raw === '') out.key = '+';
      else out.key = part;
    }
    const aliases = { plus: '=', '+': '=', left: 'Left', right: 'Right', tab: 'Tab' };
    out.key = aliases[out.key.toLowerCase()] || out.key.toUpperCase();
    return out;
  }

  const Menu = {
    buildFromTemplate: (template) => new MenuImpl(template),
    setApplicationMenu(menu) {
      menuAccelerators = collectAccelerators(menu ? menu.items : [], []).map((item) => ({ item, key: parseAccelerator(item.accelerator) }));
      const unique = new Map();
      for (const entry of menuAccelerators) unique.set(JSON.stringify(entry.key), entry.key);
      host.send('accelerators', { keys: [...unique.values()] });
    },
  };

  // ----- ipcMain, app, dialogs ----------------------------------------------------
  const ipcMain = new EventEmitter();

  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const app = new EventEmitter();
  let knownFolders = {};
  Object.assign(app, {
    whenReady: () => readyPromise,
    isReady: () => !!app.ready,
    setName() {}, setAppUserModelId() {}, setPath() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    quit() {}, exit() {},
    focus() { host.send('reveal', {}); },
    getAppPath: () => path.join(__dirname, 'app'),
    getPath(name) {
      if (name === 'appData') return process.env.APPDATA || knownFolders.appData || path.join(os.homedir(), 'AppData', 'Roaming');
      if (name === 'downloads') return knownFolders.downloads || path.join(os.homedir(), 'Downloads');
      if (name === 'desktop') return knownFolders.desktop || path.join(os.homedir(), 'Desktop');
      if (name === 'userData') return process.env.ZAALIS_BROWSER_DATA || os.tmpdir();
      return os.homedir();
    },
    getFileIcon(filePath) {
      return quiet(host.command('fileIcon', { path: String(filePath) }).then((result) => nativeImageFromDataUrl(result && result.dataUrl)));
    },
  });

  const dialog = {
    showMessageBox(_window, options) {
      const opts = options || _window || {};
      return quiet(host.command('messageBox', {
        title: String(opts.title || 'zaalis browser'), message: String(opts.message || ''),
        detail: String(opts.detail || ''), buttons: (opts.buttons || ['OK']).map(String),
        defaultId: Number(opts.defaultId) || 0, cancelId: Number.isInteger(opts.cancelId) ? opts.cancelId : 0,
        type: String(opts.type || 'info'),
      }).then((result) => ({ response: Number(result && result.response) || 0 })));
    },
    showOpenDialog(_window, options) {
      const opts = options || _window || {};
      return quiet(host.command('openFile', {
        title: String(opts.title || ''),
        filters: (opts.filters || []).map((filter) => ({ name: String(filter.name), extensions: (filter.extensions || []).map(String) })),
      }).then((result) => (result && result.path ? { canceled: false, filePaths: [result.path] } : { canceled: true, filePaths: [] })));
    },
  };

  function nativeImageFromDataUrl(dataUrl) {
    const value = String(dataUrl || '');
    return { isEmpty: () => !value, toDataURL: () => value };
  }

  // Profile photos are cropped and scaled by the shell (WIC): Node has no image
  // codec, and the vendored main.js calls this helper instead (sync patch).
  const nativeImage = {
    createFromPath(filePath) { return { isEmpty: () => !fs.existsSync(String(filePath)), path: String(filePath) }; },
    squareAvatar(source, target, size) {
      return host.command('squareImage', { source: String(source), target: String(target), size: Number(size) || 256 });
    },
  };

  const shell = {
    showItemInFolder: (target) => host.send('shell', { action: 'showItemInFolder', path: String(target) }),
    openPath: (target) => { host.send('shell', { action: 'openPath', path: String(target) }); return Promise.resolve(''); },
    openExternal: (target) => { host.send('shell', { action: 'openExternal', path: String(target) }); return Promise.resolve(); },
  };

  const clipboard = { writeText: (text) => host.send('clipboard', { text: String(text) }) };

  // Electron's net.request, over Node's fetch (same machine, same user).
  const net = {
    request(options) {
      const opts = typeof options === 'string' ? { url: options } : (options || {});
      const request = new EventEmitter();
      const headers = {};
      const controller = new AbortController();
      request.setHeader = (name, value) => { headers[name] = String(value); };
      request.abort = () => controller.abort();
      request.end = (body) => {
        fetch(opts.url, { method: opts.method || 'GET', headers, body: body === undefined ? undefined : body,
          redirect: opts.redirect === 'manual' ? 'manual' : 'follow', signal: controller.signal })
          .then(async (response) => {
            const incoming = new EventEmitter();
            incoming.statusCode = response.status;
            incoming.headers = Object.fromEntries(response.headers.entries());
            request.emit('response', incoming);
            try {
              const buffer = Buffer.from(await response.arrayBuffer());
              if (buffer.length) incoming.emit('data', buffer);
              incoming.emit('end');
            } catch (error) { incoming.emit('error', error); }
          })
          .catch((error) => request.emit('error', error));
      };
      return request;
    },
  };

  const protocol = { registerSchemesAsPrivileged() {}, handle: (scheme, handler) => protocolHandlers.set(scheme, handler) };

  const session = {
    fromPartition: sessionFor,
    get defaultSession() { return sessionFor(''); },
  };

  // ----- Shell events -> Electron events -------------------------------------------
  function viewOf(message) {
    const view = views.get(Number(message.view));
    return view && !view.webContents.isDestroyed() ? view : null;
  }

  function emitSafe(target, ...args) {
    try { target.emit(...args); } catch (error) { host.log(`[zaalis browser] ${args[0]} : ${error && error.stack || error}`); }
  }

  async function handleResource(message) {
    let reply = { req: message.req, status: 404, headers: { 'content-type': 'text/plain' }, body: '' };
    try {
      const scheme = String(message.url || '').split(':')[0];
      const handler = protocolHandlers.get(scheme);
      if (handler) {
        const response = await handler({ url: String(message.url), method: String(message.method || 'GET') });
        let buffer = Buffer.from(await response.arrayBuffer());
        if (String(message.url).startsWith('zaalis://home/') && (response.headers.get('content-type') || '').includes('text/html')) {
          const locale = require('./locale');
          buffer = Buffer.from(buffer.toString('utf8').replace('</body>', '<script>' + locale.client(host.language || 'fr') + '</script></body>'));
        }
        reply = { req: message.req, status: response.status, headers: Object.fromEntries(response.headers.entries()), body: buffer.toString('base64') };
      }
    } catch (error) {
      reply = { req: message.req, status: 500, headers: { 'content-type': 'text/plain' }, body: Buffer.from(String(error && error.message || error)).toString('base64') };
    }
    host.send('resourceReply', reply);
  }

  const downloads = new Map();
  function handleDownloadStarting(message) {
    const view = viewOf(message);
    const item = new EventEmitter();
    let savePath = String(message.path || '');
    let received = 0;
    let total = Number(message.total) || 0;
    Object.assign(item, {
      getFilename: () => path.basename(String(message.path || message.url || 'telechargement')),
      getURL: () => String(message.url || ''),
      getTotalBytes: () => total,
      getReceivedBytes: () => received,
      getMimeType: () => String(message.mime || ''),
      setSavePath: (value) => { savePath = String(value || ''); },
      getSavePath: () => savePath,
      cancel: () => host.send('downloadCancel', { req: message.req }),
      pause() {}, resume() {},
      update(state, bytes, bytesTotal) { received = Number(bytes) || received; total = Number(bytesTotal) || total; },
    });
    downloads.set(message.req, item);
    const ses = view ? view.session : sessionFor('persist:zaalis-browser');
    emitSafe(ses, 'will-download', { preventDefault() {} }, item, view ? view.webContents : null);
    host.send('downloadReply', { req: message.req, path: savePath });
  }

  function handleDownloadProgress(message) {
    const item = downloads.get(message.req);
    if (!item) return;
    item.update(message.state, message.received, message.total);
    if (message.state === 'progressing' || message.state === 'interrupted-resumable') {
      emitSafe(item, 'updated', {}, message.state === 'progressing' ? 'progressing' : 'interrupted');
      return;
    }
    downloads.delete(message.req);
    emitSafe(item, 'done', {}, message.state === 'completed' ? 'completed' : message.state === 'cancelled' ? 'cancelled' : 'interrupted');
  }

  function handlePermission(message) {
    const view = viewOf(message);
    const permission = PERMISSION_NAMES[message.kind] || 'unknown';
    const reply = (allow) => host.send('permissionReply', { req: message.req, allow: !!allow });
    const handler = view && view.session.permissionRequestHandler;
    if (!handler) return reply(false);
    let answered = false;
    try {
      handler(view.webContents, permission, (allow) => { if (!answered) { answered = true; reply(allow); } },
        { requestingUrl: String(message.uri || ''), isMainFrame: true });
    } catch { if (!answered) reply(false); }
  }

  function handleEvent(message) {
    switch (message.ev) {
      case 'resize':
        windowSize = [Math.max(0, Math.round(message.width || 0)), Math.max(0, Math.round(message.height || 0))];
        if (mainWindow) emitSafe(mainWindow, 'resize');
        return;
      case 'resource': handleResource(message); return;
      case 'downloadStarting': handleDownloadStarting(message); return;
      case 'download': handleDownloadProgress(message); return;
      case 'permission': handlePermission(message); return;
      case 'accelerator': {
        const key = JSON.stringify({ ctrl: !!message.ctrl, shift: !!message.shift, alt: !!message.alt, key: String(message.key || '') });
        const entry = menuAccelerators.find((candidate) => JSON.stringify(candidate.key) === key);
        if (entry) { try { entry.item.click(); } catch (error) { host.log(String(error && error.stack || error)); } }
        return;
      }
      default: break;
    }
    const view = viewOf(message);
    if (!view) return;
    const wc = view.webContents;
    switch (message.ev) {
      case 'navStarting': {
        if (!wc.loading) { wc.loading = true; emitSafe(wc, 'did-start-loading'); }
        if (!message.self && !message.redirect) {
          let prevented = false;
          emitSafe(wc, 'will-navigate', { preventDefault() { prevented = true; }, url: message.url }, String(message.url || ''));
          if (prevented) host.send('stop', { view: view.id, navId: message.navId });
        }
        return;
      }
      case 'committed':
        wc.url = String(message.url || wc.url);
        wc.isolatedWorlds.clear();
        emitSafe(wc, 'did-navigate', {}, wc.url, message.httpStatus || 200, '');
        return;
      case 'sourceChanged':
        if (message.url) wc.url = String(message.url);
        if (!message.newDocument) emitSafe(wc, 'did-navigate-in-page', {}, wc.url, true);
        return;
      case 'domReady': emitSafe(wc, 'dom-ready'); return;
      case 'completed': {
        if (message.url) wc.url = String(message.url);
        // A page served with an HTTP error status (404, 429…) is still a page:
        // Electron reports it as loaded, not as a failed navigation.
        if (message.ok || Number(message.httpStatus) >= 400) {
          emitSafe(wc, 'did-finish-load');
          wc.settleLoads(null);
        } else {
          const code = WEB_ERROR_CODES[message.status] !== undefined ? WEB_ERROR_CODES[message.status] : -2;
          emitSafe(wc, 'did-fail-load', {}, code, WEB_ERROR_NAMES[String(code)] || 'ERR_FAILED', String(message.url || wc.url), true);
          const error = new Error(WEB_ERROR_NAMES[String(code)] || 'ERR_FAILED');
          error.code = code;
          wc.settleLoads(error);
        }
        wc.loading = false;
        emitSafe(wc, 'did-stop-loading');
        return;
      }
      case 'title': wc.title = String(message.title || ''); emitSafe(wc, 'page-title-updated', {}, wc.title); return;
      case 'history': wc.canBack = !!message.canBack; wc.canForward = !!message.canForward; return;
      case 'audible': wc.audible = !!message.audible; return;
      case 'newWindow':
        if (wc.windowOpenHandler) { try { wc.windowOpenHandler({ url: String(message.url || '') }); } catch {} }
        return;
      case 'webMessage':
        if (hooks.onWebMessage) { try { hooks.onWebMessage(wc, String(message.message || '')); } catch {} }
        emitSafe(ipcMain, 'zaalis:postMessage', { sender: wc, senderFrame: wc.mainFrame }, String(message.message || ''));
        return;
      case 'console': {
        const levels = { debug: 0, log: 0, info: 1, warning: 2, warn: 2, error: 3 };
        emitSafe(wc, 'console-message', {
          level: levels[message.level] !== undefined ? levels[message.level] : 0,
          message: String(message.text || ''), lineNumber: message.line || 0, sourceId: String(message.source || ''),
        });
        return;
      }
      case 'contextMenu': {
        contextMenuTarget = wc;
        emitSafe(wc, 'context-menu', { preventDefault() {} }, {
          x: message.x || 0, y: message.y || 0, linkURL: String(message.link || ''),
          selectionText: String(message.selection || ''), isEditable: !!message.editable, pageURL: wc.url,
        });
        return;
      }
      case 'crashed': emitSafe(wc, 'render-process-gone', {}, { reason: 'crashed' }); return;
      default: return;
    }
  }

  const electron = {
    app, BaseWindow, WebContentsView, ipcMain, Menu, shell, protocol, net, session, nativeImage, dialog, clipboard,
  };

  return {
    electron,
    handleEvent,
    setFolders(folders) { knownFolders = folders || {}; },
    setSize(width, height) { windowSize = [Math.max(0, Math.round(width || 0)), Math.max(0, Math.round(height || 0))]; },
    markReady() { app.ready = true; resolveReady(); },
    viewById: (id) => views.get(Number(id)) || null,
    views,
  };
}

module.exports = { createElectron, WEB_ERROR_CODES, PERMISSION_NAMES };
