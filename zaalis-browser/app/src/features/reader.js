'use strict';
/* =============================================================================
 *  Mode Lecture (façon Chrome / Firefox), 100 % maison
 * -----------------------------------------------------------------------------
 *  Extraction de l'article dans un monde isolé de la page (algorithme inspiré
 *  de Readability : score des blocs par densité de texte, de virgules et de
 *  liens, bonus/malus selon classes et identifiants, regroupement des blocs
 *  frères), puis affichage dans zaalis://home/reader.html. Le HTML extrait est
 *  ré-assaini dans la page de lecture (liste blanche + CSP sans script).
 * =========================================================================== */

const WORLD = 1015;
const ICON = '<svg viewBox="0 0 24 24"><path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z"/><path d="M12 6v13.5"/></svg>';

const READERABLE_JS = `(() => {
  if (!document.body) return false;
  if (document.querySelector('article p, [itemprop="articleBody"] p')) {
    const t = [...document.querySelectorAll('article p, [itemprop="articleBody"] p')].reduce((n, p) => n + (p.textContent || '').trim().length, 0);
    if (t > 600) return true;
  }
  let score = 0;
  for (const p of document.querySelectorAll('p, pre')) {
    const len = (p.textContent || '').trim().length;
    if (len < 140) continue;
    if (p.closest('nav, footer, aside, [role="navigation"]')) continue;
    score += Math.sqrt(len - 140);
    if (score > 20) return true;
  }
  return false;
})()`;

const EXTRACT_JS = `(() => {
  const UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|cookie|newsletter|subscribe|share|promo|modal/i;
  const MAYBE = /and|article|body|column|content|main|shadow/i;
  const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i;
  const NEGATIVE = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i;
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (e) { return ''; } };
  const meta = (sel) => { const m = document.querySelector(sel); return m ? (m.getAttribute('content') || '').trim() : ''; };
  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();

  // ----- Métadonnées
  let title = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]');
  const h1 = document.querySelector('article h1, main h1, h1');
  if (!title && h1) title = textOf(h1);
  if (!title) title = document.title || '';
  const byline = meta('meta[name="author"]') || meta('meta[property="article:author"]') ||
    (() => { const b = document.querySelector('[rel="author"], [itemprop="author"], .byline, .author'); return b ? textOf(b).slice(0, 120) : ''; })();
  const dateRaw = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') ||
    (() => { const t = document.querySelector('time[datetime]'); return t ? t.getAttribute('datetime') : ''; })();
  const siteName = meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\\./, '');
  const leadImage = abs(meta('meta[property="og:image"]'));
  const lang = (document.documentElement.getAttribute('lang') || '').trim();

  // ----- Copie nettoyée du document
  const root = document.body.cloneNode(true);
  // Images paresseuses : on rapatrie la vraie source avant de cloner le contenu.
  const realImgs = document.body.querySelectorAll('img');
  root.querySelectorAll('img').forEach((img, i) => {
    const r = realImgs[i];
    const src = (r && (r.currentSrc || r.src)) || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
    img.setAttribute('src', abs(src));
    img.removeAttribute('srcset');
  });
  root.querySelectorAll('script,style,noscript,iframe,form,button,input,select,textarea,svg,canvas,nav,footer,aside,object,embed,dialog,[hidden],[aria-hidden="true"],[role="navigation"],[role="banner"],[role="complementary"]').forEach(e => e.remove());
  root.querySelectorAll('*').forEach(e => {
    const sig = (e.className && typeof e.className === 'string' ? e.className : '') + ' ' + (e.id || '');
    if (sig.trim() && UNLIKELY.test(sig) && !MAYBE.test(sig) && e.tagName !== 'BODY' && e.tagName !== 'ARTICLE' && e.tagName !== 'MAIN') e.remove();
  });

  const linkDensity = (el) => {
    const len = textOf(el).length || 1;
    let l = 0; el.querySelectorAll('a').forEach(a => { l += textOf(a).length; });
    return l / len;
  };
  const classWeight = (el) => {
    let w = 0;
    for (const s of [typeof el.className === 'string' ? el.className : '', el.id || '']) {
      if (!s) continue;
      if (NEGATIVE.test(s)) w -= 25;
      if (POSITIVE.test(s)) w += 25;
    }
    return w;
  };
  const scores = new Map();
  const init = (el) => {
    if (scores.has(el)) return;
    let s = 0;
    switch (el.tagName) {
      case 'ARTICLE': case 'MAIN': s += 10; break;
      case 'DIV': s += 5; break;
      case 'PRE': case 'TD': case 'BLOCKQUOTE': case 'SECTION': s += 3; break;
      case 'ADDRESS': case 'OL': case 'UL': case 'DL': case 'DD': case 'DT': case 'LI': case 'FORM': s -= 3; break;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': case 'TH': s -= 5; break;
    }
    scores.set(el, s + classWeight(el));
  };
  root.querySelectorAll('p, pre, td, blockquote, li').forEach(p => {
    const text = textOf(p);
    if (text.length < 25) return;
    const parent = p.parentElement; if (!parent) return;
    const grand = parent.parentElement;
    let s = 1 + text.split(/[,،、，]/).length + Math.min(Math.floor(text.length / 100), 3);
    init(parent); scores.set(parent, scores.get(parent) + s);
    if (grand) { init(grand); scores.set(grand, scores.get(grand) + s / 2); }
  });
  let top = null, topScore = 0;
  for (const [el, s] of scores) {
    const f = s * (1 - linkDensity(el));
    if (f > topScore) { topScore = f; top = el; }
  }
  if (!top) top = root.querySelector('article, main, [role="main"]') || root;
  // Remonte quand le parent contient l'essentiel du texte (articles découpés en sections).
  while (top.parentElement && top.parentElement !== root.parentElement && textOf(top).length < textOf(top.parentElement).length * 0.6 && (scores.get(top.parentElement) || 0) > topScore * 0.5) top = top.parentElement;

  // Blocs frères utiles.
  const out = document.createElement('div');
  const threshold = Math.max(10, topScore * 0.2);
  const parent = top.parentElement;
  const siblings = parent ? [...parent.children] : [top];
  for (const sib of siblings) {
    let keep = sib === top;
    if (!keep) {
      const s = (scores.get(sib) || 0) * (1 - linkDensity(sib));
      if (s >= threshold) keep = true;
      else if (sib.tagName === 'P') {
        const t = textOf(sib), ld = linkDensity(sib);
        if ((t.length > 80 && ld < 0.25) || (t.length > 0 && ld === 0 && /\\.( |$)/.test(t))) keep = true;
      }
    }
    if (keep) out.appendChild(sib.cloneNode(true));
  }
  // Nettoyage final : blocs pauvres en texte ou saturés de liens.
  out.querySelectorAll('div, section, ul, ol, table').forEach(el => {
    const t = textOf(el), ld = linkDensity(el), imgs = el.querySelectorAll('img').length, ps = el.querySelectorAll('p').length;
    if ((ld > 0.5 && t.length < 600) || (t.length < 40 && imgs === 0 && !el.querySelector('pre, code')) || (imgs > ps + 2 && t.length < 200 && ps === 0)) el.remove();
  });
  // Titre en double.
  const firstH = out.querySelector('h1, h2');
  if (firstH && textOf(firstH).toLowerCase() === title.toLowerCase()) firstH.remove();
  out.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href'); if (h) a.setAttribute('href', abs(h)); });

  const text = textOf(out);
  return {
    title: title.slice(0, 300), byline: byline.slice(0, 200), date: dateRaw, siteName, leadImage, lang,
    url: location.href, html: out.innerHTML.slice(0, 1500000), length: text.length,
    minutes: Math.max(1, Math.round(text.split(/\\s+/).length / 230)),
  };
})()`;

