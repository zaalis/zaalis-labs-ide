'use strict';
/* =============================================================================
 *  Traduction de page façon Chrome
 * -----------------------------------------------------------------------------
 *  - Détection maison de la langue (attribut lang + analyse statistique du
 *    texte visible, voir lib/langdetect.js).
 *  - Icône dans l'omnibox + bulle « Traduire cette page ? » (proposée une fois
 *    par site et par session), choix de la langue cible, « Toujours traduire »,
 *    « Ne jamais traduire <langue> / ce site », « Afficher l'original ».
 *  - Moteurs : modèle IA local via zaalis labs ide ; à défaut, l'API Translator
 *    intégrée à Chromium si le moteur l'expose (window.Translator).
 *  Le texte est traduit par lots et réinjecté nœud par nœud ; l'original est
 *  conservé pour être restauré sans recharger la page.
 * =========================================================================== */

const { detect, normalize, langName, NAMES } = require('./lib/langdetect');
const { popupManager, POPUP_VIEW } = require('./lib/popup');

const WORLD = 1015;          // monde isolé des modules de contenu zaalis
const BATCH = 60;
const MAX_SEGMENTS = 2500;
const TARGETS = ['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ko', 'ar', 'tr'];

const ICON = '<svg viewBox="0 0 24 24"><path d="M4 5h9"/><path d="M8.5 3v2"/><path d="M11 5c-.8 3.6-3 6.4-6 8"/><path d="M6.5 8.5c1 1.8 2.6 3.2 4.5 4"/><path d="M12.5 21l4-10 4 10"/><path d="M14 17.5h5"/></svg>';

const SAMPLE_JS = `(() => {
  const attr = (document.documentElement.getAttribute('lang') || document.documentElement.getAttribute('xml:lang') || '').trim();
  let meta = '';
  const m = document.querySelector('meta[http-equiv="content-language" i]');
  if (m) meta = m.getAttribute('content') || '';
  const body = document.body;
  const text = body ? (body.innerText || '').replace(/\\s+/g, ' ').slice(0, 12000) : '';
  return { attr, meta, text };
})()`;

const EXTRACT_JS = `(() => {
  const st = window.__zxTr || (window.__zxTr = { nodes: [], orig: [] });
  if (st.nodes.length) {
    // Déjà extrait : on restaure l'original avant une nouvelle traduction.
    st.nodes.forEach((n, i) => { try { if (n.isConnected) n.nodeValue = st.orig[i]; } catch (e) {} });
  }
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','KBD','SAMP','SVG','MATH']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const v = n.nodeValue;
      if (!v || v.trim().length < 2 || !/[\\p{L}]/u.test(v)) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || skip.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      if (p.closest('[contenteditable=""],[contenteditable="true"],[translate="no"],.notranslate')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = []; let n;
  while ((n = walker.nextNode()) && nodes.length < ${MAX_SEGMENTS}) nodes.push(n);
  st.nodes = nodes; st.orig = nodes.map(x => x.nodeValue);
  st.title = document.title; st.translated = false;
  return nodes.map(x => x.nodeValue.replace(/\\s+/g, ' ').trim().slice(0, 600));
})()`;

function applyJs(map) {
  return `(() => { const st = window.__zxTr; if (!st) return 0; const map = ${JSON.stringify(map)}; let c = 0;
    for (const k of Object.keys(map)) { const n = st.nodes[+k]; if (n && n.isConnected && typeof map[k] === 'string' && map[k]) {
      const o = st.orig[+k]; const lead = (o.match(/^\\s*/) || [''])[0], trail = (o.match(/\\s*$/) || [''])[0];
      n.nodeValue = lead + map[k] + trail; c++; } }
    st.translated = true; return c; })()`;
}
const RESTORE_JS = `(() => { const st = window.__zxTr; if (!st) return 0; let c = 0;
  st.nodes.forEach((n, i) => { try { if (n.isConnected) { n.nodeValue = st.orig[i]; c++; } } catch (e) {} });
  st.translated = false; return c; })()`;

