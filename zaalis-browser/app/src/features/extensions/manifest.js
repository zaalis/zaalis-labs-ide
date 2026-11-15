'use strict';
// Manifeste d'extension : lecture, localisation (_locales), icônes,
// avertissements d'autorisations (libellés de Chrome) et motifs d'URL.

const fs = require('fs');
const path = require('path');

function stripBom(s) { return String(s).replace(/^﻿/, ''); }
// JSON tolérant aux commentaires (certains manifestes en contiennent).
function parseJsonLoose(text) {
  const s = stripBom(text);
  try { return JSON.parse(s); } catch {}
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], nx = s[i + 1];
    if (inStr) { out += ch; if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && nx === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && nx === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

function readManifestDir(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) throw new Error('manifest.json introuvable dans ce dossier');
  return parseJsonLoose(fs.readFileSync(p, 'utf8'));
}

// Résout __MSG_nom__ avec _locales/<langue>/messages.json (fr, puis défaut).
function localizer(readFile, manifest) {
  const cache = {};
  const load = (loc) => {
    if (loc in cache) return cache[loc];
    let msgs = null;
    try { const t = readFile('_locales/' + loc + '/messages.json'); if (t) msgs = parseJsonLoose(t.toString('utf8')); } catch {}
    const lower = {};
    if (msgs) for (const k of Object.keys(msgs)) lower[k.toLowerCase()] = msgs[k] && msgs[k].message;
    return (cache[loc] = lower);
  };
  const locales = ['fr', 'fr_FR', manifest.default_locale || 'en', 'en', 'en_US'];
  return (value) => String(value == null ? '' : value).replace(/__MSG_([A-Za-z0-9_@]+)__/g, (m, key) => {
    for (const loc of locales) { const v = load(loc)[key.toLowerCase()]; if (v != null) return v; }
    return m;
  });
}
function localizedInfo(manifest, readFile) {
  const L = localizer(readFile, manifest);
  return {
    name: L(manifest.name || manifest.short_name || 'Extension').slice(0, 75),
    description: L(manifest.description || '').slice(0, 300),
  };
}
const dirReader = (dir) => (rel) => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

function actionOf(manifest) {
  return manifest.action || manifest.browser_action || manifest.page_action || null;
}
// Chemin relatif de l'icône la plus adaptée à la taille demandée.
function pickIcon(icons, size) {
  if (!icons) return null;
  if (typeof icons === 'string') return icons;
  const sizes = Object.keys(icons).map(Number).filter(n => n > 0).sort((a, b) => a - b);
  if (!sizes.length) return null;
  const s = sizes.find(n => n >= size) || sizes[sizes.length - 1];
  return icons[String(s)];
}
function toolbarIconPath(manifest) {
  const a = actionOf(manifest);
  return pickIcon(a && a.default_icon, 32) || pickIcon(manifest.icons, 32);
}

