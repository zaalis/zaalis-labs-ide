'use strict';
/* =============================================================================
 *  Groupes d'onglets (comme Google Chrome)
 * -----------------------------------------------------------------------------
 *  - Un onglet porte `tab.group` (identifiant du groupe) ; les groupes ont un
 *    nom, une des 9 couleurs de Chrome et un état réduit / déplié.
 *  - Les membres d'un groupe restent toujours contigus : après chaque
 *    réordonnancement (glisser-déposer), un onglet lâché au milieu d'un groupe
 *    le rejoint, un onglet sorti du groupe le quitte.
 *  - Un onglet ouvert depuis un onglet groupé rejoint le groupe.
 *  - Un onglet épinglé ne peut pas faire partie d'un groupe.
 *  - Persistance avec la restauration de session (session-tabs.json).
 * =========================================================================== */

const COLORS = {
  grey:   { label: 'Gris',   light: '#5f6368', dark: '#dadce0' },
  blue:   { label: 'Bleu',   light: '#1a73e8', dark: '#8ab4f8' },
  red:    { label: 'Rouge',  light: '#d93025', dark: '#f28b82' },
  yellow: { label: 'Jaune',  light: '#f9ab00', dark: '#fdd663' },
  green:  { label: 'Vert',   light: '#188038', dark: '#81c995' },
  pink:   { label: 'Rose',   light: '#d01884', dark: '#ff8bcb' },
  purple: { label: 'Violet', light: '#a142f4', dark: '#d7aefb' },
  cyan:   { label: 'Cyan',   light: '#007b83', dark: '#78d9ec' },
  orange: { label: 'Orange', light: '#fa903e', dark: '#fcad70' },
};
const COLOR_ORDER = Object.keys(COLORS);

