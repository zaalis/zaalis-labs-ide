'use strict';
/* =============================================================================
 *  Navigation sécurisée (Safe Browsing) — 100 % local, sans clé d'API
 * -----------------------------------------------------------------------------
 *  Listes publiques gratuites de sites malveillants / d'hameçonnage,
 *  téléchargées et rafraîchies en arrière-plan (requêtes conditionnelles
 *  ETag / If-Modified-Since), conservées dans « userData/Safe Browsing » et
 *  chargées en mémoire :
 *   - hôtes bloqués entiers (Map hôte -> menace) ;
 *   - URL précises (Map hôte -> préfixes de chemin), comme les expressions
 *     « hôte/chemin » de Google Safe Browsing.
 *  La vérification d'une URL essaie les suffixes d'hôte (a.b.c.d.com, c.d.com,
 *  d.com…) et les préfixes de chemin, sans aucune requête réseau : rien de ce
 *  qui est visité ne quitte la machine.
 *
 *  Branchements : navigation principale (safeBrowsingVerdict de main.js),
 *  sous-cadres (will-frame-navigate), téléchargements (avertissement avant
 *  l'enregistrement et avant l'ouverture). Interstitiel rouge façon Chrome :
 *  interface/interstitial.html (partagé avec les erreurs de certificat).
 * =========================================================================== */

const DEFAULT_SOURCES = [
  {
    id: 'urlhaus', threat: 'malware',
    label: 'URLhaus (abuse.ch) — logiciels malveillants',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    mirror: 'https://malware-filter.pages.dev/urlhaus-filter-online.txt',
    format: 'abp',
  },
  {
    id: 'phishing', threat: 'phishing',
    label: 'Phishing Filter (OpenPhish, PhishTank, IPThreat)',
    url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt',
    mirror: 'https://malware-filter.pages.dev/phishing-filter.txt',
    format: 'abp',
  },
  {
    id: 'openphish', threat: 'phishing',
    label: 'OpenPhish — flux communautaire',
    url: 'https://openphish.com/feed.txt',
    format: 'urls',
  },
];

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_UPDATE_DELAY_MS = 15 * 1000;
const MAX_LIST_BYTES = 64 * 1024 * 1024;

// Pages de test publiques (équivalent de testsafebrowsing.appspot.com).
const BUILTIN = new Map([
  ['testsafebrowsing.appspot.com', 'malware'],
  ['malware.testing.google.test', 'malware'],
  ['phishing.testing.zaalis.test', 'phishing'],
  ['malware.testing.zaalis.test', 'malware'],
]);

// Domaines d'hébergement / grandes plateformes : une entrée « hôte entier »
// égale à l'un d'eux est ignorée (seules leurs sous-parties listées comptent).
const NEVER_BLOCK_WHOLE_HOST = new Set([
  'google.com', 'youtube.com', 'gmail.com', 'googleusercontent.com', 'googleapis.com', 'gstatic.com',
  'microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'sharepoint.com', 'onedrive.live.com',
  'apple.com', 'icloud.com', 'amazon.com', 'amazonaws.com', 'cloudfront.net', 'facebook.com', 'instagram.com',
  'whatsapp.com', 'wikipedia.org', 'github.com', 'github.io', 'githubusercontent.com', 'gitlab.com', 'gitlab.io',
  'blogspot.com', 'weebly.com', 'wixsite.com', 'wix.com', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'firebaseapp.com', 'web.app', 'appspot.com', 'azurewebsites.net', 'windows.net', 'dropbox.com', 'gravatar.com',
  'cloudflare.com', 'linkedin.com', 'x.com', 'twitter.com', 'discord.com', 'discord.gg', 'telegram.org', 't.me',
  'zaalis.com', 'localhost',
]);

const THREAT_TEXT = {
  malware: {
    title: 'Le site que vous allez ouvrir contient des logiciels malveillants',
    reason: (h) => `Des pirates informatiques présents sur ${h} pourraient tenter d'installer des programmes dangereux sur votre ordinateur afin de voler ou de supprimer vos informations (photos, mots de passe, messages et numéros de carte bancaire, par exemple).`,
  },
  phishing: {
    title: 'Site trompeur',
    reason: (h) => `Des pirates informatiques présents sur ${h} pourraient vous inciter à effectuer une action dangereuse, comme installer un logiciel ou divulguer des informations personnelles (mots de passe, numéros de téléphone ou de carte bancaire, par exemple).`,
  },
  homograph: {
    title: 'Adresse trompeuse',
    reason: (h) => `L'adresse ${h} utilise des caractères qui imitent ceux d'un site connu. Il pourrait s'agir d'une tentative d'hameçonnage.`,
  },
};