function hostPatterns(manifest) {
  const out = new Set();
  const isPattern = (p) => p === '<all_urls>' || /^(\*|https?|wss?|ftp|file|urn):\/\//.test(p);
  for (const p of manifest.host_permissions || []) out.add(p);
  if ((manifest.manifest_version || 2) < 3) for (const p of manifest.permissions || []) if (typeof p === 'string' && isPattern(p)) out.add(p);
  for (const cs of manifest.content_scripts || []) for (const p of cs.matches || []) out.add(p);
  return [...out];
}
function apiPermissions(manifest) {
  return (manifest.permissions || []).filter(p => typeof p === 'string' && !/:\/\//.test(p) && p !== '<all_urls>');
}

const PERMISSION_TEXT = {
  tabs: 'Lire votre historique de navigation',
  history: 'Lire et modifier votre historique de navigation',
  bookmarks: 'Lire et modifier vos favoris',
  downloads: 'Gérer vos téléchargements',
  'downloads.open': 'Ouvrir les fichiers que vous avez téléchargés',
  notifications: 'Afficher des notifications',
  clipboardRead: 'Lire les données que vous copiez et collez',
  clipboardWrite: 'Modifier les données que vous copiez et collez',
  geolocation: 'Détecter votre position géographique',
  nativeMessaging: 'Communiquer avec des applications natives coopérantes',
  management: 'Gérer vos applications, extensions et thèmes',
  privacy: 'Modifier vos paramètres de confidentialité',
  proxy: 'Lire et modifier tous vos paramètres réseau',
  contentSettings: 'Modifier vos paramètres qui contrôlent l\'accès des sites Web aux cookies, à JavaScript, aux plug-ins, etc.',
  debugger: 'Accéder au débogueur de pages',
  desktopCapture: 'Capturer le contenu de votre écran',
  tabCapture: 'Capturer le contenu des onglets',
  topSites: 'Lire la liste de vos sites les plus visités',
  sessions: 'Lire vos onglets récemment fermés',
  webNavigation: 'Lire votre historique de navigation',
  declarativeNetRequestFeedback: 'Lire votre historique de navigation',
  readingList: 'Lire et modifier les entrées de la liste de lecture',
  pageCapture: 'Lire et modifier toutes vos données sur tous les sites',
  tts: 'Lire à voix haute du texte',
  ttsEngine: 'Lire tout le texte prononcé à l\'aide de la synthèse vocale',
  system_display: 'Identifier et éjecter les périphériques de stockage',
  'system.storage': 'Identifier et éjecter les périphériques de stockage',
  'webAuthenticationProxy': 'Lire et modifier les données d\'authentification Web',
  identity: 'Connaître votre adresse e-mail',
  'identity.email': 'Connaître votre adresse e-mail',
  cookies: '',
  storage: '', unlimitedStorage: '', alarms: '', contextMenus: '', activeTab: '', scripting: '',
  declarativeNetRequest: 'Bloquer le contenu de n\'importe quelle page',
  declarativeNetRequestWithHostAccess: 'Bloquer le contenu de n\'importe quelle page',
  webRequest: '', webRequestBlocking: '', offscreen: '', sidePanel: '', i18n: '', idle: '', power: '', favicon: '',
};

// Avertissements affichés avant l'installation (comme le dialogue de Chrome).
function permissionWarnings(manifest) {
  const out = [];
  const hosts = hostPatterns(manifest);
  const all = hosts.some(p => p === '<all_urls>' || /^(\*|https?):\/\/\*\/\*$/.test(p) || /^\*:\/\/\*\//.test(p));
  if (all) out.push('Lire et modifier toutes vos données sur tous les sites');
  else {
    const names = [...new Set(hosts.map(p => { const m = /^[^:]+:\/\/([^/]+)/.exec(p); return m ? m[1].replace(/^\*\./, '') : null; }).filter(Boolean))];
    if (names.length === 1) out.push('Lire et modifier vos données sur ' + names[0]);
    else if (names.length > 1 && names.length <= 4) out.push('Lire et modifier vos données sur ' + names.join(', '));
    else if (names.length > 4) out.push('Lire et modifier vos données sur ' + names.length + ' sites');
  }
  const perms = new Set(apiPermissions(manifest));
  for (const p of perms) {
    const t = PERMISSION_TEXT[p];
    if (t === undefined) continue;
    if (t && !(all && (p === 'tabs' || p === 'webNavigation' || p === 'pageCapture')) && !out.includes(t)) out.push(t);
  }
  return out;
}

// Motifs de correspondance d'URL de Chrome (<all_urls>, *://*.exemple.com/*…).
function matchPattern(pattern, urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file|urn):$/.test(u.protocol);
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!m) return false;
  const [, scheme, host, pth] = m;
  const proto = u.protocol.slice(0, -1);
  if (scheme === '*') { if (proto !== 'http' && proto !== 'https') return false; }
  else if (scheme !== proto) return false;
  if (host && host !== '*') {
    const h = host.replace(/:\d+$|:\*$/, '').toLowerCase();
    const uh = u.hostname.toLowerCase();
    if (h.startsWith('*.')) { const base = h.slice(2); if (uh !== base && !uh.endsWith('.' + base)) return false; }
    else if (uh !== h) return false;
  }
  const re = new RegExp('^' + String(pth || '/*').split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(u.pathname + u.search);
}

// Versions Chrome : jusqu'à 4 entiers séparés par des points.
function compareVersions(a, b) {
  const x = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const y = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

module.exports = {
  parseJsonLoose, readManifestDir, localizedInfo, dirReader, actionOf, pickIcon, toolbarIconPath,
  hostPatterns, apiPermissions, permissionWarnings, matchPattern, compareVersions,
};
