'use strict';
/* =============================================================================
 *  Remplissage automatique des adresses et formulaires (façon Chrome)
 * -----------------------------------------------------------------------------
 *  Adresses enregistrées par profil (chiffrées), proposées après l'envoi d'un
 *  formulaire d'adresse, suggérées au focus d'un champ reconnu (autocomplete=…
 *  ou heuristiques FR/EN sur name/id/label) et remplies dans tout le
 *  formulaire. Pas de cartes bancaires. Script de contenu : section « Mots de
 *  passe et remplissage automatique » de preload-content.js.
 * =========================================================================== */

const FIELDS = ['name', 'organization', 'street', 'street2', 'postalCode', 'city', 'country', 'phone', 'email'];
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9@+]/g, '');

function init(ctx) {
  const { path, crypto } = ctx;
  let store = null, storeProfile = null;
  const file = () => path.join(ctx.profileDataDir(), 'autofill.json');
  function load() {
    if (store && storeProfile === ctx.currentProfileId) return store;
    storeProfile = ctx.currentProfileId;
    const d = ctx.readJson(file(), null, true) || {};
    store = { version: 1, profiles: Array.isArray(d.profiles) ? d.profiles : [], settings: Object.assign({ enabled: true }, d.settings || {}) };
    return store;
  }
  function save() {
    ctx.writeJson(file(), store, true);
    for (const t of ctx.tabs) {
      try { if (t.view.webContents.getURL().startsWith('zaalis://home/passwords.html')) t.view.webContents.send('zaalis:message', { type: 'pwChanged' }); } catch {}
    }
  }
  function clean(v) {
    const out = {};
    for (const f of FIELDS) out[f] = String((v && v[f]) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return out;
  }
  // Même adresse : même rue + code postal, ou même nom + e-mail.
  function sameAs(a, b) {
    if (a.street && b.street && norm(a.street) === norm(b.street) && norm(a.postalCode) === norm(b.postalCode)) return true;
    if (a.name && b.name && a.email && b.email && norm(a.name) === norm(b.name) && norm(a.email) === norm(b.email)) return true;
    return false;
  }
  function upsert(values, opts) {
    const s = load();
    const v = clean(values);
    const existing = s.profiles.find(p => (opts && opts.id ? p.id === opts.id : sameAs(p, v)));
    if (existing) {
      let changed = false;
      for (const f of FIELDS) if (v[f] && v[f] !== existing[f] && (!existing[f] || (opts && opts.overwrite))) { existing[f] = v[f]; changed = true; }
      if (changed) existing.updated = Date.now();
      return { profile: existing, status: changed ? 'updated' : 'unchanged' };
    }
    const p = Object.assign({ id: 'a' + crypto.randomBytes(6).toString('hex'), created: Date.now(), updated: Date.now(), used: 0 }, v);
    s.profiles.push(p);
    return { profile: p, status: 'added' };
  }
  const summary = (p) => [p.name, p.street, [p.postalCode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  // ----- Script de contenu -------------------------------------------------
  const pending = new Map();   // tabId -> valeurs proposées
  ctx.page('afSubmitted', (payload, info) => {
    const s = load();
    if (!s.settings.enabled || info.tab.incognito || !payload || typeof payload.values !== 'object') return null;
    const v = clean(payload.values);
    const known = s.profiles.find(p => sameAs(p, v));
    if (known) {
      known.used = (known.used || 0) + 1; known.lastUsed = Date.now();
      upsert(v);              // complète les champs vides seulement
      save();
      return null;
    }
    pending.set(info.tab.id, v);
    setTimeout(() => {
      if (pending.get(info.tab.id) !== v) return;
      ctx.sendChrome({ type: 'pwPrompt', tabId: info.tab.id, prompt: { kind: 'address', summary: summary(v), values: v } });
    }, 250);
    return { prompted: 'address' };
  });
  ctx.page('afSuggest', (p) => {
    const s = load();
    if (!s.settings.enabled) return { items: [] };
    const type = ['givenName', 'familyName'].includes(p.type) ? 'name' : String(p.type || '');
    if (!FIELDS.includes(type)) return { items: [] };
    const items = s.profiles
      .filter(x => x[type])
      .sort((a, b) => (b.used || 0) - (a.used || 0))
      .map(x => ({ id: x.id, label: x[type], sub: summary(x) }));
    return { items: items.slice(0, 8) };
  });
  ctx.page('afFill', (p) => {
    const x = load().profiles.find(y => y.id === String(p.id || ''));
    if (!x) return null;
    x.used = (x.used || 0) + 1; x.lastUsed = Date.now();
    ctx.writeJson(file(), store, true);
    const out = {};
    for (const f of FIELDS) out[f] = x[f];
    return out;
  });
  ctx.page('afManage', () => { ctx.openInternal('passwords#addresses'); return true; });

  // ----- Bulle du chrome -----------------------------------------------------
  ctx.action('afSave', (args) => {
    const id = parseInt(args[0], 10);
    const v = pending.get(id);
    if (!v) return;
    pending.delete(id);
    upsert(v); save();
    ctx.toast('Adresse enregistrée.');
  });
  ctx.action('afDismiss', (args) => { pending.delete(parseInt(args[0], 10)); });
  ctx.on('tabClosed', (t) => pending.delete(t.id));

  // ----- Page passwords.html (onglet Adresses) -------------------------------
  const PAGES = { pages: ['passwords.html'] };
  const list = () => ({ profiles: load().profiles.map(p => Object.assign({ summary: summary(p) }, p)), settings: load().settings });
  ctx.rpc('afList', () => list(), PAGES);
  ctx.rpc('afProfileSave', (p) => {
    const v = clean(p.profile || {});
    if (!Object.values(v).some(Boolean)) throw new Error('Adresse vide.');
    if (p.id) {
      const x = load().profiles.find(y => y.id === p.id);
      if (!x) throw new Error('Adresse introuvable.');
      Object.assign(x, v, { updated: Date.now() });
    } else upsert(v);
    save();
    return list();
  }, PAGES);
  ctx.rpc('afProfileDelete', (p) => { const s = load(); s.profiles = s.profiles.filter(x => x.id !== p.id); save(); return list(); }, PAGES);
  ctx.rpc('afSettings', (p) => { if (typeof p.enabled === 'boolean') load().settings.enabled = p.enabled; save(); return list(); }, PAGES);

  return {
    exportAll() { return { profiles: load().profiles.map(p => Object.assign({}, p)) }; },
    importAll(data, opts) {
      opts = Object.assign({ merge: true }, opts || {});
      const s = load();
      if (!opts.merge) s.profiles = [];
      const res = { added: 0, updated: 0, skipped: 0 };
      for (const p of (data && data.profiles) || []) {
        const r = upsert(p);
        res[r.status === 'added' ? 'added' : r.status === 'updated' ? 'updated' : 'skipped']++;
      }
      save();
      return res;
    },
    removeWhere(pred) {
      const s = load();
      const before = s.profiles.length;
      s.profiles = s.profiles.filter(p => { try { return !pred(p); } catch { return true; } });
      if (s.profiles.length !== before) save();
      return before - s.profiles.length;
    },
    list,
    pendingFor: (tabId) => pending.get(tabId) || null,
    FIELDS,
  };
}

module.exports = { init, FIELDS };