// ----- Analyse des listes ----------------------------------------------------
function cleanHost(h) {
  h = String(h || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '');
  if (!h || h.length > 253 || /[\s/]/.test(h)) return '';
  return h;
}
function decodeEntities(s) { return s.replace(/&amp;/g, '&').replace(/&#38;/g, '&'); }

// Renvoie { hosts:[hôte], urls:[[hôte, préfixe]] }.
function parseList(text, format) {
  const hosts = [], urls = [];
  const addUrl = (raw) => {
    let s = decodeEntities(raw.trim());
    if (!s) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try { u = new URL(s); } catch { return; }
    const host = cleanHost(u.hostname);
    if (!host) return;
    const p = (u.pathname || '/') + (u.search || '');
    if (p === '/' || p === '') hosts.push(host);
    else urls.push([host, p]);
  };
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === '!' || line[0] === '#' || line[0] === '[') continue;
    if (format === 'hosts') {
      const parts = line.split(/\s+/);
      const h = cleanHost(parts.length > 1 ? parts[1] : parts[0]);
      if (h && h !== '0.0.0.0' && h !== 'localhost') hosts.push(h);
    } else if (format === 'domains') {
      const h = cleanHost(line);
      if (h) hosts.push(h);
    } else if (format === 'urls') {
      addUrl(line);
    } else {   // 'abp' : « hôte », « ||hôte^ », « ||hôte/chemin^$all »
      if (line.startsWith('@@')) continue;
      let s = line.replace(/\$[^/]*$/, '');
      if (s.startsWith('||')) s = s.slice(2);
      else if (s.startsWith('|')) s = s.slice(1);
      s = s.replace(/\^+$/, '').replace(/\^\|?$/, '');
      if (!s || s.includes('*')) continue;
      if (s.includes('/')) addUrl(s);
      else { const h = cleanHost(s); if (h) hosts.push(h); }
    }
  }
  return { hosts, urls };
}

// Même analyse, par tranches de lignes, en rendant la main à la boucle
// d'événements entre deux tranches : jamais d'interface figée au démarrage.
async function parseListChunked(text, format) {
  const lines = String(text).split(/\r?\n/);
  const out = { hosts: [], urls: [] };
  for (let i = 0; i < lines.length; i += 8000) {
    const part = parseList(lines.slice(i, i + 8000).join('\n'), format);
    for (const h of part.hosts) out.hosts.push(h);
    for (const u of part.urls) out.urls.push(u);
    await new Promise(r => setImmediate(r));
  }
  return out;
}

