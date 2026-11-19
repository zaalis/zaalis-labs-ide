// Kit commun des pages internes zaalis://home/*.html.
//   zx.post(action, ...args)        message simple vers main.js
//   zx.call(rpcName, params)        -> Promise (voir ctx.rpc dans main.js)
//   zx.on(type, cb)                 messages poussés par main.js
//   zx.$(id), zx.esc(s), zx.toast(text), zx.confirm(title, text) -> Promise<bool>
(function () {
  'use strict';
  const SEP = '\x1f';
  const bridge = window.zaalisBridge || null;
  const listeners = new Map();
  const pending = new Map();
  let seq = 0;

  // Thème appliqué avant le premier rendu (main.js le confirme au dom-ready).
  try { if (localStorage.getItem('zaalis_theme') === 'dark') document.documentElement.classList.add('dark'); } catch (e) {}
  document.addEventListener('DOMContentLoaded', () => {
    if (document.documentElement.classList.contains('dark')) document.body.classList.add('dark');
  });

  function post(...parts) { if (bridge) bridge.postMessage(parts.map(p => String(p == null ? '' : p)).join(SEP)); }
  function call(name, params) {
    const id = 'r' + (++seq) + '_' + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post(name, id, JSON.stringify(params || {}));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Délai dépassé (' + name + ')')); } }, 120000);
    });
  }
  function on(type, cb) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(cb); }
  if (bridge) bridge.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'rpc' && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id);
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'Erreur'));
      return;
    }
    const set = listeners.get(d.type);
    if (set) for (const cb of set) { try { cb(d); } catch (err) { console.error(err); } }
  });

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastEl = null, toastTimer = 0;
  function toast(text) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'zx-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = text; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  // Boîte de dialogue simple. fields : [{ name, label, type, value }] -> objet ou null.
  function dialog(title, html, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'zx-dialog-back';
      const fields = (opts.fields || []).map(f => '<label>' + esc(f.label) + '</label><input class="zx-input" name="' + esc(f.name) + '" type="' + esc(f.type || 'text') + '" value="' + esc(f.value || '') + '"' + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>').join('');
      back.innerHTML = '<div class="zx-dialog" role="dialog"><h2>' + esc(title) + '</h2><div>' + (html || '') + '</div>' + fields +
        '<div class="actions"><button class="zx-btn" data-r="0">' + esc(opts.cancel || 'Annuler') + '</button>' +
        '<button class="zx-btn primary' + (opts.danger ? ' danger' : '') + '" data-r="1">' + esc(opts.ok || 'OK') + '</button></div></div>';
      const done = (ok) => {
        let val = ok;
        if (ok && opts.fields) { val = {}; back.querySelectorAll('input').forEach(i => { val[i.name] = i.value; }); }
        back.remove(); resolve(ok ? val : (opts.fields ? null : false));
      };
      back.addEventListener('click', (e) => { const r = e.target.getAttribute && e.target.getAttribute('data-r'); if (r) done(r === '1'); else if (e.target === back) done(false); });
      back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); });
      document.body.appendChild(back);
      const first = back.querySelector('input') || back.querySelector('[data-r="1"]');
      if (first) first.focus();
    });
  }
  const confirm = (title, text, opts) => dialog(title, '<p class="zx-muted">' + esc(text) + '</p>', opts);
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' o';
    const u = ['Ko', 'Mo', 'Go', 'To']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0).replace('.', ',') + ' ' + u[i];
  }
  function fmtDate(ts) { try { return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }

  window.zx = { post, call, on, $, esc, toast, dialog, confirm, fmtBytes, fmtDate, available: !!bridge };
})();
