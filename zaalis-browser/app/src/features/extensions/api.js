'use strict';
/* =============================================================================
 *  Implémentation côté main des API chrome.* complétées par preload-ext.js :
 *  action, tabs, windows, contextMenus, runtime.openOptionsPage.
 *  Les identifiants d'onglet sont les webContents.id, comme les API natives
 *  d'Electron (tabs.sendMessage, scripting.executeScript…) : tout reste
 *  cohérent entre le natif et le shim.
 * =========================================================================== */

const { matchPattern, hostPatterns, apiPermissions, actionOf } = require('./manifest');

function createApi(core) {
  const { ctx } = core;
  const windowId = () => (ctx.mainWin && ctx.mainWin.id) || 1;

  // ----- Onglets ------------------------------------------------------------
  function sessionTabs(info) {
    return ctx.tabs.filter(t => !t.incognito && t.view && !t.view.webContents.isDestroyed() && t.view.webContents.session === info.ses);
  }
  function tabByWcId(info, id) {
    return sessionTabs(info).find(t => t.view.webContents.id === id) || null;
  }
  function canSeeUrl(ext, url) {
    const m = ext.manifest;
    if (apiPermissions(m).includes('tabs')) return true;
    if (core.hasActiveTabGrant(ext.id, url)) return true;
    return hostPatterns({ host_permissions: m.host_permissions, permissions: m.permissions, manifest_version: m.manifest_version })
      .some(p => matchPattern(p, url));
  }
  function tabInfo(info, ext, t) {
    const wc = t.view.webContents;
    const list = sessionTabs(info);
    const active = ctx.activeTab() === t;
    const url = wc.getURL() || '';
    let bounds = { width: 0, height: 0 };
    try { bounds = t.view.getBounds(); } catch {}
    const out = {
      id: wc.id, index: list.indexOf(t), windowId: windowId(), active, highlighted: active, selected: active,
      pinned: !!t.pinned, audible: wc.isCurrentlyAudible(), discarded: false, autoDiscardable: true,
      incognito: false, status: wc.isLoading() ? 'loading' : 'complete', mutedInfo: { muted: wc.isAudioMuted() },
      width: bounds.width, height: bounds.height, groupId: -1, frozen: false,
    };
    const opener = t.openerId ? ctx.tabById(t.openerId) : null;
    if (opener && opener.view && !opener.view.webContents.isDestroyed()) out.openerTabId = opener.view.webContents.id;
    if (canSeeUrl(ext, url)) {
      out.url = url; out.title = wc.getTitle() || '';
      try { out.favIconUrl = new URL('/favicon.ico', url).toString(); } catch {}
      out.pendingUrl = undefined;
    }
    return out;
  }
  function requireTab(info, id) {
    const t = id == null ? ctx.activeTab() : tabByWcId(info, Number(id));
    if (!t || (id == null && (t.incognito || t.view.webContents.session !== info.ses))) throw new Error('No tab with id: ' + id + '.');
    return t;
  }
  function textMatch(pattern, text) {
    const re = new RegExp('^' + String(pattern).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(String(text || ''));
  }
  function resolveUrl(ext, u) {
    if (u == null || u === '') return '';
    let target;
    try { target = new URL(String(u), 'chrome-extension://' + ext.id + '/'); } catch { throw new Error('URL invalide : ' + u); }
    if (target.protocol === 'http:' || target.protocol === 'https:') return target.toString();
    if (target.protocol === 'chrome-extension:' && target.host === ext.id) return target.toString();
    if (target.toString() === 'about:blank') return '';
    if (/^(chrome|zaalis|edge|about):/i.test(String(u))) return String(u);
    throw new Error('Impossible d\'ouvrir cette URL : ' + u);
  }

  const tabs = {
    query(info, ext, src, [q]) {
      q = q || {};
      let list = sessionTabs(info);
      const cur = ctx.activeTab();
      const res = [];
      list.forEach((t) => {
        const ti = tabInfo(info, ext, t);
        if (q.active != null && ti.active !== !!q.active) return;
        if (q.highlighted != null && ti.highlighted !== !!q.highlighted) return;
        if (q.pinned != null && ti.pinned !== !!q.pinned) return;
        if (q.audible != null && ti.audible !== !!q.audible) return;
        if (q.muted != null && ti.mutedInfo.muted !== !!q.muted) return;
        if (q.discarded === true) return;
        if (q.currentWindow === false || q.lastFocusedWindow === false) return;
        if (q.windowId != null && q.windowId !== -2 && q.windowId !== windowId()) return;
        if (q.windowType && q.windowType !== 'normal') return;
        if (q.status && ti.status !== q.status) return;
        if (q.index != null && ti.index !== q.index) return;
        if (q.groupId != null && q.groupId !== -1) return;
        if (q.title != null && !(ti.title != null && textMatch(q.title, ti.title))) return;
        if (q.url != null) {
          const pats = Array.isArray(q.url) ? q.url : [q.url];
          const real = t.view.webContents.getURL();
          if (!canSeeUrl(ext, real) || !pats.some(p => matchPattern(p, real))) return;
        }
        res.push(ti);
      });
      void cur;
      return res;
    },
    get(info, ext, src, [id]) { return tabInfo(info, ext, requireTab(info, id)); },
    getCurrent(info, ext, src) {
      const t = src.wc ? ctx.tabOfWebContents(src.wc) : null;
      return t ? tabInfo(info, ext, t) : undefined;
    },
    create(info, ext, src, [p]) {
      p = p || {};
      const target = resolveUrl(ext, p.url);
      const opener = p.openerTabId != null ? tabByWcId(info, Number(p.openerTabId)) : null;
      const t = ctx.createTab(target, p.active !== false && p.selected !== false, opener ? { openerId: opener.id } : {});
      if (!t) throw new Error('Impossible de créer l\'onglet');
      if (p.pinned && !t.pinned) ctx.handleAction('pinTab', [String(t.id)]);
      if (Number.isInteger(p.index)) moveTab(info, t, p.index);
      return tabInfo(info, ext, t);
    },
    update(info, ext, src, args) {
      let [id, p] = args;
      if (id && typeof id === 'object') { p = id; id = null; }
      p = p || {};
      const t = requireTab(info, id);
      const wc = t.view.webContents;
      if (p.url != null) {
        if (/^javascript:/i.test(String(p.url))) throw new Error('Les URL javascript: sont interdites');
        const target = resolveUrl(ext, p.url);
        if (target) wc.loadURL(target).catch(() => {});
      }
      if (p.active || p.highlighted || p.selected) ctx.selectTab(t.id);
      if (p.pinned != null && !!p.pinned !== !!t.pinned) ctx.handleAction('pinTab', [String(t.id)]);
      if (p.muted != null) wc.setAudioMuted(!!p.muted);
      return tabInfo(info, ext, t);
    },
    remove(info, ext, src, [ids]) {
      for (const id of (Array.isArray(ids) ? ids : [ids])) { const t = requireTab(info, id); ctx.closeTab(t.id); }
    },
    reload(info, ext, src, args) {
      let [id, p] = args;
      if (id && typeof id === 'object') { p = id; id = null; }
      const wc = requireTab(info, id).view.webContents;
      (p && p.bypassCache) ? wc.reloadIgnoringCache() : wc.reload();
    },
    duplicate(info, ext, src, [id]) {
      const t = requireTab(info, id);
      const n = ctx.createTab(t.view.webContents.getURL(), true, { openerId: t.id });
      return tabInfo(info, ext, n);
    },
    goBack(info, ext, src, [id]) { const h = requireTab(info, id).view.webContents.navigationHistory; if (h.canGoBack()) h.goBack(); },
    goForward(info, ext, src, [id]) { const h = requireTab(info, id).view.webContents.navigationHistory; if (h.canGoForward()) h.goForward(); },
    discard(info, ext, src, [id]) { return tabInfo(info, ext, requireTab(info, id)); },
    highlight(info, ext, src, [p]) {
      const idx = Array.isArray(p && p.tabs) ? p.tabs[0] : p && p.tabs;
      const t = sessionTabs(info)[idx];
      if (!t) throw new Error('No tab at index: ' + idx + '.');
      ctx.selectTab(t.id);
      return core.windowInfo(info, ext, false);
    },
    move(info, ext, src, [ids, p]) {
      const out = [];
      let index = p && Number.isInteger(p.index) ? p.index : -1;
      for (const id of (Array.isArray(ids) ? ids : [ids])) {
        const t = requireTab(info, id);
        moveTab(info, t, index);
        out.push(tabInfo(info, ext, t));
        if (index >= 0) index++;
      }
      return Array.isArray(ids) ? out : out[0];
    },
    async captureVisibleTab(info, ext, src, args) {
      const opts = args.find(a => a && typeof a === 'object') || {};
      const t = ctx.activeTab();
      if (!t || t.view.webContents.session !== info.ses) throw new Error('Aucun onglet visible');
      const url = t.view.webContents.getURL();
      const allowed = hostPatterns(ext.manifest).some(pt => pt === '<all_urls>' && matchPattern(pt, url)) || core.hasActiveTabGrant(ext.id, url);
      if (!allowed) throw new Error('Either the \'<all_urls>\' or \'activeTab\' permission is required.');
      const img = await t.view.webContents.capturePage();
      if (opts.format === 'png') return img.toDataURL();
      const q = Number.isInteger(opts.quality) ? Math.max(0, Math.min(100, opts.quality)) : 92;
      return 'data:image/jpeg;base64,' + img.toJPEG(q).toString('base64');
    },
    async detectLanguage(info, ext, src, [id]) {
      const wc = requireTab(info, id).view.webContents;
      try {
        const lang = await wc.executeJavaScript('(document.documentElement.lang || "").trim()', true);
        return (lang || 'und').split('-')[0].toLowerCase();
      } catch { return 'und'; }
    },
  };
  function moveTab(info, t, index) {
    const all = ctx.tabs.slice();
    const from = all.indexOf(t);
    if (from < 0) return;
    all.splice(from, 1);
    const to = index < 0 || index > all.length ? all.length : index;
    all.splice(to, 0, t);
    ctx.handleAction('reorderTabs', [all.map(x => x.id).join(',')]);
  }

  // ----- Fenêtres -------------------------------------------------------------
  core.windowInfo = (info, ext, populate) => {
    const w = ctx.mainWin;
    let b = { x: 0, y: 0, width: 0, height: 0 };
    try { b = w.getBounds(); } catch {}
    const out = {
      id: windowId(), focused: !!(w && w.isFocused()), top: b.y, left: b.x, width: b.width, height: b.height,
      incognito: false, type: 'normal', alwaysOnTop: false,
      state: !w ? 'normal' : w.isFullScreen() ? 'fullscreen' : w.isMinimized() ? 'minimized' : w.isMaximized() ? 'maximized' : 'normal',
    };
    if (populate) out.tabs = sessionTabs(info).map(t => tabInfo(info, ext, t));
    return out;
  };
  const getInfo = (a) => a.find(x => x && typeof x === 'object') || {};
  const windows = {
    get(info, ext, src, a) { const id = a[0]; if (id !== windowId() && id !== -2) throw new Error('No window with id: ' + id + '.'); return core.windowInfo(info, ext, getInfo(a).populate); },
    getCurrent(info, ext, src, a) { return core.windowInfo(info, ext, getInfo(a).populate); },
    getLastFocused(info, ext, src, a) { return core.windowInfo(info, ext, getInfo(a).populate); },
    getAll(info, ext, src, a) { return [core.windowInfo(info, ext, getInfo(a).populate)]; },
    create(info, ext, src, [p]) {
      p = p || {};
      const urls = p.url == null ? [''] : (Array.isArray(p.url) ? p.url : [p.url]);
      urls.forEach((u, i) => ctx.createTab(resolveUrl(ext, u), p.focused !== false && i === 0, {}));
      return core.windowInfo(info, ext, true);
    },
    update(info, ext, src, [id, p]) {
      const w = ctx.mainWin;
      p = p || {};
      if (w) {
        if (p.state === 'minimized') w.minimize();
        else if (p.state === 'maximized') w.maximize();
        else if (p.state === 'fullscreen') w.setFullScreen(true);
        else if (p.state === 'normal') { if (w.isFullScreen()) w.setFullScreen(false); if (w.isMaximized()) w.unmaximize(); if (w.isMinimized()) w.restore(); }
        if (p.focused) { if (w.isMinimized()) w.restore(); w.focus(); }
      }
      return core.windowInfo(info, ext, false);
    },
    remove() { throw new Error('La fenêtre principale ne peut pas être fermée par une extension.'); },
  };

  // ----- Action (bouton de la barre d'outils) ---------------------------------
  const color = (c) => {
    if (Array.isArray(c)) return 'rgba(' + c.slice(0, 3).map(n => n | 0).join(',') + ',' + ((c[3] == null ? 255 : c[3]) / 255).toFixed(3) + ')';
    return /^#[0-9a-f]{3,8}$|^[a-z]+$|^rgba?\([\d\s.,%]+\)$/i.test(String(c || '')) ? String(c) : '';
  };
  const colorArray = (c) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(c || ''));
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; }
    const r = /^rgba?\(([^)]+)\)$/.exec(String(c || ''));
    if (r) { const p = r[1].split(',').map(s => parseFloat(s)); return [p[0] | 0, p[1] | 0, p[2] | 0, Math.round((p[3] == null ? 1 : p[3]) * 255)]; }
    return [0, 0, 0, 0];
  };
  function setProp(ext, d, key, value) {
    const st = core.actionState(ext.id);
    if (d && d.tabId != null) {
      if (!st.tabs.has(d.tabId)) st.tabs.set(d.tabId, {});
      if (value === null) delete st.tabs.get(d.tabId)[key]; else st.tabs.get(d.tabId)[key] = value;
    } else st.global[key] = value;
    core.uiChanged();
  }
  function getProp(ext, d, key) {
    const st = core.actionState(ext.id);
    const tab = d && d.tabId != null ? st.tabs.get(d.tabId) : null;
    return tab && key in tab ? tab[key] : st.global[key];
  }
  const action = {
    setBadgeText(info, ext, src, [d]) { setProp(ext, d, 'badgeText', d && d.text != null ? String(d.text).slice(0, 8) : (d && d.tabId != null ? null : '')); },
    getBadgeText(info, ext, src, [d]) { return getProp(ext, d, 'badgeText') || ''; },
    setBadgeBackgroundColor(info, ext, src, [d]) { setProp(ext, d, 'badgeBg', color(d && d.color)); },
    getBadgeBackgroundColor(info, ext, src, [d]) { return colorArray(getProp(ext, d, 'badgeBg') || '#5f6368'); },
    setBadgeTextColor(info, ext, src, [d]) { setProp(ext, d, 'badgeColor', color(d && d.color)); },
    getBadgeTextColor(info, ext, src, [d]) { return colorArray(getProp(ext, d, 'badgeColor') || '#ffffff'); },
    setTitle(info, ext, src, [d]) { setProp(ext, d, 'title', d && d.title != null ? String(d.title).slice(0, 200) : (d && d.tabId != null ? null : '')); },
    getTitle(info, ext, src, [d]) { return getProp(ext, d, 'title') || ext.name; },
    setPopup(info, ext, src, [d]) {
      const p = d && d.popup ? String(d.popup) : '';
      if (p) { const u = new URL(p, 'chrome-extension://' + ext.id + '/'); if (u.protocol !== 'chrome-extension:' || u.host !== ext.id) throw new Error('Popup hors de l\'extension'); }
      setProp(ext, d, 'popup', p);
    },
    getPopup(info, ext, src, [d]) { const p = getProp(ext, d, 'popup'); return p ? new URL(p, 'chrome-extension://' + ext.id + '/').toString() : ''; },
    async setIcon(info, ext, src, [d]) {
      d = d || {};
      let url = null;
      if (d.imageData && typeof d.imageData === 'object') {
        const keys = Object.keys(d.imageData).map(Number).sort((a, b) => a - b);
        const k = keys.find(n => n >= 32) || keys[keys.length - 1];
        const v = d.imageData[k];
        if (typeof v === 'string' && /^data:image\/png;base64,/.test(v) && v.length < 2e6) url = core.normalizeIcon(v);
      } else if (d.path) {
        const rel = typeof d.path === 'string' ? d.path : (() => {
          const ks = Object.keys(d.path).map(Number).sort((a, b) => a - b);
          return d.path[ks.find(n => n >= 32) || ks[ks.length - 1]];
        })();
        url = core.iconFromFile(ext, rel);
      }
      if (!url) throw new Error('Icône invalide');
      setProp(ext, d, 'icon', url);
    },
    enable(info, ext, src, [tabId]) { setProp(ext, tabId != null ? { tabId } : null, 'enabled', true); },
    disable(info, ext, src, [tabId]) { setProp(ext, tabId != null ? { tabId } : null, 'enabled', false); },
    isEnabled(info, ext, src, [tabId]) { return getProp(ext, tabId != null ? { tabId } : null, 'enabled') !== false; },
    openPopup(info, ext) { return core.openPopupForActive(info, ext); },
    getUserSettings(info, ext) { return { isOnToolbar: !!core.entry(info, ext.id)?.pinned }; },
  };

  // ----- Menus contextuels ----------------------------------------------------
  function menuMap(info, ext) {
    const k = info.partition + '|' + ext.id;
    if (!core.menus.has(k)) core.menus.set(k, new Map());
    return core.menus.get(k);
  }
  const MENU_CONTEXTS = new Set(['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'launcher', 'browser_action', 'page_action', 'action']);
  function cleanMenuProps(p) {
    const o = {};
    if (p.title != null) o.title = String(p.title).slice(0, 300);
    if (p.type != null) o.type = ['normal', 'checkbox', 'radio', 'separator'].includes(p.type) ? p.type : 'normal';
    if (p.contexts != null) o.contexts = (Array.isArray(p.contexts) ? p.contexts : [p.contexts]).filter(c => MENU_CONTEXTS.has(c));
    if (p.checked != null) o.checked = !!p.checked;
    if (p.enabled != null) o.enabled = !!p.enabled;
    if (p.visible != null) o.visible = !!p.visible;
    if (p.parentId !== undefined) o.parentId = p.parentId;
    if (p.documentUrlPatterns != null) o.documentUrlPatterns = [].concat(p.documentUrlPatterns).map(String);
    if (p.targetUrlPatterns != null) o.targetUrlPatterns = [].concat(p.targetUrlPatterns).map(String);
    return o;
  }
  const contextMenus = {
    create(info, ext, src, [p]) {
      p = p || {};
      const map = menuMap(info, ext);
      const id = p.id;
      if (id == null) throw new Error('Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create');
      if (map.has(id)) throw new Error('Cannot create item with duplicate id ' + id);
      const props = Object.assign({ type: 'normal', contexts: ['page'], enabled: true, visible: true, checked: false }, cleanMenuProps(p));
      if (props.parentId != null && !map.has(props.parentId)) throw new Error('Cannot find menu item with id ' + props.parentId);
      if (props.type !== 'separator' && !props.title) throw new Error('Property \'title\' is required');
      props.id = id;
      map.set(id, props);
      return id;
    },
    update(info, ext, src, [id, p]) {
      const map = menuMap(info, ext);
      const item = map.get(id);
      if (!item) throw new Error('Cannot find menu item with id ' + id);
      Object.assign(item, cleanMenuProps(p || {}));
    },
    remove(info, ext, src, [id]) {
      const map = menuMap(info, ext);
      if (!map.has(id)) throw new Error('Cannot find menu item with id ' + id);
      const drop = (x) => { map.delete(x); for (const [k, v] of [...map]) if (v.parentId === x) drop(k); };
      drop(id);
    },
    removeAll(info, ext) { menuMap(info, ext).clear(); },
  };

  // ----- Divers ----------------------------------------------------------------
  const runtime = {
    openOptionsPage(info, ext) {
      const page = (ext.manifest.options_ui && ext.manifest.options_ui.page) || ext.manifest.options_page;
      if (!page) throw new Error('Could not create an options page.');
      ctx.createTab('chrome-extension://' + ext.id + '/' + String(page).replace(/^\/+/, ''), true, {});
    },
  };

  const table = { action, tabs, windows, contextMenus, runtime };

  // Point d'entrée : méthode « espace.nom ».
  async function handle(info, ext, method, args, src) {
    if (method === 'listen') { core.noteListener(info, ext.id, String(args[0] || ''), src); return; }
    if (method === 'hello') { core.noteHello(info, ext.id, src); return; }
    if (method === 'window.close') return core.windowClose(info, ext, src);
    if (String(method).startsWith('declarativeNetRequest.')) {
      if (!apiPermissions(ext.manifest).some(p => /^declarativeNetRequest/.test(p))) throw new Error('L\'autorisation « declarativeNetRequest » est requise.');
      return core.dnrCall(info, ext, String(method).slice('declarativeNetRequest.'.length), Array.isArray(args) ? args : []);
    }
    if (method === 'webRequest.addListener') return core.wrAdd(info, ext, src, args);
    if (method === 'webRequest.removeListener') return core.wrRemove(info, ext, args[0]);
    const [nsName, fn] = String(method).split('.');
    const nsObj = table[nsName === 'menus' ? 'contextMenus' : nsName];
    if (!nsObj || typeof nsObj[fn] !== 'function' || !Object.prototype.hasOwnProperty.call(nsObj, fn)) throw new Error('API non prise en charge : chrome.' + method);
    if (nsName === 'contextMenus' && !apiPermissions(ext.manifest).some(p => p === 'contextMenus' || p === 'menus')) {
      throw new Error('L\'autorisation « contextMenus » est requise.');
    }
    if (nsName === 'action' && !actionOf(ext.manifest) && fn !== 'getUserSettings') throw new Error('Cette extension n\'a pas de bouton d\'action.');
    return nsObj[fn](info, ext, src, Array.isArray(args) ? args : []);
  }

  return { handle, tabInfo, sessionTabs, tabByWcId, menuMap };
}

module.exports = { createApi };
