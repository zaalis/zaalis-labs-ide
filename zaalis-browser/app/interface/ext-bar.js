// Extensions dans la barre d'outils (src/features/extensions.js) : icônes
// épinglées avec badge, bouton « puzzle » et son menu, comme Chrome. Chargé
// par chrome.html après son script principal : réutilise post(), $(),
// reportHeight(). Les popups d'action sont des vues natives ouvertes par main.js.
(function () {
  'use strict';
  const bridge = window.zaalisBridge;
  if (!bridge) return;

  const css = document.createElement('style');
  css.textContent = `
  .ext-bar { display:flex; align-items:center; gap:2px; flex:none; }
  .ext-bar:empty { display:none; }
  .ext-btn { position:relative; width:34px; height:34px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center; }
  .ext-btn:hover, .ext-btn.on { background:var(--surface-h); }
  .ext-btn:active { transform:scale(.88); }
  .ext-btn img { width:18px; height:18px; object-fit:contain; pointer-events:none; }
  .ext-btn .ph { width:18px; height:18px; border-radius:4px; background:var(--muted); color:#fff; font:700 11px/18px "Segoe UI",sans-serif; text-align:center; }
  .ext-btn.off { opacity:.45; }
  .ext-badge { position:absolute; right:1px; bottom:3px; min-width:14px; height:13px; padding:0 3px; border-radius:3px;
    background:#5f6368; color:#fff; font:700 9.5px/13px "Segoe UI",sans-serif; text-align:center; pointer-events:none; white-space:nowrap; max-width:30px; overflow:hidden; }
  #ext-puzzle svg { width:19px; height:19px; }
  .ext-pop { position:absolute; top:94px; right:10px; width:320px; max-width:calc(100vw - 20px); z-index:58;
    background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:16px; padding:8px;
    box-shadow:0 10px 34px rgba(0,0,0,.28); opacity:0; pointer-events:none; transform:translateY(-6px) scale(.99); transform-origin:top right;
    transition:opacity .15s ease, transform .15s ease; font:13.5px "Segoe UI",sans-serif; }
  body.ext-open .ext-pop { opacity:1; pointer-events:auto; transform:none; }
  .ext-pop .hd { display:flex; align-items:center; padding:6px 8px 8px 12px; font-size:15px; font-weight:600; }
  .ext-pop .hd span { flex:1; }
  .ext-pop .list { max-height:340px; overflow-y:auto; }
  .ext-pop .row { display:flex; align-items:center; gap:10px; height:40px; padding:0 6px 0 12px; border-radius:10px; }
  .ext-pop .row:hover { background:var(--surface-h); }
  .ext-pop .row img, .ext-pop .row .ph { width:18px; height:18px; flex:none; object-fit:contain; }
  .ext-pop .row .ph { border-radius:4px; background:var(--muted); color:#fff; font:700 11px/18px "Segoe UI",sans-serif; text-align:center; }
  .ext-pop .row .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ext-pop .row.off .nm { opacity:.5; }
  .ext-pop .ib { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--muted); flex:none; }
  .ext-pop .ib:hover { background:var(--border); color:var(--text); }
  .ext-pop .ib.pinned { color:var(--accent); }
  .ext-pop .ib svg, .ext-pop .foot svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .ext-pop .ib.pinned svg { fill:currentColor; }
  .ext-pop .empty { padding:10px 12px 14px; color:var(--muted); line-height:1.45; }
  .ext-pop .foot { display:flex; align-items:center; gap:10px; height:38px; padding:0 12px; border-radius:10px; margin-top:2px; }
  .ext-pop .foot:hover { background:var(--surface-h); }
  .ext-pop .sep { height:1px; background:var(--border); margin:6px 4px; }
  `;
  document.head.appendChild(css);

  const PUZZLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4a2 2 0 0 1 4 0v2h4v4h-2a2 2 0 0 0 0 4h2v4h-4v-2a2 2 0 0 0-4 0v2H6v-4H4a2 2 0 0 1 0-4h2V6h4z"/></svg>';
  const PIN = '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></svg>';
  const GEAR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>';
  const STORE = '<svg viewBox="0 0 24 24"><path d="M4 8h16l-1 12H5z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';

  const bar = document.createElement('div');
  bar.className = 'ext-bar'; bar.id = 'ext-bar';
  const puzzle = document.createElement('div');
  puzzle.className = 'iconbtn'; puzzle.id = 'ext-puzzle'; puzzle.title = 'Extensions';
  puzzle.innerHTML = PUZZLE;
  const anchor = document.getElementById('downloads') || document.getElementById('settings');
  if (!anchor || !anchor.parentNode) return;
  anchor.parentNode.insertBefore(bar, anchor);
  anchor.parentNode.insertBefore(puzzle, anchor);
  const pop = document.createElement('div');
  pop.className = 'ext-pop'; pop.id = 'ext-pop';
  document.body.appendChild(pop);

  let exts = [];
  let incognito = false;
  window.extPopOpen = false;
  const send = (...p) => { try { post(...p); } catch (e) { bridge.postMessage(p.join('\x1f')); } };
  const relayout = () => { try { reportHeight(); } catch (e) {} };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function iconNode(e) {
    if (e.icon) { const img = document.createElement('img'); img.src = e.icon; img.alt = ''; return img; }
    const ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = (e.name || '?').trim().charAt(0).toUpperCase(); return ph;
  }
  function rectArgs(el) { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.bottom)]; }
  function activate(e, el) { setOpen(false); send('extActionClick', e.id, ...rectArgs(el)); }

  function renderBar() {
    bar.innerHTML = '';
    for (const e of exts.filter(x => x.pinned)) {
      const b = document.createElement('div');
      b.className = 'ext-btn' + (e.enabled ? '' : ' off') + (e.popupOpen ? ' on' : '');
      b.title = e.title || e.name;
      b.dataset.id = e.id;
      b.appendChild(iconNode(e));
      if (e.badge) {
        const bd = document.createElement('div');
        bd.className = 'ext-badge'; bd.textContent = e.badge;
        if (e.badgeBg) bd.style.background = e.badgeBg;
        if (e.badgeColor) bd.style.color = e.badgeColor;
        b.appendChild(bd);
      }
      b.addEventListener('click', () => { if (e.enabled) activate(e, b); });
      b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); const r = b.getBoundingClientRect(); send('extIconMenu', e.id, Math.round(r.left), Math.round(r.bottom)); });
      bar.appendChild(b);
    }
    puzzle.classList.toggle('ai-on', window.extPopOpen);
  }
  function renderPop() {
    const rows = exts.map((e, i) => '<div class="row' + (e.enabled ? '' : ' off') + '" data-i="' + i + '" title="' + esc(e.title || e.name) + '">' +
      '<span class="ic"></span><div class="nm">' + esc(e.name) + '</div>' +
      '<div class="ib' + (e.pinned ? ' pinned' : '') + '" data-pin="' + i + '" title="' + (e.pinned ? 'Retirer de la barre d\'outils' : 'Épingler') + '">' + PIN + '</div>' +
      '<div class="ib" data-menu="' + i + '" title="Plus d\'actions">&#8942;</div></div>').join('');
    pop.innerHTML = '<div class="hd"><span>Extensions</span></div>' +
      (incognito ? '<div class="empty">Les extensions sont désactivées en navigation privée.</div>' : '') +
      (exts.length ? '<div class="list">' + rows + '</div>' : '<div class="empty">Aucune extension installée. Trouvez-en sur le Chrome Web Store : le bouton « Ajouter à zaalis » les installe directement.</div>') +
      '<div class="sep"></div>' +
      '<div class="foot" id="ext-store">' + STORE + '<span>Découvrir plus d\'extensions</span></div>' +
      '<div class="foot" id="ext-manage">' + GEAR + '<span>Gérer les extensions</span></div>';
    pop.querySelectorAll('.row').forEach((row) => {
      const e = exts[+row.dataset.i];
      row.querySelector('.ic').replaceWith(iconNode(e));
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-pin]')) { send('extPin', e.id, e.pinned ? '0' : '1'); return; }
        if (ev.target.closest('[data-menu]')) { const r = ev.target.closest('[data-menu]').getBoundingClientRect(); send('extIconMenu', e.id, Math.round(r.left), Math.round(r.bottom)); return; }
        if (e.enabled) activate(e, puzzle);
      });
    });
    pop.querySelector('#ext-store').onclick = () => { setOpen(false); send('extOpenStore'); };
    pop.querySelector('#ext-manage').onclick = () => { setOpen(false); send('extManage'); };
  }
  function position() {
    const r = puzzle.getBoundingClientRect();
    pop.style.right = Math.max(10, Math.round(window.innerWidth - r.right - 4)) + 'px';
    pop.style.top = Math.round(r.bottom + 6) + 'px';
  }
  function setOpen(open) {
    window.extPopOpen = !!open;
    document.body.classList.toggle('ext-open', window.extPopOpen);
    if (window.extPopOpen) { position(); renderPop(); }
    puzzle.classList.toggle('ai-on', window.extPopOpen);
    relayout();
  }
  puzzle.addEventListener('click', () => setOpen(!window.extPopOpen));
  document.addEventListener('mousedown', (e) => {
    if (window.extPopOpen && !e.target.closest('#ext-pop, #ext-puzzle')) setOpen(false);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.extPopOpen) setOpen(false); });
  window.addEventListener('resize', () => { if (window.extPopOpen) position(); });

  bridge.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.type !== 'state' || !Array.isArray(d.extensions)) return;
    const next = JSON.stringify([d.extensions, d.extensionsIncognito]);
    if (next === renderBar.last) return;
    renderBar.last = next;
    exts = d.extensions.filter(e => e.hasAction || true);
    incognito = !!d.extensionsIncognito;
    renderBar();
    if (window.extPopOpen) renderPop();
  });
})();