function init(ctx) {
  const { fs, path } = ctx;
  const popup = popupManager(ctx);
  const prefsFile = () => path.join(ctx.dataFolder, 'translate.json');
  let prefs = { target: 'fr', always: [], never: [], neverSites: [], offer: true };
  const offeredHosts = new Set();       // bulle proposée une fois par site et par session
  const info = new WeakMap();           // tab -> { source, attr, confidence, translated, busy, progress, error, engine }

  function savePrefs() { ctx.writeJson(prefsFile(), prefs); }
  function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
  function isWeb(u) { return /^https?:/i.test(String(u || '')); }

  function tabInfo(tab) {
    if (!tab) return null;
    let i = info.get(tab);
    if (!i) { i = { source: '', confidence: 0, translated: '', busy: false, progress: 0, error: '' }; info.set(tab, i); }
    return i;
  }
  const isForeign = (i) => !!(i && i.source && i.source !== prefs.target);

  async function analyse(tab) {
    const wc = tab.view.webContents;
    const u = wc.getURL();
    const i = tabInfo(tab);
    Object.assign(i, { source: '', confidence: 0, translated: '', busy: false, progress: 0, error: '' });
    if (!isWeb(u)) { ctx.pushState(); return; }
    let s;
    try { s = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SAMPLE_JS }], true); } catch { return; }
    if (!s || wc.isDestroyed() || wc.getURL() !== u) return;
    const d = detect(s.text);
    const declared = normalize(s.attr || s.meta);
    // Le texte prime sur un attribut lang souvent laissé à « en » par les gabarits.
    let source = d.lang && d.confidence >= 0.25 ? d.lang : (declared || d.lang);
    if (declared && d.lang === declared) source = declared;
    i.source = source; i.confidence = d.confidence; i.declared = declared;
    ctx.pushState();
    if (!isForeign(i)) return;
    const host = hostOf(u);
    if (prefs.never.includes(source) || prefs.neverSites.includes(host)) return;
    if (prefs.always.includes(source)) { translate(tab, prefs.target); return; }
    if (prefs.offer && !offeredHosts.has(host) && ctx.activeTab() === tab && !tab.incognito) {
      offeredHosts.add(host);
      openBubble(null, false);
    }
  }

  // ----- Moteurs --------------------------------------------------------------
  // L'API Translator de Chromium peut exister sans moteur derrière (Electron) :
  // ses promesses ne se résolvent alors jamais. Tout appel est donc borné.
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((res, rej) => setTimeout(() => (fallback instanceof Error ? rej(fallback) : res(fallback)), ms))]);
  async function translatorApiAvailable(wc, source, target) {
    try {
      return await withTimeout(wc.executeJavaScript(`(async () => {
        if (typeof Translator === 'undefined' || !Translator.availability) return 'none';
        try { return await Translator.availability({ sourceLanguage: ${JSON.stringify(source)}, targetLanguage: ${JSON.stringify(target)} }); }
        catch (e) { return 'none'; } })()`, true), 4000, 'none');
    } catch { return 'none'; }
  }
  async function viaTranslatorApi(wc, source, target, segs) {
    return withTimeout(wc.executeJavaScript(`(async () => {
      const t = await Translator.create({ sourceLanguage: ${JSON.stringify(source)}, targetLanguage: ${JSON.stringify(target)} });
      const segs = ${JSON.stringify(segs)}; const out = [];
      for (const s of segs) { try { out.push(await t.translate(s)); } catch (e) { out.push(''); } }
      return out; })()`, true), 60000, new Error('le traducteur intégré de Chromium ne répond pas'));
  }
  async function viaIde(segs, offset, target) {
    const payload = segs.map((s, k) => (offset + k) + '\t' + s.replace(/[\t\n]/g, ' ')).join('\n');
    const out = await ctx.ideChat({
      message: 'Traduis en ' + (NAMES[target] || target) + ' chaque segment ci-dessous (format « index<TAB>texte »). ' +
               'Réponds UNIQUEMENT par un objet JSON {"index": "traduction"} sans autre texte. ' +
               'Conserve les nombres, les noms propres, la ponctuation et la casse.\n\n' + payload,
      systemPrompt: 'Tu es un moteur de traduction. Tu renvoies exclusivement du JSON valide.',
      timeoutMs: 120000,
    });
    const m = String(out && out.response || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('réponse du modèle illisible');
    const map = JSON.parse(m[0]);
    const clean = {};
    for (const k of Object.keys(map)) if (typeof map[k] === 'string') clean[String(parseInt(k, 10))] = map[k];
    return clean;
  }

  async function translate(tab, target) {
    if (!tab) return false;
    target = TARGETS.includes(normalize(target)) ? normalize(target) : prefs.target;
    const i = tabInfo(tab);
    if (i.busy) return false;
    const wc = tab.view.webContents;
    const url = wc.getURL();
    Object.assign(i, { busy: true, progress: 0, error: '' });
    update(tab);
    try {
      const segs = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: EXTRACT_JS }], true);
      if (!Array.isArray(segs) || !segs.length) throw new Error('aucun texte à traduire');
      let engine = '';
      if (ctx.ideStatus === 'connected') engine = 'ide';
      else {
        const av = await translatorApiAvailable(wc, i.source || 'en', target);
        if (av && av !== 'none' && av !== 'unavailable') engine = 'chromium';
      }
      if (!engine) throw new Error('La traduction nécessite zaalis labs ide (modèle IA local). Lancez l\'IDE puis réessayez.');
      i.engine = engine;
      for (let off = 0; off < segs.length; off += BATCH) {
        if (wc.isDestroyed() || wc.getURL() !== url) return false;
        const chunk = segs.slice(off, off + BATCH);
        let map = {};
        if (engine === 'ide') map = await viaIde(chunk, off, target);
        else {
          const out = await viaTranslatorApi(wc, i.source || 'en', target, chunk);
          out.forEach((v, k) => { if (v) map[String(off + k)] = v; });
        }
        await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: applyJs(map) }], true);
        i.progress = Math.round(Math.min(segs.length, off + BATCH) * 100 / segs.length);
        update(tab);
      }
      i.translated = target;
      return true;
    } catch (e) {
      const msg = String(e && e.message || e);
      i.error = /no-secret|no-key/.test(msg) ? 'Configurez l\'IA dans zaalis labs ide pour traduire.'
        : /Chromium ne répond pas/.test(msg) ? 'La traduction nécessite zaalis labs ide (modèle IA local) : ' + msg + '.' : msg;
      ctx.toast('Traduction impossible : ' + i.error);
      return false;
    } finally {
      i.busy = false;
      update(tab);
    }
  }

  async function showOriginal(tab) {
    if (!tab) return;
    try { await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: RESTORE_JS }], true); } catch {}
    tabInfo(tab).translated = '';
    update(tab);
  }

  // ----- Bulle ----------------------------------------------------------------
  let lastAnchor = null;
  function bubbleState(tab) {
    const i = tabInfo(tab) || {};
    const host = tab ? hostOf(tab.view.webContents.getURL()) : '';
    return {
      source: i.source || '', sourceName: langName(i.source), target: prefs.target, targetName: langName(prefs.target),
      targets: TARGETS.map(c => ({ code: c, name: NAMES[c] })),
      translated: i.translated || '', busy: !!i.busy, progress: i.progress || 0, error: i.error || '',
      always: prefs.always.includes(i.source), never: prefs.never.includes(i.source), neverSite: prefs.neverSites.includes(host),
      host, ideConnected: ctx.ideStatus === 'connected',
    };
  }
  function update(tab) {
    ctx.pushState();
    if (tab === ctx.activeTab()) popup.send('translate', { type: 'trUpdate', state: bubbleState(tab) });
  }
  function openBubble(anchor, focus) {
    anchor = anchor || lastAnchor || defaultAnchor();
    popup.open('translate', 'translate-bubble.html', anchor, {}, { width: 340, height: 190, focus });
  }
  function defaultAnchor() {
    // Ancre approximative : à droite de la barre d'adresse.
    const w = ctx.mainWin ? ctx.mainWin.getContentSize()[0] : 1200;
    return { x: w - 260, y: 48, w: 28, h: 28 };
  }

  // ----- Points d'accroche ----------------------------------------------------
  prefs = Object.assign(prefs, ctx.readJson(prefsFile(), {}));

  ctx.on('tabCreated', (tab, wc) => {
    wc.on('did-stop-loading', () => { if (!tabInfo(tab).busy) analyse(tab); });
    wc.on('did-navigate', () => {
      const i = tabInfo(tab); i.translated = ''; i.source = '';
      if (tab === ctx.activeTab() && popup.current() === 'translate') popup.close('translate');
    });
  });

  ctx.omniAction('translate', (tab) => {
    const i = tab && info.get(tab);
    if (!i || !isForeign(i) && !i.translated) return null;
    return { title: i.translated ? 'Page traduite — options de traduction' : 'Traduire cette page', svg: ICON, active: !!i.translated || !!i.busy };
  }, (anchor) => { lastAnchor = anchor; openBubble(anchor, true); });

  const opts = { views: [POPUP_VIEW], pages: ['languages.html'] };
  ctx.rpc('trState', () => bubbleState(ctx.activeTab()), opts);
  ctx.rpc('trDo', (p) => { const t = ctx.activeTab(); if (p.target) { prefs.target = normalize(p.target) || prefs.target; savePrefs(); } translate(t, prefs.target); return bubbleState(t); }, opts);
  ctx.rpc('trOriginal', async () => { const t = ctx.activeTab(); await showOriginal(t); return bubbleState(t); }, opts);
  ctx.rpc('trPref', (p) => {
    const t = ctx.activeTab(); const i = tabInfo(t) || {};
    const toggle = (list, v, on) => { const s = new Set(list); on ? s.add(v) : s.delete(v); return [...s]; };
    if ('target' in p && normalize(p.target)) prefs.target = normalize(p.target);
    if ('always' in p && i.source) { prefs.always = toggle(prefs.always, i.source, !!p.always); if (p.always) prefs.never = toggle(prefs.never, i.source, false); }
    if ('never' in p && i.source) { prefs.never = toggle(prefs.never, i.source, !!p.never); if (p.never) prefs.always = toggle(prefs.always, i.source, false); }
    if ('neverSite' in p && t) prefs.neverSites = toggle(prefs.neverSites, hostOf(t.view.webContents.getURL()), !!p.neverSite);
    savePrefs();
    if ((p.never || p.neverSite) && popup.current() === 'translate') popup.close('translate');
    ctx.pushState();
    return bubbleState(t);
  }, opts);
  // Préférences complètes (page Langues).
  ctx.rpc('trPrefsGet', () => ({ ...prefs, targets: TARGETS.map(c => ({ code: c, name: NAMES[c] })), names: NAMES }), { pages: ['languages.html'] });
  ctx.rpc('trPrefsSet', (p) => {
    if (p.target && normalize(p.target)) prefs.target = normalize(p.target);
    for (const k of ['always', 'never', 'neverSites']) if (Array.isArray(p[k])) prefs[k] = p[k].map(String).slice(0, 200);
    if ('offer' in p) prefs.offer = !!p.offer;
    savePrefs();
    return { ...prefs };
  }, { pages: ['languages.html'] });

  return {
    translateActive: (lang) => translate(ctx.activeTab(), /fran/i.test(String(lang || '')) ? 'fr' : (normalize(lang) || prefs.target)),
    translate, showOriginal, analyse, translatorApiAvailable, detect, tabInfo: (t) => info.get(t) || null, prefs: () => prefs,
  };
}

module.exports = { init, EXTRACT_JS, RESTORE_JS, applyJs, WORLD };