function init(ctx) {
  const { path } = ctx;
  const readerable = new WeakMap();
  const articles = new Map();   // id -> article (onglets de lecture ouverts)
  let seq = 0;
  const prefsFile = () => path.join(ctx.dataFolder, 'reader.json');
  let prefs = { theme: 'light', font: 'sans', size: 19, width: 680, line: 1.6 };

  async function checkReaderable(tab) {
    const wc = tab.view.webContents;
    if (!/^https?:/i.test(wc.getURL())) { readerable.delete(tab); return; }
    try {
      const v = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: READERABLE_JS }], true);
      readerable.set(tab, !!v);
    } catch { readerable.delete(tab); }
    if (tab === ctx.activeTab()) ctx.pushState();
  }

  async function extract(tab) {
    return tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: EXTRACT_JS }], true);
  }

  async function open(tab) {
    if (!tab) return null;
    let a;
    try { a = await extract(tab); } catch (e) { ctx.toast('Mode Lecture indisponible sur cette page.'); return null; }
    if (!a || a.length < 200) { ctx.toast('Aucun article lisible n\'a été trouvé sur cette page.'); return null; }
    const id = 'a' + (++seq) + Date.now().toString(36);
    articles.set(id, a);
    if (articles.size > 30) articles.delete(articles.keys().next().value);
    return ctx.createTab('zaalis://home/reader.html#' + id, true, { openerId: tab.id });
  }

  prefs = Object.assign(prefs, ctx.readJson(prefsFile(), {}));
  ctx.alias('reader', 'reader.html');

  ctx.on('tabCreated', (tab, wc) => {
    wc.on('did-stop-loading', () => checkReaderable(tab));
    wc.on('did-navigate', () => readerable.delete(tab));
  });
  ctx.omniAction('reader', (tab) => (tab && readerable.get(tab)) ? { title: 'Ouvrir en mode Lecture', svg: ICON } : null,
    (_anchor, tab) => open(tab));
  ctx.on('contextMenu', (items, c) => {
    if (!c.internal && c.onPageArea && readerable.get(c.tab)) items.push({ label: 'Ouvrir en mode Lecture', click: () => open(c.tab) });
  });

  const opts = { pages: ['reader.html'] };
  ctx.rpc('readerGet', (p) => {
    const a = articles.get(String(p.id || ''));
    return { article: a || null, prefs };
  }, opts);
  ctx.rpc('readerPrefs', (p) => {
    if (['light', 'sepia', 'dark'].includes(p.theme)) prefs.theme = p.theme;
    if (['sans', 'serif', 'mono'].includes(p.font)) prefs.font = p.font;
    if (p.size >= 12 && p.size <= 36) prefs.size = Math.round(p.size);
    if (p.width >= 480 && p.width <= 1100) prefs.width = Math.round(p.width);
    if (p.line >= 1.2 && p.line <= 2.2) prefs.line = Math.round(p.line * 10) / 10;
    ctx.writeJson(prefsFile(), prefs);
    return prefs;
  }, opts);

  return { open, extract, checkReaderable, isReaderable: (t) => !!readerable.get(t), articles };
}

module.exports = { init, EXTRACT_JS, READERABLE_JS };