function init(ctx) {
  const { Menu } = ctx.electron;
  const groups = new Map();   // id -> { id, title, color, collapsed }
  let seq = 1;

  const tabsOf = (gid) => ctx.tabs.filter(t => t.group === gid);
  const cleanTitle = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 60);
  const nextColor = () => {
    const used = new Set([...groups.values()].map(g => g.color));
    return COLOR_ORDER.find(c => !used.has(c)) || COLOR_ORDER[groups.size % COLOR_ORDER.length];
  };

  function refresh() {
    ctx.layoutAll();
    ctx.pushState();
    ctx.scheduleSaveOpenTabs();
  }

  // Supprime les groupes vides et rend chaque groupe contigu, à la position de
  // son premier membre. Les onglets épinglés restent en tête, hors groupe.
  function normalize() {
    const list = ctx.tabs.slice();
    for (const t of list) {
      if (t.pinned && t.group) t.group = '';
      if (t.group && !groups.has(t.group)) t.group = '';
    }
    for (const id of [...groups.keys()]) if (!list.some(t => t.group === id)) groups.delete(id);
    const out = [];
    const placed = new Set();
    for (const t of list) {
      if (placed.has(t)) continue;
      if (!t.group) { out.push(t); placed.add(t); continue; }
      for (const m of list) if (m.group === t.group && !placed.has(m)) { out.push(m); placed.add(m); }
    }
    const changed = out.some((t, i) => t !== list[i]);
    if (changed) ctx.setTabOrder(out);
    lastOrder = ctx.tabs.map(t => t.id);
    return changed;
  }

  // Après un glisser-déposer : un onglet non groupé coincé entre deux membres
  // d'un même groupe le rejoint ; un membre isolé de son groupe le quitte.
  // Ordre connu avant le dernier réordonnancement : permet de savoir quel
  // onglet a réellement été déplacé par l'utilisateur.
  let lastOrder = [];
  const remember = () => { lastOrder = ctx.tabs.map(t => t.id); };

  function movedTab(before, after) {
    if (before.length !== after.length) return null;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === before[i]) continue;
      // Candidats : l'onglet arrivé à cette place, ou celui qui l'a quittée.
      for (const id of [after[i], before[i]]) {
        const a = after.filter(x => x !== id), b = before.filter(x => x !== id);
        if (a.length === b.length && a.every((x, k) => x === b[k])) return id;
      }
      return null;
    }
    return null;
  }

  function afterReorder() {
    const list = ctx.tabs;
    const movedId = movedTab(lastOrder, list.map(t => t.id));
    if (movedId) {
      const i = list.findIndex(t => t.id === movedId);
      const t = list[i];
      const prev = list[i - 1], next = list[i + 1];
      const pg = prev && prev.group, ng = next && next.group;
      if (!t.pinned) {
        if (pg && pg === ng) t.group = pg;                               // lâché au milieu d'un groupe
        else if (t.group && pg !== t.group && ng !== t.group) t.group = '';  // sorti de son groupe
      }
    } else {
      // Plusieurs déplacements : décision sur l'état avant modification.
      const g0 = list.map(t => t.group || '');
      list.forEach((t, i) => { if (!g0[i] && !t.pinned && g0[i - 1] && g0[i - 1] === g0[i + 1]) t.group = g0[i - 1]; });
      const g1 = list.map(t => t.group || '');
      list.forEach((t, i) => {
        if (!g1[i]) return;
        const count = g1.filter(x => x === g1[i]).length;
        if (count > 1 && g1[i - 1] !== g1[i] && g1[i + 1] !== g1[i]) t.group = '';
      });
    }
    normalize();
    remember();
  }

  function create(tabIds, opts) {
    opts = opts || {};
    const id = 'g' + Date.now().toString(36) + (seq++);
    const color = COLORS[opts.color] ? opts.color : nextColor();
    groups.set(id, { id, title: cleanTitle(opts.title), color, collapsed: false });
    // Les membres sont regroupés à la position du premier onglet visé.
    const members = tabIds.map(x => ctx.tabById(x)).filter(t => t && !t.pinned);
    if (!members.length) { groups.delete(id); return null; }
    const first = Math.min(...members.map(t => ctx.tabs.indexOf(t)));
    for (const t of members) t.group = id;
    const list = ctx.tabs.filter(t => !members.includes(t));
    const anchor = ctx.tabs.slice(0, first).filter(t => !members.includes(t)).length;
    list.splice(anchor, 0, ...members);
    ctx.setTabOrder(list);
    normalize();
    refresh();
    if (opts.edit !== false) ctx.sendChrome({ type: 'tabGroupEdit', id });
    return id;
  }

  function addTo(tabId, gid) {
    const t = ctx.tabById(tabId);
    const g = groups.get(gid);
    if (!t || !g || t.pinned) return false;
    t.group = gid;
    // Place l'onglet à la fin du groupe.
    const list = ctx.tabs.filter(x => x !== t);
    let last = -1;
    list.forEach((x, i) => { if (x.group === gid) last = i; });
    list.splice(last + 1, 0, t);
    ctx.setTabOrder(list);
    normalize();
    refresh();
    return true;
  }

  function removeFrom(tabId) {
    const t = ctx.tabById(tabId);
    if (!t || !t.group) return false;
    const gid = t.group;
    t.group = '';
    // Le sortant se place juste après le groupe (comme Chrome).
    const list = ctx.tabs.filter(x => x !== t);
    let last = -1;
    list.forEach((x, i) => { if (x.group === gid) last = i; });
    if (last >= 0) list.splice(last + 1, 0, t); else list.splice(ctx.tabs.indexOf(t), 0, t);
    ctx.setTabOrder(list);
    normalize();
    refresh();
    return true;
  }

  function update(gid, patch) {
    const g = groups.get(gid);
    if (!g) return null;
    if (patch.title !== undefined) g.title = cleanTitle(patch.title);
    if (patch.color !== undefined && COLORS[patch.color]) g.color = patch.color;
    if (patch.collapsed !== undefined) setCollapsed(gid, !!patch.collapsed, true);
    refresh();
    return g;
  }

  function setCollapsed(gid, collapsed, silent) {
    const g = groups.get(gid);
    if (!g) return;
    g.collapsed = collapsed;
    // L'onglet actif ne peut pas rester caché : on active l'onglet visible le
    // plus proche (ou un nouvel onglet s'il n'y en a pas), comme Chrome.
    const act = ctx.activeTab();
    if (collapsed && act && act.group === gid) {
      const list = ctx.tabs;
      const idx = list.indexOf(act);
      const visible = (t) => !(t.group && groups.get(t.group) && groups.get(t.group).collapsed);
      let pick = null;
      for (let d = 1; d < list.length && !pick; d++) {
        if (list[idx + d] && visible(list[idx + d])) pick = list[idx + d];
        else if (list[idx - d] && visible(list[idx - d])) pick = list[idx - d];
      }
      if (pick) ctx.selectTab(pick.id);
      else ctx.createTab('', true);
    }
    if (!silent) refresh();
  }

  function ungroup(gid) {
    for (const t of tabsOf(gid)) t.group = '';
    groups.delete(gid);
    refresh();
  }

  function closeGroup(gid) {
    const ids = tabsOf(gid).map(t => t.id);
    groups.delete(gid);
    for (const id of ids) ctx.closeTab(id);
    refresh();
  }

  function newTabInGroup(gid) {
    if (!groups.has(gid)) return null;
    const g = groups.get(gid);
    if (g.collapsed) g.collapsed = false;
    const t = ctx.createTab('', true, { focusOmnibox: true });
    addTo(t.id, gid);
    return t;
  }

  // ----- Menus natifs ------------------------------------------------------
  function groupLabel(g) {
    const n = tabsOf(g.id).length;
    return (g.title || 'Groupe sans nom') + ' — ' + COLORS[g.color].label + ' (' + n + ' onglet' + (n > 1 ? 's' : '') + ')';
  }

  // Entrées ajoutées au menu contextuel d'un onglet (showTabMenu de main.js).
  function tabMenuItems(tab) {
    if (!tab || tab.pinned) return [];
    const items = [{ label: 'Ajouter l\'onglet à un nouveau groupe', click: () => create([tab.id]) }];
    const others = [...groups.values()].filter(g => g.id !== tab.group);
    if (others.length) {
      items.push({
        label: 'Ajouter l\'onglet à un groupe existant',
        submenu: others.map(g => ({ label: groupLabel(g), click: () => addTo(tab.id, g.id) })),
      });
    }
    if (tab.group) items.push({ label: 'Retirer du groupe', click: () => removeFrom(tab.id) });
    return items;
  }

  function showGroupMenu(gid) {
    const g = groups.get(gid);
    if (!g) return;
    const items = [
      { label: 'Renommer le groupe…', click: () => ctx.sendChrome({ type: 'tabGroupEdit', id: gid }) },
      { label: 'Couleur', submenu: COLOR_ORDER.map(c => ({
          label: COLORS[c].label, type: 'radio', checked: g.color === c, click: () => update(gid, { color: c }),
        })) },
      { label: g.collapsed ? 'Développer le groupe' : 'Réduire le groupe', click: () => setCollapsed(gid, !g.collapsed) },
      { type: 'separator' },
      { label: 'Nouvel onglet dans le groupe', click: () => newTabInGroup(gid) },
      { label: 'Dissocier', click: () => ungroup(gid) },
      { label: 'Fermer le groupe', click: () => closeGroup(gid) },
    ];
    Menu.buildFromTemplate(items).popup();
  }

  // ----- Points d'accroche ------------------------------------------------
  ctx.tabState((t) => (t.group && groups.has(t.group) ? { group: t.group } : { group: '' }));
  ctx.state('chrome', () => ({
    tabGroups: [...groups.values()].map(g => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed,
      light: COLORS[g.color].light, dark: COLORS[g.color].dark, count: tabsOf(g.id).length })),
  }));
  // Persistance : groupes + appartenance de chaque onglet (même index que urls).
  ctx.state('session', () => ({
    tabGroups: ctx.tabs.map(t => t.group || ''),
    groups: [...groups.values()].map(g => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed })),
  }));

  ctx.on('tabCreated', (tab, _wc, _partition, opts) => {
    opts = opts || {};
    if (opts.restoreOf) { remember(); return; }   // réveil d'un onglet en veille : géré par memorysaver
    if (opts.group && groups.has(opts.group)) { tab.group = opts.group; normalize(); return; }
    const opener = opts.openerId ? ctx.tabById(opts.openerId) : null;
    if (opener && opener.group && groups.has(opener.group) && !tab.incognito === !opener.incognito) {
      tab.group = opener.group;
      normalize();
      return;
    }
    remember();
  });
  ctx.on('tabClosed', () => {
    // Le groupe vide disparaît (après retrait effectif de l'onglet).
    setImmediate(() => { normalize(); ctx.pushState(); });
  });
  ctx.on('tabsReordered', () => afterReorder());
  ctx.on('tabActivated', (tab) => {
    // Activer un onglet d'un groupe réduit (Ctrl+Tab, recherche) le déplie.
    if (tab && tab.group && groups.has(tab.group) && groups.get(tab.group).collapsed) {
      groups.get(tab.group).collapsed = false;
    }
  });
  ctx.on('sessionRestored', (saved) => restoreSession(saved));
  function restoreSession(saved) {
    groups.clear();
    const data = (saved && saved.data) || {};
    const list = Array.isArray(data.groups) ? data.groups : [];
    for (const g of list.slice(0, 100)) {
      if (!g || typeof g.id !== 'string') continue;
      groups.set(g.id, { id: g.id.slice(0, 40), title: cleanTitle(g.title), color: COLORS[g.color] ? g.color : 'grey', collapsed: !!g.collapsed });
    }
    const membership = Array.isArray(data.tabGroups) ? data.tabGroups : [];
    ctx.tabs.forEach((t, i) => { const gid = membership[i]; t.group = typeof gid === 'string' && groups.has(gid) ? gid : ''; });
    const act = ctx.activeTab();
    if (act && act.group && groups.get(act.group)) groups.get(act.group).collapsed = false;
    normalize();
    ctx.pushState();
  }

  ctx.action('tabGroupMenu', (args) => showGroupMenu(args[0]));
  ctx.action('tabGroupToggle', (args) => { const g = groups.get(args[0]); if (g) setCollapsed(g.id, !g.collapsed); });
  ctx.action('tabGroupSet', (args) => {
    let patch = {};
    try { patch = JSON.parse(args.slice(1).join(ctx.SEP)) || {}; } catch {}
    update(args[0], patch);
  });
  ctx.action('tabGroupNew', (args) => create(String(args[0] || '').split(',').map(x => parseInt(x, 10)).filter(Number.isFinite)));

  return {
    COLORS, groups, create, addTo, removeFrom, update, setCollapsed, ungroup, closeGroup, newTabInGroup,
    normalize, afterReorder, tabMenuItems, showGroupMenu, restoreSession,
  };
}

module.exports = { init, COLORS };
