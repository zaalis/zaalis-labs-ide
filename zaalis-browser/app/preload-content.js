// Preload injecté dans chaque onglet de contenu.
// Ne fournit `window.zaalisBridge` que pour les pages internes zaalis://home/*
// (la page d'accueil s'en sert pour piloter les raccourcis et la recherche).
// Il ne faut surtout pas l'exposer aux sites externes : certains, dont YouTube,
// détectent cette API comme un environnement WebView et adaptent leur routage ou
// leur comportement d'autoplay.

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

ipcRenderer.on('zaalis:message', (_e, data) => {
  const evt = { data };
  for (const cb of listeners) { try { cb(evt); } catch (err) { console.error(err); } }
});

const webview = {
  postMessage(msg) {
    if (typeof msg !== 'string') { try { msg = JSON.stringify(msg); } catch { return; } }
    ipcRenderer.send('zaalis:postMessage', msg);
  },
  addEventListener(name, cb) {
    if (name === 'message' && typeof cb === 'function') listeners.add(cb);
  },
  removeEventListener(name, cb) {
    if (name === 'message') listeners.delete(cb);
  },
};

if (location.protocol === 'zaalis:') {
  // Le pont n'est publié que pour les pages de l'application. Les sites
  // externes ne voient ni API Electron, ni objet ajouté par le navigateur.
  contextBridge.exposeInMainWorld('zaalisBridge', webview);
}

// ===== Client Hints : navigator.userAgentData façon Google Chrome ============
// (src/features/clienthints.js réécrit les en-têtes Sec-CH-UA ; ici le même
// résultat côté JavaScript.) Exécuté dans le monde principal AVANT tout script
// de la page. Les accesseurs restent natifs (Proxy) : toString() inchangé.
if ((location.protocol === 'http:' || location.protocol === 'https:') && typeof contextBridge.executeInMainWorld === 'function') {
  try {
    const full = String((process && process.versions && process.versions.chrome) || ((navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1]) || '');
    contextBridge.executeInMainWorld({
      func: (major, fullVersion) => {
        const NUAD = window.NavigatorUAData;
        if (!NUAD || !NUAD.prototype || !major) return;
        const proto = NUAD.prototype;
        const fix = (list, version) => {
          const out = Array.from(list || [], b => ({ brand: String(b.brand), version: String(b.version) })).filter(b => b.brand !== 'Google Chrome');
          let i = out.findIndex(b => b.brand === 'Chromium');
          if (i < 0) { out.unshift({ brand: 'Chromium', version }); i = 0; }
          out.splice(i + 1, 0, { brand: 'Google Chrome', version: out[i].version || version });
          return Object.freeze(out.map(b => Object.freeze(b)));
        };
        const d = Object.getOwnPropertyDescriptor(proto, 'brands');
        if (d && d.get) {
          Object.defineProperty(proto, 'brands', Object.assign({}, d, {
            get: new Proxy(d.get, { apply: (t, self, args) => fix(Reflect.apply(t, self, args), major) }),
          }));
        }
        if (typeof proto.getHighEntropyValues === 'function') {
          proto.getHighEntropyValues = new Proxy(proto.getHighEntropyValues, {
            apply: (t, self, args) => Reflect.apply(t, self, args).then((r) => {
              if (r && r.brands) r.brands = fix(r.brands, major);
              if (r && r.fullVersionList) r.fullVersionList = fix(r.fullVersionList, fullVersion);
              return r;
            }),
          });
        }
        if (typeof proto.toJSON === 'function') {
          proto.toJSON = new Proxy(proto.toJSON, {
            apply: (t, self, args) => { const r = Reflect.apply(t, self, args); if (r && r.brands) r.brands = fix(r.brands, major); return r; },
          });
        }
      },
      args: [full.split('.')[0], full],
    });
  } catch (e) {}
}