// ----- Canonicalisation & suffixes (façon Google Safe Browsing) -------------
function isIp(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':'); }
function hostSuffixes(host) {
  if (isIp(host)) return [host];
  const labels = host.split('.');
  const out = [host];
  // Au plus 4 suffixes supplémentaires, en partant des 5 derniers composants.
  const start = Math.max(1, labels.length - 5);
  for (let i = start; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return [...new Set(out)];
}
function isPrivateHost(h) {
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '[::1]' || h === '::1';
}
function pathMatches(pathAndQuery, prefix) {
  if (!pathAndQuery.startsWith(prefix)) return false;
  if (pathAndQuery.length === prefix.length) return true;
  const last = prefix[prefix.length - 1];
  if (last === '/' || last === '?' || last === '&' || last === '=') return true;
  const next = pathAndQuery[prefix.length];
  return next === '/' || next === '?' || next === '#' || next === '&';
}

function init(ctx) {
  const { app, fs, path, crypto, electron } = ctx;
  const { net, dialog } = electron;

  let sources = DEFAULT_SOURCES;
  if (process.env.ZAALIS_SB_SOURCES) {
    try { sources = JSON.parse(process.env.ZAALIS_SB_SOURCES); } catch (e) { console.error('[safebrowsing] ZAALIS_SB_SOURCES invalide', e); }
  }
  const dir = () => path.join(app.getPath('userData'), 'Safe Browsing');
  const metaFile = () => path.join(dir(), 'lists.json');

  let hostDb = new Map();     // hôte -> menace
  let urlDb = new Map();      // hôte -> [[préfixe, menace]]
  let meta = {};              // id -> { etag, lastModified, fetchedAt, checkedAt, count, error, bytes }
  let loaded = false;
  let updating = null;
  let timer = null;
  const bypassHosts = new Set();   // « Accéder à ce site dangereux » (session)

  // ----- Base en mémoire ---------------------------------------------------
  function rebuild(parsedById) {
    const hosts = new Map(), urls = new Map();
    const order = { malware: 3, phishing: 2, unwanted: 1 };
    const put = (map, k, v) => { const cur = map.get(k); if (!cur || (order[v] || 0) > (order[cur] || 0)) map.set(k, v); };
    for (const src of sources) {
      const parsed = parsedById[src.id];
      if (!parsed) continue;
      for (const h of parsed.hosts) { if (!NEVER_BLOCK_WHOLE_HOST.has(h)) put(hosts, h, src.threat); }
      for (const [h, p] of parsed.urls) {
        let arr = urls.get(h);
        if (!arr) { arr = []; urls.set(h, arr); }
        if (arr.length < 2000) arr.push([p, src.threat]);
      }
    }
    hostDb = hosts; urlDb = urls; loaded = true;
  }
  const parsedCache = {};
  async function loadFromDisk() {
    meta = ctx.readJson(metaFile(), {}) || {};
    for (const src of sources) {
      const file = path.join(dir(), src.id + '.txt');
      try {
        const text = await fs.promises.readFile(file, 'utf8');
        parsedCache[src.id] = await parseListChunked(text, src.format);
      } catch {}
    }
    rebuild(parsedCache);
  }

  // ----- Mise à jour des listes -------------------------------------------
  async function fetchSource(src, force) {
    const m = meta[src.id] || {};
    const file = path.join(dir(), src.id + '.txt');
    const haveFile = fs.existsSync(file);
    if (!force && haveFile && m.fetchedAt && Date.now() - m.fetchedAt < UPDATE_EVERY_MS - 60000) return false;
    const urls = [src.url, src.mirror].filter(Boolean);
    let lastErr = null;
    for (const u of urls) {
      try {
        const headers = { 'user-agent': ctx.chromeUserAgent() };
        if (haveFile && m.source === u) {
          if (m.etag) headers['if-none-match'] = m.etag;
          if (m.lastModified) headers['if-modified-since'] = m.lastModified;
        }
        const res = await net.fetch(u, { headers, cache: 'no-store', redirect: 'follow' });
        if (res.status === 304) {
          meta[src.id] = { ...m, fetchedAt: Date.now(), checkedAt: Date.now(), error: '' };
          return false;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_LIST_BYTES) throw new Error('liste trop volumineuse');
        const text = buf.toString('utf8');
        const parsed = await parseListChunked(text, src.format);
        const count = parsed.hosts.length + parsed.urls.length;
        if (!count) throw new Error('liste vide ou illisible');
        fs.mkdirSync(dir(), { recursive: true });
        const tmp = file + '.tmp';
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, file);
        parsedCache[src.id] = parsed;
        meta[src.id] = {
          source: u, etag: res.headers.get('etag') || '', lastModified: res.headers.get('last-modified') || '',
          fetchedAt: Date.now(), checkedAt: Date.now(), count, bytes: buf.length, error: '',
        };
        return true;
      } catch (e) { lastErr = e; }
    }
    meta[src.id] = { ...m, checkedAt: Date.now(), error: String(lastErr && lastErr.message || lastErr) };
    return false;
  }
  async function updateAll(force) {
    if (updating) return updating;
    updating = (async () => {
      let changed = false;
      for (const src of sources) { if (await fetchSource(src, force)) changed = true; }
      ctx.writeJson(metaFile(), meta);
      if (changed) rebuild(parsedCache);
      return status();
    })();
    try { return await updating; } finally { updating = null; }
  }

  // ----- Vérification ------------------------------------------------------
  function lookup(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = cleanHost(u.hostname.replace(/^\[|\]$/g, ''));
    if (!host || isPrivateHost(host)) return null;
    const suffixes = hostSuffixes(host);
    for (const h of suffixes) {
      const b = BUILTIN.get(h);
      if (b) return { threat: b, host, match: h, source: 'intégrée' };
    }
    if (!loaded) return null;
    for (const h of suffixes) {
      const t = hostDb.get(h);
      if (t) return { threat: t, host, match: h, source: 'liste' };
    }
    let pq = (u.pathname || '/') + (u.search || '');
    let decoded = pq;
    try { decoded = decodeURIComponent(pq); } catch {}
    for (const h of suffixes) {
      const arr = urlDb.get(h);
      if (!arr) continue;
      for (const [prefix, threat] of arr) {
        if (pathMatches(pq, prefix) || pathMatches(decoded, prefix)) return { threat, host, match: h + prefix, source: 'liste' };
      }
    }
    return null;
  }
  function homograph(rawUrl) {
    let host = '';
    try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return null; }
    if (/(^|\.)xn--/.test(host) && /(paypal|google|apple|microsoft|amazon|bank|coinbase|netflix|facebook|instagram|outlook|office|binance|ledger|metamask)/i.test(rawUrl)) {
      return { threat: 'homograph', host, match: host, source: 'heuristique' };
    }
    return null;
  }
  // Verdict complet : { threat, reason, title, host } ou null.
  function verdict(rawUrl) {
    if (!ctx.settings.safeBrowsing) return null;
    const v = lookup(rawUrl) || homograph(rawUrl);
    if (!v) return null;
    if (bypassHosts.has(v.host)) return null;
    const text = THREAT_TEXT[v.threat] || THREAT_TEXT.malware;
    return { ...v, title: text.title, reason: text.reason(v.host) };
  }

  // ----- Interstitiels (partagés avec les erreurs de certificat) -----------
  const interstitials = new Map();   // jeton -> { kind, url, host, wcId, … }
  const kinds = new Map();           // kind -> { proceed(info, wc) }
  function createInterstitial(wc, info) {
    const token = crypto.randomBytes(16).toString('hex');
    interstitials.set(token, { ...info, wcId: wc.id, createdAt: Date.now() });
    // Les jetons expirent (une page restée ouverte des heures garde le sien).
    if (interstitials.size > 200) interstitials.delete(interstitials.keys().next().value);
    try { wc.loadURL('zaalis://home/interstitial.html#' + token).catch(() => {}); } catch {}
    return token;
  }
  function registerKind(kind, handler) { kinds.set(kind, handler); }
  kinds.set('safebrowsing', {
    proceed(info, wc) {
      bypassHosts.add(info.host);
      wc.loadURL(info.url).catch(() => {});
    },
  });
  // Appelée par main.js (navigation bloquée). true si l'interstitiel est affiché.
  function showInterstitial(wc, rawUrl) {
    const v = verdict(rawUrl);
    if (!v) return false;
    createInterstitial(wc, { kind: 'safebrowsing', url: String(rawUrl), host: v.host, threat: v.threat, title: v.title, reason: v.reason, source: v.source });
    return true;
  }
  function interstitialFor(event, token) {
    const info = interstitials.get(String(token || ''));
    if (!info || !event || !event.sender || event.sender.id !== info.wcId) throw new Error('Avertissement expiré');
    return info;
  }

  ctx.rpc('secInterstitialInfo', (p, event) => {
    const i = interstitialFor(event, p.token);
    return { kind: i.kind, url: i.url, host: i.host, threat: i.threat || '', title: i.title || '', reason: i.reason || '',
      error: i.error || '', errorText: i.errorText || '', cert: i.cert || null, canProceed: i.canProceed !== false };
  }, { pages: ['interstitial.html'] });
  ctx.rpc('secProceed', (p, event) => {
    const i = interstitialFor(event, p.token);
    if (i.canProceed === false) throw new Error('Impossible de continuer vers ce site');
    const handler = kinds.get(i.kind);
    if (!handler) throw new Error('Type d\'avertissement inconnu');
    interstitials.delete(String(p.token));
    handler.proceed(i, event.sender);
    return true;
  }, { pages: ['interstitial.html'] });
  ctx.rpc('secBack', (p, event) => {
    const i = interstitials.get(String(p.token || ''));
    const wc = event.sender;
    const nav = wc.navigationHistory;
    // Retour à la dernière page qui n'est ni l'interstitiel ni l'URL en cause.
    try {
      const entries = nav.getAllEntries();
      for (let k = nav.getActiveIndex() - 1; k >= 0; k--) {
        const u = entries[k] && entries[k].url || '';
        if (u.startsWith('zaalis://home/interstitial.html') || (i && u === i.url) || u.startsWith('data:')) continue;
        nav.goToIndex(k);
        return true;
      }
    } catch {}
    wc.loadURL('zaalis://home/index.html').catch(() => {});
    return true;
  }, { pages: ['interstitial.html'] });

  // ----- Téléchargements ----------------------------------------------------
  const flaggedDownloads = new Map();   // url -> verdict
  function downloadVerdict(item, wc) {
    const chain = [];
    try { chain.push(...item.getURLChain()); } catch {}
    try { chain.push(item.getURL()); } catch {}
    for (const u of chain) { const v = verdict(u); if (v) return v; }
    return null;
  }
  ctx.on('session', (ses) => {
    ses.on('will-download', (_e, item, wc) => {
      const v = downloadVerdict(item, wc);
      if (!v) return;
      flaggedDownloads.set(item.getURL(), v);
      try { item.pause(); } catch {}
      const win = ctx.mainWin;
      dialog.showMessageBox(win || undefined, {
        type: 'warning',
        title: 'Téléchargement dangereux',
        message: `« ${item.getFilename()} » peut être dangereux. zaalis Browser l'a donc bloqué.`,
        detail: `Ce fichier provient de ${v.host}, un site signalé pour ${v.threat === 'phishing' ? 'hameçonnage' : 'logiciels malveillants'}.`,
        buttons: ['Supprimer', 'Conserver quand même'],
        defaultId: 0, cancelId: 0, noLink: true,
      }).then(({ response }) => {
        try { if (response === 1) item.resume(); else item.cancel(); } catch {}
      }).catch(() => { try { item.cancel(); } catch {} });
    });
  });
  // Appelée par main.js avant d'ouvrir un fichier téléchargé.
  function confirmOpenDownload(d) {
    const v = (d && (flaggedDownloads.get(d.url) || verdict(d.url))) || null;
    if (!v) return true;
    const r = dialog.showMessageBoxSync(ctx.mainWin || undefined, {
      type: 'warning', title: 'Fichier dangereux',
      message: `« ${d.name} » provient de ${v.host}, un site signalé comme dangereux.`,
      detail: 'L\'ouvrir pourrait installer des programmes malveillants ou voler vos informations.',
      buttons: ['Ne pas ouvrir', 'Ouvrir quand même'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return r === 1;
  }

  // ----- Sous-cadres (iframes) et redirections serveur ---------------------
  ctx.on('tabCreated', (tab, wc) => {
    wc.on('will-frame-navigate', (e) => {
      try {
        if (e.isMainFrame) return;
        if (verdict(e.url)) e.preventDefault();
      } catch {}
    });
    // Redirection HTTP (30x) vers un site listé : will-navigate ne la voit pas.
    wc.on('will-redirect', (e, legacyUrl, _inPlace, legacyMain) => {
      try {
        const u = e.url || legacyUrl;
        const main = e.isMainFrame !== undefined ? e.isMainFrame : legacyMain;
        if (!verdict(u)) return;
        e.preventDefault();
        if (main) showInterstitial(wc, u);
      } catch {}
    });
  });

  // ----- Statut / page security.html ---------------------------------------
  function status() {
    let urlCount = 0;
    for (const arr of urlDb.values()) urlCount += arr.length;
    return {
      enabled: !!ctx.settings.safeBrowsing,
      loaded,
      updating: !!updating,
      hosts: hostDb.size,
      urls: urlCount,
      bypassed: [...bypassHosts],
      sources: sources.map(s => {
        const m = meta[s.id] || {};
        return { id: s.id, label: s.label || s.id, threat: s.threat, url: m.source || s.url,
          count: m.count || 0, fetchedAt: m.fetchedAt || 0, checkedAt: m.checkedAt || 0, error: m.error || '', bytes: m.bytes || 0 };
      }),
    };
  }
  ctx.alias('security', 'security.html');
  ctx.alias('safe-browsing', 'security.html');
  ctx.rpc('sbStatus', () => status(), { pages: ['security.html'] });
  ctx.rpc('sbUpdateNow', () => updateAll(true), { pages: ['security.html'] });
  ctx.rpc('sbSetEnabled', (p) => {
    ctx.settings.safeBrowsing = !!p.enabled; ctx.saveSettings(); ctx.pushPanelState();
    return status();
  }, { pages: ['security.html'] });
  ctx.rpc('sbCheckUrl', (p) => verdict(String(p.url || '')), { pages: ['security.html'] });
  ctx.rpc('sbClearBypass', () => { bypassHosts.clear(); return status(); }, { pages: ['security.html'] });

  // ----- Cycle de vie --------------------------------------------------------
  ctx.on('ready', () => {
    loadFromDisk().catch(e => console.error('[safebrowsing] chargement', e)).finally(() => {
      if (process.env.ZAALIS_E2E && !process.env.ZAALIS_SB_SOURCES) return;   // pas de réseau pendant les tests
      const t = setTimeout(() => updateAll(false).catch(() => {}), FIRST_UPDATE_DELAY_MS);
      if (t.unref) t.unref();
      timer = setInterval(() => updateAll(false).catch(() => {}), UPDATE_EVERY_MS);
      if (timer.unref) timer.unref();
    });
  });

  return {
    verdict, lookup, showInterstitial, createInterstitial, registerKind, confirmOpenDownload,
    updateAll, status, isBypassed: (h) => bypassHosts.has(h), loadFromDisk,
    _waitLoaded: () => loaded,
    // Tests e2e uniquement : listes servies par un serveur local.
    _setSources: (list) => { if (process.env.ZAALIS_E2E) { sources = list; meta = {}; } },
  };
}

module.exports = { init, parseList, parseListChunked, hostSuffixes, pathMatches };
