// Bulle « Enregistrer le mot de passe ? » / « Mettre à jour ? » / « Enregistrer
// l'adresse ? » ancrée à la barre d'adresse, et icône clé de l'omnibox
// (src/features/passwords.js, src/features/autofill.js). Chargé par chrome.html
// après son script principal : réutilise post(), $(), reportHeight().
(function () {
  'use strict';
  const bridge = window.zaalisBridge;
  if (!bridge) return;

  const css = document.createElement('style');
  css.textContent = `
  .pw-key { width:28px; height:28px; border-radius:50%; flex:none; display:none; align-items:center; justify-content:center; color:var(--muted); cursor:default; }
  .pw-key.show { display:flex; }
  .pw-key:hover, .pw-key.on { background:var(--surface-h); color:var(--text); }
  .pw-key.pending { color:var(--accent, #1a73e8); }
  .pw-key svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .pw-pop { position:absolute; z-index:59; width:380px; max-width:calc(100vw - 24px); padding:18px 18px 16px;
    border:1px solid var(--border); border-radius:16px; background:var(--surface); color:var(--text);
    box-shadow:0 12px 34px rgba(0,0,0,.30); opacity:0; pointer-events:none; transform:translateY(-6px) scale(.985);
    transform-origin:top right; transition:opacity .15s ease, transform .15s ease; font:13.5px "Segoe UI",sans-serif; }
  body.pw-open .pw-pop { opacity:1; pointer-events:auto; transform:none; }
  .pw-head { display:flex; align-items:flex-start; gap:10px; margin-bottom:12px; }
  .pw-head .tt { flex:1; font-size:15.5px; font-weight:600; }
  .pw-head .x { width:28px; height:28px; margin:-4px -6px 0 0; border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--muted); }
  .pw-head .x:hover { background:var(--surface-h); color:var(--text); }
  .pw-head .x svg, .pw-eye svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .pw-field { display:flex; align-items:center; gap:6px; margin:8px 0; }
  .pw-field label { width:118px; color:var(--muted); font-size:12.5px; flex:none; }
  .pw-field input { flex:1; min-width:0; height:32px; padding:0 10px; border-radius:6px; border:1px solid var(--border); background:var(--input-bg, transparent); color:var(--text); font:inherit; outline:0; }
  .pw-field input:focus { border-color:var(--accent, #1a73e8); }
  .pw-eye { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--muted); flex:none; }
  .pw-eye:hover { background:var(--surface-h); color:var(--text); }
  .pw-sum { color:var(--muted); line-height:1.45; margin:4px 0 6px; }
  .pw-note { color:var(--muted); font-size:12px; margin-top:10px; }
  .pw-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  .pw-actions button { height:32px; padding:0 16px; border-radius:16px; border:1px solid var(--border); background:transparent; color:var(--accent, #1a73e8); font:600 13px "Segoe UI",sans-serif; }
  .pw-actions button:hover { background:var(--surface-h); }
  .pw-actions button.primary { background:var(--accent, #1a73e8); border-color:var(--accent, #1a73e8); color:#fff; }
  body.dark .pw-actions button.primary { color:#202124; }
  `;
  document.head.appendChild(css);

  const KEY_SVG = '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/></svg>';
  const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const X = '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>';

  const key = document.getElementById('pw-key');
  const pop = document.getElementById('pw-pop');
  if (!key || !pop) return;
  key.innerHTML = KEY_SVG;
  key.title = 'Gérer les mots de passe';

  let cur = null;           // { tabId, prompt }
  let activeTabId = null;
  window.pwPopOpen = false;

  function place() {
    const r = document.getElementById('address').getBoundingClientRect();
    const w = Math.min(380, window.innerWidth - 24);
    pop.style.left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  }
  function setOpen(open) {
    window.pwPopOpen = !!open;
    document.body.classList.toggle('pw-open', !!open);
    key.classList.toggle('on', !!open);
    if (open) place();
    if (typeof reportHeight === 'function') reportHeight();
  }
  function close(dismiss) {
    if (dismiss && cur) post(cur.prompt.kind === 'address' ? 'afDismiss' : 'pwDismiss', cur.tabId);
    if (cur && cur.prompt.kind === 'address') cur = null;
    setOpen(false);
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render() {
    const p = cur.prompt;
    pop.innerHTML = '';
    const head = el('div', 'pw-head');
    const title = p.kind === 'address' ? 'Enregistrer l\'adresse ?' : p.kind === 'update' ? 'Mettre à jour le mot de passe ?' : 'Enregistrer le mot de passe ?';
    head.appendChild(el('div', 'tt', title));
    const x = el('div', 'x'); x.innerHTML = X; x.title = 'Fermer'; x.onclick = () => close(false);
    head.appendChild(x);
    pop.appendChild(head);
    let userIn = null, pwIn = null;
    if (p.kind === 'address') {
      pop.appendChild(el('div', 'pw-sum', p.summary || ''));
    } else {
      const f1 = el('div', 'pw-field');
      f1.appendChild(el('label', '', 'Nom d\'utilisateur'));
      userIn = el('input'); userIn.value = p.username || ''; userIn.spellcheck = false;
      if (p.accounts && p.accounts.length) { const dl = el('datalist'); dl.id = 'pw-accounts'; p.accounts.forEach(a => { const o = el('option'); o.value = a; dl.appendChild(o); }); f1.appendChild(dl); userIn.setAttribute('list', 'pw-accounts'); }
      f1.appendChild(userIn);
      pop.appendChild(f1);
      const f2 = el('div', 'pw-field');
      f2.appendChild(el('label', '', 'Mot de passe'));
      pwIn = el('input'); pwIn.type = 'password'; pwIn.value = p.password || ''; pwIn.spellcheck = false;
      f2.appendChild(pwIn);
      const eye = el('div', 'pw-eye'); eye.innerHTML = EYE; eye.title = 'Afficher le mot de passe';
      eye.onclick = () => { const show = pwIn.type === 'password'; pwIn.type = show ? 'text' : 'password'; eye.innerHTML = show ? EYE_OFF : EYE; eye.title = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'; };
      f2.appendChild(eye);
      pop.appendChild(f2);
      pop.appendChild(el('div', 'pw-note', 'Site : ' + (p.host || '') + ' · chiffré sur cet appareil avec votre compte Windows.'));
    }
    const actions = el('div', 'pw-actions');
    if (p.kind === 'save') {
      const never = el('button', '', 'Jamais'); never.onclick = () => { post('pwNever', cur.tabId); cur = null; setOpen(false); };
      actions.appendChild(never);
    } else if (p.kind === 'address') {
      const no = el('button', '', 'Non merci'); no.onclick = () => close(true);
      actions.appendChild(no);
    } else {
      const no = el('button', '', 'Non merci'); no.onclick = () => { post('pwDismiss', cur.tabId); cur = null; setOpen(false); };
      actions.appendChild(no);
    }
    const ok = el('button', 'primary', p.kind === 'update' ? 'Mettre à jour' : 'Enregistrer');
    ok.id = 'pw-ok';
    ok.onclick = () => {
      if (p.kind === 'address') post('afSave', cur.tabId);
      else post('pwSave', cur.tabId, userIn.value, pwIn.value);
      cur = null; setOpen(false);
    };
    actions.appendChild(ok);
    pop.appendChild(actions);
    pop.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') ok.click(); if (e.key === 'Escape') close(false); };
  }

  bridge.addEventListener('message', (e) => {
    const d = e.data;
    if (!d) return;
    if (d.type === 'pwPrompt' && d.prompt) {
      cur = { tabId: d.tabId, prompt: d.prompt };
      if (activeTabId !== null && d.tabId !== activeTabId) return;   // affichée au retour sur l'onglet (icône clé)
      render(); setOpen(true);
    } else if (d.type === 'state') {
      const act = (d.tabs || []).find(t => t.active);
      const newActive = act ? act.id : null;
      const url = (d.active && d.active.url) || '';
      const web = /^https?:/i.test(url);
      const pw = d.pw || {};
      key.classList.toggle('show', web && !!pw.key);
      key.classList.toggle('pending', !!pw.pending);
      key.title = pw.pending ? 'Enregistrer le mot de passe' : 'Gérer les mots de passe';
      if (newActive !== activeTabId) {
        activeTabId = newActive;
        if (window.pwPopOpen && cur && cur.tabId !== activeTabId) setOpen(false);
      }
      if (window.pwPopOpen) place();
    }
  });

  key.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.pwPopOpen) { setOpen(false); return; }
    post('pwKey');
  });
  document.addEventListener('pointerdown', (e) => {
    if (window.pwPopOpen && !e.target.closest('#pw-pop, #pw-key')) setOpen(false);
  });
  window.addEventListener('resize', () => { if (window.pwPopOpen) place(); });
})();