// ===== Mots de passe et remplissage automatique ==============================
// (src/features/passwords.js et src/features/autofill.js)
// Pages web http/https, toutes les frames : détection des formulaires de
// connexion / inscription / changement de mot de passe (avec ou sans <form>)
// et des formulaires d'adresse, menu de suggestions dans un Shadow DOM fermé,
// remplissage. Le processus principal vérifie l'origine de la frame à chaque
// requête : la page ne reçoit jamais la liste des comptes enregistrés, seulement
// le compte choisi par l'utilisateur au moment du remplissage.
if (location.protocol === 'http:' || location.protocol === 'https:') (() => {
  const ask = (kind, data) => ipcRenderer.invoke('zaalis:page', Object.assign({}, data || {}, { kind })).catch(() => null);
  const USER_TYPES = new Set(['text', 'email', 'tel', '']);
  const attr = (el, n) => String((el && el.getAttribute && el.getAttribute(n)) || '').toLowerCase();
  const isInput = (el) => !!el && el.tagName === 'INPUT';
  const isPw = (el) => isInput(el) && el.type === 'password';
  const isUserField = (el) => isInput(el) && USER_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  function labelOf(el) {
    let t = '';
    try { if (el.labels) for (const l of el.labels) t += ' ' + l.textContent; } catch (e) {}
    t += ' ' + (el.getAttribute('aria-label') || '');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const n = document.getElementById(id); if (n) t += ' ' + n.textContent; }
    return t;
  }
  const hintOf = (el) => (attr(el, 'name') + ' ' + attr(el, 'id') + ' ' + attr(el, 'placeholder') + ' ' + labelOf(el)).toLowerCase();
  const inputsIn = (root) => Array.from(root.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden');
  const pwFieldsIn = (root, withValue) => inputsIn(root).filter(i => isPw(i) && (withValue ? !!i.value : visible(i)));

  // Conteneur logique d'un champ : son <form>, sinon l'ancêtre le plus proche
  // qui regroupe le(s) mot(s) de passe et l'identifiant (SPA sans <form>).
  function containerOf(el) {
    if (el.form) return el.form;
    let n = el.parentElement, best = null;
    for (let i = 0; n && i < 10; i++, n = n.parentElement) {
      if (n.querySelector('input[type=password]')) { best = n; if (n.querySelectorAll('input').length >= 2) return n; }
      if (n === document.body) break;
    }
    return best || document.body || document.documentElement;
  }
  function usernameFor(root, pw) {
    const all = inputsIn(root);
    const ac = all.find(i => isUserField(i) && /\busername\b/.test(attr(i, 'autocomplete')));
    if (ac) return ac;
    const idx = pw ? all.indexOf(pw) : all.length;
    for (let i = idx - 1; i >= 0; i--) { const c = all[i]; if (isUserField(c) && (visible(c) || c.value)) return c; }
    return null;
  }
  const NEW_RE = /new|nouveau|nouvel|confirm|repeat|retype|again|verif|r[ée]p[ée]t|signup|sign-up|register|inscri|create|cr[ée]er/;
  const CONFIRM_RE = /confirm|repeat|retype|again|verif|r[ée]p[ée]t|re-?enter|ressaisi/;
  function roleOf(pw, root) {
    const ac = attr(pw, 'autocomplete');
    if (ac.includes('new-password')) return 'new';
    if (ac.includes('current-password')) return 'current';
    const pws = pwFieldsIn(root, false);
    const i = pws.indexOf(pw);
    if (pws.length >= 3) return i === 0 ? 'current' : 'new';
    if (pws.length === 2) {
      if (CONFIRM_RE.test(hintOf(pws[1])) && !/current|actuel|old|ancien/.test(hintOf(pws[0]))) return 'new';
      return i === 0 ? 'current' : 'new';
    }
    return NEW_RE.test(hintOf(pw)) ? 'new' : 'current';
  }

  // ----- Collecte à la soumission ----------------------------------------
  let lastUser = '';   // identifiant saisi à l'étape précédente (connexion en deux temps)
  function collectLogin(root) {
    const pws = pwFieldsIn(root, true);
    if (!pws.length) return null;
    let current = '', fresh = '';
    const acCur = pws.find(p => attr(p, 'autocomplete').includes('current-password'));
    const acNew = pws.filter(p => attr(p, 'autocomplete').includes('new-password'));
    if (acCur || acNew.length) {
      current = acCur ? acCur.value : '';
      fresh = acNew.length ? acNew[0].value : '';
      if (acNew.length >= 2 && acNew[0].value !== acNew[1].value) return null;
    } else if (pws.length === 1) {
      if (roleOf(pws[0], root) === 'new') fresh = pws[0].value; else current = pws[0].value;
    } else if (pws.length === 2) {
      if (pws[0].value === pws[1].value) fresh = pws[0].value;
      else { current = pws[0].value; fresh = pws[1].value; }
    } else {
      current = pws[0].value; fresh = pws[1].value;
      if (pws[2].value !== fresh) return null;
    }
    const u = usernameFor(root, pws[0]);
    const username = ((u && u.value) || lastUser || '').trim();
    return { username, password: current, newPassword: fresh, formType: fresh ? (current ? 'change' : 'signup') : 'login' };
  }

  // ----- Champs d'adresse ------------------------------------------------
  const AF_AC = {
    'email': 'email', 'tel': 'phone', 'tel-national': 'phone', 'postal-code': 'postalCode',
    'address-level2': 'city', 'country': 'country', 'country-name': 'country', 'organization': 'organization',
    'street-address': 'street', 'address-line1': 'street', 'address-line2': 'street2',
    'given-name': 'givenName', 'family-name': 'familyName', 'name': 'name',
  };
  const AF_RE = [
    ['email', /e-?mail|courriel|m[ée]l\b/],
    ['phone', /t[ée]l[ée]phone|phone|mobile|portable|\btel\b|gsm/],
    ['postalCode', /postal|\bzip|code ?postal|\bcp\b|postcode/],
    ['city', /city|ville|town|localit[ée]|commune/],
    ['country', /country|\bpays\b/],
    ['organization', /company|organi[sz]ation|soci[ée]t[ée]|entreprise|business/],
    ['street2', /line ?2|address2|addr2|compl[ée]ment|appartement|\bapt\b|b[aâ]timent/],
    ['street', /address|adresse|street|\brue\b|voie|line ?1|addr1/],
    ['givenName', /first.?name|given|pr[ée]nom|fname/],
    ['familyName', /last.?name|family|surname|nom de famille|lname/],
    ['name', /full.?name|\bname\b|\bnom\b/],
  ];
  const AF_EXCLUDE = /user|login|identifiant|pseudo|search|recherche|coupon|promo|captcha|password|mot de passe|card|carte|cvc|iban/;
  function addressType(el) {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') || el.disabled || el.readOnly) return '';
    if (el.tagName === 'INPUT' && !['text', 'email', 'tel', ''].includes(el.type)) return '';
    const tokens = attr(el, 'autocomplete').split(/\s+/);
    for (const tk of tokens) if (AF_AC[tk]) return AF_AC[tk];
    const h = hintOf(el);
    if (AF_EXCLUDE.test(h)) return '';
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
    for (const [type, re] of AF_RE) if (re.test(h)) return type;
    return '';
  }
  const addrFieldsIn = (root) => Array.from(root.querySelectorAll('input, select')).filter(i => i.type !== 'hidden' && addressType(i));
  function addrContainerOf(el) {
    if (el.form) return el.form;
    let n = el.parentElement;
    for (let i = 0; n && i < 10; i++, n = n.parentElement) {
      if (new Set(addrFieldsIn(n).map(addressType)).size >= 3) return n;
      if (n === document.body) break;
    }
    return document.body || document.documentElement;
  }
  function fieldValue(el) {
    if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return o && o.value ? o.text.trim() : ''; }
    return String(el.value || '').trim();
  }
  function collectAddress(root) {
    if (pwFieldsIn(root, true).length) return null;
    const v = {};
    for (const el of addrFieldsIn(root)) { const val = fieldValue(el); if (val && !v[addressType(el)]) v[addressType(el)] = val; }
    if (!v.name && (v.givenName || v.familyName)) v.name = [v.givenName, v.familyName].filter(Boolean).join(' ');
    delete v.givenName; delete v.familyName;
    const isAddress = v.street || (v.postalCode && v.city);
    if (!isAddress || Object.keys(v).length < 3) return null;
    return v;
  }

  // ----- Envoi des soumissions --------------------------------------------
  let lastKey = '', lastKeyAt = 0;
  function once(key) {
    if (key === lastKey && Date.now() - lastKeyAt < 4000) return false;
    lastKey = key; lastKeyAt = Date.now();
    return true;
  }
  function report(root) {
    if (!root) return;
    const data = collectLogin(root);
    if (data) {
      if (once('pw\u0000' + data.username + '\u0000' + data.password + '\u0000' + data.newPassword)) ask('pwSubmitted', data);
      return;
    }
    const addr = collectAddress(root);
    if (addr) { if (once('af\u0000' + JSON.stringify(addr))) ask('afSubmitted', { values: addr }); return; }
    // Première étape d'une connexion en deux temps : on retient l'identifiant.
    const u = inputsIn(root).find(i => isUserField(i) && i.value && /user|login|e-?mail|identifiant|courriel|account|compte/.test(hintOf(i) + ' ' + attr(i, 'autocomplete') + ' ' + i.type));
    if (u) lastUser = u.value.trim();
  }
  function rootForButton(b) {
    if (b.form) return b.form;
    let n = b.parentElement;
    for (let i = 0; n && i < 10; i++, n = n.parentElement) {
      if (pwFieldsIn(n, true).length || new Set(addrFieldsIn(n).map(addressType)).size >= 3) return n;
      if (n === document.body) break;
    }
    return null;
  }
  window.addEventListener('submit', (e) => { if (e.target && e.target.tagName === 'FORM') report(e.target); }, true);
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || !e.target || !e.target.closest) return;
    const b = e.target.closest('button, input[type=submit], input[type=button], input[type=image], [role=button], a');
    if (b) { const r = rootForButton(b); if (r) report(r); }
  }, true);

  // Mot de passe saisi puis formulaire disparu (SPA) ou page quittée.
  let snap = null;   // { el, data, at }
  function snapshot(el) {
    const root = containerOf(el);
    const data = collectLogin(root);
    snap = data ? { el, data, at: Date.now() } : null;
  }
  function flushSnap(force) {
    if (!snap) return;
    if (force || !snap.el.isConnected) {
      const s = snap; snap = null;
      if (Date.now() - s.at < 120000 && once('pw\u0000' + s.data.username + '\u0000' + s.data.password + '\u0000' + s.data.newPassword)) ask('pwSubmitted', s.data);
    }
  }
  window.addEventListener('input', (e) => {
    const el = e.target;
    if (!e.isTrusted || !isInput(el)) return;
    if (isPw(el)) snapshot(el);
    else if (snap && isUserField(el)) snapshot(snap.el);
    if (menuField === el) refilter();
  }, true);
  window.addEventListener('pagehide', () => flushSnap(true));

  // ----- Menu de suggestions (Shadow DOM fermé) ---------------------------
  let host = null, menu = null, menuItems = [], allItems = [], menuSel = -1, menuField = null, menuSeq = 0, filterMode = '';
  const ICONS = {
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/></svg>',
    gen: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    addr: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    manage: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function ensureMenu() {
    if (host && host.isConnected) return;
    host = document.createElement('zaalis-autofill');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;display:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' +
      '.m{font:13px "Segoe UI",system-ui,sans-serif;color:#202124;background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25);padding:6px 0;min-width:240px;max-width:420px;max-height:320px;overflow:auto}' +
      '.i{display:flex;align-items:center;gap:10px;padding:7px 14px;cursor:default}.i.s,.i:hover{background:#e8f0fe}' +
      '.i svg{width:18px;height:18px;flex:none;fill:none;stroke:#5f6368;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
      '.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.u{color:#5f6368;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.c{min-width:0}' +
      '.sep{border-top:1px solid #e0e0e0;margin:4px 0}.mono{font-family:Consolas,monospace}' +
      '@media (prefers-color-scheme:dark){.m{background:#292a2d;color:#e8eaed}.i.s,.i:hover{background:#394457}.u{color:#9aa0a6}.sep{border-color:#3c4043}.i svg{stroke:#9aa0a6}}' +
      '</style><div class="m" role="listbox"></div>';
    menu = shadow.querySelector('.m');
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const it = e.target.closest && e.target.closest('[data-i]');
      if (it) choose(+it.getAttribute('data-i'));
    });
    (document.documentElement || document).appendChild(host);
  }
  function renderMenu() {
    menu.innerHTML = menuItems.map((it, i) =>
      (it.sep ? '<div class="sep"></div>' : '') +
      '<div class="i' + (i === menuSel ? ' s' : '') + '" data-i="' + i + '" role="option">' + (ICONS[it.icon] || '') +
      '<div class="c"><div class="t">' + esc(it.label) + '</div>' + (it.sub ? '<div class="u' + (it.mono ? ' mono' : '') + '">' + esc(it.sub) + '</div>' : '') + '</div></div>').join('');
  }
  function placeMenu() {
    if (!host || !menuField || !menuField.isConnected) return hideMenu();
    const r = menuField.getBoundingClientRect();
    const h = menu.offsetHeight || 120;
    const below = r.bottom + 4 + h < innerHeight || r.top < h;
    host.style.left = Math.max(4, Math.min(r.left, innerWidth - 250)) + 'px';
    host.style.top = (below ? r.bottom + 4 : r.top - h - 4) + 'px';
    menu.style.minWidth = Math.max(240, Math.min(r.width, 420)) + 'px';
  }
  function showMenu(field, items, mode) {
    ensureMenu();
    menuField = field; allItems = items; filterMode = mode || '';
    menuItems = items.slice(); menuSel = -1;
    renderMenu();
    host.style.display = 'block';
    placeMenu();
  }
  function hideMenu() { if (host) host.style.display = 'none'; menuField = null; menuItems = []; menuSel = -1; }
  function refilter() {
    if (!menuField || filterMode !== 'prefix') return;
    const q = String(menuField.value || '').toLowerCase();
    menuItems = allItems.filter(it => it.always || !q || String(it.label).toLowerCase().startsWith(q));
    if (!menuItems.some(it => !it.always)) return hideMenu();
    menuSel = -1; renderMenu(); placeMenu();
  }
  function choose(i) {
    const it = menuItems[i];
    const field = menuField;
    hideMenu();
    if (it && it.run) it.run(field);
  }
  window.addEventListener('keydown', (e) => {
    if (menuField && e.target === menuField && host && host.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        const n = menuItems.length;
        menuSel = e.key === 'ArrowDown' ? (menuSel + 1) % n : (menuSel - 1 + n) % n;
        renderMenu(); return;
      }
      if (e.key === 'Enter' && menuSel >= 0) { e.preventDefault(); e.stopImmediatePropagation(); choose(menuSel); return; }
      if (e.key === 'Escape') { hideMenu(); return; }
    }
    if (e.key === 'Enter' && e.isTrusted && isInput(e.target)) {
      const t = e.target;
      setTimeout(() => report(isPw(t) || pwFieldsIn(containerOf(t), true).length ? containerOf(t) : addrContainerOf(t)), 0);
    }
  }, true);
  window.addEventListener('focusout', (e) => { if (e.target === menuField) setTimeout(() => { if (document.activeElement !== menuField) hideMenu(); }, 150); }, true);
  window.addEventListener('scroll', () => { if (menuField) placeMenu(); }, true);
  window.addEventListener('resize', () => { if (menuField) placeMenu(); });

  // ----- Remplissage ------------------------------------------------------
  function setValue(el, v) {
    if (!el) return;
    if (el.tagName === 'SELECT') {
      const want = String(v || '').toLowerCase();
      const opt = Array.from(el.options).find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want);
      if (!opt) return;
      el.value = opt.value;
    } else {
      el.value = v == null ? '' : String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function fillLogin(root, id) {
    const c = await ask('pwFill', { id });
    if (!c) return;
    const pws = pwFieldsIn(root, false);
    const target = pws.find(p => roleOf(p, root) === 'current') || pws[0];
    const u = usernameFor(root, target || null);
    if (u && c.username) setValue(u, c.username);
    if (target) setValue(target, c.password);
  }
  function fillNew(root, password) {
    for (const p of pwFieldsIn(root, false)) if (roleOf(p, root) === 'new') setValue(p, password);
  }
  function constraintsOf(el) {
    return { minLength: el.minLength > 0 ? el.minLength : 0, maxLength: el.maxLength > 0 ? el.maxLength : 0, pattern: el.getAttribute('pattern') || '' };
  }
  async function fillAddress(root, id) {
    const p = await ask('afFill', { id });
    if (!p) return;
    const parts = String(p.name || '').trim().split(/\s+/);
    const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
    const family = parts.length > 1 ? parts[parts.length - 1] : '';
    for (const el of addrFieldsIn(root)) {
      const t = addressType(el);
      const v = t === 'givenName' ? given : t === 'familyName' ? family : p[t];
      if (v && !fieldValue(el)) setValue(el, v);
    }
  }

  // ----- Suggestions au focus ---------------------------------------------
  async function onFieldFocus(el) {
    const seq = ++menuSeq;
    let items = [], mode = '';
    const root = containerOf(el);
    const loginField = isPw(el) || (isUserField(el) && pwFieldsIn(root, false).length > 0 && !addressTypeStrict(el));
    if (loginField) {
      const role = isPw(el) ? roleOf(el, root) : 'username';
      if (role === 'new') {
        const g = await ask('pwGenerate', constraintsOf(el));
        if (g && g.password) items.push({ icon: 'gen', label: 'Utiliser un mot de passe sécurisé', sub: g.password, mono: true, run: () => fillNew(root, g.password) });
      } else {
        const r = await ask('pwSuggest', {});
        if (r && r.items && r.items.length) {
          for (const it of r.items) items.push({ icon: 'key', label: it.username || '(aucun identifiant)', sub: it.site, run: () => fillLogin(root, it.id) });
          items.push({ icon: 'manage', label: 'Gérer les mots de passe…', sep: true, always: true, run: () => ask('pwManage', {}) });
          if (role === 'username') mode = 'prefix';
        }
      }
    } else if (el.tagName === 'INPUT') {
      const type = addressType(el);
      if (type) {
        const r = await ask('afSuggest', { type });
        if (r && r.items && r.items.length) {
          for (const it of r.items) items.push({ icon: 'addr', label: it.label, sub: it.sub, run: () => fillAddress(addrContainerOf(el), it.id) });
          items.push({ icon: 'manage', label: 'Gérer les adresses…', sep: true, always: true, run: () => ask('afManage', {}) });
          mode = 'prefix';
        }
      }
    }
    if (seq !== menuSeq || document.activeElement !== el) return;
    if (items.length) { showMenu(el, items, mode); if (mode) refilter(); } else hideMenu();
  }
  // Champ e-mail d'un formulaire d'adresse explicitement marqué comme tel.
  const addressTypeStrict = (el) => /\b(email|tel|postal-code|street-address|address-line1)\b/.test(attr(el, 'autocomplete')) && !/username/.test(attr(el, 'autocomplete'));
  window.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!e.isTrusted || !isInput(el) || el.readOnly || el.disabled) return;
    onFieldFocus(el);
  }, true);

  // ----- Remplissage automatique au chargement (un seul compte) ------------
  const autoTried = new WeakSet();
  async function tryAutofill() {
    const pws = Array.from(document.querySelectorAll('input[type=password]')).filter(p => !autoTried.has(p) && visible(p));
    if (!pws.length) return;
    pws.forEach(p => autoTried.add(p));
    const p = pws[0];
    const root = containerOf(p);
    if (pwFieldsIn(root, false).length !== 1 || roleOf(p, root) !== 'current' || p.value) return;
    const c = await ask('pwAutofill', {});
    if (!c || !c.password || p.value) return;
    // Comme Chrome, le site ne doit pas pouvoir lire les identifiants avant
    // une action de l'utilisateur : le remplissage attend la première
    // interaction réelle (clic, toucher, touche) avec la page.
    const fill = () => {
      if (p.value || !p.isConnected) return;
      const u = usernameFor(root, p);
      if (u && !u.value && c.username) setValue(u, c.username);
      setValue(p, c.password);
    };
    if (userActed) { fill(); return; }
    pendingFills.push(fill);
  }
  let userActed = false;
  const pendingFills = [];
  const onFirstAct = (e) => {
    if (!e.isTrusted || userActed) return;
    userActed = true;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, onFirstAct, true);
    pendingFills.splice(0).forEach(f => { try { f(); } catch (err) {} });
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, onFirstAct, true);
  let moTimer = 0;
  function onMutations() {
    if (moTimer) return;
    moTimer = setTimeout(() => { moTimer = 0; flushSnap(false); tryAutofill(); }, 400);
  }
  function start() {
    try { new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    setTimeout(tryAutofill, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

// ===== Chrome Web Store : « Ajouter à zaalis » ================================
// (src/features/extensions.js) Sur une fiche d'extension, le bouton officiel
// « Ajouter à Chrome » (inopérant hors de Chrome) est relabellisé et redirigé
// vers l'installation zaalis ; à défaut, un bouton flottant est ajouté. Monde
// isolé du preload : la page ne voit ni la fonction ni le canal IPC.
(function () {
  if (location.protocol !== 'https:' || window.top !== window) return;
  const host = location.hostname;
  if (host !== 'chromewebstore.google.com' && !(host === 'chrome.google.com' && location.pathname.startsWith('/webstore/'))) return;
  const idOf = () => { const m = /\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(location.pathname); return m ? m[1] : null; };
  const ADD_RE = /^\s*(Ajouter à Chrome|Add to Chrome|Passer à Chrome|Switch to Chrome|Obtenir|Get|Ajouter à zaalis|Supprimer de zaalis|Supprimer de Chrome|Remove from Chrome)\s*$/i;
  let state = { id: null, installed: false, busy: false };
  let floating = null;

  const invoke = (kind, extra) => ipcRenderer.invoke('zaalis:page', Object.assign({ kind }, extra || {})).catch(() => null);
  const label = () => state.busy ? 'Installation…' : (state.installed ? 'Supprimer de zaalis' : 'Ajouter à zaalis');

  async function onClick(ev) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (state.busy || !state.id) return;
    state.busy = true; paint();
    const r = await invoke(state.installed ? 'extStoreRemove' : 'extStoreInstall', { id: state.id });
    state.busy = false;
    if (r && typeof r.installed === 'boolean') state.installed = r.installed;
    await refresh();
  }
  function officialButtons() {
    return Array.from(document.querySelectorAll('button')).filter(b => ADD_RE.test(b.textContent || '') && b.offsetParent !== null);
  }
  function paint() {
    const btns = state.id ? officialButtons() : [];
    for (const b of btns) {
      if (!b.__zaalis) {
        b.__zaalis = true;
        b.addEventListener('click', onClick, true);
      }
      b.disabled = false; b.removeAttribute('disabled'); b.removeAttribute('aria-disabled');
      const span = Array.from(b.querySelectorAll('span')).reverse().find(s => ADD_RE.test(s.textContent || '')) || b;
      if (span.textContent !== label()) span.textContent = label();
    }
    if (state.id && !btns.length) {
      if (!floating) {
        floating = document.createElement('button');
        floating.setAttribute('style', 'position:fixed;top:84px;right:24px;z-index:2147483647;height:40px;padding:0 22px;border:0;border-radius:20px;' +
          'background:#1a73e8;color:#fff;font:600 14px "Google Sans",Roboto,"Segoe UI",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer');
        floating.addEventListener('click', onClick, true);
        (document.body || document.documentElement).appendChild(floating);
      }
      if (floating.textContent !== label()) floating.textContent = label();
      const bg = state.installed ? 'rgb(95, 99, 104)' : 'rgb(26, 115, 232)';
      if (floating.style.background !== bg) floating.style.background = bg;
    } else if (floating) { floating.remove(); floating = null; }
  }
  async function refresh() {
    const id = idOf();
    if (!id) { state.id = null; paint(); return; }
    const r = await invoke('extStoreState', { id });
    state.id = r && r.supported ? id : null;
    state.installed = !!(r && r.installed);
    paint();
  }
  let t = 0, lastPath = '';
  function watch() {
    if (t) return;
    t = setTimeout(() => {
      t = 0;
      if (location.pathname !== lastPath) { lastPath = location.pathname; refresh(); } else paint();
    }, 250);
  }
  function start() {
    try { new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    watch();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
