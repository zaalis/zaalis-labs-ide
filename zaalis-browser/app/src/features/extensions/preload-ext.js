'use strict';
/* =============================================================================
 *  Shim chrome.* des extensions (préchargé via session.registerPreloadScript,
 *  types « frame » et « service-worker »). Electron fournit nativement
 *  runtime, storage, i18n, scripting, management, tabs.sendMessage/connect/
 *  executeScript… mais pas l'interface : chrome.action n'a aucun effet,
 *  tabs.create/remove/windows/contextMenus n'existent pas et tabs.query ne
 *  connaît pas les onglets de zaalis. Ce script complète l'API dans le monde
 *  principal de chaque page / service worker d'extension, et route les appels
 *  vers main.js (src/features/extensions/api.js) par IPC.
 *  Il ne fait strictement rien hors des contextes chrome-extension://.
 * =========================================================================== */

const { contextBridge, ipcRenderer } = require('electron');

// Pages : l'URL est connue ici. Service workers : `location` n'existe pas
// dans le monde du preload, le contrôle est fait dans le monde principal.
const isServiceWorker = typeof window === 'undefined' || typeof document === 'undefined';
const href = (!isServiceWorker && typeof location !== 'undefined' && location) ? String(location.href) : '';

if (isServiceWorker || /^chrome-extension:\/\/[a-p]{32}\//.test(href)) {
  let dispatcher = null;
  const queue = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Appel vers main.js. Le gestionnaire IPC du service worker peut être
  // attaché quelques millisecondes après le démarrage : on réessaie.
  async function call(method, args) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await ipcRenderer.invoke('zaalis:ext', { method: String(method), args: Array.isArray(args) ? args : [] });
        if (r && r.__zxError) throw new Error(r.__zxError);
        return r ? r.value : undefined;
      } catch (e) {
        const msg = String(e && e.message || e);
        if (/No handler registered/i.test(msg) && attempt < 100) { await sleep(50); continue; }
        throw new Error(msg.replace(/^Error invoking remote method 'zaalis:ext': (Error: )?/, ''));
      }
    }
  }
  function setDispatcher(fn) {
    dispatcher = fn;
    while (queue.length) { const [n, a] = queue.shift(); try { dispatcher(n, a); } catch {} }
  }
  ipcRenderer.on('zaalis:ext-event', (_e, name, args) => {
    if (dispatcher) { try { dispatcher(name, args); } catch {} } else queue.push([name, args]);
  });

  try {
    contextBridge.executeInMainWorld({
      args: [call, setDispatcher, isServiceWorker],
      func: function install(call, setDispatcher, isServiceWorker) {
        if (!/^chrome-extension:$/.test(String((self.location && self.location.protocol) || ''))) return;
        const c = globalThis.chrome;
        if (!c || c.__zxShim) return;
        try { Object.defineProperty(c, '__zxShim', { value: true }); } catch (e) {}

        // ----- Événements -------------------------------------------------
        const listeners = Object.create(null);
        function makeEvent(name) {
          return {
            addListener(fn) {
              if (typeof fn !== 'function') return;
              (listeners[name] || (listeners[name] = new Set())).add(fn);
              call('listen', [name]).catch(() => {});
            },
            removeListener(fn) { if (listeners[name]) listeners[name].delete(fn); },
            hasListener(fn) { return !!(listeners[name] && listeners[name].has(fn)); },
            hasListeners() { return !!(listeners[name] && listeners[name].size); },
          };
        }
        const menuClicks = new Map();   // id -> onclick (pages MV2)
        // Les événements reçus avant la fin du script principal sont différés :
        // ses écouteurs (enregistrés au premier niveau) doivent les recevoir.
        let started = false;
        const early = [];
        setTimeout(() => { started = true; while (early.length) deliver.apply(null, early.shift()); }, 0);
        setDispatcher((name, args) => { if (started) deliver(name, args); else early.push([name, args]); });
        const wrListeners = new Map();  // id -> fn (chrome.webRequest)
        function deliver(name, args) {
          args = Array.isArray(args) ? args : [];
          if (name.startsWith('webRequest.')) {
            const fn = wrListeners.get(args[0]);
            if (fn) { try { fn(args[1]); } catch (e) { console.error(e); } }
            return;
          }
          if (name === 'contextMenus.onClicked' && args[0]) {
            const fn = menuClicks.get(args[0].menuItemId);
            if (fn) { try { fn(args[0], args[1]); } catch (e) { console.error(e); } }
          }
          const set = listeners[name];
          if (!set) return;
          for (const fn of Array.from(set)) { try { fn.apply(null, args); } catch (e) { console.error(e); } }
        }

        // ----- Promesse + callback, avec chrome.runtime.lastError ---------
        function withLastError(message, fn) {
          const rt = c.runtime;
          let set = false;
          try { Object.defineProperty(rt, 'lastError', { configurable: true, get: () => ({ message }) }); set = true; } catch (e) {}
          try { fn(); } finally { if (set) { try { delete rt.lastError; } catch (e) {} } }
        }
        function api(method, prep) {
          return function () {
            let a = Array.prototype.slice.call(arguments);
            let cb = null;
            if (a.length && typeof a[a.length - 1] === 'function') cb = a.pop();
            const run = async () => call(method, prep ? await prep(a) : a);
            const p = run();
            if (!cb) return p;
            p.then((r) => { try { cb(r); } catch (e) { console.error(e); } },
                   (err) => withLastError(String(err && err.message || err), () => { try { cb(); } catch (e) { console.error(e); } }));
          };
        }
        function assign(target, src) {
          for (const k of Object.keys(src)) {
            try { target[k] = src[k]; } catch (e) {}
            if (target[k] !== src[k]) { try { Object.defineProperty(target, k, { value: src[k], configurable: true, writable: true }); } catch (e) {} }
          }
          return target;
        }
        function ns(name) {
          let o = null;
          try { o = c[name]; } catch (e) {}
          if (!o || typeof o !== 'object') {
            o = {};
            try { c[name] = o; } catch (e) {}
            if (c[name] !== o) { try { Object.defineProperty(c, name, { value: o, configurable: true, writable: true }); } catch (e) {} }
          }
          return o;
        }

        // ImageData -> data: URL (OffscreenCanvas existe dans les pages et workers).
        async function imageDataToUrl(img) {
          if (!img || typeof OffscreenCanvas === 'undefined') return null;
          const cv = new OffscreenCanvas(img.width, img.height);
          cv.getContext('2d').putImageData(img, 0, 0);
          const blob = await cv.convertToBlob({ type: 'image/png' });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          return 'data:image/png;base64,' + btoa(s);
        }
        async function prepSetIcon(a) {
          const d = Object.assign({}, a[0] || {});
          if (d.imageData) {
            const src = (typeof ImageData !== 'undefined' && d.imageData instanceof ImageData) ? { 32: d.imageData } : d.imageData;
            const out = {};
            for (const k of Object.keys(src)) out[k] = await imageDataToUrl(src[k]);
            d.imageData = out;
          }
          return [d];
        }

        // ----- chrome.action / browserAction --------------------------------
        const action = {
          setBadgeText: api('action.setBadgeText'), getBadgeText: api('action.getBadgeText'),
          setBadgeBackgroundColor: api('action.setBadgeBackgroundColor'), getBadgeBackgroundColor: api('action.getBadgeBackgroundColor'),
          setBadgeTextColor: api('action.setBadgeTextColor'), getBadgeTextColor: api('action.getBadgeTextColor'),
          setTitle: api('action.setTitle'), getTitle: api('action.getTitle'),
          setPopup: api('action.setPopup'), getPopup: api('action.getPopup'),
          setIcon: api('action.setIcon', prepSetIcon),
          enable: api('action.enable'), disable: api('action.disable'), isEnabled: api('action.isEnabled'),
          openPopup: api('action.openPopup'), getUserSettings: api('action.getUserSettings'),
          onClicked: makeEvent('action.onClicked'),
        };
        assign(ns('action'), action);
        if (c.runtime && c.runtime.getManifest && (c.runtime.getManifest() || {}).manifest_version === 2) {
          assign(ns('browserAction'), action);
          assign(ns('pageAction'), Object.assign({}, action, { show: api('action.enable'), hide: api('action.disable') }));
        }

        // ----- chrome.tabs (en complément des API natives) -------------------
        assign(ns('tabs'), {
          TAB_ID_NONE: -1,
          query: api('tabs.query'), get: api('tabs.get'), getCurrent: api('tabs.getCurrent'),
          create: api('tabs.create'), update: api('tabs.update'), remove: api('tabs.remove'),
          reload: api('tabs.reload'), duplicate: api('tabs.duplicate'),
          goBack: api('tabs.goBack'), goForward: api('tabs.goForward'),
          highlight: api('tabs.highlight'), move: api('tabs.move'), discard: api('tabs.discard'),
          captureVisibleTab: api('tabs.captureVisibleTab'), detectLanguage: api('tabs.detectLanguage'),
          onCreated: makeEvent('tabs.onCreated'), onUpdated: makeEvent('tabs.onUpdated'),
          onActivated: makeEvent('tabs.onActivated'), onRemoved: makeEvent('tabs.onRemoved'),
          onMoved: makeEvent('tabs.onMoved'), onHighlighted: makeEvent('tabs.onHighlighted'),
          onReplaced: makeEvent('tabs.onReplaced'), onZoomChange: makeEvent('tabs.onZoomChange'),
        });

        // ----- chrome.windows (une seule fenêtre de navigation) ---------------
        assign(ns('windows'), {
          WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
          get: api('windows.get'), getCurrent: api('windows.getCurrent'), getLastFocused: api('windows.getLastFocused'),
          getAll: api('windows.getAll'), create: api('windows.create'), update: api('windows.update'), remove: api('windows.remove'),
          onCreated: makeEvent('windows.onCreated'), onRemoved: makeEvent('windows.onRemoved'),
          onFocusChanged: makeEvent('windows.onFocusChanged'), onBoundsChanged: makeEvent('windows.onBoundsChanged'),
        });

        // ----- chrome.contextMenus / chrome.menus ----------------------------
        let menuSeq = 0;
        const menus = {
          ACTION_MENU_TOP_LEVEL_LIMIT: 6,
          ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' },
          ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' },
          create(props, cb) {
            props = Object.assign({}, props || {});
            const id = props.id != null ? props.id : ('zx' + Date.now().toString(36) + '_' + (++menuSeq));
            if (typeof props.onclick === 'function') menuClicks.set(id, props.onclick);
            delete props.onclick;
            props.id = id;
            call('contextMenus.create', [props]).then(() => { if (cb) cb(); },
              (e) => withLastError(String(e.message || e), () => { if (cb) cb(); }));
            return id;
          },
          update(id, props, cb) {
            props = Object.assign({}, props || {});
            if (typeof props.onclick === 'function') { menuClicks.set(id, props.onclick); }
            delete props.onclick;
            const p = call('contextMenus.update', [id, props]);
            if (!cb) return p; p.then(() => cb(), (e) => withLastError(String(e.message || e), () => cb()));
          },
          remove(id, cb) {
            menuClicks.delete(id);
            const p = call('contextMenus.remove', [id]);
            if (!cb) return p; p.then(() => cb(), (e) => withLastError(String(e.message || e), () => cb()));
          },
          removeAll(cb) {
            menuClicks.clear();
            const p = call('contextMenus.removeAll', []);
            if (!cb) return p; p.then(() => cb(), () => cb());
          },
          onClicked: makeEvent('contextMenus.onClicked'),
          onShown: makeEvent('contextMenus.onShown'), onHidden: makeEvent('contextMenus.onHidden'),
        };
        assign(ns('contextMenus'), menus);
        assign(ns('menus'), menus);

        // ----- chrome.webRequest (observation) --------------------------------
        // Electron n'émet pas les événements webRequest des extensions : zaalis
        // les observe lui-même (répartiteur webRequest partagé) et les relaie.
        if (c.webRequest) {
          let wrSeq = 0;
          const byFn = new Map();   // fn -> [ids]
          const wrEvent = (ev) => ({
            addListener(fn, filter, extra) {
              if (typeof fn !== 'function') return;
              const id = 'w' + (++wrSeq) + '_' + Math.random().toString(36).slice(2, 8);
              wrListeners.set(id, fn);
              byFn.set(fn, (byFn.get(fn) || []).concat(id));
              call('webRequest.addListener', [ev, id, filter || {}, Array.isArray(extra) ? extra : []]).catch((e) => console.error(e));
            },
            removeListener(fn) {
              for (const id of byFn.get(fn) || []) { wrListeners.delete(id); call('webRequest.removeListener', [id]).catch(() => {}); }
              byFn.delete(fn);
            },
            hasListener(fn) { return byFn.has(fn); },
            hasListeners() { return byFn.size > 0; },
          });
          const evs = {};
          for (const ev of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) evs[ev] = wrEvent(ev);
          assign(c.webRequest, evs);
        }

        // ----- declarativeNetRequest (moteur maison de zaalis) -----------------
        // Electron court-circuite le DNR natif dès qu'une écoute webRequest
        // existe : les règles sont gérées et appliquées par zaalis.
        if (c.declarativeNetRequest) {
          const d = {};
          for (const fn of ['updateDynamicRules', 'getDynamicRules', 'updateSessionRules', 'getSessionRules', 'updateEnabledRulesets',
            'getEnabledRulesets', 'updateStaticRules', 'getDisabledRuleIds', 'getAvailableStaticRuleCount', 'isRegexSupported',
            'testMatchOutcome', 'getMatchedRules', 'setExtensionActionOptions']) d[fn] = api('declarativeNetRequest.' + fn);
          d.onRuleMatchedDebug = makeEvent('declarativeNetRequest.onRuleMatchedDebug');
          assign(c.declarativeNetRequest, d);
        }

        // ----- chrome.runtime : page d'options, onInstalled ----------------
        // onInstalled natif d'Electron n'est pas fiable : zaalis le déclenche
        // lui-même à l'installation et à chaque changement de version.
        if (c.runtime) {
          assign(c.runtime, { openOptionsPage: api('runtime.openOptionsPage'), onInstalled: makeEvent('runtime.onInstalled') });
        }

        // Fermeture d'un popup d'action (window.close() dans popup.html).
        if (!isServiceWorker) {
          const nativeClose = globalThis.close;
          try {
            globalThis.close = function () { call('window.close', []).then((handled) => { if (!handled && nativeClose) nativeClose.call(globalThis); }, () => {}); };
          } catch (e) {}
        }
        call('hello', [isServiceWorker ? 'sw' : 'frame']).catch(() => {});
      },
    });
  } catch (e) {
    // Contexte sans chrome.* (rare) : rien à compléter.
  }
}
