'use strict';
// Bulles façon Chrome (traduire, code QR, Cast…) : une WebContentsView posée
// au-dessus des pages, ancrée sous une icône du chrome. Une seule bulle à la
// fois ; elle se ferme si elle perd le focus, au changement d'onglet, à la
// navigation ou sur Échap (action popupClose).
//
// Les pages des bulles (interface/*.html) parlent au processus principal via
// les actions déclarées avec { views: [POPUP_VIEW] }.

const POPUP_VIEW = 'zxpopup';
let shared = null;

function popupManager(ctx) {
  if (shared) return shared;
  const { electron, path } = ctx;
  const { WebContentsView } = electron;
  let cur = null;   // { view, name, onClose, anchor, width, height }

  function place() {
    if (!cur || !ctx.mainWin) return;
    const [W, H] = ctx.mainWin.getContentSize();
    const w = Math.min(cur.width, W - 16);
    const h = Math.min(cur.height, H - (cur.anchor.y + cur.anchor.h + 6) - 8);
    let x = Math.round(cur.anchor.x + cur.anchor.w - w);
    x = Math.max(8, Math.min(x, W - w - 8));
    const y = Math.round(cur.anchor.y + cur.anchor.h + 6);
    cur.view.setBounds({ x, y, width: Math.max(120, w), height: Math.max(60, h) });
  }

  function close(name) {
    if (!cur || (name && cur.name !== name)) return;
    const c = cur; cur = null;
    try { ctx.mainWin && ctx.mainWin.contentView.removeChildView(c.view); } catch {}
    try { c.view.webContents.close(); } catch {}
    try { c.onClose && c.onClose(); } catch {}
  }

  // page : 'translate-bubble.html' ; query : objet ; opts : { width, height, focus, onClose }
  function open(name, page, anchor, query, opts) {
    opts = opts || {};
    close();
    if (!ctx.mainWin) return null;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', '..', 'preload-chrome.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    view.setBackgroundColor('#00000000');
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    ctx.trustView(wc, POPUP_VIEW);
    const q = new URLSearchParams(Object.assign({ theme: ctx.settings.theme === 'dark' ? 'dark' : 'light' }, query || {}));
    cur = { view, name, onClose: opts.onClose, anchor: anchor || { x: 0, y: 0, w: 0, h: 0 }, width: opts.width || 340, height: opts.height || 200 };
    ctx.mainWin.contentView.addChildView(view);
    place();
    wc.loadURL('zaalis://home/' + page + '?' + q.toString()).catch(() => {});
    wc.once('did-finish-load', () => { if (opts.focus !== false) { try { wc.focus(); } catch {} } });
    // Fermeture quand on clique ailleurs (seulement si la bulle a eu le focus).
    wc.on('focus', () => { if (cur && cur.view === view) cur.focused = true; });
    wc.on('blur', () => { setTimeout(() => { if (cur && cur.view === view && cur.focused && !wc.isFocused()) close(); }, 120); });
    return view;
  }

  function current() { return cur ? cur.name : ''; }
  function send(name, msg) { if (cur && cur.name === name) { try { cur.view.webContents.send('zaalis:message', msg); } catch {} } }

  ctx.action('popupResize', (args, event) => {
    if (!cur || !event || event.sender !== cur.view.webContents) return;
    const h = parseInt(args[0], 10), w = parseInt(args[1], 10);
    if (h > 30 && h < 900) cur.height = h;
    if (w > 120 && w < 900) cur.width = w;
    place();
  }, { views: [POPUP_VIEW] });
  ctx.action('popupClose', (args, event) => {
    if (cur && event && event.sender === cur.view.webContents) close();
  }, { views: [POPUP_VIEW] });

  ctx.action('popupOpenInternal', (args, event) => {
    if (!cur || !event || event.sender !== cur.view.webContents) return;
    close(); ctx.openInternal(args[0]);
  }, { views: [POPUP_VIEW] });

  ctx.on('tabActivated', () => close());
  ctx.on('ready', () => { if (ctx.mainWin) ctx.mainWin.on('resize', () => close()); });

  shared = { open, close, current, send, POPUP_VIEW };
  return shared;
}

module.exports = { popupManager, POPUP_VIEW };
