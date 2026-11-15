/* =============================================================================
 *  zaalis browser — Windows / macOS (Electron for Content Security)
 * -----------------------------------------------------------------------------
 *  Reproduit le comportement du navigateur natif Windows :
 *   - Fenêtre unique avec chrome custom (chrome.html) en haut, contenu par onglet
 *     en dessous (WebContentsView par onglet, seul l'actif visible).
 *   - Page d'accueil zaalis (index.html) via protocole zaalis://.
 *   - Panneau latéral droit (panel.html) pour paramètres / historique.
 *   - Favoris, historique, raccourcis, réglages persistés dans le dossier
 *     de données de l'app (%APPDATA%\zaalis browser sous Windows).
 *   - API locale HTTP sur 127.0.0.1:8715 (search / open / newtab).
 *   - Bus de messages entre chrome/panel et le main via IPC, compatible avec
 *     le protocole 'action\x1farg' des pages HTML d'origine.
 *   - Widevine (Prime Video, Netflix, Disney+…) via le build castlabs ECS.
 * =========================================================================== */

'use strict';

const electron = require('electron');
const {
  app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, Menu, shell,
  protocol, net, session, nativeImage, dialog, clipboard, desktopCapturer,
  safeStorage, screen
} = electron;
// API propre au build castlabs (Widevine). Absente d'un Electron standard.
const components = electron.components || null;

// Version installée : les variables d'environnement réservées aux tests
// (profil jetable, contournement de Windows Hello, sources de listes, flux de
// mise à jour en http…) sont ignorées. Fait avant tout chargement de module.
if (electron.app.isPackaged) {
  for (const k of ['ZAALIS_E2E', 'ZAALIS_E2E_DIR', 'ZAALIS_IMPORT_ROOTS', 'ZAALIS_SB_SOURCES', 'ZAALIS_UPDATE_FORCE', 'ZAALIS_AGENT_SELFTEST', 'ZAALIS_SELFTEST_SUBMODEL']) delete process.env[k];
}
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const url  = require('url');
const crypto = require('crypto');

// Blocs autonomes extraits dans src/core/ (scripts injectés, catalogue IA…).
const { TOOL_RESULT_MAX, A11Y_TREE_MAX, AGENT_SYSTEM, parseToolCall, toolLabel, clampResult, a11ySnapshotJs, resolveTargetJs, AGENT_OVERLAY_JS, FOCUS_SELECT_JS, READ_VALUE_JS, legacyFillJs, DISPATCH_CHANGE_JS, parseModifiers, KEY_ALIASES, keyCodeFor, stripHtml, findElementsJs, PAGE_TEXT_JS, formInputJs, waitForJs, agentUrl, TRANSLATE_EXTRACT_JS, MEDIA_STATE_JS, mediaCommandJS } = require('./src/core/page-scripts');
const { AI_PROVIDER_GROUPS, AI_PROVIDERS, AI_MODEL_LABELS, GST, WORK_APPS } = require('./src/core/ai-catalog');
const { describeNetError, wrappedLinkTarget, UNREACHABLE_NET_ERRORS } = require('./src/core/net-errors');
const { decodeEntities, stripTags, parseDuckDuckGo, dedupeResults, fallbackResults, buildOverview } = require('./src/core/search-parse');

// ----- Constantes ------------------------------------------------------------

const HOME_URL   = 'zaalis://home/index.html';
const CHROME_URL = 'zaalis://home/chrome.html';
const PANEL_URL  = 'zaalis://home/panel.html';
const SEP        = '\x1f';
const API_PORT   = 8715;
const PANEL_WIDTH = 340;
// Au retour sur un onglet de serveur de développement local (localhost…)
// laissé en arrière-plan, on revalide la page après ce délai pour voir la
// dernière version publiée par l'IDE. Jamais pour les sites ordinaires :
// comme dans Chrome, une vidéo en pause, un formulaire ou une conversation
// doivent retrouver exactement leur état au retour sur l'onglet.
const STALE_TAB_REFRESH_MS = 4000;

function isLocalDevUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.test') ||
           h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch { return false; }
}

// ----- État global -----------------------------------------------------------

let mainWin        = null;
let chromeView     = null;
let panelView      = null;
let dataFolder     = null;

const tabs   = [];              // { id, view, loading }
let   active = -1;
let   nextId = 1;
let   splitPair = null;         // [idGauche, idDroite] — vue fractionnee (2 max)

// Les éléments Favoris / applications / profil ne vivent que sur l'accueil.
// Les pages externes démarrent donc juste après la barre d'onglets et d'outils.
const CHROME_COMPACT_HEIGHT = 95;
let chromeHeight = CHROME_COMPACT_HEIGHT;
let contentTop   = CHROME_COMPACT_HEIGHT;
let chromeOverlay = false;
let chromeOverlayRect = { left:0, top:0, right:0, bottom:0 };

let panelOpen = false;
let pendingPanelHistory = false;
let pendingPanelDownloads = false;
let panelLoaded = false;
let panelHideTimer = null;
let panelPreloadTimer = null;
let panelViewVisible = false;
let panelBoundsKey = '';
let panelBoundsUpdates = 0;
const PANEL_ANIM_MS = 190;
const PANEL_PRELOAD_DELAY_MS = 900;

const settings = {
  theme:          'light',
  offline:        false,
  searchEngine:   'google',
  showBookmarks:  true,
  historyEnabled: true,
  blockPopups:    false,
  contextMenus:   true,
  devTools:       true,
  devToolsDock:   'right',   // right | bottom | window (fenêtre séparée)
  devToolsWidth:  520,
  devToolsHeight: 320,
  statusBar:      true,
  zoomControls:   true,
  restoreTabs:    false,
  safeSearch:     false,
  httpsOnly:      false,   // force la mise a niveau http -> https quand possible
  safeBrowsing:   true,    // avertit sur les sites malveillants/hameconnage connus
  zoomPct:        100,
  aiProvider:     'codex',
  aiSubmodel:     'gpt-5.5',
  // Le modèle de conversation du mode vocal est volontairement séparé de la
  // recherche et du panneau IA : il ne s'affiche que dans ses réglages.
  voiceProvider:  'codex',
  voiceSubmodel:  'gpt-5.5',
  aiOverview:     true,
  aiConnectEnabled: true,
};

// Modèles locaux vivants récupérés du serveur IDE (Ollama installés + .gguf
// présents). Remplacent les valeurs par défaut ci-dessus dès qu'ils sont connus.
let liveOllamaModels = [];
let liveGgufModels = [];
// Instantané des fournisseurs pour le panneau : fusionne les listes vivantes
// local/gguf par-dessus le catalogue statique.
function aiProvidersSnapshot() {
  const out = {};
  for (const [k, p] of Object.entries(AI_PROVIDERS)) {
    let submodels = p.submodels;
    if (k === 'local' && liveOllamaModels.length) submodels = liveOllamaModels.slice();
    else if (k === 'gguf') submodels = liveGgufModels.slice();
    out[k] = { label: p.label, group: p.group, hint: p.hint || '', submodels };
  }
  return out;
}
function aiModelLabel() {
  return AI_MODEL_LABELS[settings.aiSubmodel] || settings.aiSubmodel ||
         (AI_PROVIDERS[settings.aiProvider] || {}).label || 'IA';
}
function validAiChoice(provider, submodel) {
  const p = AI_PROVIDERS[provider];
  if (!p) return false;
  // 'local' (Ollama) et 'gguf' (llama.cpp) acceptent n'importe quel modèle
  // installe : listes ouvertes alimentees en direct par le serveur IDE.
  return (provider === 'local' || provider === 'gguf') ? !!submodel : p.submodels.includes(submodel);
}

let bookmarks = [];   // { url, title }
let shortcuts = [];   // { url, title } — home page tiles
let history   = [];   // { url, title }

// ----- Lanceur d'applications (facon Google) --------------------------------
let launcherMode = 'travail';   // 'travail' | 'creatif'
let launcherApps = [];          // mode creatif : { url, title }

// Mode recherche IA (zaalis labs ide) : etat unique partage entre la barre
// d'adresse (chrome.html) et la barre centrale de l'accueil (index.html) pour
// que le degrade IA s'affiche simultanement sur les deux. Session uniquement.
let aiSearchOn = false;

// ----- Profils (comptes locaux, facon Chrome) --------------------------------
// Aucun profil selectionne = mode invite. Chaque profil : pseudo, couleur
// d'avatar, photo optionnelle (fichier avatars/<id>.png servi via zaalis://).

const PROFILE_COLORS = ['#4898ff','#00c4a7','#f5b400','#e8710a','#d93025','#a142f4','#24c1e0','#5f6368'];
let profiles = [];            // { id, name, color, photo } — photo = timestamp ou 0
let currentProfileId = '';    // '' = invite

function profilesFile() { return path.join(dataFolder, 'profiles.json'); }
function avatarsDir()   { return path.join(dataFolder, 'avatars'); }
function avatarPath(id) { return path.join(avatarsDir(), id + '.png'); }

function loadProfiles() {
  try {
    const d = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    profiles = Array.isArray(d)
      ? d.filter(p => p && p.id && p.name).map(p => ({
          id: String(p.id), name: String(p.name).slice(0, 40),
          color: PROFILE_COLORS.includes(p.color) ? p.color : PROFILE_COLORS[0],
          photo: Number(p.photo) || 0,
        }))
      : [];
  } catch { profiles = []; }
  // Auto-réparation : si profiles.json est absent ou corrompu mais que des
  // dossiers de profil subsistent sur disque, on reconstruit les entrées
  // manquantes. Un profil (et ses favoris/historique) ne peut donc jamais
  // « disparaître » à cause d'un simple fichier d'index perdu.
  try {
    const base = path.join(dataFolder, 'profiles');
    const dirs = fs.existsSync(base)
      ? fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : [];
    let recovered = false;
    for (const id of dirs) {
      if (profiles.some(p => p.id === id)) continue;
      profiles.push({
        id, name: 'Profil récupéré ' + (profiles.length + 1),
        color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length], photo: 0,
      });
      recovered = true;
    }
    if (recovered) saveProfiles();
  } catch {}
  if (currentProfileId && !profiles.some(p => p.id === currentProfileId)) currentProfileId = '';
}

// Écriture atomique : on écrit dans un fichier temporaire puis on renomme, afin
// qu'un crash en plein milieu ne laisse jamais un profiles.json vide (0 octet).
function saveProfiles() {
  try {
    const f = profilesFile(), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(profiles), 'utf8');
    fs.renameSync(tmp, f);
  } catch {}
}

function currentProfile() { return profiles.find(p => p.id === currentProfileId) || null; }

function profileById(id) { return profiles.find(p => p.id === id) || null; }

function createProfile(name) {
  name = String(name || '').replace(/\x1f/g, ' ').trim().slice(0, 40);
  if (!name) name = 'Profil ' + (profiles.length + 1);
  const p = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length],
    photo: 0,
  };
  saveOpenTabsNow();             // conserve les onglets du profil quitté
  profiles.push(p);
  currentProfileId = p.id;
  saveProfiles();
  saveSettings();
  refreshAfterProfileSwitch();   // nouveau profil = donnees vierges, bien separees
}

function selectProfile(id) {
  if (id && !profileById(id)) return;
  if ((id || '') === currentProfileId) return;
  saveOpenTabsNow();             // conserve les onglets du profil quitté
  currentProfileId = id || '';
  saveSettings();
  refreshAfterProfileSwitch();   // bascule = jeu de donnees du profil cible
}

function renameProfile(id, name) {
  const p = profileById(id);
  name = String(name || '').trim().slice(0, 40);
  if (!p || !name) return;
  p.name = name;
  saveProfiles();
  pushState();
}

function setProfileColor(id, color) {
  const p = profileById(id);
  if (!p || !PROFILE_COLORS.includes(color)) return;
  p.color = color;
  saveProfiles();
  pushState();
}

function deleteProfile(id) {
  const i = profiles.findIndex(p => p.id === id);
  if (i < 0) return;
  const wasCurrent = currentProfileId === id;
  if (wasCurrent) saveOpenTabsNow();   // conserve les onglets avant repli sur l'invité
  profiles.splice(i, 1);
  try { fs.unlinkSync(avatarPath(id)); } catch {}
  // Efface aussi les donnees du profil supprime (dossier dedie).
  try { fs.rmSync(path.join(dataFolder, 'profiles', id), { recursive: true, force: true }); } catch {}
  if (wasCurrent) {
    currentProfileId = '';
    saveSettings();
    saveProfiles();
    refreshAfterProfileSwitch();   // repli sur l'invite + ses donnees
    return;
  }
  saveProfiles();
  pushState();
}

// Choix d'une photo de profil via le selecteur natif ; recadree en 256x256
// et stockee dans le dossier de donnees.
async function chooseProfilePhoto(id) {
  const p = profileById(id);
  if (!p || !mainWin) return;
  let r;
  try {
    r = await dialog.showOpenDialog(mainWin, {
      title: 'Choisir une photo de profil',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
  } catch { return; }
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return;
  // [zaalis IDE] recadrage carré centré + 256 px par l'hôte natif (WIC).
  try {
    fs.mkdirSync(avatarsDir(), { recursive: true });
    await nativeImage.squareAvatar(r.filePaths[0], avatarPath(id), 256);
  } catch { return; }
  p.photo = Date.now();
  saveProfiles();
  pushState();
}

// ----- Persistance -----------------------------------------------------------

function ensureDataFolder() {
  // [zaalis IDE] navigateur intégré : dossier de données fourni par l'hôte.
  dataFolder = process.env.ZAALIS_BROWSER_DATA || path.join(app.getPath('appData'), 'zaalis browser');
  try { fs.mkdirSync(dataFolder, { recursive: true }); } catch {}
}

// Alias sur le Bureau au premier lancement, seulement quand l'app est
// installée dans /Applications (ne pollue pas les runs de dev).
function ensureDesktopAlias() {
  try {
    const appPath = app.getAppPath();
    if (!appPath.startsWith('/Applications/')) return;
    const marker = path.join(dataFolder, '.desktop-alias-installed');
    if (fs.existsSync(marker)) return;
    const desktop = app.getPath('desktop');
    const alias = path.join(desktop, 'zaalis browser.app');
    if (!fs.existsSync(alias)) {
      // AppleScript pour créer un vrai alias Finder (pas un symlink cassé).
      const script = `tell application "Finder" to make alias file to (POSIX file "/Applications/zaalis Browser.app") at (POSIX file "${desktop}")`;
      require('child_process').execFile('/usr/bin/osascript', ['-e', script], (err) => {
        if (err) {
          // Fallback : symlink simple.
          try { fs.symlinkSync('/Applications/zaalis browser.app', alias); } catch {}
        }
        try { fs.writeFileSync(marker, '1'); } catch {}
      });
    } else {
      fs.writeFileSync(marker, '1');
    }
  } catch {}
}

// Dossier de donnees du profil courant. Chaque profil a ses propres favoris /
// raccourcis / historique / lanceur, bien separes. L'invite (aucun profil)
// utilise la racine du dossier de donnees (compat avec les donnees existantes).
function profileDataDir() {
  if (!currentProfileId) return dataFolder;
  const d = path.join(dataFolder, 'profiles', currentProfileId);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

// ----- Fichiers locaux chiffrés ---------------------------------------------
// Historique, favoris, onglets à restaurer, téléchargements, autorisations et
// conversations IA sont chiffrés sur disque avec la clé du compte Windows
// (DPAPI, via safeStorage) — la même protection que les cookies. Un fichier
// copié hors de la session de l'utilisateur est illisible. Les anciens
// fichiers en clair sont relus tels quels puis chiffrés à la prochaine écriture.
const SEAL_PREFIX = 'ZSEAL1:';
function sealAvailable() {
  try { return app.isReady() && safeStorage.isEncryptionAvailable(); } catch { return false; }
}
function sealWrite(file, text) {
  let out = String(text);
  if (sealAvailable()) {
    try { out = SEAL_PREFIX + safeStorage.encryptString(out).toString('base64'); } catch {}
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, file);   // écriture atomique
}
function sealRead(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.startsWith(SEAL_PREFIX)) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(SEAL_PREFIX.length), 'base64'));
}

function readTsv(name) {
  const p = path.join(profileDataDir(), name);
  if (!fs.existsSync(p)) return [];
  let text = '';
  try { text = sealRead(p); } catch { return []; }
  return text.split(/\r?\n/).map(l => {
    const t = l.indexOf('\t');
    if (t < 0) return null;
    const url = l.slice(0, t), title = l.slice(t + 1);
    return url ? { url, title } : null;
  }).filter(Boolean);
}

function writeTsv(name, list) {
  const p = path.join(profileDataDir(), name);
  sealWrite(p, list.map(e => e.url + '\t' + (e.title || '')).join('\n'));
}

// ----- Lanceur : persistance par profil -------------------------------------
function launcherFile() { return path.join(profileDataDir(), 'launcher.json'); }
function loadLauncher() {
  launcherMode = 'travail'; launcherApps = [];
  try {
    const d = JSON.parse(fs.readFileSync(launcherFile(), 'utf8'));
    if (d.mode === 'creatif' || d.mode === 'travail') launcherMode = d.mode;
    if (Array.isArray(d.creative)) launcherApps = d.creative
      .filter(x => x && x.url)
      .map(x => ({ url: String(x.url), title: String(x.title || x.url).slice(0, 60) }))
      .slice(0, 30);
  } catch {}
}
function saveLauncher() {
  try { fs.writeFileSync(launcherFile(), JSON.stringify({ mode: launcherMode, creative: launcherApps })); } catch {}
}
function normalizeShortcutUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(u)) return u;
  return 'https://' + u.replace(/^\/+/, '');
}

// ----- Session : onglets a restaurer ----------------------------------------
function sessionTabsFile() { return path.join(profileDataDir(), 'session-tabs.json'); }
let saveTabsTimer = null;
function tabUrlForSession(t) {
  if (t.incognito) return '';   // la navigation privée n'est jamais persistée
  try {
    const u = (t.discarded ? t.discarded.url : t.view.webContents.getURL()) || '';
    return isInternal(u) ? '' : u;
  } catch { return ''; }
}
function saveOpenTabsNow() {
  if (!settings.restoreTabs) return;
  try {
    const urls = tabs.map(tabUrlForSession);
    sealWrite(sessionTabsFile(), JSON.stringify({ active, urls, ...featureState('session') }));
  } catch {}
}
function scheduleSaveOpenTabs() {
  if (!settings.restoreTabs) return;
  if (saveTabsTimer) clearTimeout(saveTabsTimer);
  saveTabsTimer = setTimeout(() => { saveTabsTimer = null; saveOpenTabsNow(); }, 250);
}
function loadSessionTabs() {
  try {
    const d = JSON.parse(sealRead(sessionTabsFile()));
    const urls = Array.isArray(d.urls) ? d.urls.map(u => String(u || '')).slice(0, 40) : [];
    return { active: Math.max(0, Math.min(urls.length - 1, parseInt(d.active, 10) || 0)), urls, data: d };
  } catch { return null; }
}
function clearSessionTabs() {
  try { fs.unlinkSync(sessionTabsFile()); } catch {}
}

// Recharge toutes les donnees liees au profil (favoris, raccourcis, historique,
// lanceur) depuis le dossier du profil courant.
function loadProfileData() {
  bookmarks = readTsv('bookmarks.tsv');
  shortcuts = readTsv('shortcuts.tsv');
  history   = readTsv('history.tsv');
  loadLauncher();
  loadDownloads();
}

// Applique un changement de profil : recharge les donnees, reconstruit les
// onglets sur la session isolee du profil, et rafraichit l'UI.
function refreshAfterProfileSwitch() {
  loadProfileData();
  rebuildTabsForProfile();
  pushState();
  pushShortcuts();
  pushPanelState();
  sendPanelHistory();
  pushDownloads();
}

function loadSettings() {
  const p = path.join(dataFolder, 'settings.txt');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq), v = line.slice(eq + 1);
      if (k === 'theme')                       settings.theme = v === 'dark' ? 'dark' : 'light';
      else if (k === 'offline')                settings.offline = v === '1';
      else if (k === 'searchEngine' &&
               ['google','bing','duckduckgo','brave'].includes(v)) settings.searchEngine = v;
      else if (k === 'showBookmarks')          settings.showBookmarks = v !== '0';
      else if (k === 'historyEnabled')         settings.historyEnabled = v !== '0';
      else if (k === 'blockPopups')            settings.blockPopups = v === '1';
      else if (k === 'contextMenus')           settings.contextMenus = v !== '0';
      else if (k === 'devTools')               settings.devTools = v !== '0';
      else if (k === 'devToolsDock')           settings.devToolsDock = ['right', 'bottom', 'window'].includes(v) ? v : 'right';
      else if (k === 'devToolsWidth')          settings.devToolsWidth = Math.max(DEVTOOLS_MIN, parseInt(v, 10) || 520);
      else if (k === 'devToolsHeight')         settings.devToolsHeight = Math.max(DEVTOOLS_MIN, parseInt(v, 10) || 320);
      else if (k === 'statusBar')              settings.statusBar = v !== '0';
      else if (k === 'zoomControls')           settings.zoomControls = v !== '0';
      else if (k === 'restoreTabs')            settings.restoreTabs = v === '1';
      else if (k === 'safeSearch')             settings.safeSearch = v === '1';
      else if (k === 'httpsOnly')              settings.httpsOnly = v === '1';
      else if (k === 'safeBrowsing')           settings.safeBrowsing = v !== '0';
      else if (k === 'aiProvider' && AI_PROVIDERS[v]) settings.aiProvider = v;
      else if (k === 'aiSubmodel' && v)        settings.aiSubmodel = v;
      else if (k === 'voiceProvider' && AI_PROVIDERS[v]) settings.voiceProvider = v;
      else if (k === 'voiceSubmodel' && v)     settings.voiceSubmodel = v;
      else if (k === 'aiOverview')             settings.aiOverview = v !== '0';
      else if (k === 'aiConnectEnabled')       settings.aiConnectEnabled = v !== '0';
      else if (k === 'zoomPct')                settings.zoomPct = Math.max(67, Math.min(200, parseInt(v,10) || 100));
      else if (k === 'currentProfile')         currentProfileId = v || '';
    }
  }
  // Cohérence provider/sous-modèle (fichier édité à la main, ancienne version…).
  if (!validAiChoice(settings.aiProvider, settings.aiSubmodel)) {
    settings.aiSubmodel = AI_PROVIDERS[settings.aiProvider].submodels[0] || settings.aiSubmodel || 'gpt-5.5';
  }
  if (!validAiChoice(settings.voiceProvider, settings.voiceSubmodel)) {
    // Migration des réglages existants : le premier lancement vocal reprend
    // le modèle IA courant, puis conserve son propre choix.
    settings.voiceProvider = settings.aiProvider;
    settings.voiceSubmodel = settings.aiSubmodel;
  }
  // Les favoris / raccourcis / historique / lanceur sont propres au profil :
  // charges par loadProfileData() une fois le profil courant connu.
}

function saveSettings() {
  const lines = [
    `theme=${settings.theme}`,
    `offline=${settings.offline ? 1 : 0}`,
    `searchEngine=${settings.searchEngine}`,
    `showBookmarks=${settings.showBookmarks ? 1 : 0}`,
    `historyEnabled=${settings.historyEnabled ? 1 : 0}`,
    `blockPopups=${settings.blockPopups ? 1 : 0}`,
    `contextMenus=${settings.contextMenus ? 1 : 0}`,
    `devTools=${settings.devTools ? 1 : 0}`,
    `devToolsDock=${settings.devToolsDock}`,
    `devToolsWidth=${settings.devToolsWidth}`,
    `devToolsHeight=${settings.devToolsHeight}`,
    `statusBar=${settings.statusBar ? 1 : 0}`,
    `zoomControls=${settings.zoomControls ? 1 : 0}`,
    `restoreTabs=${settings.restoreTabs ? 1 : 0}`,
    `safeSearch=${settings.safeSearch ? 1 : 0}`,
    `httpsOnly=${settings.httpsOnly ? 1 : 0}`,
    `safeBrowsing=${settings.safeBrowsing ? 1 : 0}`,
    `aiProvider=${settings.aiProvider}`,
    `aiSubmodel=${settings.aiSubmodel}`,
    `voiceProvider=${settings.voiceProvider}`,
    `voiceSubmodel=${settings.voiceSubmodel}`,
    `aiOverview=${settings.aiOverview ? 1 : 0}`,
    `aiConnectEnabled=${settings.aiConnectEnabled ? 1 : 0}`,
    `zoomPct=${settings.zoomPct}`,
    `currentProfile=${currentProfileId}`,
  ];
  fs.writeFileSync(path.join(dataFolder, 'settings.txt'), lines.join('\n'), 'utf8');
}

const saveBookmarks = () => writeTsv('bookmarks.tsv', bookmarks);
const saveHistory   = () => writeTsv('history.tsv',   history);
const saveShortcuts = () => writeTsv('shortcuts.tsv', shortcuts);

// ----- Utilitaires ----------------------------------------------------------

function isInternal(u) {
  return !u || u === 'about:blank' || u.startsWith('zaalis://') || u.includes('zaalis.home');
}

function isAllowedInternalUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'zaalis:' && u.host === 'home' && !u.username && !u.password;
  } catch { return false; }
}

function allowedPageUrl(raw, allowInternal) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    if (allowInternal && isAllowedInternalUrl(u.toString())) return u.toString();
    // Fichier local ouvert depuis Windows (ligne de commande) : jamais depuis une page.
    if (allowInternal && u.protocol === 'file:' && trustedFileUrls.has(u.href)) return u.href;
    // Pages d'extension (options, onglets ouverts par chrome.tabs.create).
    if (u.protocol === 'chrome-extension:' && featureUrlAllowed(u.href)) return u.href;
  } catch {}
  return null;
}

function resolveQuery(q) {
  q = (q || '').trim();
  if (!q) return HOME_URL;
  const alias = internalAlias(q);
  if (alias) return alias;
  if (trustedFileUrls.has(q)) return q;
  if (isAllowedInternalUrl(q)) return q;
  // Les URL saisies ne peuvent ouvrir que des pages web. Les autres schémas
  // (javascript:, data:, file:, etc.) deviennent une recherche ordinaire.
  if (/^https?:\/\//i.test(q)) return httpsUpgrade(q);
  // localhost / IP / hôte avec port
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$|\?|#)/i.test(q)) return 'http://' + q;
  // Contient un point + un TLD >=2 lettres et pas d'espace -> URL directe.
  if (!q.includes(' ') && /^[^\s]+\.[a-z]{2,63}([\/?#].*)?$/i.test(q)) return httpsUpgrade('https://' + q);
  const engines = {
    google:     'https://www.google.com/search?q=',
    bing:       'https://www.bing.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    brave:      'https://search.brave.com/search?q=',
  };
  const base = engines[settings.searchEngine] || engines.google;
  const safe = settings.safeSearch ? '&safe=active' : '';
  return base + encodeURIComponent(q) + safe;
}

// ----- Recherche IA (zaalis labs ide) ---------------------------------------
// Le moteur IA recupere de vrais resultats web (via DuckDuckGo HTML, cote
// process principal pour eviter les blocages CORS), les analyse, puis produit
// une page de resultats interne. Le modele choisi (settings.aiModel) pilote le
// libelle et la synthese. Aucune cle secrete n'est embarquee : la synthese est
// construite localement a partir des extraits des sources.

// User-Agent identique à celui de Google Chrome (version réduite « 150.0.0.0 »).
// L'UA par défaut d'Electron contient « zaalisbrowser/x » et « Electron/x » :
// Google refuse alors la connexion (« navigateur non sécurisé ») et des sites
// comme Prime Video, Netflix ou WhatsApp Web servent une page d'incompatibilité.
function chromeUserAgent() {
  const major = String(process.versions.chrome || '150').split('.')[0];
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
                 : process.platform === 'win32'  ? 'Windows NT 10.0; Win64; x64'
                 : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
         `Chrome/${major}.0.0.0 Safari/537.36`;
}

const AI_UA = chromeUserAgent();

function httpGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ url: urlStr, redirect: 'follow' }); }
    catch (e) { reject(e); return; }
    req.setHeader('User-Agent', AI_UA);
    req.setHeader('Accept', 'text/html,application/xhtml+xml');
    req.setHeader('Accept-Language', 'fr-FR,fr;q=0.9,en;q=0.8');
    if (headers) for (const k of Object.keys(headers)) req.setHeader(k, headers[k]);
    const chunks = [];
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, 9000);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ----- Client zaalis labs ide (serveur local, port 3000) --------------------
// Le pont est authentifié par un secret partagé que le serveur IDE écrit dans
// ~/Library/Application Support/zaalis/server-data/browser-secret. Accès
// limité côté IDE au chat. Si l'IDE n'est pas lancé, chaque fonction IA du
// navigateur bascule sur son repli local.

const IDE_PORT = Number(process.env.ZAALIS_IDE_PORT) || 3000;

function ideSecretPath() {
  if (process.env.ZAALIS_BROWSER_SECRET_FILE) return process.env.ZAALIS_BROWSER_SECRET_FILE; // [zaalis IDE]
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'zaalis', 'server-data', 'browser-secret');
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'zaalis', 'server-data', 'browser-secret');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'zaalis', 'server-data', 'browser-secret');
}

function ideSecret() {
  try { return fs.readFileSync(ideSecretPath(), 'utf8').trim(); } catch { return ''; }
}

// Etat de connexion a zaalis labs ide, envoye a l'UI pour griser les
// fonctions IA quand elles ne sont pas utilisables.
// 'connected'    : IDE joignable + utilisateur connecte -> chat OK
// 'no-account'   : IDE joignable mais aucun compte -> inviter a s'inscrire
// 'unreachable'  : IDE injoignable (jamais lance, ferme, port occupe)
// 'offline'      : mode local securise actif
// 'disabled'     : la connexion a ete manuellement coupee dans les reglages
let ideStatus = 'unreachable';
let ideStatusMessage = '';
let ideStatusChecking = false;
let ideStatusTimer = null;

// Valeurs de repli affichées avant le premier contact avec l'IDE. Dès que
// l'IDE répond, cette liste est remplacée par les voix réellement disponibles
// sur cet ordinateur, sans redémarrer le navigateur.

function setIdeStatus(status, message) {
  if (ideStatus === status && ideStatusMessage === (message || '')) return;
  ideStatus = status;
  ideStatusMessage = message || '';
  // L'IDE n'est plus joignable : on eteint le mode IA pour ne pas laisser un
  // degrade actif sur une fonction devenue indisponible.
  if (status !== 'connected' && aiSearchOn) { aiSearchOn = false; pushAiMode(); }
  pushState();
  pushPanelState();
  pushAiPanelState();
  pushAiStatusToTabs();
}

// GET rapide vers l'IDE. Ajoute le secret quand fourni pour authentifier
// via le pont navigateur.
function ideProbe(pathname, timeoutMs, withSecret) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ method: 'GET', url: 'http://127.0.0.1:' + IDE_PORT + pathname }); }
    catch (e) { reject(e); return; }
    if (withSecret) {
      const s = ideSecret();
      if (s) req.setHeader('x-zaalis-browser', s);
    }
    const chunks = [];
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, timeoutMs || 2500);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// Determine l'etat du pont : IDE lance ? secret ecrit ? compte present ?
async function refreshIdeStatus(force) {
  if (ideStatusChecking && !force) return;
  ideStatusChecking = true;
  try {
    if (!settings.aiConnectEnabled) { setIdeStatus('disabled'); return; }
    if (settings.offline)            { setIdeStatus('offline');  return; }
    const secret = ideSecret();
    // Aucun secret : l'IDE n'a jamais ete lance sur cet ordinateur.
    if (!secret) { setIdeStatus('unreachable', 'zaalis labs ide n\'est pas installé ou n\'a jamais été lancé.'); return; }
    // 1) L'IDE est-il joignable ? /api/auth/me est public.
    let alive;
    try { alive = await ideProbe('/api/auth/me'); }
    catch { setIdeStatus('unreachable', 'zaalis labs ide est fermé ou ne répond pas.'); return; }
    if (alive.status !== 200) { setIdeStatus('unreachable', 'zaalis labs ide a répondu ' + alive.status + '.'); return; }
    // 2) Le pont fonctionne-t-il avec un utilisateur ? On sonde /api/gguf-models
    // (autorise via le pont) : 200 = compte trouve ; 401 = aucun compte.
    let bridged;
    try { bridged = await ideProbe('/api/gguf-models', 2500, true); }
    catch { setIdeStatus('unreachable', 'zaalis labs ide ne répond plus.'); return; }
    if (bridged.status === 401 || (bridged.body && bridged.body.error && /Authentification|Authorization/i.test(String(bridged.body.error)))) {
      setIdeStatus('no-account', 'Créez un compte ou connectez-vous dans zaalis labs ide pour commencer à utiliser les fonctions IA.');
      return;
    }
    if (bridged.status !== 200) { setIdeStatus('unreachable', 'zaalis labs ide n\'accepte pas le pont (' + bridged.status + ').'); return; }
    setIdeStatus('connected', 'Connecté à zaalis labs ide.');
    // Le pont est vivant : rafraîchit la liste des modèles locaux installés.
    refreshLocalModels();
  } finally {
    ideStatusChecking = false;
  }
}

// Récupère en direct les modèles locaux installés côté IDE — tags Ollama et
// fichiers .gguf — pour que tout modèle ajouté apparaisse automatiquement dans
// le sélecteur du navigateur, sans redémarrage ni liste codée en dur.
async function refreshLocalModels() {
  let changed = false;
  const key = (a) => a.join('\0');
  try {
    const r = await ideProbe('/api/ollama-models', 2500, true);
    if (r && r.status === 200 && r.body && Array.isArray(r.body.models)) {
      const list = r.body.models.map((m) => String(m)).filter(Boolean);
      // Ollama joignable mais vide : on garde les valeurs par défaut (list vide
      // -> aiProvidersSnapshot retombe sur le catalogue statique).
      if (key(list) !== key(liveOllamaModels)) { liveOllamaModels = list; changed = true; }
    }
  } catch {}
  try {
    const r = await ideProbe('/api/gguf-models', 2500, true);
    if (r && r.status === 200 && r.body && Array.isArray(r.body.models)) {
      const list = r.body.models.map((m) => m && m.name).filter(Boolean).map(String);
      if (key(list) !== key(liveGgufModels)) { liveGgufModels = list; changed = true; }
    }
  } catch {}
  if (changed) pushPanelState();
}

function startIdeStatusWatcher() {
  refreshIdeStatus();
  if (ideStatusTimer) clearInterval(ideStatusTimer);
  ideStatusTimer = setInterval(refreshIdeStatus, 15000);
}

// POST JSON vers le serveur IDE. Rejette si indisponible / non authentifié.
function idePost(pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secret = ideSecret();
    if (!secret) { reject(new Error('no-secret')); return; }
    let req;
    try { req = net.request({ method: 'POST', url: 'http://127.0.0.1:' + IDE_PORT + pathname }); }
    catch (e) { reject(e); return; }
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('x-zaalis-browser', secret);
    const chunks = [];
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, timeoutMs || 45000);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400 || data.error) reject(new Error(data.error || ('HTTP ' + res.statusCode)));
          else resolve(data);
        } catch (e) { reject(e); }
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(JSON.stringify(body));
  });
}

// Appel chat au modèle choisi dans les réglages. Retourne { response, thinking }.
async function ideChat({ message, systemPrompt, history: turns, timeoutMs, provider, submodel, images }) {
  const data = await idePost('/api/chat', {
    model: provider || settings.aiProvider,
    submodel: submodel || settings.aiSubmodel,
    message,
    systemPrompt: systemPrompt || '',
    history: Array.isArray(turns) ? turns : [],
    // Captures d'écran de l'agent (vision) : [{ mime, data(base64) }].
    images: Array.isArray(images) ? images : [],
  }, timeoutMs);
  const text = String(data.response || '').trim();
  if (!text) throw new Error('empty-response');
  // Réponses d'erreur "douces" du serveur IDE (clé manquante, etc.).
  if (/^\[[^\]]+\]\s/.test(text) && /cle api|api key|aucune cle/i.test(text)) throw new Error('no-key:' + text);
  return { response: text, thinking: String(data.thinking || '') };
}


// Repli 1 : API JSON DuckDuckGo (pas de captcha). Fournit un resume "Abstract"
// et des sujets connexes. On l'utilise quand le scraping HTML est bloque.
async function fetchDdgJson(q) {
  try {
    const raw = await httpGet('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) +
                              '&format=json&no_html=1&no_redirect=1&t=zaalis');
    const d = JSON.parse(raw);
    const results = [];
    if (d.AbstractURL && d.Heading) {
      results.push({ url: d.AbstractURL, title: d.Heading, snippet: d.AbstractText || '' });
    }
    const flat = [];
    for (const it of (d.RelatedTopics || [])) {
      if (it.FirstURL && it.Text) flat.push(it);
      else if (Array.isArray(it.Topics)) for (const s of it.Topics) if (s.FirstURL && s.Text) flat.push(s);
    }
    for (const it of flat.slice(0, 7)) {
      const t = String(it.Text);
      results.push({ url: it.FirstURL, title: t.split(' - ')[0].slice(0, 90), snippet: t });
    }
    return { abstract: d.AbstractText || '', results };
  } catch { return { abstract: '', results: [] }; }
}

// Repli 2 : suggestions Wikipedia (toujours disponibles pour les sujets connus).
async function fetchWikipedia(q) {
  try {
    const raw = await httpGet('https://fr.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search=' +
                              encodeURIComponent(q));
    const a = JSON.parse(raw);
    const titles = a[1] || [], descs = a[2] || [], urls = a[3] || [];
    return titles.map((t, i) => ({ url: urls[i], title: t, snippet: descs[i] || 'Article Wikipedia.' }))
                 .filter(r => r.url);
  } catch { return []; }
}

// Suggestions de saisie (facon Google) : recuperees cote process principal
// pour eviter les blocages CORS depuis les pages internes. On interroge l'API
// de completion Google (client=firefox -> JSON simple), avec repli DuckDuckGo.
// Format Google : ["requete", ["sugg1", "sugg2", ...], [], {...}].
async function fetchSuggest(q) {
  q = (q || '').trim();
  if (!q) return [];
  const lang = 'fr';
  try {
    const raw = await httpGet('https://suggestqueries.google.com/complete/search?client=firefox&hl=' +
                              lang + '&q=' + encodeURIComponent(q));
    const a = JSON.parse(raw);
    if (Array.isArray(a) && Array.isArray(a[1]) && a[1].length) {
      return a[1].filter(s => typeof s === 'string').slice(0, 8);
    }
  } catch { /* repli ci-dessous */ }
  try {
    const raw = await httpGet('https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list');
    const a = JSON.parse(raw);
    if (Array.isArray(a) && Array.isArray(a[1])) return a[1].filter(s => typeof s === 'string').slice(0, 8);
  } catch { /* aucune suggestion */ }
  return [];
}


// Navigation d'une requete IA : URL directe -> navigation normale ;
// sinon on ouvre la page de resultats interne (la requete voyage via le hash).
function aiSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(q) ||
      (!q.includes(' ') && /^[^\s]+\.[a-z]{2,63}([\/?#].*)?$/i.test(q))) {
    navigateActive(resolveQuery(q));
    return;
  }
  // Non connecte : on bascule sur une recherche classique et on rappelle le
  // statut via la barre pour que l'UI le signale.
  if (ideStatus !== 'connected') { refreshIdeStatus(true); navigateActive(resolveQuery(q)); return; }
  navigateActive('zaalis://home/aisearch.html#' + encodeURIComponent(q));
}

// Execute la recherche IA et renvoie les resultats a l'onglet demandeur.
// Strategie en couches : d'abord les vrais resultats web (DuckDuckGo HTML),
// puis, si bloque, l'API JSON (resume + connexes) et Wikipedia. En dernier
// recours, des liens directs vers les moteurs. La synthese privilegie le
// resume factuel quand il existe, sinon un condense des extraits.
async function runAiSearch(q, sender) {
  if (!sender) return;
  q = (q || '').trim();
  const model = aiModelLabel();
  const reply = (payload) => {
    try { sender.send('zaalis:message', Object.assign({ type: 'aiResults', query: q, model }, payload)); }
    catch {}
  };
  if (!q) { reply({ results: [], overview: '', error: 'empty' }); return; }
  if (settings.offline) { reply({ results: [], overview: '', error: 'offline' }); return; }

  let results = [], abstract = '', error = null;

  // 1) Vrais resultats web via le HTML DuckDuckGo (ideal sur IP residentielle).
  try {
    const html = await httpGet('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=fr-fr');
    results = parseDuckDuckGo(html);
  } catch { /* on bascule sur les replis */ }

  // 2) Replis JSON + Wikipedia si le scraping n'a rien donne (captcha, blocage).
  if (results.length < 3) {
    const [json, wiki] = await Promise.all([fetchDdgJson(q), fetchWikipedia(q)]);
    abstract = json.abstract || '';
    results = dedupeResults([...results, ...json.results, ...wiki]);
  }

  // 3) Dernier recours : liens directs vers les moteurs.
  if (!results.length) { results = fallbackResults(q); error = 'empty-results'; }

  results = results.slice(0, 10);

  // Envoie d'abord les sources (affichage immediat), puis la synthese.
  let overview = '', aiLive = false;
  if (settings.aiOverview) overview = abstract && abstract.length > 40 ? abstract : buildOverview(q, results);
  reply({ results, overview, error, pendingAi: settings.aiOverview && !error });

  // Synthese generative par le modele choisi, via zaalis labs ide. En cas
  // d'indisponibilite (IDE ferme, pas de cle), la synthese locale reste.
  if (settings.aiOverview && !error) {
    try {
      const src = results.slice(0, 6).map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ''}`).join('\n\n');
      const out = await ideChat({
        message: 'Requete de recherche : « ' + q + ' »\n\nSources :\n\n' + src,
        systemPrompt: 'Tu es le moteur de recherche IA du navigateur zaalis. A partir des sources fournies, redige en francais une synthese factuelle de 2 a 4 phrases qui repond directement a la requete. Pas de titre, pas de liste, pas de mention des numeros de sources. Si les sources ne permettent pas de repondre, dis-le simplement.',
        timeoutMs: 30000,
      });
      overview = out.response;
      aiLive = true;
    } catch { /* la synthese locale deja envoyee fait foi */ }
    reply({ results, overview, error, aiLive });
  }
}


// Page d'erreur maison (chargée quand une navigation échoue).
function errorPageHtml(u, code, desc, override) {
  let host = u;
  try { host = new URL(u).host || u; } catch {}
  const dark = settings.theme === 'dark';
  const bg   = dark ? '#202124' : '#e9eaed';
  const fg   = dark ? '#e8eaed' : '#202124';
  const mut  = dark ? '#9aa0a6' : '#5f6368';
  const accent = dark ? '#8ab4f8' : '#1a73e8';
  const esc = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  const encHost = esc(host);
  const encUrl  = esc(u);
  const [shortCode, title, message] = override || describeNetError(code, encHost);
  // « Réessayer » recharge l'adresse d'origine : un simple location.reload()
  // rechargerait la page d'erreur elle-même (document data:).
  const retry = /^https?:/i.test(String(u)) ? JSON.stringify(String(u)).replace(/</g, '\\u003c') : 'null';
  // Lien Safe Links injoignable : accès direct à la destination, sauf si elle
  // est signalée comme dangereuse.
  let direct = (!override && UNREACHABLE_NET_ERRORS.has(Number(code))) ? wrappedLinkTarget(u) : null;
  if (direct && safeBrowsingVerdict(direct)) direct = null;
  let directHost = '';
  try { if (direct) directHost = new URL(direct).host; } catch {}
  const directJs = direct ? JSON.stringify(direct).replace(/</g, '\\u003c') : 'null';
  const directNote = direct
    ? `<p>Ce lien passe par le filtre Microsoft Safe Links, injoignable depuis votre réseau. Sa destination réelle est <code>${esc(directHost)}</code> : vous pouvez l'ouvrir directement, sans la vérification de Microsoft. Ne continuez que si vous faites confiance à l'expéditeur.</p>`
    : '';
  const directBtn = direct ? `<button id="direct">Ouvrir ${esc(directHost)}</button>` : '';
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html,body{margin:0;height:100%;background:${bg};color:${fg};font-family:-apple-system,"Segoe UI",Arial,sans-serif;}
  .wrap{max-width:640px;margin:0 auto;padding:96px 32px;}
  h1{font-size:26px;font-weight:600;margin:0 0 12px;}
  p{font-size:15px;line-height:1.5;color:${mut};margin:0 0 10px;}
  code{background:${dark?'#303134':'#f1f3f4'};padding:1px 6px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}
  .actions{margin-top:28px;display:flex;gap:10px;flex-wrap:wrap;}
  button{background:${accent};color:${dark?'#202124':'#fff'};border:0;border-radius:8px;padding:9px 18px;font-size:14px;font-weight:500;cursor:pointer;}
  button.ghost{background:transparent;color:${accent};border:1px solid ${accent};}
  .details{margin-top:36px;font-size:13px;color:${mut};}
  .details b{color:${fg};font-weight:600;}
</style></head><body><div class="wrap">
  <h1>${esc(title)}</h1>
  <p>${message}</p>
  ${directNote}
  <div class="actions">
    ${directBtn}
    <button${direct ? ' class="ghost"' : ''} id="retry">Réessayer</button>
    <button class="ghost" id="back">Retour</button>
  </div>
  <div class="details"><b>${esc(shortCode)}</b><br>${encUrl}</div>
</div><script>
  const target = ${retry};
  document.getElementById('retry').onclick = () => { if (target) location.href = target; else location.reload(); };
  document.getElementById('back').onclick = () => history.back();
  const direct = ${directJs};
  const directBtn = document.getElementById('direct');
  if (directBtn && direct) directBtn.onclick = () => { location.href = direct; };
</script></body></html>`;
}

function activeTab() { return active >= 0 ? tabs[active] : null; }

function pushHistory(u, title) {
  if (!settings.historyEnabled) return;
  if (!u || isInternal(u)) return;
  const last = history[history.length - 1];
  if (last && last.url === u) { last.title = title || last.title; saveHistory(); return; }
  history.push({ url: u, title: title || u });
  if (history.length > 2000) history.shift();
  saveHistory();
}

function removeHistoryUrl(u) {
  history = history.filter(e => e.url !== u);
  saveHistory();
  sendPanelHistory();
  pushPanelState();
}

// ----- Layout ---------------------------------------------------------------

// Plein écran : vidéo HTML5 (YouTube, Prime Video…) ou F11. Comme Chrome, la
// barre d'onglets et d'outils disparaît et la page occupe tout l'écran.
let htmlFullscreenTabId = null;

function fullscreenTab() {
  if (htmlFullscreenTabId == null) return null;
  const t = tabs.find(x => x.id === htmlFullscreenTabId);
  if (!t || t.view.webContents.isDestroyed()) { htmlFullscreenTabId = null; return null; }
  return t;
}

function windowFullscreen() {
  try { return !!(mainWin && mainWin.isFullScreen()); } catch { return false; }
}

function layoutAll() {
  if (!mainWin || !chromeView) return;
  const [w, h] = mainWin.getContentSize();

  const fsTab = fullscreenTab();
  if (fsTab) {
    // Seul l'onglet en plein écran reste visible, sur toute la fenêtre.
    chromeView.setVisible(false);
    for (const t of tabs) {
      if (t === fsTab) { t.view.setBounds({ x: 0, y: 0, width: w, height: h }); t.view.setVisible(true); hideDevViews(t); }
      else hideTab(t);
    }
    if (panelView && panelViewVisible) panelView.setVisible(false);
    if (aiPanelView && aiPanelVisible) aiPanelView.setVisible(false);
    if (findView) findView.setVisible(false);
    return;
  }

  const immersive = windowFullscreen();     // F11 : pas de barre, comme Chrome
  chromeView.setVisible(!immersive);
  chromeView.setBounds({ x: 0, y: 0, width: w, height: chromeHeight });
  if (panelView && panelViewVisible) panelView.setVisible(true);
  if (aiPanelView && aiPanelVisible) aiPanelView.setVisible(true);

  const bodyTop = immersive ? 0 : contentTop;
  const bodyHeight = Math.max(0, h - bodyTop);
  // Le chat IA est un panneau ancré : sa largeur est réservée à droite
  // dès son ouverture. Ainsi, les pages (et les vues fractionnées) se
  // redimensionnent au lieu de rester cachées sous le panneau qui glisse.
  const aiReservedWidth = aiPanelOpen ? Math.min(AI_PANEL_WIDTH, w) : 0;
  const bodyWidth = Math.max(0, w - aiReservedWidth);

  // Vue fractionnee : si l'onglet actif fait partie de la paire, les deux
  // membres se partagent la largeur, colles bord a bord (aucune demarcation).
  const pair = currentSplitTabs();
  const half = Math.floor(bodyWidth / 2);
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (pair && (t.id === pair[0].id || t.id === pair[1].id)) {
      const isLeft = t.id === pair[0].id;
      // La vue de droite deborde d'1px sous celle de gauche : sans ce
      // recouvrement, le fond de fenetre transparait sur le joint sub-pixel
      // (trait noir). Chrome n'a aucune demarcation -> on l'imite.
      placeTab(t, {
        x: isLeft ? 0 : half - 1,
        y: bodyTop,
        width: isLeft ? half : Math.max(0, bodyWidth - half + 1),
        height: bodyHeight,
      });
    } else if (!pair && i === active) {
      placeTab(t, { x: 0, y: bodyTop, width: bodyWidth, height: bodyHeight });
    } else {
      hideTab(t);
    }
  }

  layoutPanel();

  layoutAiPanel();

  layoutFindBar(bodyTop, bodyWidth);
}

// ----- Outils de développement ancrés (F12) ---------------------------------
// Comme Chrome : F12 ouvre les DevTools dans la fenêtre, à droite ou en bas de
// la page, avec une poignée pour les redimensionner. Chaque onglet a les siens
// (tab.dev = { view, grip, rect }). Clic droit sur la poignée : choix de
// l'ancrage (droite, bas, fenêtre séparée).
const DEVTOOLS_MIN = 160;
const DEVTOOLS_GRIP = 5;
const DEVGRIP_URL = 'zaalis://home/devgrip.html';

function hideDevViews(t) {
  if (!t.dev) return;
  try { t.dev.view.setVisible(false); t.dev.grip.setVisible(false); } catch {}
}
function hideTab(t) {
  t.view.setVisible(false);
  hideDevViews(t);
}
// Place un onglet dans `rect` en réservant, s'ils sont ouverts, la zone des
// outils de développement et de leur poignée.
// Découpe le rectangle de l'onglet entre la page, la poignée et les outils (à droite ou en bas).
function devToolsLayout(rect) {
  const bottom = settings.devToolsDock === 'bottom';
  const total = bottom ? rect.height : rect.width;
  const wanted = bottom ? settings.devToolsHeight : settings.devToolsWidth;
  // La page garde toujours une zone visible, les outils aussi.
  const size = Math.max(0, Math.min(Math.max(DEVTOOLS_MIN, wanted), total - DEVTOOLS_MIN - DEVTOOLS_GRIP));
  const grip = Math.min(DEVTOOLS_GRIP, Math.max(0, total - size));
  const page = Math.max(0, total - size - grip);
  return bottom ? {
    page: { x: rect.x, y: rect.y, width: rect.width, height: page },
    grip: { x: rect.x, y: rect.y + page, width: rect.width, height: grip },
    dev:  { x: rect.x, y: rect.y + page + grip, width: rect.width, height: size },
  } : {
    page: { x: rect.x, y: rect.y, width: page, height: rect.height },
    grip: { x: rect.x + page, y: rect.y, width: grip, height: rect.height },
    dev:  { x: rect.x + page + grip, y: rect.y, width: size, height: rect.height },
  };
}
function placeTab(t, rect) {
  const d = t.dev;
  if (!d) { t.view.setBounds(rect); t.view.setVisible(true); return; }
  d.rect = rect;
  const parts = devToolsLayout(rect);
  t.view.setBounds(parts.page);
  d.grip.setBounds(parts.grip);
  d.view.setBounds(parts.dev);
  t.view.setVisible(true);
  d.grip.setVisible(true);
  d.view.setVisible(true);
}

// Les vues d'interface restent au-dessus des onglets et de leurs outils.
function raiseOverlays() {
  if (!mainWin) return;
  if (chromeView) { mainWin.contentView.addChildView(chromeView); }
  if (panelView && panelOpen) { mainWin.contentView.addChildView(panelView); }
  if (aiPanelView && aiPanelOpen) { mainWin.contentView.addChildView(aiPanelView); }
  if (findView) { mainWin.contentView.addChildView(findView); }
}

function disposeDevTools(tab) {
  const d = tab && tab.dev;
  if (!d) return;
  tab.dev = null;
  for (const v of [d.view, d.grip]) {
    try { if (mainWin) mainWin.contentView.removeChildView(v); } catch {}
    try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch {}
  }
}

// inspectAt : { x, y } pour « Inspecter » (sélectionne l'élément sous le curseur).
function openDevToolsFor(tab, inspectAt) {
  if (!tab || !mainWin) return;
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return;
  const inspect = () => { if (inspectAt) { try { wc.inspectElement(inspectAt.x, inspectAt.y); } catch {} } };

  if (settings.devToolsDock === 'window') {
    if (tab.dev) { wc.once('devtools-closed', () => openDevToolsFor(tab, inspectAt)); wc.closeDevTools(); return; }
    if (inspectAt) inspect(); else wc.openDevTools({ mode: 'detach' });
    return;
  }
  if (tab.dev) { inspect(); try { tab.dev.view.webContents.focus(); } catch {} return; }
  // Des outils ouverts en fenêtre séparée doivent d'abord être fermés : leur
  // vue d'accueil ne peut être définie qu'avant l'ouverture.
  if (wc.isDevToolsOpened()) { wc.once('devtools-closed', () => openDevToolsFor(tab, inspectAt)); wc.closeDevTools(); return; }

  const view = new WebContentsView();
  const grip = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  lockInternalView(grip.webContents, DEVGRIP_URL);
  grip.webContents.loadURL(DEVGRIP_URL + '?theme=' + (settings.theme === 'dark' ? 'dark' : 'light'));
  // F12 referme les outils même quand le clavier est dans les DevTools.
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !input.control && !input.alt && !input.meta) {
      event.preventDefault();
      closeDevToolsFor(tab);
    }
  });
  tab.dev = { view, grip, rect: null };
  try {
    wc.setDevToolsWebContents(view.webContents);
    mainWin.contentView.addChildView(view);
    mainWin.contentView.addChildView(grip);
    raiseOverlays();
    wc.openDevTools({ mode: 'detach' });
  } catch {
    disposeDevTools(tab);
    try { wc.openDevTools({ mode: 'detach' }); } catch {}
    return;
  }
  layoutAll();
  inspect();
}

function closeDevToolsFor(tab) {
  if (!tab) return;
  const wc = tab.view.webContents;
  // « devtools-closed » retire la zone ancrée ; le retrait direct ne sert que
  // de filet si les outils n'étaient plus ouverts.
  // (isDevToolsOpened() vaut toujours false pour des outils ancrés dans une
  // vue fournie par l'application : on se fie à tab.dev.)
  const docked = tab.dev;
  try { if (!wc.isDestroyed() && (docked || wc.isDevToolsOpened())) wc.closeDevTools(); } catch {}
  if (docked) setTimeout(() => { if (tab.dev === docked) { disposeDevTools(tab); layoutAll(); } }, 500);
  try { if (!wc.isDestroyed() && tab === activeTab()) wc.focus(); } catch {}
}

function devToolsShown(tab) {
  if (!tab) return false;
  try { return !!tab.dev || tab.view.webContents.isDevToolsOpened(); } catch { return false; }
}

function setDevToolsDock(mode, tab) {
  if (!['right', 'bottom', 'window'].includes(mode)) return;
  const previous = settings.devToolsDock;
  settings.devToolsDock = mode;
  saveSettings();
  if (mode === 'window' || previous === 'window') { if (tab) openDevToolsFor(tab); }
  layoutAll();
}

function tabOfDevGrip(sender) {
  return tabs.find(t => t.dev && t.dev.grip.webContents === sender) || null;
}

// La poignée ne transmet que « je bouge » : la position vient du curseur
// système, fiable quel que soit le facteur d'échelle de l'écran.
function dragDevGrip(tab) {
  if (!tab || !tab.dev || !tab.dev.rect || !mainWin) return;
  const rect = tab.dev.rect;
  const origin = mainWin.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  if (settings.devToolsDock === 'bottom') {
    const max = Math.max(DEVTOOLS_MIN, rect.height - DEVTOOLS_MIN - DEVTOOLS_GRIP);
    settings.devToolsHeight = Math.round(Math.max(DEVTOOLS_MIN, Math.min(max, origin.y + rect.y + rect.height - cursor.y)));
  } else {
    const max = Math.max(DEVTOOLS_MIN, rect.width - DEVTOOLS_MIN - DEVTOOLS_GRIP);
    settings.devToolsWidth = Math.round(Math.max(DEVTOOLS_MIN, Math.min(max, origin.x + rect.x + rect.width - cursor.x)));
  }
  layoutAll();
}

function showDevGripMenu(tab) {
  if (!tab) return;
  const dock = settings.devToolsDock;
  Menu.buildFromTemplate([
    { label: 'Ancrer à droite', type: 'radio', checked: dock === 'right', click: () => setDevToolsDock('right', tab) },
    { label: 'Ancrer en bas', type: 'radio', checked: dock === 'bottom', click: () => setDevToolsDock('bottom', tab) },
    { label: 'Ouvrir dans une fenêtre séparée', type: 'radio', checked: dock === 'window', click: () => setDevToolsDock('window', tab) },
    { type: 'separator' },
    { label: 'Fermer les outils de développement', accelerator: 'F12', registerAccelerator: false, click: () => closeDevToolsFor(tab) },
  ]).popup({ window: mainWin || undefined });
}

// Le panneau de réglages est une surcouche : son animation ne doit jamais
// relancer le layout ni le repaint des onglets web situés derrière.
function layoutPanel() {
  if (!mainWin || !panelView) return;
  if (!panelOpen && !panelViewVisible) return;

  const [w, h] = mainWin.getContentSize();
  const panelTop = 94;
  const bounds = {
    x: Math.max(0, w - PANEL_WIDTH),
    y: panelTop,
    width: PANEL_WIDTH,
    height: Math.max(0, h - panelTop),
  };
  const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  if (key !== panelBoundsKey) {
    panelView.setBounds(bounds);
    panelBoundsKey = key;
    panelBoundsUpdates++;
  }
  if (panelOpen && !panelViewVisible) {
    panelView.setVisible(true);
    panelViewVisible = true;
  }
}

// ----- État -> chrome / panel -----------------------------------------------

function pushState() {
  if (!chromeView) return;
  const a = activeTab();
  const activeUrl   = a ? a.view.webContents.getURL()   : '';
  const activeTitle = a ? a.view.webContents.getTitle() : '';
  const canBack = a ? a.view.webContents.navigationHistory.canGoBack() : false;
  const canFwd  = a ? a.view.webContents.navigationHistory.canGoForward() : false;
  const marked = !isInternal(activeUrl) && bookmarks.some(b => b.url === activeUrl);

  const msg = {
    type: 'state',
    theme: settings.theme,
    searchEngine: settings.searchEngine,
    offline: settings.offline,
    showBookmarks: settings.showBookmarks,
    tabs: tabs.map((t, i) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || '',
      url:   t.view.webContents.getURL()   || '',
      active: i === active,
      pinned: !!t.pinned,
      incognito: !!t.incognito,
      ...featureTabState(t),
    })),
    incognito: !!(a && a.incognito),
    active: {
      url: activeUrl,
      title: activeTitle,
      canBack,
      canForward: canFwd,
      loading: !!(a && a.loading),
      isBookmarked: marked,
    },
    bookmarks: bookmarks.map(b => ({ url: b.url, title: b.title })),
    split: splitPair ? splitPair.slice() : null,
    profile: {
      currentId: currentProfileId,
      current: currentProfile()
        ? (({ id, name, color, photo }) => ({ id, name, color, photo }))(currentProfile())
        : null,
      list: profiles.map(p => ({ id: p.id, name: p.name, color: p.color, photo: p.photo })),
    },
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    aiConnected: ideStatus === 'connected',
    aiConnectEnabled: settings.aiConnectEnabled,
    aiMode: aiSearchOn,
    launcherMode,
    launcherApps: launcherApps.map(a => ({ url: a.url, title: a.title })),
    launcherWork: WORK_APPS,
    panelOpen,
    aiPanelOpen,
  };
  Object.assign(msg, featureState('chrome'));
  chromeView.webContents.send('zaalis:message', msg);
}

function pushPanelState() {
  if (!panelView) return;
  panelView.webContents.send('zaalis:message', {
    ...featureState('panel'),
    type: 'state',
    theme: settings.theme,
    searchEngine: settings.searchEngine,
    offline: settings.offline,
    showBookmarks: settings.showBookmarks,
    historyEnabled: settings.historyEnabled,
    blockPopups: settings.blockPopups,
    contextMenus: settings.contextMenus,
    devTools: settings.devTools,
    statusBar: settings.statusBar,
    zoomControls: settings.zoomControls,
    restoreTabs: settings.restoreTabs,
    safeSearch: settings.safeSearch,
    httpsOnly: settings.httpsOnly,
    safeBrowsing: settings.safeBrowsing,
    aiProvider: settings.aiProvider,
    aiSubmodel: settings.aiSubmodel,
    voiceProvider: settings.voiceProvider,
    voiceSubmodel: settings.voiceSubmodel,
    aiOverview: settings.aiOverview,
    aiProviders: aiProvidersSnapshot(),
    aiProviderGroups: AI_PROVIDER_GROUPS,
    aiModelLabels: AI_MODEL_LABELS,
    aiConnectEnabled: settings.aiConnectEnabled,
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    zoomPct: settings.zoomPct,
    historyCount: history.length,
    downloadCount: downloads.length,
    bookmarkCount: bookmarks.length,
    profile: {
      currentId: currentProfileId,
      current: currentProfile()
        ? (({ id, name, color, photo }) => ({ id, name, color, photo }))(currentProfile())
        : null,
      list: profiles.map(p => ({ id: p.id, name: p.name, color: p.color, photo: p.photo })),
    },
  });
}

function pushShortcuts() {
  const msg = { type: 'shortcuts', items: shortcuts.map(s => ({ url: s.url, title: s.title })) };
  for (const t of tabs) {
    const u = t.view.webContents.getURL();
    if (isInternal(u)) t.view.webContents.send('zaalis:message', msg);
  }
}

// Diffuse l'etat du mode recherche IA a la barre d'adresse (chrome) et aux
// pages d'accueil : les deux barres allument leur degrade en meme temps.
function pushAiMode() {
  const msg = { type: 'aiMode', on: aiSearchOn };
  if (chromeView) chromeView.webContents.send('zaalis:message', msg);
  for (const t of tabs) {
    const u = t.view.webContents.getURL();
    if (isInternal(u)) t.view.webContents.send('zaalis:message', msg);
  }
}

// Diffuse l'etat de la connexion IA aux pages internes (accueil, recherche IA).
function pushAiStatusToTabs() {
  const msg = {
    type: 'aiStatus', connected: ideStatus === 'connected',
    status: ideStatus, message: ideStatusMessage,
  };
  for (const t of tabs) {
    const u = t.view.webContents.getURL();
    if (isInternal(u)) t.view.webContents.send('zaalis:message', msg);
  }
}

function sendPanelHistory() {
  if (!panelView) return;
  const items = [];
  for (let i = history.length - 1; i >= 0; i--) items.push({ url: history[i].url, title: history[i].title });
  panelView.webContents.send('zaalis:message', { type: 'history', items });
}

// ----- Telechargements ------------------------------------------------------
// Les fichiers partent directement dans ~/Telechargements (pas de boite de
// dialogue, comme Chrome). Chaque element vit dans `downloads` (le plus recent
// en tete) ; tant qu'il progresse, son DownloadItem est garde dans
// `liveDownloads` pour pouvoir l'annuler.

const DOWNLOAD_KEEP = 60;         // elements termines conserves sur disque
let downloads = [];               // { id, name, path, url, state, received, total, icon, startedAt }
const liveDownloads = new Map();  // id -> DownloadItem (uniquement en cours)
let downloadSeq = 0;
let downloadsPushTimer = null;

function downloadsFile() { return path.join(profileDataDir(), 'downloads.json'); }

function loadDownloads() {
  downloads = [];
  try {
    const d = JSON.parse(sealRead(downloadsFile()));
    if (Array.isArray(d)) downloads = d.filter(x => x && x.id && x.name).slice(0, DOWNLOAD_KEEP);
  } catch {}
  // Anciennes entrees sans icone (ou fichier remplace) : on la relit du systeme.
  downloads.forEach(d => { if (!d.icon && d.path && fs.existsSync(d.path)) attachFileIcon(d); });
}

function saveDownloads() {
  // On ne persiste que les elements termines : un telechargement en cours n'a
  // aucun sens apres un redemarrage.
  const done = downloads.filter(d => d.state !== 'progressing').slice(0, DOWNLOAD_KEEP);
  try { sealWrite(downloadsFile(), JSON.stringify(done)); } catch {}
}

function downloadsPayload() {
  return downloads.map(d => ({
    id: d.id, name: d.name, path: d.path, url: d.url, state: d.state,
    received: d.received, total: d.total, icon: d.icon || '', startedAt: d.startedAt,
  }));
}

function pushDownloads() {
  const msg = { type: 'downloads', items: downloadsPayload() };
  if (chromeView) chromeView.webContents.send('zaalis:message', msg);
  if (panelView)  panelView.webContents.send('zaalis:message', msg);
}

// Les evenements `updated` arrivent tres souvent : on regroupe les envois.
function scheduleDownloadsPush() {
  if (downloadsPushTimer) return;
  downloadsPushTimer = setTimeout(() => { downloadsPushTimer = null; pushDownloads(); }, 120);
}

// Chemins déjà attribués à un téléchargement en cours : Chromium n'écrit le
// fichier final qu'à la fin (.crdownload avant), donc deux fichiers homonymes
// lancés ensemble recevraient sinon le même chemin et s'écraseraient.
const reservedDownloadPaths = new Set();
// URL pour lesquelles l'utilisateur a demandé « Enregistrer sous… ».
const saveAsRequests = new Set();

// Caractères interdits par Windows dans un nom de fichier (et noms réservés).
function safeDownloadName(filename) {
  // Pas de path.basename : sous Windows, « a:b.txt » serait lu comme un lecteur.
  let name = String(filename || '').replace(/[\\/]/g, '_');
  name = name.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\s+|[. ]+$/g, '').slice(0, 200);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name;
  return name || 'telechargement';
}

// Telechargements/nom.zip -> nom (1).zip si le fichier existe deja (comme Chrome).
function uniqueDownloadPath(dir, filename) {
  filename = safeDownloadName(filename);
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  const taken = p => fs.existsSync(p) || reservedDownloadPaths.has(p.toLowerCase());
  let p = path.join(dir, filename);
  for (let i = 1; taken(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// Icone systeme du fichier (celle du Finder), en dataURL pour la webview.
function attachFileIcon(entry) {
  if (!entry.path) return;
  app.getFileIcon(entry.path, { size: 'normal' })
    .then(img => {
      if (!img || img.isEmpty()) return;
      entry.icon = img.toDataURL();
      // L'icone arrive apres coup : on reecrit le fichier pour la conserver.
      if (entry.state !== 'progressing') saveDownloads();
      scheduleDownloadsPush();
    })
    .catch(() => {});
}

function downloadById(id) { return downloads.find(d => d.id === id) || null; }

function attachDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    const id = 'd' + Date.now() + '-' + (++downloadSeq);
    const dir = app.getPath('downloads');
    const itemUrl = item.getURL();
    const askWhere = saveAsRequests.delete(itemUrl);
    let savePath = '';
    try {
      fs.mkdirSync(dir, { recursive: true });
      savePath = uniqueDownloadPath(dir, item.getFilename());
      if (askWhere) {
        // « Enregistrer sous… » : boîte de dialogue native, comme Chrome.
        item.setSaveDialogOptions({ defaultPath: savePath, title: 'Enregistrer sous' });
        savePath = '';
      } else {
        item.setSavePath(savePath);
      }
    } catch { savePath = ''; }
    if (savePath) reservedDownloadPaths.add(savePath.toLowerCase());

    const entry = {
      id,
      name: savePath ? path.basename(savePath) : safeDownloadName(item.getFilename()),
      path: savePath,
      url: itemUrl,
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes() || 0,
      icon: '',
      startedAt: Date.now(),
    };
    downloads.unshift(entry);
    liveDownloads.set(id, item);
    pushDownloads();

    // Avec « Enregistrer sous… », le chemin n'est connu qu'après la boîte.
    const syncPath = () => {
      const p = item.getSavePath();
      if (p && p !== entry.path) { entry.path = p; entry.name = path.basename(p); }
    };

    item.on('updated', (__e, state) => {
      syncPath();
      entry.received = item.getReceivedBytes();
      entry.total    = item.getTotalBytes() || entry.total;
      entry.state    = state === 'interrupted' ? 'interrupted' : 'progressing';
      if (!entry.icon) attachFileIcon(entry);
      scheduleDownloadsPush();
    });

    item.once('done', (__e, state) => {
      syncPath();
      liveDownloads.delete(id);
      if (savePath) reservedDownloadPaths.delete(savePath.toLowerCase());
      entry.received = item.getReceivedBytes();
      entry.total    = item.getTotalBytes() || entry.received;
      entry.state    = state === 'completed' ? 'completed'
                     : state === 'cancelled' ? 'cancelled' : 'interrupted';
      if (entry.state === 'completed') attachFileIcon(entry);
      // Boîte « Enregistrer sous » annulée : rien n'a été téléchargé.
      if (entry.state === 'cancelled' && askWhere && !entry.path) downloads = downloads.filter(d => d !== entry);
      saveDownloads();
      pushDownloads();
    });
  });
}

// Reprend un téléchargement interrompu (réseau coupé…) ou le relance depuis
// son URL s'il ne peut plus être repris, comme le bouton « Reprendre » de Chrome.
function resumeDownload(id) {
  const item = liveDownloads.get(id);
  if (item) {
    try { if (item.canResume()) { item.resume(); return; } } catch {}
  }
  const d = downloadById(id);
  if (!d || !/^https?:/i.test(d.url || '') || d.state === 'progressing') return;
  downloads = downloads.filter(x => x.id !== id);
  const t = activeTab();
  const ses = t ? t.view.webContents.session : session.fromPartition(browserPartition());
  try { ses.downloadURL(d.url); } catch {}
  saveDownloads();
  pushDownloads();
}

/* =============================================================================
 *  Sessions : isolation par profil + navigation privée + permissions par site
 * ========================================================================== */

const INCOGNITO_PARTITION = 'zaalis-incognito';   // pas de "persist:" => éphémère
const readyPartitions = new Set();

// Partition de la session pour l'onglet courant : chaque profil est réellement
// isolé (cookies/stockage séparés). L'invité garde la session historique.
function browserPartition() {
  return currentProfileId ? ('persist:zaalis-profile-' + currentProfileId)
                          : 'persist:zaalis-browser';
}

// Prépare une session (protocole zaalis://, téléchargements, permissions) une
// seule fois par partition. Idempotent : sûr à rappeler.
function setupSession(partition) {
  const ses = session.fromPartition(partition);
  if (readyPartitions.has(partition)) return ses;
  readyPartitions.add(partition);
  try { ses.protocol.handle('zaalis', zaalisProtocolHandler); } catch {}
  try { ses.setUserAgent(chromeUserAgent()); } catch {}
  attachDownloads(ses);
  attachPermissions(ses, partition);
  attachDisplayCapture(ses, partition);
  attachDeviceChoosers(ses);
  runFeatureHooks('session', ses, partition);
  return ses;
}

// Écrit sur disque les cookies et le stockage des sessions ouvertes (fermeture
// de l'application) : aucune connexion n'est perdue, rien ne reste en attente.
function flushSessions() {
  for (const partition of readyPartitions) {
    if (partition === INCOGNITO_PARTITION) continue;   // jamais persistée
    try {
      const ses = session.fromPartition(partition);
      ses.cookies.flushStore().catch(() => {});
      ses.flushStorageData();
    } catch {}
  }
}

// DNS chiffré (DNS-over-HTTPS), comme le « DNS sécurisé » de Chrome : les noms
// des sites visités ne circulent plus en clair sur le réseau local et un DNS
// de box défaillant ou filtrant n'empêche plus d'ouvrir un site. Mode
// automatique : en cas d'échec, Chromium retombe sur le DNS du système (noms
// internes d'entreprise, portails captifs…).
function configureSecureDns() {
  try {
    app.configureHostResolver({
      secureDnsMode: 'automatic',
      secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'],
    });
  } catch {}
}

// ----- Permissions par site (caméra, micro, géoloc, notifications…) ---------
// Même modèle que Chrome : les autorisations sans risque sont accordées
// d'office, les autres ouvrent une demande « Bloquer / Autoriser » dont le
// choix peut être mémorisé par profil + origine (permissions.json). Sans
// mémorisation, l'accord vaut pour la session (« autoriser cette fois »).
// La navigation privée ne garde ses choix qu'en mémoire.
let sitePermissions = {};        // "partition|origin|permission" -> allow|deny

// Accordées d'office, comme dans Chrome : plein écran, verrouillage du pointeur
// et du clavier (jeux, visio), écriture dans le presse-papiers, contenu protégé
// (Widevine : Prime Video, Netflix, Disney+…), choix de la sortie audio et
// accès au stockage tiers (les cookies tiers restent autorisés, comme Chrome).
const AUTO_GRANTED_PERMISSIONS = new Set([
  'fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write',
  'mediaKeySystem', 'speaker-selection', 'storage-access', 'top-level-storage-access',
]);

const PERMISSION_LABELS = {
  camera: 'utiliser votre caméra',
  microphone: 'utiliser votre micro',
  geolocation: 'connaître votre position',
  notifications: 'afficher des notifications',
  midi: 'accéder à vos appareils MIDI',
  midiSysex: 'contrôler et reprogrammer vos appareils MIDI',
  'clipboard-read': 'voir le texte et les images copiés dans le presse-papiers',
  'idle-detection': 'savoir quand vous utilisez activement cet appareil',
  'window-management': 'gérer les fenêtres sur tous vos écrans',
};

// Libellés courts du popup « informations du site » (barre d'adresse).
const PERMISSION_NAMES = {
  camera: 'Caméra', microphone: 'Micro', media: 'Caméra et micro',
  geolocation: 'Position', notifications: 'Notifications', midi: 'Appareils MIDI',
  midiSysex: 'Appareils MIDI (SysEx)', 'clipboard-read': 'Presse-papiers',
  'idle-detection': 'Détection d\'inactivité', 'window-management': 'Gestion des fenêtres',
};
function permissionDisplayName(name) {
  if (name.startsWith('openExternal:')) return 'Ouvrir les liens « ' + name.slice(13) + ': »';
  return PERMISSION_NAMES[name] || name;
}

function permissionsFile() { return path.join(dataFolder, 'permissions.json'); }
function loadSitePermissions() {
  try { const d = JSON.parse(sealRead(permissionsFile())); sitePermissions = (d && typeof d === 'object') ? d : {}; }
  catch { sitePermissions = {}; }
}
function saveSitePermissions() {
  try { sealWrite(permissionsFile(), JSON.stringify(sitePermissions)); } catch {}
}
function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }
function hostOf(u) { try { return new URL(u).host || String(u); } catch { return String(u || ''); } }

// Contexte de décisions d'une partition (profil, invité ou navigation privée).
const permissionContexts = new Map();
function permissionContext(partition) {
  let ctx = permissionContexts.get(partition);
  if (ctx) return ctx;
  const ephemeral = partition === INCOGNITO_PARTITION;
  const privateStore = Object.create(null);
  const onceGrants = new Set();                 // « autoriser cette fois »
  const store = () => (ephemeral ? privateStore : sitePermissions);
  const key = (origin, name) => partition + '|' + origin + '|' + name;
  ctx = {
    partition, ephemeral,
    pending: new Map(),                         // demandes identiques regroupées
    decision(origin, name) {
      const s = store();
      const v = s[key(origin, name)];
      if (v === 'allow' || v === 'deny') return v;
      // Anciennes décisions « media » : valent pour la caméra et le micro.
      if (name === 'camera' || name === 'microphone') {
        const legacy = s[key(origin, 'media')];
        if (legacy === 'allow' || legacy === 'deny') return legacy;
      }
      return onceGrants.has(key(origin, name)) ? 'allow' : '';
    },
    record(origin, name, allow, remember) {
      if (remember) {
        store()[key(origin, name)] = allow ? 'allow' : 'deny';
        if (!ephemeral) saveSitePermissions();
      } else if (allow) {
        onceGrants.add(key(origin, name));
      }
    },
    forgetOnce(origin) {
      if (!origin) { onceGrants.clear(); return; }
      for (const k of [...onceGrants]) if (k.startsWith(partition + '|' + origin + '|')) onceGrants.delete(k);
    },
  };
  permissionContexts.set(partition, ctx);
  return ctx;
}

function isInternalOrigin(origin) { return String(origin || '').startsWith('zaalis://'); }

// Boîte de dialogue native d'autorisation. Les demandes identiques arrivées
// pendant qu'elle est ouverte reçoivent la même réponse (au lieu d'un refus).
// opts.session : l'accord ne vaut que pour la session (jamais mémorisé).
function askPermission(ctx, origin, names, what, opts) {
  opts = opts || {};
  const id = origin + '|' + names.join('+');
  if (ctx.pending.has(id)) return ctx.pending.get(id);
  const canRemember = !ctx.ephemeral && !opts.session;
  const p = (async () => {
    if (!mainWin) return false;
    let r;
    try {
      r = await dialog.showMessageBox(mainWin, {
        type: 'question',
        title: 'zaalis Browser',
        buttons: ['Bloquer', 'Autoriser'],
        defaultId: 1, cancelId: 0, noLink: true,
        message: hostOf(origin) + ' souhaite ' + what + '.',
        detail: opts.detail || 'Vous pourrez modifier ce choix depuis l\'icône située à gauche de l\'adresse.',
        checkboxLabel: canRemember ? 'Mémoriser ce choix pour ce site' : undefined,
        checkboxChecked: canRemember,
      });
    } catch { return false; }
    const allow = r.response === 1;
    const remember = canRemember && !!r.checkboxChecked;
    for (const n of names) ctx.record(origin, n, allow, remember);
    return allow;
  })();
  ctx.pending.set(id, p);
  p.finally(() => ctx.pending.delete(id));
  return p;
}

function mediaPermissionNames(types) {
  const names = [];
  if (types && types.includes('video')) names.push('camera');
  if (types && types.includes('audio')) names.push('microphone');
  return names.length ? names : ['camera', 'microphone'];
}

function joinLabels(names) {
  if (names.length === 2 && names.includes('camera') && names.includes('microphone')) return 'utiliser votre caméra et votre micro';
  return names.map(n => PERMISSION_LABELS[n] || ('utiliser : ' + n)).join(' et ');
}

// ----- Liens vers des applications (mailto:, tel:, zoommtg:, msteams:…) -----
// Chrome les confie au système après confirmation. Les schémas gérés par le
// navigateur lui-même ne sortent jamais ; ceux connus pour être dangereux
// (shell:, ms-msdt:, search-ms:…) sont refusés comme dans Chrome.
const BROWSER_SCHEMES = new Set([
  'http', 'https', 'about', 'blob', 'data', 'file', 'filesystem', 'javascript',
  'zaalis', 'chrome', 'chrome-extension', 'devtools', 'view-source', 'ws', 'wss', 'ftp',
]);
const BLOCKED_EXTERNAL_SCHEMES = new Set([
  'afp', 'disk', 'disks', 'hcp', 'ie.http', 'ms-help', 'nntp', 'res', 'shell',
  'vbscript', 'vnd.ms.radio', 'ms-msdt', 'search-ms', 'search', 'ms-officecmd',
  'ms-cxh', 'ms-cxh-full', 'its', 'mk', 'ms-its', 'mhtml', 'cdl',
]);
function urlScheme(u) {
  const m = /^([a-z][a-z0-9+.\-]*):/i.exec(String(u || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function isExternalAppUrl(u) {
  const s = urlScheme(u);
  return !!s && !BROWSER_SCHEMES.has(s);
}

function confirmOpenExternal(ctx, origin, externalUrl) {
  const scheme = urlScheme(externalUrl);
  if (!scheme || BROWSER_SCHEMES.has(scheme) || BLOCKED_EXTERNAL_SCHEMES.has(scheme)) return Promise.resolve(false);
  const name = 'openExternal:' + scheme;
  const prior = origin ? ctx.decision(origin, name) : '';
  if (prior === 'allow') return Promise.resolve(true);
  if (prior === 'deny') return Promise.resolve(false);
  if (!mainWin) return Promise.resolve(false);
  const id = origin + '|' + name;
  if (ctx.pending.has(id)) return ctx.pending.get(id);
  const p = (async () => {
    let r;
    try {
      r = await dialog.showMessageBox(mainWin, {
        type: 'question',
        title: 'zaalis Browser',
        buttons: ['Annuler', 'Ouvrir'],
        defaultId: 1, cancelId: 0, noLink: true,
        message: 'Ouvrir l\'application associée aux liens « ' + scheme + ': » ?',
        detail: (origin ? hostOf(origin) + ' souhaite ouvrir cette application.\n' : '') +
                String(externalUrl).slice(0, 200),
        checkboxLabel: origin && !ctx.ephemeral
          ? 'Toujours autoriser ' + hostOf(origin) + ' à ouvrir ce type de lien' : undefined,
        checkboxChecked: false,
      });
    } catch { return false; }
    const allow = r.response === 1;
    if (allow && r.checkboxChecked && origin) ctx.record(origin, name, true, true);
    return allow;
  })();
  ctx.pending.set(id, p);
  p.finally(() => ctx.pending.delete(id));
  return p;
}

// Ouvre un lien d'application après confirmation (clic sur mailto:, etc.).
function openExternalFromPage(wc, partition, targetUrl) {
  const origin = originOf(wc && !wc.isDestroyed() ? wc.getURL() : '') || '';
  confirmOpenExternal(permissionContext(partition), origin, targetUrl).then(ok => {
    if (ok) shell.openExternal(targetUrl).catch(() => {});
  });
}

function attachPermissions(ses, partition) {
  const ctx = permissionContext(partition);
  const isLocal = o => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o);

  // Vérification synchrone (enumerateDevices, Notification.permission…).
  // Le micro des pages internes (zaalis://home) sert au mode vocal : c'est
  // notre propre UI, pas un site — accord direct, sans dialogue site web.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '') || String(requestingOrigin || '');
    if (isInternalOrigin(origin)) return permission === 'media' || AUTO_GRANTED_PERMISSIONS.has(permission);
    if (AUTO_GRANTED_PERMISSIONS.has(permission)) return true;
    // WebHID / WebSerial / WebUSB : le sélecteur d'appareil fait office de
    // consentement (comme Chrome), réservé aux contextes sécurisés.
    if (permission === 'hid' || permission === 'serial' || permission === 'usb') {
      return /^https:/i.test(origin) || isLocal(origin);
    }
    if (permission === 'media') {
      const t = details && details.mediaType;
      const names = t === 'audio' ? ['microphone'] : t === 'video' ? ['camera'] : ['camera', 'microphone'];
      return names.every(n => ctx.decision(origin, n) === 'allow');
    }
    return ctx.decision(origin, permission) === 'allow';
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    details = details || {};
    const origin = originOf(details.requestingUrl || '') || '';
    let answered = false;
    const done = ok => { if (answered) return; answered = true; try { callback(!!ok); } catch {} };

    if (isInternalOrigin(origin)) return done(permission === 'media' || AUTO_GRANTED_PERMISSIONS.has(permission));
    if (AUTO_GRANTED_PERMISSIONS.has(permission)) return done(true);
    if (permission === 'openExternal') {
      confirmOpenExternal(ctx, origin, details.externalURL).then(done, () => done(false));
      return;
    }
    // display-capture est arbitré par le sélecteur (setDisplayMediaRequestHandler).
    if (permission === 'display-capture') return done(true);
    if (permission === 'unknown' || !origin || !/^https?:/i.test(origin)) return done(false);
    // Comme Chrome : pas de notifications en navigation privée.
    if (permission === 'notifications' && ctx.ephemeral) return done(false);

    if (permission === 'fileSystem') {
      // Un fichier choisi dans le sélecteur est lisible d'office ; modifier un
      // fichier ou parcourir un dossier demande confirmation (pour la session).
      if (details.fileAccessType !== 'writable' && !details.isDirectory) return done(true);
      const target = details.filePath ? path.basename(details.filePath) : 'ce fichier';
      const writable = details.fileAccessType === 'writable';
      const name = 'fileSystem:' + (writable ? 'write:' : 'read:') + (details.filePath || '');
      if (ctx.decision(origin, name) === 'allow') return done(true);
      const what = writable
        ? (details.isDirectory ? 'modifier les fichiers du dossier « ' + target + ' »'
                               : 'enregistrer les modifications dans « ' + target + ' »')
        : 'afficher les fichiers du dossier « ' + target + ' »';
      askPermission(ctx, origin, [name], what, { session: true, detail: details.filePath || '' })
        .then(done, () => done(false));
      return;
    }

    const names = permission === 'media' ? mediaPermissionNames(details.mediaTypes) : [permission];
    if (names.some(n => ctx.decision(origin, n) === 'deny')) return done(false);
    const missing = names.filter(n => ctx.decision(origin, n) !== 'allow');
    if (!missing.length) return done(true);
    askPermission(ctx, origin, missing, joinLabels(missing)).then(done, () => done(false));
  });
}

// ----- Partage d'écran (getDisplayMedia : Meet, Teams, Discord…) -----------
// Sans ce gestionnaire, Electron refuse tout partage d'écran. Comme Chrome, on
// propose l'écran entier, une fenêtre ou un onglet, avec l'audio du système.
function attachDisplayCapture(ses, partition) {
  ses.setDisplayMediaRequestHandler((request, callback) => {
    let answered = false;
    const reply = s => { if (answered) return; answered = true; try { callback(s || null); } catch {} };
    pickDisplaySource(request, partition).then(reply, () => reply(null));
  });
}

async function pickDisplaySource(request, partition) {
  if (!mainWin || !request.videoRequested) return null;
  const origin = request.securityOrigin || (request.frame && request.frame.url) || '';
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  } catch {}
  const screens = sources.filter(s => s.id.startsWith('screen:'));
  const windows = sources.filter(s => s.id.startsWith('window:') && s.name).slice(0, 10);
  const incognito = partition === INCOGNITO_PARTITION;
  const shareableTabs = tabs.filter(t => !!t.incognito === incognito &&
    isWebPageUrl(t.view.webContents.getURL()) &&
    (!request.frame || t.view.webContents.mainFrame !== request.frame)).slice(0, 8);

  const choices = [];
  screens.forEach((s, i) => choices.push({
    label: screens.length > 1 ? 'Écran entier ' + (i + 1) : 'Écran entier', video: s,
  }));
  windows.forEach(s => choices.push({ label: 'Fenêtre : ' + s.name.slice(0, 80), video: s }));
  shareableTabs.forEach(t => choices.push({
    label: 'Onglet : ' + (t.view.webContents.getTitle() || t.view.webContents.getURL()).slice(0, 80),
    frame: t.view.webContents.mainFrame,
  }));
  if (!choices.length) return null;

  const withAudio = request.audioRequested && process.platform !== 'darwin';
  const r = await dialog.showMessageBox(mainWin, {
    type: 'none',
    title: 'zaalis Browser',
    message: origin ? hostOf(origin) + ' souhaite partager le contenu de votre écran.' : 'Partager votre écran',
    detail: 'Choisissez ce que vous voulez partager :',
    buttons: [...choices.map(c => c.label), 'Annuler'],
    cancelId: choices.length, defaultId: 0, noLink: false,
    checkboxLabel: withAudio ? 'Partager aussi l\'audio' : undefined,
    checkboxChecked: withAudio,
  });
  const c = choices[r.response];
  if (!c) return null;
  const audio = withAudio && r.checkboxChecked;
  if (c.frame) {
    if (c.frame.isDestroyed && c.frame.isDestroyed()) return null;
    return audio ? { video: c.frame, audio: c.frame } : { video: c.frame };
  }
  return audio ? { video: c.video, audio: 'loopback' } : { video: c.video };
}

// ----- Sélecteurs d'appareils (Bluetooth, HID, USB, série, clés FIDO) -------
// Comme Chrome, le site ne voit un appareil que si l'utilisateur le choisit.
// Electron choisirait sinon automatiquement le premier appareil Bluetooth.
async function chooseFromList(message, items) {
  if (!mainWin) return null;
  if (!items.length) {
    dialog.showMessageBox(mainWin, {
      type: 'info', title: 'zaalis Browser', message,
      detail: 'Aucun appareil compatible n\'a été trouvé.', buttons: ['OK'],
    }).catch(() => {});
    return null;
  }
  const shown = items.slice(0, 12);
  try {
    const r = await dialog.showMessageBox(mainWin, {
      type: 'none', title: 'zaalis Browser', message,
      buttons: [...shown.map(i => i.label), 'Annuler'],
      cancelId: shown.length, defaultId: 0, noLink: false,
    });
    return shown[r.response] ? shown[r.response].id : null;
  } catch { return null; }
}

function frameHost(frame) {
  try { return frame && frame.url ? hostOf(frame.url) : 'Ce site'; } catch { return 'Ce site'; }
}

function attachDeviceChoosers(ses) {
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const items = (details.deviceList || []).map(d => ({ id: d.deviceId, label: d.name || ('Appareil HID ' + d.vendorId + ':' + d.productId) }));
    chooseFromList(frameHost(details.frame) + ' souhaite se connecter à un appareil HID', items)
      .then(id => { try { id ? callback(id) : callback(); } catch {} });
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const items = (details.deviceList || []).map(d => ({ id: d.deviceId, label: d.productName || d.manufacturerName || ('Appareil USB ' + d.vendorId + ':' + d.productId) }));
    chooseFromList(frameHost(details.frame) + ' souhaite se connecter à un appareil USB', items)
      .then(id => { try { id ? callback(id) : callback(); } catch {} });
  });
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault();
    const items = (portList || []).map(p => ({ id: p.portId, label: p.displayName ? p.displayName + ' (' + p.portName + ')' : p.portName }));
    const host = wc && !wc.isDestroyed() ? hostOf(wc.getURL()) : 'Ce site';
    chooseFromList(host + ' souhaite se connecter à un port série', items)
      .then(id => { try { callback(id || ''); } catch {} });
  });
  ses.on('select-webauthn-account', (event, details, callback) => {
    event.preventDefault();
    const items = (details.accounts || []).map(a => ({ id: a.credentialId, label: a.displayName || a.userName || a.name || 'Compte' }));
    chooseFromList('Choisissez un compte pour ' + (details.relyingPartyId || 'ce site'), items)
      .then(id => { try { id ? callback(id) : callback(); } catch {} });
  });
}

// Bluetooth : la liste des appareils arrive au fil de la découverte. On la
// laisse se remplir quelques secondes puis on demande à l'utilisateur.
function attachBluetoothChooser(wc) {
  let pendingCallback = null, latest = [], timer = null;
  wc.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    latest = devices || [];
    if (pendingCallback) return;
    pendingCallback = callback;
    timer = setTimeout(() => {
      const cb = pendingCallback;
      pendingCallback = null; timer = null;
      if (wc.isDestroyed()) return;
      const items = latest.map(d => ({ id: d.deviceId, label: d.deviceName || ('Appareil ' + d.deviceId) }));
      chooseFromList(hostOf(wc.getURL()) + ' souhaite s\'associer à un appareil Bluetooth', items)
        .then(id => { try { cb(id || ''); } catch {} });
    }, 3500);
  });
  wc.once('destroyed', () => { if (timer) clearTimeout(timer); });
}

// ----- Informations du site / cookies (popup de la barre d'adresse) --------

function siteInfoForActiveTab() {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : '';
  let parsed;
  try { parsed = new URL(pageUrl); } catch { return Promise.resolve({ available: false }); }
  if (!/^https?:$/.test(parsed.protocol)) return Promise.resolve({ available: false });

  const origin = parsed.origin;
  const partition = tab.incognito ? INCOGNITO_PARTITION : browserPartition();
  const prefix = partition + '|' + origin + '|';
  const permissions = Object.entries(tab.incognito ? {} : sitePermissions)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ permission: key.slice(prefix.length), value }))
    .filter(x => (x.value === 'allow' || x.value === 'deny') &&
                 !x.permission.startsWith('fileSystem:') && x.permission !== 'popups')
    .map(x => ({ ...x, label: permissionDisplayName(x.permission) }));
  const popupsAllowed = permissionContext(partition).decision(origin, 'popups') === 'allow';

  return wc.session.cookies.get({ url: pageUrl }).then(cookies => ({
    available: true,
    origin,
    host: parsed.hostname,
    secure: parsed.protocol === 'https:',
    incognito: !!tab.incognito,
    cookies: cookies.map(c => ({
      name: String(c.name || ''), domain: String(c.domain || parsed.hostname),
      path: String(c.path || '/'), secure: !!c.secure, httpOnly: !!c.httpOnly,
      session: !!c.session, sameSite: String(c.sameSite || 'unspecified'),
    })),
    permissions,
    popupsAllowed,
  })).catch(() => ({ available: true, origin, host: parsed.hostname,
    secure: parsed.protocol === 'https:', incognito: !!tab.incognito, cookies: [], permissions, popupsAllowed }));
}

function sendSiteInfo(sender) {
  if (!sender || sender.isDestroyed()) return;
  siteInfoForActiveTab().then(async info => {
    // Certificat et niveau de sécurité (src/features/certificates.js).
    const certm = featureModules.certificates;
    if (certm && info && info.available) { try { info.security = await certm.siteSecurity(activeTab()); } catch {} }
    try { sender.send('zaalis:message', { type: 'siteInfo', info }); } catch {}
  });
}

function clearActiveSiteData(sender) {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  let origin = '';
  try { origin = new URL(wc.getURL()).origin; } catch {}
  if (!wc || !origin || origin === 'null') return;
  wc.session.clearStorageData({
    origin,
    storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'],
  }).then(() => {
    try { sender.send('zaalis:message', { type: 'toast', text: 'Cookies et données du site effacés.' }); } catch {}
    sendSiteInfo(sender);
  }).catch(() => {
    try { sender.send('zaalis:message', { type: 'toast', text: 'Impossible d’effacer les données de ce site.' }); } catch {}
  });
}

// Pop-ups et redirections pour le site actif (popup « informations du site »).
function setActiveSitePopups(allow, sender) {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  const origin = wc ? originOf(wc.getURL()) : '';
  if (!origin || origin === 'null' || !/^https?:/.test(origin)) return;
  permissionContext(tab.incognito ? INCOGNITO_PARTITION : browserPartition())
    .record(origin, 'popups', allow, true);
  try { sender.send('zaalis:message', { type: 'toast', text: allow ? 'Pop-ups autorisées sur ce site.' : 'Pop-ups bloquées sur ce site.' }); } catch {}
  sendSiteInfo(sender);
}

function resetActiveSitePermissions(sender) {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  let origin = '';
  try { origin = new URL(wc.getURL()).origin; } catch {}
  if (!wc || !origin || origin === 'null') return;
  if (!tab.incognito) {
    const prefix = browserPartition() + '|' + origin + '|';
    for (const key of Object.keys(sitePermissions)) if (key.startsWith(prefix)) delete sitePermissions[key];
    saveSitePermissions();
  }
  permissionContext(tab.incognito ? INCOGNITO_PARTITION : browserPartition()).forgetOnce(origin);
  try { sender.send('zaalis:message', { type: 'toast', text: 'Autorisations de ce site réinitialisées.' }); } catch {}
  sendSiteInfo(sender);
}

// ----- Safe Browsing léger (hors-ligne) -------------------------------------
// Heuristiques + petite liste locale : avertit sans dépendre d'un service tiers.
const SAFE_BROWSING_BLOCKLIST = [
  // domaines de démonstration/hameçonnage notoires (test)
  'testsafebrowsing.appspot.com',
  'malware.testing.google.test',
];
function safeBrowsingVerdict(u) {
  if (!settings.safeBrowsing) return null;
  // Listes publiques mises à jour + heuristiques : src/features/safebrowsing.js.
  const sbm = featureModules.safebrowsing;
  if (sbm && typeof sbm.verdict === 'function') { const v = sbm.verdict(u); return v ? v.reason : null; }
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  for (const bad of SAFE_BROWSING_BLOCKLIST) {
    if (host === bad || host.endsWith('.' + bad)) return 'Ce site figure sur une liste de sites dangereux connus.';
  }
  // Heuristique : nom d'hôte en punycode imitant une marque (homographe).
  if (/(^|\.)xn--/.test(host) && /(paypal|google|apple|microsoft|amazon|bank|coinbase)/i.test(u)) {
    return 'L\'adresse de ce site utilise des caractères trompeurs (risque d\'hameçonnage).';
  }
  return null;
}

// Affiche l'avertissement Safe Browsing (interstitiel interne du module, sinon
// la page de secours ci-dessous).
function showSafeBrowsingWarning(wc, u, reason) {
  const sbm = featureModules.safebrowsing;
  if (sbm && sbm.showInterstitial && sbm.showInterstitial(wc, u)) return;
  const html = safeBrowsingInterstitial(u, reason);
  try { wc.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64')); } catch {}
}

// Interstitiel Safe Browsing : page d'avertissement avec « Retour » / « Continuer ».
function safeBrowsingInterstitial(u, reason) {
  const safe = String(u).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark}
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:#8b1a1a;color:#fff}
    .box{max-width:520px;padding:34px;text-align:center}
    .ic{font-size:52px;margin-bottom:12px}
    h1{font-size:22px;margin:0 0 10px} p{opacity:.92;line-height:1.5;font-size:14px}
    .u{font-size:12px;opacity:.7;word-break:break-all;margin-top:10px}
    .row{margin-top:22px;display:flex;gap:10px;justify-content:center}
    button{border:0;border-radius:10px;padding:10px 18px;font-size:13.5px;font-weight:600;cursor:pointer}
    .back{background:#fff;color:#8b1a1a}.go{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6)}
  </style></head><body><div class="box">
    <div class="ic">⚠️</div>
    <h1>Site potentiellement dangereux</h1>
    <p>${reason.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
    <div class="u">${safe}</div>
    <div class="row">
      <button class="back" id="back">Retour en sécurité</button>
      <button class="go" id="go">Continuer quand même</button>
    </div>
  </div><script>
    const destination=${JSON.stringify(String(u))};
    document.getElementById('back').onclick=()=>history.length>1?history.back():location.href=${JSON.stringify(HOME_URL)};
    document.getElementById('go').onclick=()=>location.href=destination;
  <\/script></body></html>`;
}

// Mise à niveau http -> https quand HTTPS-Only est actif (hors hôtes locaux et
// hôtes qui ont explicitement échoué en https, mémorisés le temps de la session).
const httpsExceptions = new Set();
function httpsUpgrade(u) {
  if (!settings.httpsOnly) return u;
  try {
    const x = new URL(u);
    if (x.protocol === 'http:' &&
        !/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[)/.test(x.hostname) &&
        !httpsExceptions.has(x.hostname)) {
      x.protocol = 'https:';
      return x.toString();
    }
  } catch {}
  return u;
}

// Ouvre l'ecran "Telechargements" du panneau. Si le panneau vient d'etre cree,
// sa page n'est pas encore prete : on rejoue la demande sur `panelReady`.
function showPanelDownloads() {
  if (!panelView || !panelLoaded) { pendingPanelDownloads = true; return; }
  panelView.webContents.send('zaalis:message', { type: 'showDownloads', items: downloadsPayload() });
}

function cancelDownload(id) {
  const item = liveDownloads.get(id);
  if (item) { try { item.cancel(); } catch {} return; }
  // Deja termine cote systeme : on marque quand meme l'entree comme annulee.
  const d = downloadById(id);
  if (d && d.state === 'progressing') { d.state = 'cancelled'; saveDownloads(); pushDownloads(); }
}

function showDownload(id) {
  const d = downloadById(id);
  if (d && d.path && fs.existsSync(d.path)) shell.showItemInFolder(d.path);
}

function openDownload(id) {
  const d = downloadById(id);
  if (!(d && d.state === 'completed' && d.path && fs.existsSync(d.path))) return;
  // Fichier venant d'un site signalé : confirmation avant ouverture.
  const sbm = featureModules.safebrowsing;
  if (sbm && sbm.confirmOpenDownload && !sbm.confirmOpenDownload(d)) return;
  shell.openPath(d.path);
}

function removeDownload(id) {
  const d = downloadById(id);
  if (!d || d.state === 'progressing') return;   // on annule avant de retirer
  downloads = downloads.filter(x => x.id !== id);
  saveDownloads();
  pushDownloads();
}

function clearDownloads() {
  downloads = downloads.filter(d => d.state === 'progressing');
  saveDownloads();
  pushDownloads();
}

// ----- Onglets --------------------------------------------------------------

function applyWebSettings(view) {
  const wc = view.webContents;
  wc.setZoomFactor(settings.zoomPct / 100);
  wc.setAudioMuted(false);
}

function isWebPageUrl(u) {
  return /^https?:\/\//i.test(String(u || ''));
}

// `reload()` respecte le cache HTTP. Pour un navigateur de travail, le bouton
// d'actualisation et le retour vers un onglet ancien doivent au contraire
// revalider la ressource aupres du serveur : Electron fournit exactement cette
// semantique avec reloadIgnoringCache().
function reloadFresh(wc) {
  if (!wc || wc.isDestroyed()) return;
  try { wc.reloadIgnoringCache(); } catch {}
}

// Bloqueur de pop-ups façon Chrome : une page ne peut ouvrir une fenêtre ou un
// onglet qu'en réponse à une action de l'utilisateur (clic, touche, toucher)
// datant de moins de 5 s. Les sites autorisés dans « informations du site »
// (autorisation « popups ») et les clics sur des liens restent libres.
const POPUP_GESTURE_MS = 5000;
const GESTURE_INPUTS = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'char',
  'touchStart', 'touchEnd', 'gestureTap', 'gestureTapDown']);

function popupAllowed(tab, details) {
  // Ctrl+clic / clic molette : toujours une action explicite sur un lien.
  if (details.disposition === 'background-tab') return true;
  const recentGesture = Date.now() - (tab.lastGestureAt || 0) < POPUP_GESTURE_MS;
  const origin = originOf(tab.view.webContents.getURL());
  const ctx = permissionContext(tab.incognito ? INCOGNITO_PARTITION : browserPartition());
  const siteChoice = origin ? ctx.decision(origin, 'popups') : '';
  if (siteChoice === 'allow') return true;
  if (siteChoice === 'deny' || !recentGesture) return false;
  // Réglage « Bloquer les pop-ups » : seules les fenêtres scriptées dimensionnées
  // (window.open avec des options) sont refusées, les liens target=_blank passent.
  if (settings.blockPopups && details.disposition === 'new-window') return false;
  return true;
}

function notifyPopupBlocked(tab) {
  const now = Date.now();
  if (now - (tab.lastPopupToastAt || 0) < 4000) return;
  tab.lastPopupToastAt = now;
  if (chromeView && activeTab() === tab) {
    chromeView.webContents.send('zaalis:message', {
      type: 'toast', text: 'Pop-up bloquée sur ' + hostOf(tab.view.webContents.getURL()),
    });
  }
}

// Position d'insertion d'un onglet ouvert depuis un autre : juste à droite de
// son ouvreur (après ses autres « enfants »), comme Chrome.
function insertIndexFor(openerId) {
  const oi = tabs.findIndex(t => t.id === openerId);
  if (oi < 0) return tabs.length;
  let i = oi + 1;
  while (i < tabs.length && tabs[i].openerId === openerId) i++;
  // Les onglets épinglés restent groupés en tête de la barre.
  const firstUnpinned = tabs.findIndex(t => !t.pinned);
  return Math.max(i, firstUnpinned < 0 ? tabs.length : firstUnpinned);
}

function consoleLevel(level) {
  if (typeof level === 'string') return ({ debug: 'log', verbose: 'log', info: 'info', warning: 'warn', error: 'error' })[level] || 'log';
  return ['log', 'info', 'warn', 'error'][level] || 'log';
}

// opts : { incognito, openerId, webContents (pop-up créée par la page, à
// adopter telle quelle), loadOptions (referrer / données POST d'un lien) }.
function createTab(rawUrl, activate, opts) {
  opts = opts || {};
  const incognito = !!opts.incognito;
  const preload = path.join(__dirname, 'preload-content.js');
  const partition = incognito ? INCOGNITO_PARTITION : browserPartition();
  setupSession(partition);   // protocole zaalis:// + téléchargements + permissions
  const view = opts.webContents
    // Pop-up ouverte par window.open : on adopte le WebContents créé par
    // Chromium pour conserver window.opener (connexion Google/Apple/PayPal,
    // paiements 3-D Secure…). Il hérite des préférences de l'onglet ouvreur.
    ? new WebContentsView({ webContents: opts.webContents })
    : new WebContentsView({
        webPreferences: {
          preload,
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: true,
          // Le preload (scripts de contenu : mots de passe, remplissage…)
          // s'exécute aussi dans les iframes. Il reste isolé et sans Node.
          nodeIntegrationInSubFrames: true,
          // Les WebContentsView invisibles sont sinon mis en veille : les apps
          // Google et les tableaux de bord ne recoivent plus leurs mises a jour
          // temps reel tant que l'onglet est cache.
          backgroundThrottling: false,
        },
      });
  view.setBackgroundColor('#00000000');

  const tab = {
    id: nextId++, view, loading: false, consoleBuf: [], pinned: false, incognito,
    loadedOnce: false, lastBackgroundAt: 0, lastFreshReloadAt: 0,
    openerId: opts.openerId || 0, lastGestureAt: 0, closing: false,
  };
  if (opts.openerId) {
    const activeId = activeTab() ? activeTab().id : -1;
    tabs.splice(insertIndexFor(opts.openerId), 0, tab);
    active = tabs.findIndex(t => t.id === activeId);            // garde l'onglet actif
    makeSplitAdjacent();                                         // la paire reste collée
  } else {
    tabs.push(tab);
  }

  const wc = view.webContents;

  // WebRTC : seule l'adresse publique de l'interface par défaut est exposée
  // aux sites, jamais les adresses privées du réseau local.
  try { wc.setWebRTCIPHandlingPolicy('default_public_interface_only'); } catch {}

  // Outils de développement fermés (bouton, raccourci, fermeture de la fenêtre
  // séparée) : on retire la zone ancrée et la page reprend toute la place.
  wc.on('devtools-closed', () => { if (tab.dev) { disposeDevTools(tab); layoutAll(); } });

  // Capture des messages console de la page (tampon circulaire) pour que
  // l'assistant IA puisse les inspecter, comme l'extension Claude dans Chrome.
  wc.on('console-message', (event, ...legacyArgs) => {
    try {
      const [legacyLevel, legacyMessage, legacyLine, legacySourceId] = legacyArgs;
      const level = event.level ?? legacyLevel;
      const message = event.message ?? legacyMessage;
      const line = event.lineNumber ?? legacyLine;
      const sourceId = event.sourceId ?? legacySourceId;
      const lv = consoleLevel(level);
      const src = sourceId ? String(sourceId).split('/').pop() : '';
      tab.consoleBuf.push({
        level: lv,
        message: String(message).slice(0, 600),
        source: src,
        line
      });
      if (tab.consoleBuf.length > 200) tab.consoleBuf.shift();
    } catch {}
  });

  // Dernière action de l'utilisateur dans la page (pour le bloqueur de pop-ups).
  // before-mouse-event / before-input-event couvrent aussi les iframes d'autres
  // sites (bouton « Se connecter avec Google », PayPal, lecteurs intégrés) ;
  // input-event ajoute le toucher sur le document principal.
  const noteGesture = (_e, input) => { if (input && GESTURE_INPUTS.has(input.type)) tab.lastGestureAt = Date.now(); };
  wc.on('before-mouse-event', noteGesture);
  wc.on('before-input-event', noteGesture);
  wc.on('input-event', noteGesture);

  // Pop-ups et liens target=_blank -> nouvel onglet, en conservant le lien
  // avec la page d'origine (window.opener), indispensable aux connexions
  // « Se connecter avec Google », aux paiements et aux lecteurs intégrés.
  wc.setWindowOpenHandler((details) => {
    const url = String(details.url || '');
    if (isExternalAppUrl(url)) {
      openExternalFromPage(wc, partition, url);
      return { action: 'deny' };
    }
    const popupUrlOk = url === '' || url === 'about:blank' || /^(https?|blob):/i.test(url);
    if (!popupUrlOk) return { action: 'deny' };
    if (!popupAllowed(tab, details)) { notifyPopupBlocked(tab); return { action: 'deny' }; }
    const foreground = details.disposition !== 'background-tab';
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => {
        if (options && options.webContents) {
          return createTab('', foreground, { incognito, openerId: tab.id, webContents: options.webContents }).view.webContents;
        }
        // Lien rel=noopener : Chromium ne crée pas la page, on la charge nous-mêmes.
        const loadOptions = {};
        if (details.referrer && details.referrer.url) loadOptions.httpReferrer = details.referrer;
        if (details.postBody && details.postBody.data) {
          loadOptions.postData = details.postBody.data;
          if (details.postBody.contentType) loadOptions.extraHeaders = 'Content-Type: ' + details.postBody.contentType;
        }
        return createTab(url, foreground, { incognito, openerId: tab.id, loadOptions }).view.webContents;
      },
    };
  });

  attachBluetoothChooser(wc);

  wc.on('did-start-loading', () => { tab.loading = true;  pushState(); });
  wc.on('did-stop-loading',  () => { tab.loading = false; tab.loadedOnce = true; pushState(); });
  wc.on('did-finish-load',   () => { tab.loadedAt = Date.now(); });
  wc.on('page-title-updated',   () => pushState());
  wc.on('did-navigate',         (_e, u) => {
    tab.consoleBuf = [];
    pushHistory(u, wc.getTitle()); pushState(); scheduleSaveOpenTabs();
    if (findBarOpen && findTabId === tab.id && findView) {
      findNeedsNewSession = true;
      findView.webContents.send('zaalis:message', { type: 'findResult', active: 0, total: 0 });
    }
  });
  wc.on('did-navigate-in-page', () => { pushState(); scheduleSaveOpenTabs(); });

  // Garde de navigation (liens/JS de la page) : Safe Browsing + mise à niveau HTTPS.
  wc.on('will-navigate', (event, targetUrl) => {
    // mailto:, tel:, zoommtg:… : confiés à l'application du système après
    // confirmation, au lieu d'être ignorés silencieusement.
    if (isExternalAppUrl(targetUrl)) {
      event.preventDefault();
      openExternalFromPage(wc, partition, targetUrl);
      return;
    }
    // blob: = fichier généré par la page elle-même (PDF, facture, export…).
    if (/^blob:/i.test(targetUrl)) return;
    const target = allowedPageUrl(targetUrl, isInternal(wc.getURL()));
    if (!target) { event.preventDefault(); return; }
    const verdict = safeBrowsingVerdict(targetUrl);
    if (verdict) {
      event.preventDefault();
      showSafeBrowsingWarning(wc, targetUrl, verdict);
      return;
    }
    const up = httpsUpgrade(targetUrl);
    if (up !== targetUrl) { event.preventDefault(); wc.loadURL(up); }
  });

  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED (navigation annulée par l'utilisateur ou redirigée)
    if (!isMainFrame || code === -3) return;
    // HTTPS-Only : si une mise à niveau https échoue, on retombe en http et on
    // mémorise l'exception pour ce site (évite une boucle).
    try {
      const fx = new URL(failedUrl);
      if (settings.httpsOnly && fx.protocol === 'https:' && !httpsExceptions.has(fx.hostname) &&
          [-200, -201, -202, -501, -105, -106, -118, -137, -101, -100, -324].includes(code)) {
        httpsExceptions.add(fx.hostname);
        fx.protocol = 'http:';
        wc.loadURL(fx.toString());
        return;
      }
    } catch {}
    // Erreur de certificat (-200…-299) : « Votre connexion n'est pas privée ».
    const certm = featureModules.certificates;
    if (code <= -200 && code >= -299 && certm && certm.handleCertFailure(tab, wc, failedUrl, code, desc)) return;
    const html = errorPageHtml(failedUrl, code, desc);
    wc.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'), {
      baseURLForDataURL: failedUrl,
    });
  });

  // Onglet planté (mémoire saturée, plantage du moteur) : page « Oups » avec
  // un bouton pour recharger, comme l'onglet triste de Chrome.
  wc.on('render-process-gone', (_e, details) => {
    if (!details || details.reason === 'clean-exit' || wc.isDestroyed()) return;
    if (htmlFullscreenTabId === tab.id) { htmlFullscreenTabId = null; layoutAll(); }
    const lastUrl = wc.getURL();
    const reason = details.reason === 'oom' ? 'La mémoire disponible était insuffisante pour afficher cette page.'
                 : 'Un problème est survenu lors de l\'affichage de cette page.';
    const html = errorPageHtml(lastUrl, 0, '', ['RESULT_CODE_' + String(details.reason || 'crashed').toUpperCase().replace(/-/g, '_'),
      'Oups, la page a planté', reason + ' Cliquez sur « Réessayer » pour la recharger.']);
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      try { wc.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'),
        isWebPageUrl(lastUrl) ? { baseURLForDataURL: lastUrl } : undefined); } catch {}
    }, 0);
  });

  // Plein écran HTML5 (bouton plein écran de YouTube, Prime Video, Netflix…).
  wc.on('enter-html-full-screen', () => {
    htmlFullscreenTabId = tab.id;
    if (activeTab() !== tab) selectTab(tab.id);
    if (findBarOpen) closeFindBar();
    layoutAll();
  });
  wc.on('leave-html-full-screen', () => {
    if (htmlFullscreenTabId === tab.id) htmlFullscreenTabId = null;
    layoutAll();
    pushState();
  });

  // Ctrl + molette : zoom, comme Chrome.
  wc.on('zoom-changed', (_e, direction) => {
    setZoomPct((settings.zoomPct || 100) + (direction === 'in' ? 10 : -10));
  });

  // Résultats de la recherche dans la page (Ctrl+F).
  wc.on('found-in-page', (_e, result) => {
    if (findView && activeTab() === tab && result) {
      findView.webContents.send('zaalis:message', {
        type: 'findResult', active: result.activeMatchOrdinal || 0, total: result.matches || 0,
      });
    }
  });

  // Une page peut se fermer elle-même (window.close() d'une pop-up de connexion).
  wc.once('destroyed', () => {
    disposeDevTools(tab);
    if (!tab.closing && tabs.includes(tab)) removeTabEntry(tab);
  });

  wc.on('context-menu', (event, params) => {
    if (!settings.contextMenus) { event.preventDefault(); return; }
    showPageContextMenu(tab, params);
  });

  // Injecte le thème avant chaque navigation (comme AddScriptToExecuteOnDocumentCreated).
  const injectTheme = () => {
    const t = settings.theme === 'dark' ? 'dark' : 'light';
    wc.executeJavaScript(`
      try { localStorage.setItem('zaalis_theme', '${t}'); } catch (e) {}
      if (document.body) {
        document.body.classList.toggle('dark-mode', '${t}' === 'dark');
        document.body.classList.toggle('dark',      '${t}' === 'dark');
      }
    `).catch(() => {});
  };
  // Les sites externes conservent leur propre contexte JavaScript et leurs
  // propres politiques de sécurité (notamment YouTube / Trusted Types).
  wc.on('dom-ready', () => { if (isInternal(wc.getURL())) injectTheme(); });

  applyWebSettings(view);
  mainWin.contentView.addChildView(view);

  // Insertion sous chromeView / panel dans le z-order (les added-last sont au-dessus).
  // On remonte chromeView et panelView après.
  raiseOverlays();

  if (!opts.webContents) {
    // blob: = document généré par la page ouvreuse (PDF, facture…).
    if (opts.loadOptions && /^blob:/i.test(rawUrl)) wc.loadURL(rawUrl, opts.loadOptions).catch(() => {});
    else if (opts.loadOptions) guardedLoad(wc, rawUrl, opts.loadOptions);
    else guardedLoad(wc, rawUrl && rawUrl.length ? resolveQuery(rawUrl) : HOME_URL);
  }

  runFeatureHooks('tabCreated', tab, wc, partition, opts);
  if (activate) selectTab(tab.id);
  else { layoutAll(); pushState(); scheduleSaveOpenTabs(); }
  if (activate && opts.focusOmnibox) {
    focusOmnibox();
    // La page d'accueil se charge après : on garde la barre du haut active
    // tant que l'utilisateur n'a pas cliqué dans la page.
    wc.once('did-finish-load', () => { if (activeTab() === tab && !tab.lastGestureAt) focusOmnibox(); });
  }
  return tab;
}

// ----- Menu contextuel des pages (équivalent de celui de Chrome) -----------
const ACCEL = process.platform === 'darwin'
  ? { back: 'Cmd+[', fwd: 'Cmd+]', reload: 'Cmd+R', save: 'Cmd+S', print: 'Cmd+P', source: 'Alt+Cmd+U', inspect: 'Alt+Cmd+I', undo: 'Cmd+Z', redo: 'Shift+Cmd+Z', cut: 'Cmd+X', copy: 'Cmd+C', paste: 'Cmd+V', pastePlain: 'Shift+Alt+Cmd+V', all: 'Cmd+A' }
  : { back: 'Alt+Left', fwd: 'Alt+Right', reload: 'Ctrl+R', save: 'Ctrl+S', print: 'Ctrl+P', source: 'Ctrl+U', inspect: 'Ctrl+Shift+I', undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', pastePlain: 'Ctrl+Shift+V', all: 'Ctrl+A' };

const SEARCH_ENGINE_NAMES = { google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo', brave: 'Brave Search' };

// Enregistre une ressource (lien, image, vidéo) en demandant l'emplacement.
function saveResourceAs(wc, url) {
  if (!url || wc.isDestroyed()) return;
  saveAsRequests.add(url);
  try { wc.downloadURL(url); } catch { saveAsRequests.delete(url); }
}

// Enregistrer la page sous… (Ctrl+S) : page web complète, comme Chrome.
async function savePageAs(wc) {
  if (!wc || wc.isDestroyed() || !mainWin) return;
  const u = wc.getURL();
  if (!isWebPageUrl(u)) return;
  const base = safeDownloadName((wc.getTitle() || hostOf(u) || 'page').slice(0, 120));
  let r;
  try {
    r = await dialog.showSaveDialog(mainWin, {
      title: 'Enregistrer sous',
      defaultPath: path.join(app.getPath('downloads'), base + '.html'),
      filters: [
        { name: 'Page Web, complète', extensions: ['html', 'htm'] },
        { name: 'Page Web, HTML uniquement', extensions: ['html', 'htm'] },
        { name: 'Archive Web (MHTML)', extensions: ['mhtml'] },
      ],
    });
  } catch { return; }
  if (!r || r.canceled || !r.filePath) return;
  const type = /\.mhtml$/i.test(r.filePath) ? 'MHTML' : 'HTMLComplete';
  wc.savePage(r.filePath, type).catch(() => {
    dialog.showMessageBox(mainWin, { type: 'error', title: 'zaalis Browser', message: 'Impossible d\'enregistrer cette page.', buttons: ['OK'] }).catch(() => {});
  });
}

function printPage(wc) {
  if (!wc || wc.isDestroyed()) return;
  try { wc.print({}, () => {}); } catch {}
}

function openViewSource(u, openerTab) {
  if (!isWebPageUrl(u)) return;
  const t = createTab('', true, { incognito: !!(openerTab && openerTab.incognito), openerId: openerTab ? openerTab.id : 0 });
  try { t.view.webContents.loadURL('view-source:' + u); } catch {}
}

// Exécute un script sur l'élément média situé sous le clic (boucle, PiP…).
function mediaAt(wc, params, body) {
  const z = wc.getZoomFactor() || 1;
  const x = Math.round(params.x / z), y = Math.round(params.y / z);
  const code = `(() => { const el = document.elementFromPoint(${x}, ${y});
    const m = el && (el.closest('video, audio') || (el.querySelector && el.querySelector('video, audio')));
    if (!m) return false; ${body}; return true; })()`;
  return wc.executeJavaScript(code, true).catch(() => false);
}

function showPageContextMenu(tab, params) {
  const wc = tab.view.webContents;
  const pageUrl = wc.getURL();
  const internal = isInternal(pageUrl);
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  const flags = params.editFlags || {};
  const mf = params.mediaFlags || {};

  // Correcteur orthographique : suggestions en tête, comme Chrome.
  if (params.isEditable && params.misspelledWord) {
    const sugg = (params.dictionarySuggestions || []).slice(0, 5);
    if (sugg.length) sugg.forEach(s => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
    else items.push({ label: 'Aucune suggestion', enabled: false });
    items.push({ label: 'Ajouter au dictionnaire', click: () => { try { wc.session.addWordToSpellCheckerDictionary(params.misspelledWord); } catch {} } });
    sep();
  }

  if (params.linkURL) {
    const linkIsWeb = isWebPageUrl(params.linkURL);
    items.push({ label: 'Ouvrir le lien dans un nouvel onglet', enabled: linkIsWeb,
      click: () => createTab(params.linkURL, false, { incognito: tab.incognito, openerId: tab.id }) });
    items.push({ label: 'Ouvrir le lien dans un onglet de navigation privée', enabled: linkIsWeb,
      click: () => createTab(params.linkURL, true, { incognito: true }) });
    sep();
    items.push({ label: 'Enregistrer le lien sous…', enabled: linkIsWeb, click: () => saveResourceAs(wc, params.linkURL) });
    items.push({ label: 'Copier l\'adresse du lien', click: () => clipboard.writeText(params.linkURL) });
    if (params.linkText && !params.srcURL) items.push({ label: 'Copier le texte du lien', click: () => clipboard.writeText(params.linkText) });
    sep();
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Ouvrir l\'image dans un nouvel onglet', enabled: /^(https?|data|blob):/i.test(params.srcURL) && !/^data:/i.test(params.srcURL),
      click: () => createTab(params.srcURL, false, { incognito: tab.incognito, openerId: tab.id }) });
    items.push({ label: 'Enregistrer l\'image sous…', click: () => saveResourceAs(wc, params.srcURL) });
    items.push({ label: 'Copier l\'image', click: () => wc.copyImageAt(params.x, params.y) });
    items.push({ label: 'Copier l\'adresse de l\'image', click: () => clipboard.writeText(params.srcURL) });
    sep();
  } else if ((params.mediaType === 'video' || params.mediaType === 'audio') && !mf.inError) {
    const isVideo = params.mediaType === 'video';
    items.push({ label: mf.isPaused ? 'Lecture' : 'Pause', click: () => mediaAt(wc, params, 'm.paused ? m.play() : m.pause()') });
    items.push({ label: mf.isMuted ? 'Réactiver le son' : 'Couper le son', enabled: mf.hasAudio !== false, click: () => mediaAt(wc, params, 'm.muted = !m.muted') });
    if (mf.canLoop !== false) items.push({ label: 'Boucle', type: 'checkbox', checked: !!mf.isLooping, click: () => mediaAt(wc, params, 'm.loop = !m.loop') });
    if (mf.canToggleControls) items.push({ label: 'Afficher les commandes', type: 'checkbox', checked: !!mf.isControlsVisible, click: () => mediaAt(wc, params, 'm.controls = !m.controls') });
    if (isVideo && mf.canShowPictureInPicture) {
      items.push({ label: 'Picture-in-picture', type: 'checkbox', checked: !!mf.isShowingPictureInPicture,
        click: () => mediaAt(wc, params, 'document.pictureInPictureElement === m ? document.exitPictureInPicture() : m.requestPictureInPicture()') });
    }
    sep();
    const saveable = params.srcURL && /^https?:/i.test(params.srcURL);
    if (saveable) {
      items.push({ label: isVideo ? 'Ouvrir la vidéo dans un nouvel onglet' : 'Ouvrir l\'audio dans un nouvel onglet',
        click: () => createTab(params.srcURL, false, { incognito: tab.incognito, openerId: tab.id }) });
      if (mf.canSave !== false) items.push({ label: isVideo ? 'Enregistrer la vidéo sous…' : 'Enregistrer l\'audio sous…', click: () => saveResourceAs(wc, params.srcURL) });
      items.push({ label: isVideo ? 'Copier l\'adresse de la vidéo' : 'Copier l\'adresse de l\'audio', click: () => clipboard.writeText(params.srcURL) });
      sep();
    }
  }

  if (params.isEditable) {
    items.push({ label: 'Annuler', accelerator: ACCEL.undo, registerAccelerator: false, enabled: !!flags.canUndo, click: () => wc.undo() });
    items.push({ label: 'Rétablir', accelerator: ACCEL.redo, registerAccelerator: false, enabled: !!flags.canRedo, click: () => wc.redo() });
    sep();
    items.push({ label: 'Couper', accelerator: ACCEL.cut, registerAccelerator: false, enabled: !!flags.canCut, click: () => wc.cut() });
    items.push({ label: 'Copier', accelerator: ACCEL.copy, registerAccelerator: false, enabled: !!flags.canCopy, click: () => wc.copy() });
    items.push({ label: 'Coller', accelerator: ACCEL.paste, registerAccelerator: false, enabled: !!flags.canPaste, click: () => wc.paste() });
    items.push({ label: 'Coller en tant que texte brut', accelerator: ACCEL.pastePlain, registerAccelerator: false, enabled: !!flags.canPaste, click: () => wc.pasteAndMatchStyle() });
    items.push({ label: 'Tout sélectionner', accelerator: ACCEL.all, registerAccelerator: false, enabled: flags.canSelectAll !== false, click: () => wc.selectAll() });
    sep();
  } else if (params.selectionText && params.selectionText.trim()) {
    const sel = params.selectionText.trim().replace(/\s+/g, ' ');
    const short = sel.length > 32 ? sel.slice(0, 30) + '…' : sel;
    items.push({ label: 'Copier', accelerator: ACCEL.copy, registerAccelerator: false, click: () => wc.copy() });
    items.push({ label: 'Rechercher « ' + short + ' » sur ' + (SEARCH_ENGINE_NAMES[settings.searchEngine] || 'Google'),
      click: () => createTab(sel.slice(0, 500), true, { incognito: tab.incognito, openerId: tab.id }) });
    if (/^\S+\.[a-z]{2,}(\/\S*)?$/i.test(sel) || /^https?:\/\//i.test(sel)) {
      items.push({ label: 'Accéder à ' + short, click: () => createTab(sel, true, { incognito: tab.incognito, openerId: tab.id }) });
    }
    sep();
  }

  const onPageArea = !params.linkURL && !params.isEditable && !(params.selectionText && params.selectionText.trim()) &&
                     (params.mediaType === 'none' || !params.mediaType);
  if (onPageArea) {
    items.push({ label: 'Retour', accelerator: ACCEL.back, registerAccelerator: false, enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    items.push({ label: 'Avancer', accelerator: ACCEL.fwd, registerAccelerator: false, enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    items.push({ label: 'Actualiser', accelerator: ACCEL.reload, registerAccelerator: false, click: () => reloadFresh(wc) });
    sep();
    if (!internal) {
      items.push({ label: 'Enregistrer sous…', accelerator: ACCEL.save, registerAccelerator: false, click: () => savePageAs(wc) });
      items.push({ label: 'Imprimer…', accelerator: ACCEL.print, registerAccelerator: false, click: () => printPage(wc) });
      items.push({ label: 'Traduire la page en français', click: () => translatePage('français') });
      sep();
    }
  }

  // Entrées des modules de fonctionnalités (lecture, QR, Cast…).
  const nBefore = items.length;
  runFeatureHooks('contextMenu', items, { tab, wc, params, internal, pageUrl, onPageArea });
  if (items.length > nBefore) sep();

  // IA : résumé/chat sur la page courante via zaalis labs ide.
  items.push({ label: 'Demander à l\'IA — résumé de la page', click: () => askAiAboutPage() });
  if (onPageArea) {
    items.push({ label: tab.pinned ? 'Détacher l\'onglet' : 'Épingler l\'onglet', click: () => togglePinTab(tab.id) });
    if (!internal) items.push({ label: 'Installer comme application…', click: () => installAsApp(tab.id) });
  }

  if (settings.devTools) {
    sep();
    if (onPageArea && !internal) items.push({ label: 'Afficher le code source de la page', accelerator: ACCEL.source, registerAccelerator: false, click: () => openViewSource(pageUrl, tab) });
    items.push({ label: 'Inspecter', accelerator: ACCEL.inspect, registerAccelerator: false, click: () => openDevToolsFor(tab, { x: params.x, y: params.y }) });
  }
  // Modules (ex. extensions : chrome.contextMenus) : (items, tab, params, sep).
  runFeatureHooks('contextMenu', items, tab, params, sep);
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  Menu.buildFromTemplate(items).popup({ window: mainWin || undefined });
}

// ----- Vue fractionnee (2 onglets max, comme Chrome) -------------------------

// Retourne [tabGauche, tabDroite] si la paire est valide ET que l'onglet actif
// en fait partie (sinon la paire reste memorisee mais masquee).
function currentSplitTabs() {
  if (!splitPair) return null;
  const a = tabs.find(t => t.id === splitPair[0]);
  const b = tabs.find(t => t.id === splitPair[1]);
  if (!a || !b) { splitPair = null; return null; }
  const act = activeTab();
  if (!act || (act.id !== a.id && act.id !== b.id)) return null;
  return [a, b];
}

function setSplit(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0 || tabs.length < 2) return;
  const act = activeTab();
  let otherId;
  if (act && act.id !== id) otherId = act.id;
  else {
    const nb = tabs[idx + 1] || tabs[idx - 1];   // onglet lui-meme actif : voisin
    if (!nb) return;
    otherId = nb.id;
  }
  // Ordre gauche/droite = ordre des onglets dans la barre.
  const otherIdx = tabs.findIndex(t => t.id === otherId);
  splitPair = otherIdx < idx ? [otherId, id] : [id, otherId];
  makeSplitAdjacent();
  if (!act || (act.id !== id && act.id !== otherId)) selectTab(id);
  else { layoutAll(); pushState(); }
}

// Comme Chrome : les deux onglets d'un groupe fractionne sont ramenes cote a
// cote dans la barre (le droit vient se coller au gauche).
function makeSplitAdjacent() {
  if (!splitPair) return;
  const activeId = activeTab() ? activeTab().id : -1;
  const li = tabs.findIndex(t => t.id === splitPair[0]);
  const ri = tabs.findIndex(t => t.id === splitPair[1]);
  if (li < 0 || ri < 0) return;
  if (ri !== li + 1) {
    const [moved] = tabs.splice(ri, 1);
    tabs.splice(tabs.findIndex(t => t.id === splitPair[0]) + 1, 0, moved);
  }
  active = tabs.findIndex(t => t.id === activeId);
}

function clearSplit() {
  if (!splitPair) return;
  splitPair = null;
  layoutAll();
  pushState();
}

// Menu contextuel natif au clic droit sur un onglet de la barre.
function showTabMenu(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  const inSplit = !!(splitPair && splitPair.includes(id));
  const items = [];
  if (inSplit) {
    items.push({ label: 'Quitter la vue fractionnée', click: () => clearSplit() });
  } else {
    items.push({
      label: 'Vue fractionnée',
      enabled: tabs.length >= 2,
      click: () => setSplit(id),
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: t.pinned ? 'Détacher l\'onglet' : 'Épingler l\'onglet', click: () => togglePinTab(id) });
  // Groupes d'onglets (src/features/tabgroups.js).
  try { if (featureModules.tabgroups) items.push(...featureModules.tabgroups.tabMenuItems(t)); } catch {}
  items.push({ type: 'separator' });
  items.push({ label: 'Nouvel onglet', click: () => openNewTab() });
  items.push({ label: 'Nouvel onglet privé', click: () => openIncognitoTab() });
  items.push({ label: 'Actualiser',    click: () => reloadFresh(t.view.webContents) });
  if (!isInternal(t.view.webContents.getURL())) {
    items.push({ label: 'Installer comme application…', click: () => installAsApp(id) });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Fermer l\'onglet', click: () => closeTab(id) });
  Menu.buildFromTemplate(items).popup();
}

function selectTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  if (findBarOpen && findTabId !== id) closeFindBar();   // comme Chrome : la barre suit l'onglet
  const now = Date.now();
  const previous = activeTab();
  if (previous && previous.id !== id) previous.lastBackgroundAt = now;
  active = idx;
  runFeatureHooks('tabActivated', tabs[idx], previous);
  layoutAll();
  const t = tabs[idx];
  try { t.view.webContents.focus(); } catch {}
  const asleepFor = t.lastBackgroundAt ? now - t.lastBackgroundAt : 0;
  // Ne recharge jamais une page interne, un chargement en cours, ni un onglet
  // qui vient juste d'etre affiche. On evite ainsi les boucles et les pertes
  // de saisie, tout en revalidant les sites publies pendant l'absence.
  const wcSel = t.view.webContents;
  if (t.loadedOnce && !t.loading && isLocalDevUrl(wcSel.getURL()) &&
      !wcSel.isCurrentlyAudible() && (t.lastGestureAt || 0) <= (t.lastFreshReloadAt || t.loadedAt || 0) &&
      asleepFor >= STALE_TAB_REFRESH_MS && now - t.lastFreshReloadAt >= STALE_TAB_REFRESH_MS) {
    t.lastFreshReloadAt = now;
    reloadFresh(t.view.webContents);
  }
  pushState();
  scheduleSaveOpenTabs();
}

function closeTab(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  t.closing = true;
  // Mémorise l'URL pour la réouverture (Ctrl+Maj+T), sauf pages internes / privées.
  try {
    const u = t.discarded ? t.discarded.url : t.view.webContents.getURL();
    if (u && !t.incognito && !isInternal(u)) { closedTabs.push(u); if (closedTabs.length > 25) closedTabs.shift(); }
  } catch {}
  removeTabEntry(t);
  try { t.view.webContents.close(); } catch {}
}

// Retire un onglet de la barre (fermeture par l'utilisateur ou par la page).
function removeTabEntry(t) {
  const idx = tabs.indexOf(t);
  if (idx < 0) return;
  const wasActive = idx === active;
  if (splitPair && splitPair.includes(t.id)) splitPair = null;  // dissout la vue fractionnee
  if (htmlFullscreenTabId === t.id) htmlFullscreenTabId = null;
  disposeDevTools(t);
  runFeatureHooks('tabClosed', t);
  try { mainWin.contentView.removeChildView(t.view); } catch {}
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    active = -1;
    if (mainWin) createTab('', true);
    return;
  }
  // Comme Chrome : fermer un onglet ouvert depuis un autre ramène à l'ouvreur
  // (retour à la page d'origine après une pop-up de connexion, par exemple).
  const opener = wasActive && t.openerId ? tabs.findIndex(x => x.id === t.openerId) : -1;
  if (opener >= 0) { active = opener; selectTab(tabs[opener].id); return; }
  if (active >= tabs.length) active = tabs.length - 1;
  else if (idx < active) active--;
  if (wasActive && tabs[active]) { selectTab(tabs[active].id); return; }
  layoutAll();
  pushState();
  scheduleSaveOpenTabs();
}

function reorderTabs(csv) {
  const ids = csv.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite);
  const currentActiveId = activeTab() ? activeTab().id : -1;
  const map = new Map(tabs.map(t => [t.id, t]));
  const reordered = [];
  for (const id of ids) { const t = map.get(id); if (t) { reordered.push(t); map.delete(id); } }
  for (const t of tabs) if (map.has(t.id)) reordered.push(t);
  tabs.length = 0;
  tabs.push(...reordered);
  active = tabs.findIndex(t => t.id === currentActiveId);
  sortPinned();           // les onglets épinglés restent en tête de la barre
  makeSplitAdjacent();    // la paire fractionnee reste toujours collee
  runFeatureHooks('tabsReordered');
  layoutAll();
  pushState();
  scheduleSaveOpenTabs();
}

// Chargement filtré par Safe Browsing (barre d'adresse + ouverture d'onglet).
function guardedLoad(wc, u, loadOptions) {
  const target = allowedPageUrl(u, true);
  if (!target) return false;
  const verdict = safeBrowsingVerdict(target);
  if (verdict) {
    showSafeBrowsingWarning(wc, target, verdict);
    return true;
  }
  // loadURL rejette sa promesse sur un téléchargement ou une navigation
  // annulée : sans .catch, Node journaliserait une erreur non gérée.
  try { wc.loadURL(target, loadOptions).catch(() => {}); return true; } catch { return false; }
}

function navigateActive(u) {
  const t = activeTab();
  if (!t) { createTab(u, true); return; }
  guardedLoad(t.view.webContents, u);
  scheduleSaveOpenTabs();
}

// ----- Épinglage / recherche / navigation privée / PWA ----------------------

// Ramène les onglets épinglés au début de la barre (ordre relatif conservé).
function sortPinned() {
  const activeId = activeTab() ? activeTab().id : -1;
  const pinned = tabs.filter(t => t.pinned);
  const rest   = tabs.filter(t => !t.pinned);
  tabs.length = 0;
  tabs.push(...pinned, ...rest);
  active = tabs.findIndex(t => t.id === activeId);
}

function togglePinTab(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  t.pinned = !t.pinned;
  // Un onglet épinglé quitte toute vue fractionnée.
  if (t.pinned && splitPair && splitPair.includes(id)) splitPair = null;
  sortPinned();
  runFeatureHooks('tabsReordered');   // un onglet épinglé quitte son groupe
  layoutAll();
  pushState();
  scheduleSaveOpenTabs();
}

// Onglet de navigation privée : session éphémère, rien n'est écrit sur disque.
// Ouvre une page d'accueil privée dédiée (pas la page d'accueil classique).
function openIncognitoTab() { createTab('zaalis://home/incognito.html', true, { incognito: true, focusOmnibox: true }); }

// Nouvel onglet ouvert par l'utilisateur (Ctrl+T, bouton +, menus) : comme
// Chrome, la barre d'adresse du haut est sélectionnée pour taper aussitôt.
function openNewTab() { return createTab('', true, { focusOmnibox: true }); }

// Pile des onglets récemment fermés (URLs) pour ⌘⇧T, comme Chrome.
let closedTabs = [];
function reopenClosedTab() {
  const u = closedTabs.pop();
  if (u) createTab(u, true);
}

// Onglet suivant / précédent (cyclique), comme Ctrl+Tab.
function cycleTab(dir) {
  if (tabs.length < 2 || active < 0) return;
  const i = (active + dir + tabs.length) % tabs.length;
  selectTab(tabs[i].id);
}

// Aller à l'onglet N (⌘1..⌘8) ; ⌘9 = dernier onglet, comme Chrome.
function gotoTab(n) {
  if (!tabs.length) return;
  const idx = n >= 9 ? tabs.length - 1 : Math.min(n - 1, tabs.length - 1);
  if (tabs[idx]) selectTab(tabs[idx].id);
}

// Ouvre le panneau réglages directement sur l'écran Historique (⌘Y).
function openHistoryPanel() {
  openPanel();
  if (panelLoaded) sendPanelHistory(); else pendingPanelHistory = true;
}

// « Installer comme application » (PWA-lite) : ajoute le site au lanceur d'apps
// pour un lancement en un clic, comme une application installée.
function installAsApp(id) {
  const t = tabs.find(x => x.id === id) || activeTab();
  if (!t) return;
  const wc = t.view.webContents;
  const u = wc.getURL();
  if (isInternal(u)) return;
  const title = (wc.getTitle() || u).slice(0, 60);
  if (!launcherApps.some(a => a.url === u)) {
    launcherApps.push({ url: u, title });
    launcherApps = launcherApps.slice(0, 30);
    saveLauncher();
    pushState();
  }
  if (mainWin) dialog.showMessageBox(mainWin, {
    type: 'info', buttons: ['OK'],
    message: '« ' + title +' » est installée comme application.',
    detail: 'Retrouvez-la dans le lanceur d\'apps (mode Créatif).',
  }).catch(() => {});
}

// Sessions réellement isolées : à chaque bascule de profil, on repart sur les
// onglets propres au profil (chaque profil ayant sa propre session persistée).
function rebuildTabsForProfile() {
  if (!mainWin) return;
  for (const t of tabs) {
    disposeDevTools(t);
    try { mainWin.contentView.removeChildView(t.view); } catch {}
    try { t.view.webContents.close(); } catch {}
  }
  tabs.length = 0; active = -1; splitPair = null;
  const saved = settings.restoreTabs ? loadSessionTabs() : null;
  if (saved && saved.urls.length) {
    saved.urls.forEach((u, i) => createTab(u, i === 0));
    if (tabs[saved.active]) selectTab(tabs[saved.active].id);
    runFeatureHooks('sessionRestored', saved);
  } else {
    createTab('', true);
  }
  layoutAll();
  preloadPanelView();
}

function toggleBookmark() {
  const t = activeTab();
  if (!t) return;
  const u = t.view.webContents.getURL();
  if (isInternal(u)) return;
  const i = bookmarks.findIndex(b => b.url === u);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ url: u, title: t.view.webContents.getTitle() || u });
  saveBookmarks();
  pushState();
}

function addShortcut(u, title) {
  if (!u) return;
  u = u.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
  if (shortcuts.some(s => s.url === u)) return;
  shortcuts.push({ url: u, title: (title || u).trim() });
  saveShortcuts();
  pushShortcuts();
}

function removeShortcut(u) {
  shortcuts = shortcuts.filter(s => s.url !== u);
  saveShortcuts();
  pushShortcuts();
}

function setTheme(t) {
  settings.theme = t === 'dark' ? 'dark' : 'light';
  saveSettings();
  applyChromeTheme();
  // Applique le theme immediatement aux pages deja ouvertes (avant ce fix,
  // le mode clair/sombre ne se propageait qu'a la prochaine navigation).
  const th = settings.theme;
  for (const tab of tabs) {
    if (!isInternal(tab.view.webContents.getURL())) continue;
    try {
      tab.view.webContents.executeJavaScript(`
        try { localStorage.setItem('zaalis_theme', '${th}'); } catch (e) {}
        if (document.body) {
          document.body.classList.toggle('dark-mode', '${th}' === 'dark');
          document.body.classList.toggle('dark',      '${th}' === 'dark');
        }
      `).catch(() => {});
    } catch {}
  }
  pushState();
  pushPanelState();
  pushAiPanelState();
}

function titleBarOverlayColors() {
  return settings.theme === 'dark'
    ? { color: '#202124', symbolColor: '#e8eaed', height: 38 }
    : { color: '#e9eaed', symbolColor: '#3c4043', height: 38 };
}

function applyChromeTheme() {
  const bg = settings.theme === 'dark' ? '#202124' : '#e9eaed';
  if (mainWin) mainWin.setBackgroundColor(bg);
  // Boutons Réduire / Agrandir / Fermer de Windows : suivent le thème choisi.
  if (mainWin && process.platform !== 'darwin') { try { mainWin.setTitleBarOverlay(titleBarOverlayColors()); } catch {} }
  for (const t of tabs) { try { t.view.setBackgroundColor(bg); } catch {} }
  if (findView && findBarOpen) sendFindOpen();
}

function setSearchEngine(e) {
  if (!['google','bing','duckduckgo','brave'].includes(e)) return;
  settings.searchEngine = e;
  saveSettings();
  pushState();
  pushPanelState();
}

function setZoomPct(v) {
  v = Math.max(67, Math.min(200, parseInt(v, 10) || 100));
  settings.zoomPct = v;
  saveSettings();
  for (const t of tabs) { try { t.view.webContents.setZoomFactor(v / 100); } catch {} }
  pushPanelState();
}

function resetSettings() {
  Object.assign(settings, {
    theme: 'light', offline: false, searchEngine: 'google',
    showBookmarks: true, historyEnabled: true, blockPopups: false,
    contextMenus: true, devTools: true, statusBar: true, zoomControls: true,
    restoreTabs: false, safeSearch: false,
    aiProvider: 'codex', aiSubmodel: 'gpt-5.5',
    voiceProvider: 'codex', voiceSubmodel: 'gpt-5.5',
    aiOverview: true, zoomPct: 100,
  });
  clearSessionTabs();
  saveSettings();
  applyChromeTheme();
  for (const t of tabs) { try { t.view.webContents.setZoomFactor(1); } catch {} }
  pushState();
  pushPanelState();
}

// ----- Panneau --------------------------------------------------------------

function lockInternalView(wc, allowedUrl) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, target) => {
    try {
      const a = new URL(allowedUrl), b = new URL(target);
      if (a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname) return;
    } catch {}
    event.preventDefault();
  });
}

function ensurePanelView() {
  if (panelView) return;
  panelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelView.setBackgroundColor('#00000000');
  lockInternalView(panelView.webContents, PANEL_URL);
  panelView.webContents.on('did-finish-load', () => {
    panelLoaded = true;
    pushPanelState();
    if (pendingPanelHistory) { sendPanelHistory(); pendingPanelHistory = false; }
    if (pendingPanelDownloads) { pendingPanelDownloads = false; showPanelDownloads(); }
  });
  panelView.webContents.loadURL(PANEL_URL);
}

function preloadPanelView() {
  if (panelPreloadTimer || panelView) return;
  panelPreloadTimer = setTimeout(() => {
    panelPreloadTimer = null;
    if (mainWin && !panelView) ensurePanelView();
  }, PANEL_PRELOAD_DELAY_MS);
  panelPreloadTimer.unref?.();
}

// Courbe symétrique, assez souple pour garder le glissement naturel sans
// ralentir sous le seuil d'un pixel par image à la toute fin.
function sendPanelVisibility(open) {
  if (!panelView || !panelLoaded) return;
  try { panelView.webContents.send('zaalis:message', { type: 'panelVisibility', open: !!open }); } catch {}
}

function showPanelAnimated() {
  if (panelHideTimer) { clearTimeout(panelHideTimer); panelHideTimer = null; }
  layoutPanel();
  sendPanelVisibility(true);
}

function hidePanelAnimated() {
  sendPanelVisibility(false);
  if (panelHideTimer) clearTimeout(panelHideTimer);
  panelHideTimer = setTimeout(() => {
    panelHideTimer = null;
    if (!panelOpen && panelView && panelViewVisible) {
      panelView.setVisible(false);
      panelViewVisible = false;
    }
  }, PANEL_ANIM_MS + 40);
}

function togglePanel() {
  ensurePanelView();
  panelOpen = !panelOpen;
  if (panelOpen) {
    closeAiPanel();                 // un seul panneau lateral a la fois
    mainWin.contentView.addChildView(panelView);
    showPanelAnimated();
  } else {
    hidePanelAnimated();
  }
  pushPanelState();
  pushState();
}

function openPanel() {
  if (!panelOpen) togglePanel();
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  hidePanelAnimated();
  pushState();
}

// ----- Rechercher dans la page (Ctrl+F) --------------------------------------
// Petite vue dédiée, suspendue sous la barre d'outils en haut à droite de la
// page, comme la barre de recherche de Chrome.
const FIND_URL = 'zaalis://home/find.html';
const FIND_WIDTH = 400, FIND_HEIGHT = 64;
let findView = null;
let findBarOpen = false;
let findText = '';
let findTabId = null;

function ensureFindView() {
  if (findView) return;
  findView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  findView.setBackgroundColor('#00000000');
  findView.setVisible(false);
  lockInternalView(findView.webContents, FIND_URL);
  findView.webContents.loadURL(FIND_URL);
}

function layoutFindBar(bodyTop, bodyWidth) {
  if (!findView) return;
  if (!findBarOpen || fullscreenTab()) { findView.setVisible(false); return; }
  findView.setBounds({
    x: Math.max(0, bodyWidth - FIND_WIDTH - 8), y: Math.max(0, bodyTop - 2),
    width: Math.min(FIND_WIDTH, bodyWidth), height: FIND_HEIGHT,
  });
  findView.setVisible(true);
}

function sendFindOpen() {
  if (!findView) return;
  try { findView.webContents.send('zaalis:message', { type: 'findOpen', theme: settings.theme, text: findText }); } catch {}
}

function openFindBar() {
  const t = activeTab();
  if (!t || !mainWin || fullscreenTab()) return;
  ensureFindView();
  if (findTabId !== null && findTabId !== t.id) stopFind();
  findBarOpen = true;
  findTabId = t.id;
  mainWin.contentView.addChildView(findView);   // au-dessus des onglets
  layoutAll();
  findView.webContents.focus();
  sendFindOpen();
  if (findText) runFind(findText, true, true);
}

function stopFind() {
  const t = tabs.find(x => x.id === findTabId);
  if (t && !t.view.webContents.isDestroyed()) { try { t.view.webContents.stopFindInPage('keepSelection'); } catch {} }
}

function closeFindBar() {
  if (!findBarOpen) return;
  stopFind();
  findBarOpen = false;
  findTabId = null;
  if (findView) findView.setVisible(false);
  const t = activeTab();
  if (t) { try { t.view.webContents.focus(); } catch {} }
}

function runFind(text, forward, newSession) {
  const t = activeTab();
  if (!t) return;
  findTabId = t.id;
  const wc = t.view.webContents;
  if (!text) {
    try { wc.stopFindInPage('clearSelection'); } catch {}
    return;
  }
  try { wc.findInPage(text, { forward: forward !== false, findNext: !!newSession }); } catch {}
}

let findNeedsNewSession = false;
function findAgain(forward) {
  if (!findBarOpen) { openFindBar(); return; }
  if (findText) { runFind(findText, forward, findNeedsNewSession); findNeedsNewSession = false; }
}

// Courbe conservee pour l'animation native du panneau de chat IA.
// ----- Panneau chat IA (zaalis labs ide) -------------------------------------
// Panneau lateral droit independant du panneau parametres : chat complet avec
// le modele choisi, conversations persistees dans aichats.json.

const AI_PANEL_WIDTH = 380;
let aiPanelView = null;
let aiPanelOpen = false;
let aiPanelLoaded = false;
let aiPanelVisible = false;
let aiPanelHideTimer = null;
let aiPanelBoundsKey = '';

let aiChats = [];            // [{ id, title, createdAt, updatedAt, messages: [{role, content}] }]
let aiCurrentChatId = null;
let aiChatBusy = false;      // une requete modele a la fois

function aiChatsFile() { return path.join(dataFolder, 'aichats.json'); }

function loadAiChats() {
  try {
    const d = JSON.parse(sealRead(aiChatsFile()));
    aiChats = Array.isArray(d) ? d.filter(c => c && c.id && Array.isArray(c.messages)) : [];
  } catch { aiChats = []; }
}

function saveAiChats() {
  try {
    // Garde les 80 conversations les plus recentes.
    if (aiChats.length > 80) aiChats = aiChats.slice(-80);
    sealWrite(aiChatsFile(), JSON.stringify(aiChats));
  } catch {}
}

function aiChatById(id) { return aiChats.find(c => c.id === id) || null; }

function newAiChat(title) {
  // Reutilise la conversation courante si elle est encore vide (evite les
  // conversations vides en serie quand on clique plusieurs fois sur "+").
  const cur = aiChatById(aiCurrentChatId);
  if (cur && cur.messages.length === 0) {
    if (title) { cur.title = title; saveAiChats(); }
    return cur;
  }
  const chat = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title || 'Nouvelle conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  aiChats.push(chat);
  aiCurrentChatId = chat.id;
  saveAiChats();
  return chat;
}

function aiPanelSend(msg) {
  if (aiPanelView) { try { aiPanelView.webContents.send('zaalis:message', msg); } catch {} }
}

function pushAiPanelState() {
  aiPanelSend({
    type: 'aiPanelState',
    theme: settings.theme,
    modelLabel: aiModelLabel(),
    providerLabel: (AI_PROVIDERS[settings.aiProvider] || {}).label || '',
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    aiConnected: ideStatus === 'connected',
  });
}

function pushAiChatList() {
  const items = aiChats.slice().reverse().map(c => ({
    id: c.id,
    title: c.title,
    count: c.messages.length,
    updatedAt: c.updatedAt,
  }));
  aiPanelSend({ type: 'aiChats', items, currentId: aiCurrentChatId });
}

function pushAiChatMessages() {
  const chat = aiChatById(aiCurrentChatId);
  aiPanelSend({
    type: 'aiChatMessages',
    id: chat ? chat.id : null,
    title: chat ? chat.title : '',
    messages: chat ? chat.messages : [],
    busy: aiChatBusy,
  });
}

function ensureAiPanelView() {
  if (aiPanelView) return;
  aiPanelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aiPanelView.setBackgroundColor('#00000000');
  lockInternalView(aiPanelView.webContents, 'zaalis://home/aichat.html');
  aiPanelView.webContents.on('did-finish-load', () => {
    aiPanelLoaded = true;
    pushAiPanelState();
    pushAiChatList();
    pushAiChatMessages();
    sendAiPanelVisibility(aiPanelOpen);
  });
  aiPanelView.webContents.loadURL('zaalis://home/aichat.html');
}

function layoutAiPanel() {
  if (!mainWin || !aiPanelView) return;
  if (!aiPanelOpen && !aiPanelVisible) return;
  const [w, h] = mainWin.getContentSize();
  const bounds = {
    x: Math.max(0, w - AI_PANEL_WIDTH), y: 94,
    width: AI_PANEL_WIDTH, height: Math.max(0, h - 94),
  };
  const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  if (key !== aiPanelBoundsKey) {
    aiPanelView.setBounds(bounds);
    aiPanelBoundsKey = key;
  }
  if (aiPanelOpen && !aiPanelVisible) {
    aiPanelView.setVisible(true);
    aiPanelVisible = true;
  }
}

function sendAiPanelVisibility(open) {
  if (!aiPanelView || !aiPanelLoaded) return;
  try { aiPanelView.webContents.send('zaalis:message', { type: 'aiPanelVisibility', open: !!open }); } catch {}
}

function showAiPanelAnimated() {
  if (aiPanelHideTimer) { clearTimeout(aiPanelHideTimer); aiPanelHideTimer = null; }
  layoutAiPanel();
  sendAiPanelVisibility(true);
}

function hideAiPanelAnimated() {
  sendAiPanelVisibility(false);
  if (aiPanelHideTimer) clearTimeout(aiPanelHideTimer);
  aiPanelHideTimer = setTimeout(() => {
    aiPanelHideTimer = null;
    if (!aiPanelOpen && aiPanelView && aiPanelVisible) {
      aiPanelView.setVisible(false);
      aiPanelVisible = false;
    }
  }, PANEL_ANIM_MS + 40);
}

function openAiPanel() {
  ensureAiPanelView();
  if (aiPanelOpen) return;
  closePanel();                     // un seul panneau lateral a la fois
  aiPanelOpen = true;
  layoutAll();                      // reserve la place de la page pendant l'ouverture
  mainWin.contentView.addChildView(aiPanelView);
  showAiPanelAnimated();
  pushAiPanelState();
  pushAiChatList();
  pushAiChatMessages();
  pushState();
}

function closeAiPanel() {
  if (!aiPanelOpen) return;
  aiPanelOpen = false;
  layoutAll();                      // rend toute sa largeur à la page pendant la fermeture
  hideAiPanelAnimated();
  pushState();
}

function toggleAiPanel() { aiPanelOpen ? closeAiPanel() : openAiPanel(); }

// Envoi d'un message dans la conversation courante (creee au besoin).
// ----- Agent IA outillé (comme l'extension Claude dans Chrome) ---------------
// Agent IA outillé (comme l'extension Claude dans Chrome) : outils, vision, actions natives, protocole DevTools, boucle de chat.
// (code dans src/core/agent.js ; dépendances injectées ci-dessous)
const AGENT = require('./src/core/agent').init({
  get aiPanelOpen() { return aiPanelOpen; },
  get aiPanelView() { return aiPanelView; },
  get AGENT_SELFTEST() { return AGENT_SELFTEST; },
  get activeTab() { return activeTab; },
  get aiChatBusy() { return aiChatBusy; }, set aiChatBusy(v) { aiChatBusy = v; },
  get aiChatById() { return aiChatById; },
  get aiCurrentChatId() { return aiCurrentChatId; },
  get aiPanelSend() { return aiPanelSend; },
  get allowedPageUrl() { return allowedPageUrl; },
  get chromeUserAgent() { return chromeUserAgent; },
  get closeTab() { return closeTab; },
  get createTab() { return createTab; },
  get hostOf() { return hostOf; },
  get ideChat() { return ideChat; },
  get isInternal() { return isInternal; },
  get mainWin() { return mainWin; },
  get newAiChat() { return newAiChat; },
  get openAiPanel() { return openAiPanel; },
  get pushAiChatList() { return pushAiChatList; },
  get pushAiChatMessages() { return pushAiChatMessages; },
  get resolveQuery() { return resolveQuery; },
  get saveAiChats() { return saveAiChats; },
  get selectTab() { return selectTab; },
  get tabs() { return tabs; },
  get uniqueDownloadPath() { return uniqueDownloadPath; },
});
const { agentTokenEstimate, waitLoad, agentExec, setAiControlBorder, agentHoldCursor, agentShowAction, nativeClick, nativeKeyTap, cssToDip, nativeMouseClick, nativeKeyCombo, agentPoint, agentScreenshot, ensureDebugger, startNetworkCapture, runAgentTool, quickPageContext, ideErrorReply, aiChatSend, askAiAboutPage } = AGENT;

// ----- Recherche vocale ------------------------------------------------------
// Le navigateur conserve l'orbe et la capture vocale, mais ne déclenche plus
// de conversation IA ni de synthèse : la phrase est transcrite localement par
// zaalis labs IDE puis devient immédiatement une recherche Web, façon recherche
// vocale Google. `voiceGen` annule un résultat devenu périmé à l'arrêt.
let voiceGen = 0;
let voiceWc = null;

function voiceSend(msg) {
  if (!voiceWc || voiceWc.isDestroyed()) return;
  try { voiceWc.send('zaalis:message', msg); } catch {}
}

async function voiceStart(sender) {
  voiceGen++;
  voiceWc = sender;
  if (ideStatus !== 'connected') {
    voiceSend({ type: 'voiceState', phase: 'error', message: ideStatusMessage || 'zaalis labs ide n\'est pas joignable.' });
    return;
  }
  // macOS : déclenche la demande d'accès micro système au nom de l'app.
  // Windows requests microphone access through its privacy settings; the
  // Electron permission handler below receives the actual media request.
  let st = null;
  try { st = (await ideProbe('/api/voice-status', 4000, true)).body; } catch {}
  if (!st || !st.stt || !st.stt.ready) {
    const hint = (st && st.stt && st.stt.hint) ||
      'La transcription vocale est indisponible (zaalis labs ide ne répond pas).';
    const dl = st && st.stt && st.stt.pull;
    voiceSend({ type: 'voiceState', phase: dl ? 'preparing' : 'error', message: hint });
    if (!dl) return;
    // Modèle en cours de téléchargement : la page ré-essaiera (bouton/retry).
  }
  voiceSend({ type: 'voiceState', phase: 'listening' });
}

function voiceStop() {
  voiceGen++;
  voiceWc = null;
}

// Un tour de recherche : audio utilisateur → texte → recherche Web.
async function voiceTurn(sender, audioB64) {
  const gen = ++voiceGen;      // ce tour remplace tout tour précédent
  voiceWc = sender;
  const alive = () => gen === voiceGen && voiceWc && !voiceWc.isDestroyed();
  try {
    voiceSend({ type: 'voiceState', phase: 'thinking' });
    let stt;
    try { stt = await idePost('/api/stt', { audio: audioB64, language: 'fr' }, 150000); }
    catch (e) {
      const m = String(e && e.message || '');
      if (!alive()) return;
      voiceSend({ type: 'voiceState', phase: m.includes('model-downloading') ? 'preparing' : 'error',
                  message: m.includes('model-downloading') ? 'Le modèle vocal se télécharge, un instant…'
                         : m.includes('speech-denied') ? 'Autorisez la reconnaissance vocale pour zaalis labs IDE dans les réglages macOS.'
                         : m.includes('windows-speech-language-unavailable') ? 'Installez la reconnaissance vocale française dans les paramètres de langue de Windows.'
                         : m.includes('stt-unavailable') ? 'La reconnaissance vocale n’est pas disponible sur ce PC.'
                         : ('Transcription impossible : ' + m) });
      return;
    }
    if (!alive()) return;
    const heard = String(stt.text || '').trim();
    // Rien d'intelligible (souffle, bruit) : on se remet à l'écoute.
    if (!heard || /^[\[(]/.test(heard)) { voiceSend({ type: 'voiceState', phase: 'listening' }); return; }
    voiceSend({ type: 'voiceState', phase: 'searching', transcript: heard,
                message: 'Recherche de « ' + heard + ' »' });
    // Court temps d'affichage de la transcription, puis ouverture du moteur
    // choisi. Aucun appel LLM/TTS n'est effectué dans ce flux.
    setTimeout(() => {
      if (!alive()) return;
      navigateActive(resolveQuery(heard));
      voiceGen++;
      voiceWc = null;
    }, 180);
  } catch (e) {
    if (gen === voiceGen) voiceSend({ type: 'voiceState', phase: 'error', message: String(e && e.message || e) });
  }
}

// ----- Traduction de page (via zaalis labs ide) -----------------------------

let translating = false;
async function translatePage(targetLang) {
  // Module de traduction (src/features/translate.js) : détection de langue,
  // bulle, lots illimités, « Afficher l'original ».
  if (featureModules.translate && featureModules.translate.translateActive) return featureModules.translate.translateActive(targetLang);
  const t = activeTab();
  if (!t || translating) return;
  const wc = t.view.webContents;
  const lang = targetLang || 'français';
  let segs = [];
  try { segs = await wc.executeJavaScript(TRANSLATE_EXTRACT_JS, true); } catch { segs = []; }
  if (!Array.isArray(segs) || !segs.length) return;
  translating = true;
  if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: 'Traduction en cours…' });
  try {
    const payload = segs.map(s => s.i + '\t' + s.t).join('\n');
    const out = await ideChat({
      message: 'Traduis en ' + lang + ' chaque segment ci-dessous. Réponds UNIQUEMENT par un objet JSON ' +
               '{"index": "traduction"} sans autre texte. Conserve les nombres et noms propres.\n\n' + payload,
      systemPrompt: 'Tu es un moteur de traduction. Tu renvoies exclusivement du JSON valide.',
      timeoutMs: 90000,
    });
    const m = out.response.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no-json');
    const map = JSON.parse(m[0]);
    const clean = {};
    for (const k of Object.keys(map)) { const v = map[k]; if (typeof v === 'string') clean[String(parseInt(k, 10))] = v; }
    await wc.executeJavaScript(
      '(() => { const map = ' + JSON.stringify(clean) + '; const nodes = window.__zTransNodes || [];' +
      'let c=0; Object.keys(map).forEach(k => { const nd = nodes[+k]; if (nd && map[k]) { nd.nodeValue = map[k]; c++; } });' +
      'window.__zTransDone = true; return c; })()', true);
    if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: 'Page traduite.' });
  } catch (e) {
    const msg = String(e && e.message || '');
    const txt = msg.startsWith('no-secret') || msg.startsWith('no-key')
      ? 'Traduction indisponible : configure l\'IA dans zaalis labs ide.'
      : 'La traduction a échoué. Réessaie.';
    if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: txt });
  } finally {
    translating = false;
  }
}

// ----- Controle media -------------------------------------------------------


async function getTabMediaState(tab) {
  const wc = tab && tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed() || tab.discarded) return null;   // onglet en veille : pas de page
  try {
    const st = await wc.executeJavaScript(MEDIA_STATE_JS, true);
    if (st && st.available) {
      st.tabId = tab.id;
      st.url = wc.getURL();
      return st;
    }
  } catch {}
  try {
    if (wc.isCurrentlyAudible && wc.isCurrentlyAudible()) {
      return {
        type: 'mediaState',
        available: true,
        active: true,
        paused: false,
        current: 0,
        duration: 0,
        title: wc.getTitle() || 'Media',
        artist: '',
        artwork: '',
        host: new URL(wc.getURL()).hostname.replace(/^www\\./, ''),
        captionsOn: false,
        tabId: tab.id,
        url: wc.getURL(),
      };
    }
  } catch {}
  return null;
}

async function sendMediaState() {
  if (!chromeView) return;
  const ordered = [];
  const act = activeTab();
  if (act) ordered.push(act);
  for (const t of tabs) if (!act || t.id !== act.id) ordered.push(t);
  for (const t of ordered) {
    const st = await getTabMediaState(t);
    if (st) { chromeView.webContents.send('zaalis:message', st); return; }
  }
  chromeView.webContents.send('zaalis:message', { type: 'mediaState', available: false });
}

async function runMediaCommand(cmd, tabId) {
  const id = parseInt(tabId, 10);
  let tab = tabs.find(t => t.id === id) || activeTab();
  if (!tab) return;
  try { await tab.view.webContents.executeJavaScript(mediaCommandJS(cmd), true); } catch {}
  setTimeout(sendMediaState, 120);
}

// ----- Modules de fonctionnalités (src/features/*) -------------------------
// Chaque fonctionnalité (mises à jour, extensions, mots de passe…) vit dans
// son propre fichier et reçoit ce contexte. main.js n'expose que des points
// d'accroche : actions du bus, hooks d'onglets / de sessions, état poussé à
// l'interface, pages internes autorisées et canal des scripts de contenu.
const featureActions = new Map();   // action -> { fn, pages:Set<'x.html'>, views:Set<'find'|…> }
const featureHooks = {
  session: [], tabCreated: [], tabClosed: [], tabActivated: [], ready: [], quit: [], contextMenu: [],
  contextMenu: [],   // fn(items, { tab, wc, params, internal, pageUrl }) : ajoute des entrées au menu de page
  tabsReordered: [], sessionRestored: [],   // groupes d'onglets, restauration de session
};
// Icônes de fonctionnalités dans l'omnibox (traduire, lecture, QR…) et dans la
// barre d'outils (Cast…). fn(tabActif) -> { title, svg, active } | null ;
// onClick(anchor:{x,y,w,h} en coordonnées de la fenêtre, tab).
const featureUiActions = { omni: new Map(), toolbar: new Map() };
function featureUiList(where) {
  const t = active >= 0 ? tabs[active] : null;
  const out = [];
  for (const [id, a] of featureUiActions[where]) {
    try { const v = a.fn(t); if (v) out.push({ id, title: String(v.title || ''), svg: String(v.svg || ''), active: !!v.active }); } catch {}
  }
  return out;
}
const featureStateFns = { chrome: [], panel: [], session: [] };
const featureTabStateFns = [];
const featurePageHandlers = new Map();   // canal 'zaalis:page' -> fn(payload, ctx)
const featureViews = new Map();          // webContents -> nom de vue (popups d'extension…)
const featureModules = {};

function runFeatureHooks(kind, ...args) {
  for (const fn of featureHooks[kind] || []) {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch(e => console.error('[feature:' + kind + ']', e));
    } catch (e) { console.error('[feature:' + kind + ']', e); }
  }
}
function featureState(target) {
  const out = {};
  for (const fn of featureStateFns[target] || []) { try { Object.assign(out, fn() || {}); } catch (e) { console.error('[feature:state]', e); } }
  if (target === 'chrome') { out.omniActions = featureUiList('omni'); out.toolbarActions = featureUiList('toolbar'); }
  return out;
}
function featureTabState(t) {
  const out = {};
  for (const fn of featureTabStateFns) { try { Object.assign(out, fn(t) || {}); } catch {} }
  return out;
}
function featureViewTrusted(sender, action) {
  const view = featureViews.get(sender);
  if (!view) return false;
  const fa = featureActions.get(action);
  return !!(fa && fa.views.has(view));
}

// Raccourcis d'adresse : zaalis://extensions, chrome://settings… -> page interne.
const INTERNAL_ALIASES = new Map();
// URL de schémas propres aux modules (chrome-extension://…) : ctx.allowUrl(fn).
const featureUrlChecks = [];
function featureUrlAllowed(u) { return featureUrlChecks.some(fn => { try { return !!fn(u); } catch { return false; } }); }
function internalAlias(q) {
  if (/^chrome-extension:\/\//i.test(q) && featureUrlAllowed(q)) return q;
  const m = /^(?:zaalis|chrome|edge|about):\/{0,2}([a-z0-9-]+)\/?(.*)$/i.exec(q);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (host === 'home') return null;
  const page = INTERNAL_ALIASES.get(host);
  return page ? 'zaalis://home/' + page + (m[2] ? (m[2].startsWith('#') || m[2].startsWith('?') ? m[2] : '#' + m[2]) : '') : null;
}

// Canal des scripts de contenu (preload-content.js) : uniquement depuis un
// onglet connu. Chaque message porte { kind, ... } ; la réponse est renvoyée.
function tabOfWebContents(wc) { return tabs.find(t => t.view && t.view.webContents === wc) || null; }
ipcMain.handle('zaalis:page', async (event, payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string') return null;
  const tab = tabOfWebContents(event.sender);
  if (!tab) return null;
  const fn = featurePageHandlers.get(payload.kind);
  if (!fn) return null;
  const frame = event.senderFrame;
  let frameUrl = '';
  try { frameUrl = frame ? frame.url : event.sender.getURL(); } catch {}
  try {
    return await fn(payload, { tab, wc: event.sender, frame, frameUrl, origin: originOf(frameUrl), isMainFrame: !frame || frame === event.sender.mainFrame });
  } catch (e) { console.error('[feature:page]', payload.kind, e); return null; }
});

const featureCtx = {
  electron, app, path, fs, os, crypto, SEP,
  get mainWin() { return mainWin; },
  get chromeView() { return chromeView; },
  get panelView() { return panelView; },
  get tabs() { return tabs; },
  get splitPair() { return splitPair; },
  // Nouvel ordre des onglets (mêmes objets) ; l'onglet actif est conservé.
  setTabOrder(list) {
    const id = activeTab() ? activeTab().id : -1;
    if (list.length !== tabs.length || list.some(t => !tabs.includes(t))) return false;
    tabs.length = 0; tabs.push(...list);
    active = tabs.findIndex(t => t.id === id);
    makeSplitAdjacent();
    return true;
  },
  // Remplace l'objet onglet `oldTab` par `newTab` (même place, même actif).
  replaceTab(oldTab, newTab) {
    const wasActive = activeTab() === oldTab;
    const ni = tabs.indexOf(newTab);
    if (ni >= 0) tabs.splice(ni, 1);
    const oi = tabs.indexOf(oldTab);
    if (oi < 0) return false;
    tabs.splice(oi, 1, newTab);
    if (wasActive) active = oi;
    else { const cur = active >= 0 && active < tabs.length ? tabs[active] : null; active = cur ? tabs.indexOf(cur) : active; }
    if (splitPair) splitPair = splitPair.map(x => (x === oldTab.id ? newTab.id : x));
    return true;
  },
  get dataFolder() { return dataFolder; },
  get currentProfileId() { return currentProfileId; },
  get bookmarks() { return bookmarks; },
  set bookmarks(v) { bookmarks = v; },
  get history() { return history; },
  set history(v) { history = v; },
  get shortcuts() { return shortcuts; },
  set shortcuts(v) { shortcuts = v; },
  saveShortcuts: () => { saveShortcuts(); pushShortcuts(); },
  settings,
  activeTab: () => activeTab(),
  tabById: (id) => tabs.find(t => t.id === id) || null,
  tabOfWebContents,
  createTab: (...a) => createTab(...a),
  closeTab: (id) => closeTab(id),
  selectTab: (id) => selectTab(id),
  navigateActive: (u) => navigateActive(u),
  resolveQuery: (q) => resolveQuery(q),
  layoutAll: () => layoutAll(),
  pushState: () => pushState(),
  pushPanelState: () => pushPanelState(),
  saveSettings: () => saveSettings(),
  saveBookmarks: () => saveBookmarks(),
  saveHistory: () => saveHistory(),
  scheduleSaveOpenTabs: () => scheduleSaveOpenTabs(),
  openPanel: () => openPanel(),
  handleAction: (a, args, event) => handleAction(a, args || [], event),
  browserPartition: () => browserPartition(),
  setupSession: (p) => setupSession(p),
  readyPartitions,
  INCOGNITO_PARTITION,
  profileDataDir: () => profileDataDir(),
  sealAvailable: () => sealAvailable(),
  sealWrite: (f, t) => sealWrite(f, t),
  sealRead: (f) => sealRead(f),
  isInternal: (u) => isInternal(u),
  originOf: (u) => originOf(u),
  hostOf: (u) => hostOf(u),
  escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  chromeUserAgent: () => chromeUserAgent(),
  ideChat: (o) => ideChat(o),
  get ideStatus() { return ideStatus; },
  raiseOverlays: () => raiseOverlays(),
  get contentTop() { return contentTop; },
  get chromeHeight() { return chromeHeight; },
  // Messages vers l'interface.
  sendChrome: (msg) => { try { if (chromeView) chromeView.webContents.send('zaalis:message', msg); } catch {} },
  sendPanel:  (msg) => { try { if (panelView) panelView.webContents.send('zaalis:message', msg); } catch {} },
  toast: (text) => { try { if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: String(text) }); } catch {} },
  reply: (event, msg) => { try { if (event && event.sender && !event.sender.isDestroyed()) event.sender.send('zaalis:message', msg); } catch {} },
  // Points d'accroche.
  // opts.pages : pages internes (onglets zaalis://home/<page>) autorisées à
  // envoyer l'action ; opts.views : vues annexes (popups) autorisées. Le chrome,
  // le panneau et le panneau IA sont toujours autorisés.
  action(name, fn, opts) {
    opts = opts || {};
    featureActions.set(name, { fn, pages: new Set(opts.pages || []), views: new Set(opts.views || []) });
  },
  on(kind, fn) { if (!featureHooks[kind]) throw new Error('hook inconnu : ' + kind); featureHooks[kind].push(fn); },
  state(target, fn) { featureStateFns[target].push(fn); },
  tabState(fn) { featureTabStateFns.push(fn); },
  page(kind, fn) { featurePageHandlers.set(kind, fn); },
  alias(host, page) { INTERNAL_ALIASES.set(String(host).toLowerCase(), page); },
  allowUrl(fn) { featureUrlChecks.push(fn); },
  trustView(wc, name) { featureViews.set(wc, name); wc.once('destroyed', () => featureViews.delete(wc)); },
  module: (name) => featureModules[name] || null,
  // Icône dans l'omnibox / la barre d'outils (voir featureUiActions).
  omniAction(id, fn, onClick) { featureUiActions.omni.set(id, { fn, onClick }); },
  toolbarAction(id, fn, onClick) { featureUiActions.toolbar.set(id, { fn, onClick }); },
  // RPC pour les pages internes (interface/zx.js : zx.call(nom, params)).
  // args[0] = identifiant de requête, args[1] = paramètres JSON. La réponse
  // { type:'rpc', id, ok, result | error } est renvoyée à l'émetteur.
  rpc(name, fn, opts) {
    featureCtx.action(name, async (args, event) => {
      const id = args[0];
      let params = {};
      try { params = args[1] ? JSON.parse(args.slice(1).join(SEP)) : {}; } catch {}
      try {
        const result = await fn(params || {}, event);
        featureCtx.reply(event, { type: 'rpc', id, ok: true, result: result === undefined ? null : result });
      } catch (e) {
        featureCtx.reply(event, { type: 'rpc', id, ok: false, error: String(e && e.message || e) });
      }
    }, opts);
  },
  // Ouvre (ou ré-affiche) une page interne zaalis://home/<page>.
  openInternal(page) {
    const file = String(page || '').replace(/[^a-z0-9._#?=&-]/gi, '');
    if (!file) return null;
    const target = 'zaalis://home/' + (file.includes('.html') ? file : file + '.html');
    const base = target.split('#')[0].split('?')[0];
    const existing = tabs.find(t => !t.incognito && (t.view.webContents.getURL() || '').split('#')[0].split('?')[0] === base);
    if (panelOpen) closePanel();
    if (existing) {
      selectTab(existing.id);
      if (existing.view.webContents.getURL() !== target) existing.view.webContents.loadURL(target).catch(() => {});
      return existing;
    }
    const cur = activeTab();
    const curUrl = cur ? cur.view.webContents.getURL() : '';
    if (cur && !cur.incognito && (curUrl === HOME_URL || curUrl === '' || curUrl === 'zaalis://home/')) {
      cur.view.webContents.loadURL(target).catch(() => {});
      return cur;
    }
    return createTab(target, true);
  },
  // Petites aides de persistance JSON (chiffrées si demandé).
  readJson(file, fallback, sealed) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(sealed ? sealRead(file) : fs.readFileSync(file, 'utf8'));
    } catch { return fallback; }
  },
  writeJson(file, data, sealed) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = JSON.stringify(data);
      if (sealed) sealWrite(file, text);
      else { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
      return true;
    } catch (e) { console.error('[feature:writeJson]', file, e.message); return false; }
  },
};

function loadFeatures() {
  featureCtx.action('openInternal', (args) => featureCtx.openInternal(args[0]), { pages: ['*'] });
  // Clic sur une icône de fonctionnalité du chrome : id, x, y, w, h.
  featureCtx.action('featureUiClick', (args) => {
    const a = featureUiActions.omni.get(args[0]) || featureUiActions.toolbar.get(args[0]);
    if (!a || typeof a.onClick !== 'function') return;
    const n = (i) => Math.round(parseFloat(args[i]) || 0);
    return a.onClick({ x: n(1), y: n(2), w: n(3), h: n(4) }, activeTab());
  });
  let list = [];
  try { list = require('./src/features'); } catch (e) { console.error('[features] liste introuvable', e); return; }
  for (const name of list) {
    try {
      const mod = require('./src/features/' + name);
      featureModules[name] = (mod && typeof mod.init === 'function' ? mod.init(featureCtx) : null) || mod;
    } catch (e) { console.error('[features] échec du module', name, e); }
  }
}

// ----- Tests de bout en bout maison -----------------------------------------
// ZAALIS_E2E=updater,extensions … exécute tests/e2e/<nom>.test.js dans le
// processus principal, une fois la fenêtre prête, puis quitte (code 0 / 1).
async function runE2E(spec) {
  const names = spec === 'all'
    ? fs.readdirSync(path.join(__dirname, 'tests', 'e2e')).filter(f => f.endsWith('.test.js')).map(f => f.replace(/\.test\.js$/, ''))
    : spec.split(',').map(s => s.trim()).filter(Boolean);
  let failed = 0, passed = 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t = {
    ok(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } },
    eq(a, b, msg) { t.ok(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (obtenu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)})`)); },
    sleep,
    async waitFor(fn, timeoutMs, label) {
      const end = Date.now() + (timeoutMs || 10000);
      while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); }
      throw new Error('délai dépassé : ' + (label || 'condition'));
    },
    async waitLoad(wc, timeoutMs) {
      await sleep(50);
      await t.waitFor(() => !wc.isLoading(), timeoutMs || 15000, 'chargement de ' + wc.getURL());
    },
    // Envoie une action au bus comme si elle venait du chrome.
    action(name, ...args) { handleAction(name, args.map(String), chromeView ? { sender: chromeView.webContents } : null); },
  };
  await sleep(800);
  for (const name of names) {
    console.log('▶ ' + name);
    try {
      const fn = require(path.join(__dirname, 'tests', 'e2e', name + '.test.js'));
      await fn(t, featureCtx, { modules: featureModules, http, net, session, WebContentsView, BrowserWindow, dialog });
    } catch (e) { failed++; console.log('  ✗ exception : ' + (e && e.stack || e)); }
  }
  console.log(`\nE2E : ${passed} réussi(s), ${failed} échec(s)`);
  app.exit(failed ? 1 : 0);
}

// ----- Bus de messages ------------------------------------------------------

function handleAction(a, args, event) {
  const arg = i => (i < args.length ? args[i] : '');
  switch (a) {
    case 'ready':          pushState(); pushAiStatusToTabs(); pushShortcuts(); pushAiMode(); pushDownloads(); break;
    case 'chromeHeight': {
      const h   = parseInt(arg(0), 10) || chromeHeight;
      const top = args.length > 1 ? (parseInt(arg(1), 10) || h) : h;
      chromeOverlay = args.length > 5;
      if (chromeOverlay) {
        chromeOverlayRect = {
          left:   parseInt(arg(2), 10) || 0,
          top:    parseInt(arg(3), 10) || 0,
          right:  parseInt(arg(4), 10) || 0,
          bottom: parseInt(arg(5), 10) || 0,
        };
      } else {
        chromeOverlayRect = { left:0, top:0, right:0, bottom:0 };
      }
      if (h > 40 && h < 620 && top > 40 && top < 620) {
        chromeHeight = h;
        contentTop = top;
        layoutAll();
      }
      break;
    }
    case 'newTab':         openNewTab(); break;
    case 'newIncognito':   openIncognitoTab(); break;
    case 'openInNewTab':   createTab(arg(0), true); break;
    case 'closeTab':       closeTab(parseInt(arg(0), 10)); break;
    case 'selectTab':      selectTab(parseInt(arg(0), 10)); break;
    case 'reorderTabs':    reorderTabs(arg(0)); break;
    case 'tabMenu':        showTabMenu(parseInt(arg(0), 10)); break;
    case 'pinTab':         togglePinTab(parseInt(arg(0), 10)); break;
    case 'installApp':     installAsApp(parseInt(arg(0), 10)); break;
    case 'translatePage':  translatePage('français'); break;
    case 'toggleDevTools': toggleDevTools(false); break;
    case 'devGripMove':    dragDevGrip(tabOfDevGrip(event && event.sender)); break;
    case 'devGripEnd':     saveSettings(); break;
    case 'devGripMenu':    showDevGripMenu(tabOfDevGrip(event && event.sender)); break;
    case 'splitWith':      setSplit(parseInt(arg(0), 10)); break;
    case 'unsplit':        clearSplit(); break;
    case 'navigate':       navigateActive(resolveQuery(arg(0))); break;
    case 'setAiMode': {
      // Bascule du mode IA : refusee si l'IDE n'est pas joignable (l'UI le
      // signale de son cote). Diffuse aux deux barres pour un degrade unifie.
      const on = arg(0) === '1';
      if (on && ideStatus !== 'connected') { refreshIdeStatus(true); break; }
      if (aiSearchOn !== on) { aiSearchOn = on; pushAiMode(); }
      break;
    }
    case 'suggest': {
      // Suggestions de saisie facon Google. On repond a l'emetteur (barre
      // d'adresse ou accueil). `seq` permet d'ignorer les reponses perimees.
      const seq = arg(0), q = arg(1);
      const sender = event ? event.sender : null;
      if (!sender) break;
      if (settings.offline) { try { sender.send('zaalis:message', { type: 'suggest', seq, query: q, items: [] }); } catch {} break; }
      fetchSuggest(q).then(items => {
        try { sender.send('zaalis:message', { type: 'suggest', seq, query: q, items }); } catch {}
      });
      break;
    }
    case 'aiSearch':       aiSearch(arg(0)); break;
    case 'runAiSearch':    runAiSearch(arg(0), event ? event.sender : null); break;
    // ----- Mode vocal (page d'accueil) -----
    case 'voiceStart':     if (event) voiceStart(event.sender); break;
    case 'voiceStop':      voiceStop(); break;
    case 'voiceAudio':     if (event) voiceTurn(event.sender, arg(0)); break;
    case 'setAiProvider': {
      const p = arg(0);
      if (AI_PROVIDERS[p]) {
        settings.aiProvider = p;
        if (!validAiChoice(p, settings.aiSubmodel)) settings.aiSubmodel = AI_PROVIDERS[p].submodels[0] || settings.aiSubmodel;
        saveSettings(); pushPanelState(); pushAiPanelState();
      }
      break;
    }
    case 'setAiSubmodel':  if (validAiChoice(settings.aiProvider, arg(0))) { settings.aiSubmodel = arg(0); saveSettings(); pushPanelState(); pushAiPanelState(); } break;
    case 'setVoiceProvider': {
      const p = arg(0);
      if (AI_PROVIDERS[p]) {
        settings.voiceProvider = p;
        if (!validAiChoice(p, settings.voiceSubmodel)) settings.voiceSubmodel = AI_PROVIDERS[p].submodels[0] || settings.voiceSubmodel;
        saveSettings(); pushPanelState();
      }
      break;
    }
    case 'setVoiceSubmodel':
      if (validAiChoice(settings.voiceProvider, arg(0))) { settings.voiceSubmodel = arg(0); saveSettings(); pushPanelState(); }
      break;
    case 'setAiOverview':  settings.aiOverview = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setAiConnect':    settings.aiConnectEnabled = arg(0) === '1'; saveSettings(); refreshIdeStatus(true); break;
    case 'refreshAiStatus': refreshIdeStatus(true); break;
    case 'toggleAiPanel':  toggleAiPanel(); break;
    case 'closeAiPanel':   closeAiPanel(); break;
    case 'askAiPage':      askAiAboutPage(); break;
    case 'aiPanelReady':
      aiPanelLoaded = true;
      pushAiPanelState(); pushAiChatList(); pushAiChatMessages(); sendAiPanelVisibility(aiPanelOpen);
      break;
    case 'aiChatSend':     aiChatSend(args.join(SEP)); break;
    case 'aiChatNew':      newAiChat(); pushAiChatList(); pushAiChatMessages(); break;
    case 'aiChatSelect':   if (aiChatById(arg(0))) { aiCurrentChatId = arg(0); pushAiChatList(); pushAiChatMessages(); } break;
    case 'aiChatDelete': {
      const id = arg(0);
      aiChats = aiChats.filter(c => c.id !== id);
      if (aiCurrentChatId === id) aiCurrentChatId = aiChats.length ? aiChats[aiChats.length - 1].id : null;
      saveAiChats(); pushAiChatList(); pushAiChatMessages();
      break;
    }
    case 'profileCreate':  createProfile(arg(0)); break;
    case 'profileSelect':  selectProfile(arg(0)); break;
    case 'profileRename':  renameProfile(arg(0), arg(1)); break;
    case 'profileColor':   setProfileColor(arg(0), arg(1)); break;
    case 'profileDelete':  deleteProfile(arg(0)); break;
    case 'profilePhoto':   chooseProfilePhoto(arg(0)); break;
    case 'openBookmark':   navigateActive(arg(0)); break;
    case 'removeBookmark': {
      const u = arg(0);
      const i = bookmarks.findIndex(b => b.url === u);
      if (i >= 0) { bookmarks.splice(i, 1); saveBookmarks(); pushState(); }
      break;
    }
    case 'bookmarkToggle': toggleBookmark(); break;
    case 'addShortcut':    addShortcut(arg(0), arg(1)); break;
    case 'removeShortcut': removeShortcut(arg(0)); break;
    case 'launcherSetMode':
      if (arg(0) === 'travail' || arg(0) === 'creatif') { launcherMode = arg(0); saveLauncher(); pushState(); }
      break;
    case 'launcherAdd': {
      const u = normalizeShortcutUrl(arg(0));
      if (u && !launcherApps.some(a => a.url === u) && launcherApps.length < 30) {
        launcherApps.push({ url: u, title: String(arg(1) || u).replace(/\x1f/g, ' ').trim().slice(0, 60) });
        saveLauncher(); pushState();
      }
      break;
    }
    case 'launcherRemove':
      launcherApps = launcherApps.filter(a => a.url !== arg(0));
      saveLauncher(); pushState();
      break;
    case 'launcherOpen': if (arg(0)) createTab(arg(0), true); break;
    case 'setTheme':       setTheme(arg(0)); break;
    case 'back':           { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoBack())    t.view.webContents.navigationHistory.goBack();    break; }
    case 'forward':        { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); break; }
    case 'reload':         { const t = activeTab(); if (t) reloadFresh(t.view.webContents); break; }
    case 'getSiteInfo':    sendSiteInfo(event ? event.sender : null); break;
    case 'clearSiteData':  clearActiveSiteData(event ? event.sender : null); break;
    case 'resetSitePermissions': resetActiveSitePermissions(event ? event.sender : null); break;
    case 'home':           navigateActive(HOME_URL); break;
    case 'toggleMaximize': if (mainWin) { mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); } break;
    case 'togglePanel':    togglePanel(); break;
    case 'closePanel':     closePanel(); break;
    case 'panelReady':
      panelLoaded = true;
      pushPanelState(); pushDownloads();
      sendPanelVisibility(panelOpen);
      if (pendingPanelHistory) { sendPanelHistory(); pendingPanelHistory = false; }
      if (pendingPanelDownloads) { pendingPanelDownloads = false; showPanelDownloads(); }
      break;
    case 'getHistory':     sendPanelHistory(); break;
    case 'getDownloads':   pushDownloads(); break;
    case 'cancelDownload': cancelDownload(arg(0)); break;
    case 'resumeDownload': resumeDownload(arg(0)); break;
    // ----- Rechercher dans la page (find.html) -----
    case 'findReady':      if (findBarOpen) sendFindOpen(); break;
    case 'findQuery':      findText = String(args.join(SEP)).slice(0, 500); runFind(findText, true, true); findNeedsNewSession = false; break;
    case 'findNext':       findAgain(true); break;
    case 'findPrev':       findAgain(false); break;
    case 'findClose':      closeFindBar(); break;
    case 'setSitePopups':  setActiveSitePopups(arg(0) === '1', event ? event.sender : null); break;
    case 'showDownload':   showDownload(arg(0)); break;
    case 'openDownload':   openDownload(arg(0)); break;
    case 'removeDownload': removeDownload(arg(0)); break;
    case 'clearDownloads': clearDownloads(); break;
    case 'openDownloadsPanel': openPanel(); showPanelDownloads(); break;
    case 'openHistory':    closePanel(); navigateActive(arg(0)); break;
    case 'removeHistory':  removeHistoryUrl(arg(0)); break;
    case 'clearHistory':   history = []; saveHistory(); sendPanelHistory(); pushPanelState(); break;
    case 'clearBookmarks': bookmarks = []; saveBookmarks(); pushState(); pushPanelState(); break;
    case 'setOffline':          settings.offline = arg(0) === '1'; saveSettings(); pushState(); pushPanelState(); break;
    case 'setShowBookmarks':    settings.showBookmarks = arg(0) === '1'; saveSettings(); pushState(); pushPanelState(); break;
    case 'setHistoryEnabled':   settings.historyEnabled = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setBlockPopups':      settings.blockPopups = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setContextMenus':     settings.contextMenus = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setDevTools':         settings.devTools = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setStatusBar':        settings.statusBar = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setZoomControls':     settings.zoomControls = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setRestoreTabs':
      settings.restoreTabs = arg(0) === '1';
      saveSettings();
      if (settings.restoreTabs) saveOpenTabsNow();
      else clearSessionTabs();
      pushPanelState();
      break;
    case 'setSafeSearch':       settings.safeSearch = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setHttpsOnly':        settings.httpsOnly = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setSafeBrowsing':     settings.safeBrowsing = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'resetPermissions':
      sitePermissions = {}; saveSitePermissions();
      for (const ctx of permissionContexts.values()) ctx.forgetOnce('');
      break;
    case 'setSearchEngine':     setSearchEngine(arg(0)); break;
    case 'setZoomPct':          setZoomPct(parseInt(arg(0), 10)); break;
    case 'resetSettings':       resetSettings(); break;
    case 'getMediaState':
      sendMediaState();
      break;
    case 'mediaCommand':
      runMediaCommand(arg(0), arg(1));
      break;
    case 'mediaState':
      // Passe-plat vers chrome.
      try {
        const parsed = JSON.parse(arg(0));
        if (chromeView) chromeView.webContents.send('zaalis:message', parsed);
      } catch {}
      break;
    default: {
      const fa = featureActions.get(a);
      if (fa) {
        try {
          const r = fa.fn(args, event);
          if (r && typeof r.catch === 'function') r.catch(e => console.error('[feature]', a, e));
        } catch (e) { console.error('[feature]', a, e); }
      }
      break;
    }
  }
}

const HOME_ACTIONS = new Set([
  'ready', 'addShortcut', 'navigate', 'removeShortcut', 'setAiMode',
  'suggest', 'togglePanel', 'aiSearch',
  // Recherche vocale : ces messages ne viennent que de zaalis://home/index.html.
  'voiceStart', 'voiceStop', 'voiceAudio',
]);
const AISEARCH_ACTIONS = new Set(['runAiSearch']);
const FIND_ACTIONS = new Set(['findReady', 'findQuery', 'findNext', 'findPrev', 'findClose']);
const DEVGRIP_ACTIONS = new Set(['devGripMove', 'devGripEnd', 'devGripMenu']);

function trustedIpcAction(event, action) {
  const sender = event && event.sender;
  if (!sender || !action) return false;
  // Les trois vues d'interface ont une identité WebContents dédiée.
  if ((chromeView && sender === chromeView.webContents) ||
      (panelView && sender === panelView.webContents) ||
      (aiPanelView && sender === aiPanelView.webContents)) return true;
  if (featureViewTrusted(sender, action)) return true;
  if (findView && sender === findView.webContents) return FIND_ACTIONS.has(action);
  if (tabOfDevGrip(sender)) return DEVGRIP_ACTIONS.has(action);

  const tab = tabs.find(t => t.view && sender === t.view.webContents);
  if (!tab) return false;
  if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) return false;
  let page = '';
  try { page = new URL(sender.getURL()).pathname.replace(/^\/+/, ''); } catch { return false; }
  if (!isAllowedInternalUrl(sender.getURL())) return false;
  if (page === '' || page === 'index.html') return HOME_ACTIONS.has(action);
  if (page === 'aisearch.html') return AISEARCH_ACTIONS.has(action);
  const fa = featureActions.get(action);
  return !!(fa && (fa.pages.has(page) || fa.pages.has('*')));
}

ipcMain.on('zaalis:postMessage', (event, str) => {
  if (typeof str !== 'string') return;
  const parts = str.split(SEP);
  if (!trustedIpcAction(event, parts[0])) return;
  // Un tour vocal peut contenir jusqu'à 30 secondes de PCM 16 kHz encodé en
  // base64 (~1,3 Mo). La limite générale reste stricte pour toute autre action.
  const maxLength = parts[0] === 'voiceAudio' ? 5 * 1024 * 1024 : 65536;
  if (str.length > maxLength) return;
  handleAction(parts[0], parts.slice(1), event);
});

// ----- Fournir logo & pages via zaalis://home ------------------------------

function zaalisProtocolHandler(req) {
  const u = new URL(req.url);
  if (u.host !== 'home') return new Response('not found', { status: 404 });
  // Avatars de profil : servis depuis le dossier de donnees utilisateur.
  const av = u.pathname.match(/^\/+profile-avatar\/(p[a-z0-9]+)$/i);
  if (av) {
    const p = avatarPath(av[1]);
    if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(p), { headers: { 'content-type': 'image/png' } });
  }
  let file = u.pathname.replace(/^\/+/, '');
  if (file === '' || file === 'index.html') file = 'index.html';
  const filePath = file === 'logo-zaalis.png'
    ? path.join(__dirname, 'assets', 'logo-zaalis.png')
    : path.join(__dirname, 'interface', file);
  if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 });
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.png' ? 'image/png'
    : ext === '.svg' ? 'image/svg+xml'
    : ext === '.js'  ? 'text/javascript'
    : ext === '.css' ? 'text/css'
    : 'application/octet-stream';
  const buf = fs.readFileSync(filePath);
  // Sans en-tête de cache, Chromium peut mettre en cache disque une reponse
  // zaalis://home/*.html indefiniment (le schema est enregistre 'standard').
  // Ce cache SURVIT aux redemarrages de l'app (meme dossier userData) : une
  // fenetre (ex. le panneau IA) chargee une seule fois par run peut ainsi
  // continuer a executer un JS perime meme apres correction du fichier source
  // sur disque. On force systematiquement une lecture fraiche.
  return new Response(buf, { headers: { 'content-type': mime, 'cache-control': 'no-store' } });
}

// Enregistre le handler sur la session par défaut ET sur la session persistée
// des onglets. Sans ça, les onglets (partition:'persist:zaalis-browser') ne
// voient pas le protocole et zaalis://home/* échoue.
function registerProtocol() {
  session.defaultSession.protocol.handle('zaalis', zaalisProtocolHandler);
  // Session de l'invité : protocole zaalis:// + téléchargements + permissions.
  // Les profils et la navigation privée obtiennent leur session à la volée
  // (setupSession) dès qu'un onglet y est créé.
  setupSession('persist:zaalis-browser');
}

// Doit être appelé avant `app.whenReady()`.
protocol.registerSchemesAsPrivileged([{
  scheme: 'zaalis',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// ----- API HTTP locale ------------------------------------------------------

function startApi() {
  if (process.env.ZAALIS_BROWSER_EMBEDDED) return; // [zaalis IDE] l'IDE pilote le navigateur directement
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    // Supporte /action et /zaalis/action (utilisé par zaalis labs ide).
    let path0 = parsed.pathname || '/';
    if (path0.startsWith('/zaalis/')) path0 = path0.slice(7);
    const q     = parsed.query   || {};
    const visible = q.visible !== '0';
    res.setHeader('content-type', 'application/json; charset=utf-8');

    let action = null, value = '';
    if (path0 === '/ping')                        { res.end(JSON.stringify({ ok: true, name: 'zaalis browser' })); return; }
    if (path0 === '/search' || path0 === '/open') { action = path0.slice(1); value = q.q || q.url || ''; }
    else if (path0 === '/newtab')                 { action = 'newtab'; value = q.url || q.q || ''; }
    else if (path0 === '/')                       { res.end('zaalis browser api'); return; }

    if (!action) { res.statusCode = 404; res.end('no'); return; }

    // Les actions locales partagent le même secret que le pont IDE. Un site
    // web ne peut pas forger cet en-tête et les requêtes anonymes échouent.
    if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    const expected = Buffer.from(ideSecret());
    const supplied = Buffer.from(String(req.headers['x-zaalis-browser'] || ''));
    const authenticated = expected.length >= 16 && supplied.length === expected.length &&
      crypto.timingSafeEqual(supplied, expected);
    if (!authenticated) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }

    value = String(value || '').slice(0, 4096);

    if (mainWin) {
      if (action === 'search' || action === 'open') navigateActive(resolveQuery(value));
      else if (action === 'newtab')                 createTab(value ? resolveQuery(value) : '', true);
      if (visible) {
        mainWin.show();
        mainWin.focus();
        app.focus({ steal: true });
      }
    }
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('error', (e) => { /* port occupé — on ignore */ });
  server.listen(API_PORT, '127.0.0.1');
}

// ----- Fenêtre principale ---------------------------------------------------

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'zaalis.ico');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  mainWin = new BaseWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: settings.theme === 'dark' ? '#202124' : '#e9eaed',
    icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayColors(),
  });

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chromeView.setBackgroundColor('#00000000');
  lockInternalView(chromeView.webContents, CHROME_URL);
  mainWin.contentView.addChildView(chromeView);

  chromeView.webContents.on('did-finish-load', () => {
    // Décale la brand à droite pour ne pas passer sous les traffic lights macOS.
    if (!process.env.ZAALIS_BROWSER_EMBEDDED) chromeView.webContents.insertCSS(`
      .tabstrip { padding-right: 150px !important; }
      .brand    { padding-left: 0 !important; }
    `);
    pushState();
  });
  chromeView.webContents.loadURL(CHROME_URL);

  mainWin.on('resize', layoutAll);
  // F11 / plein écran vidéo : la barre d'onglets se masque, comme Chrome.
  mainWin.on('enter-full-screen', () => { layoutAll(); pushState(); });
  mainWin.on('leave-full-screen', () => {
    // Quitter le plein écran de la fenêtre quitte aussi celui de la vidéo.
    const t = fullscreenTab();
    if (t) { htmlFullscreenTabId = null; try { t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {}); } catch {} }
    layoutAll(); pushState();
  });
  // Boutons « Précédent / Suivant » de la souris et touches multimédias du clavier.
  mainWin.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
    else if (cmd === 'browser-forward') goForward();
    else if (cmd === 'browser-refresh') withActiveWc(wc => reloadFresh(wc));
    else if (cmd === 'browser-home') navigateActive(HOME_URL);
    else if (cmd === 'browser-search') focusOmnibox();
  });
  mainWin.on('closed', () => { mainWin = null; });

  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.show();

  const saved = settings.restoreTabs ? loadSessionTabs() : null;
  if (saved && saved.urls.length) {
    saved.urls.forEach((u, i) => createTab(u, i === 0));
    if (tabs[saved.active]) selectTab(tabs[saved.active].id);
    runFeatureHooks('sessionRestored', saved);
  } else {
    createTab('', true);
  }
  layoutAll();
}

// ----- App lifecycle --------------------------------------------------------

app.setName('zaalis browser');
app.setAppUserModelId('com.zaalis.browser');

// UA de Google Chrome pour toutes les sessions (voir chromeUserAgent()).
app.userAgentFallback = chromeUserAgent();

// Chromium utilise déjà l'accélération matérielle par défaut ; ce réglage
// privilégie explicitement la rasterisation GPU pour les surfaces Chromium et
// les animations compositées, sans désactiver ses garde-fous de compatibilité.
app.commandLine.appendSwitch('enable-gpu-rasterization');

// Autorise la lecture continue demandée par l'utilisateur (notamment le
// passage automatique au titre suivant des playlists YouTube). Sans ce réglage
// Chromium peut considérer la vidéo suivante comme un nouvel autoplay.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Empêche une deuxième instance (l'API HTTP fait déjà foreground).
// Self-test de l'agent : données isolées dans un appData temporaire pour ne
// jamais toucher le vrai profil (et éviter le verrou single-instance de l'app
// installée). Voir runAgentSelfTest().
const AGENT_SELFTEST = process.env.ZAALIS_AGENT_SELFTEST || '';
// Tests de bout en bout maison (tests/e2e/*.test.js) : profil jetable.
const E2E = process.env.ZAALIS_E2E || '';   // toujours vide en version installée (voir plus haut)
if (E2E) {
  const base = process.env.ZAALIS_E2E_DIR || path.join(os.tmpdir(), 'zaalis-e2e-' + process.pid);
  app.setPath('appData', base);
  app.setPath('userData', path.join(base, 'zaalis browser'));
}
if (AGENT_SELFTEST) {
  const base = path.join(os.tmpdir(), 'zaalis-agent-selftest');
  app.setPath('appData', base);
  app.setPath('userData', path.join(base, 'zaalis browser'));
}

// Rapports de plantage locaux, jamais envoyés (src/features/crashes.js) :
// démarré avant tout processus enfant pour qu'ils soient tous surveillés.
try { require('./src/features/crashes').startEarly(app, electron.crashReporter); } catch (e) { console.error('[crashes]', e.message); }

// Adresse web ou fichier local passé en argument (raccourci, « Ouvrir avec »,
// navigateur par défaut via « --single-argument %1 », autre instance).
// Les fichiers ainsi reçus sont les seuls file:// que le navigateur accepte.
const trustedFileUrls = new Set();
const ARGV_FILE_EXT = /\.(html?|shtml|xht|xhtml|pdf|svg|webp)$/i;
function urlFromArgv(argv) {
  const args = (argv || []).slice(1).map(a => String(a));
  const si = args.indexOf('--single-argument');
  const candidates = si >= 0 ? [args.slice(si + 1).join(' ')] : args;
  for (const a of candidates) {
    if (/^https?:\/\//i.test(a)) return a;
    if (a.startsWith('-') || !(/^file:\/\//i.test(a) || ARGV_FILE_EXT.test(a))) continue;
    try {
      const p = /^file:/i.test(a) ? url.fileURLToPath(a) : path.resolve(a);
      if (ARGV_FILE_EXT.test(p) && fs.existsSync(p) && fs.statSync(p).isFile()) {
        const fileUrl = url.pathToFileURL(p).href;
        trustedFileUrls.add(fileUrl);
        return fileUrl;
      }
    } catch {}
  }
  return '';
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_e, argv) => {
  if (!mainWin) return;
  const u = urlFromArgv(argv);
  if (u) createTab(u, true);
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
});

app.on('before-quit', () => {
  runFeatureHooks('quit');
  if (saveTabsTimer) { clearTimeout(saveTabsTimer); saveTabsTimer = null; }
  saveOpenTabsNow();
  flushSessions();
});

// ----- Widevine (Prime Video, Netflix, Disney+, Canal+, Spotify…) -----------
// Le build castlabs installe le module DRM Widevine au premier lancement puis
// le met à jour en arrière-plan. On l'attend brièvement avant d'ouvrir les
// onglets (instantané quand il est déjà installé) sans jamais bloquer le
// démarrage hors connexion.
let widevineState = components ? 'pending' : 'unavailable';
async function waitForWidevine(timeoutMs) {
  if (!components) return;
  const ready = components.whenReady([components.WIDEVINE_CDM_ID])
    .then(() => { widevineState = 'ready'; })
    .catch((e) => { widevineState = 'error'; console.warn('[widevine] installation impossible :', e && e.message); });
  await Promise.race([ready, new Promise(r => setTimeout(r, timeoutMs))]);
  if (widevineState === 'pending') console.warn('[widevine] module toujours en cours d\'installation, démarrage sans attendre');
}

// ----- Authentification HTTP (Basic/Digest, proxy) --------------------------
// Electron annule ces demandes par défaut : routeurs, intranets ou serveurs
// de test devenaient inaccessibles. Boîte « Connexion » comme dans Chrome.
const pendingAuth = new Map();
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function askHttpCredentials(authInfo, requestUrl) {
  const key = (authInfo.isProxy ? 'proxy|' : '') + authInfo.host + ':' + authInfo.port + '|' + (authInfo.realm || '');
  if (pendingAuth.has(key)) return pendingAuth.get(key);
  const p = new Promise((resolve) => {
    if (!mainWin) { resolve(null); return; }
    const dark = settings.theme === 'dark';
    const insecure = /^http:/i.test(requestUrl || '') && !authInfo.isProxy;
    const who = authInfo.isProxy ? 'Le proxy ' + authInfo.host + ':' + authInfo.port : (hostOf(requestUrl) || authInfo.host);
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Connexion</title><style>
      :root{color-scheme:${dark ? 'dark' : 'light'}}
      body{margin:0;padding:22px 24px;font-family:"Segoe UI",Arial,sans-serif;font-size:13.5px;
        background:${dark ? '#292a2d' : '#ffffff'};color:${dark ? '#e8eaed' : '#202124'}}
      h1{font-size:17px;font-weight:600;margin:0 0 6px}
      p{margin:0 0 14px;color:${dark ? '#9aa0a6' : '#5f6368'};line-height:1.45;word-break:break-word}
      p.warn{color:${dark ? '#f28b82' : '#d93025'}}
      label{display:block;font-size:12px;margin:10px 0 4px;color:${dark ? '#9aa0a6' : '#5f6368'}}
      input{width:100%;box-sizing:border-box;height:34px;padding:0 10px;border-radius:8px;font:inherit;outline:none;
        border:1px solid ${dark ? '#5f6368' : '#dadce0'};background:${dark ? '#202124' : '#fff'};color:inherit}
      input:focus{border-color:${dark ? '#8ab4f8' : '#1a73e8'}}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
      button{height:34px;padding:0 18px;border-radius:17px;font:inherit;font-weight:600;cursor:pointer;
        border:1px solid ${dark ? '#5f6368' : '#dadce0'};background:transparent;color:${dark ? '#8ab4f8' : '#1a73e8'}}
      button.primary{background:${dark ? '#8ab4f8' : '#1a73e8'};border-color:transparent;color:${dark ? '#202124' : '#fff'}}
    </style></head><body><form id="f">
      <h1>Connexion</h1>
      <p>${escapeHtml(who)} exige un nom d'utilisateur et un mot de passe.${authInfo.realm ? '<br>« ' + escapeHtml(authInfo.realm) + ' »' : ''}</p>
      ${insecure ? '<p class="warn">Votre connexion à ce site n\'est pas privée.</p>' : ''}
      <label for="u">Nom d'utilisateur</label><input id="u" autocomplete="username" autofocus>
      <label for="p">Mot de passe</label><input id="p" type="password" autocomplete="current-password">
      <div class="row"><button type="button" id="c">Annuler</button><button class="primary" type="submit">Se connecter</button></div>
    </form><script>
      const send = (v) => { document.title = 'zaalis-auth:' + JSON.stringify(v); };
      document.getElementById('f').onsubmit = (e) => { e.preventDefault(); send({ u: document.getElementById('u').value, p: document.getElementById('p').value }); };
      document.getElementById('c').onclick = () => send(null);
      addEventListener('keydown', (e) => { if (e.key === 'Escape') send(null); });
    <\/script></body></html>`;
    const win = new BrowserWindow({
      parent: mainWin, modal: true, width: 420, height: insecure ? 372 : 340,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      show: false, title: 'Connexion', autoHideMenuBar: true,
      backgroundColor: dark ? '#292a2d' : '#ffffff',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    win.setMenu(null);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); if (!win.isDestroyed()) win.destroy(); };
    win.webContents.on('page-title-updated', (e, title) => {
      if (!String(title).startsWith('zaalis-auth:')) return;
      e.preventDefault();
      let v = null;
      try { v = JSON.parse(title.slice('zaalis-auth:'.length)); } catch {}
      finish(v && typeof v.u === 'string' ? { username: v.u, password: String(v.p || '') } : null);
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish(null));
    win.once('ready-to-show', () => win.show());
    win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
  });
  pendingAuth.set(key, p);
  p.finally(() => pendingAuth.delete(key));
  return p;
}

app.on('login', (event, _wc, details, authInfo, callback) => {
  event.preventDefault();
  askHttpCredentials(authInfo || {}, (details && details.url) || '').then((creds) => {
    try { creds ? callback(creds.username, creds.password) : callback(); } catch {}
  });
});

// ----- Raccourcis clavier (identiques à Chrome sur chaque plateforme) -------
const IS_MAC = process.platform === 'darwin';
function withActiveWc(fn) {
  const t = activeTab();
  if (t && !t.view.webContents.isDestroyed()) fn(t.view.webContents, t);
}
function goBack()    { withActiveWc(wc => { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }); }
function goForward() { withActiveWc(wc => { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }); }
function toggleDevTools(openConsole) {
  if (!settings.devTools) return;
  withActiveWc((_wc, tab) => {
    if (devToolsShown(tab) && !openConsole) closeDevToolsFor(tab);
    else openDevToolsFor(tab);
  });
}
function focusOmnibox() { if (chromeView) { chromeView.webContents.focus(); chromeView.webContents.send('zaalis:message', { type: 'focusOmni' }); } }

// Entrée de menu invisible : seul son raccourci compte (alias Windows de Chrome).
const hidden = (accelerator, click) => ({ label: accelerator, accelerator, visible: false, acceleratorWorksWhenHidden: true, click });

function buildAppMenu() {
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { label: 'Fichier', submenu: [
      { label: 'Nouvel onglet',               accelerator: 'CmdOrCtrl+T',       click: () => openNewTab() },
      { label: 'Nouvel onglet privé',         accelerator: 'CmdOrCtrl+Shift+N', click: () => openIncognitoTab() },
      { label: 'Rouvrir l\'onglet fermé',     accelerator: 'CmdOrCtrl+Shift+T', click: () => reopenClosedTab() },
      { type: 'separator' },
      { label: 'Enregistrer la page sous…',   accelerator: 'CmdOrCtrl+S',       click: () => withActiveWc(wc => savePageAs(wc)) },
      { label: 'Imprimer…',                   accelerator: 'CmdOrCtrl+P',       click: () => withActiveWc(wc => printPage(wc)) },
      { type: 'separator' },
      { label: 'Fermer l\'onglet',            accelerator: 'CmdOrCtrl+W',       click: () => { const t = activeTab(); if (t) closeTab(t.id); } },
      ...(IS_MAC ? [] : [hidden('Ctrl+F4', () => { const t = activeTab(); if (t) closeTab(t.id); })]),
      { label: 'Quitter', role: 'quit', ...(IS_MAC ? { accelerator: 'Cmd+Q' } : {}) },
    ]},
    { label: 'Édition', submenu: [
      { role: 'undo', label: 'Annuler' }, { role: 'redo', label: 'Rétablir' }, { type: 'separator' },
      { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' },
      { role: 'pasteAndMatchStyle', label: 'Coller en tant que texte brut' },
      { role: 'selectAll', label: 'Tout sélectionner' },
      { type: 'separator' },
      { label: 'Rechercher…',                 accelerator: 'CmdOrCtrl+F',       click: () => openFindBar() },
      { label: 'Rechercher le suivant',       accelerator: IS_MAC ? 'Cmd+G' : 'F3',             click: () => findAgain(true) },
      { label: 'Rechercher le précédent',     accelerator: IS_MAC ? 'Cmd+Shift+G' : 'Shift+F3', click: () => findAgain(false) },
      ...(IS_MAC ? [] : [hidden('Ctrl+G', () => findAgain(true)), hidden('Ctrl+Shift+G', () => findAgain(false))]),
    ]},
    { label: 'Onglets', submenu: [
      { label: 'Onglet suivant',              accelerator: 'Ctrl+Tab',          click: () => cycleTab(1) },
      { label: 'Onglet précédent',            accelerator: 'Ctrl+Shift+Tab',    click: () => cycleTab(-1) },
      hidden(IS_MAC ? 'Cmd+Alt+Right' : 'Ctrl+PageDown', () => cycleTab(1)),
      hidden(IS_MAC ? 'Cmd+Alt+Left'  : 'Ctrl+PageUp',   () => cycleTab(-1)),
      { label: 'Aller à l\'onglet', submenu: [1,2,3,4,5,6,7,8].map(n => (
          { label: 'Onglet ' + n, accelerator: 'CmdOrCtrl+' + n, click: () => gotoTab(n) }
        )).concat([{ label: 'Dernier onglet', accelerator: 'CmdOrCtrl+9', click: () => gotoTab(9) }]) },
      { label: 'Rechercher un onglet',        accelerator: 'CmdOrCtrl+Shift+A', click: () => { if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'openTabSearch' }); } },
      { type: 'separator' },
      { label: 'Gestionnaire de tâches',      accelerator: IS_MAC ? 'Cmd+Alt+Escape' : 'Shift+Escape', click: () => { const m = featureModules.taskmanager; if (m) m.open(); } },
    ]},
    { label: 'Navigation', submenu: [
      { label: 'Reculer',                     accelerator: IS_MAC ? 'Cmd+[' : 'Alt+Left',   click: goBack },
      { label: 'Avancer',                     accelerator: IS_MAC ? 'Cmd+]' : 'Alt+Right',  click: goForward },
      ...(IS_MAC ? [hidden('Cmd+Left', goBack), hidden('Cmd+Right', goForward)] : []),
      { label: 'Actualiser',                  accelerator: 'CmdOrCtrl+R',       click: () => withActiveWc(wc => reloadFresh(wc)) },
      { label: 'Actualiser sans le cache',    accelerator: 'CmdOrCtrl+Shift+R', click: () => withActiveWc(wc => reloadFresh(wc)) },
      ...(IS_MAC ? [] : [
        hidden('F5', () => withActiveWc(wc => reloadFresh(wc))),
        hidden('Ctrl+F5', () => withActiveWc(wc => reloadFresh(wc))),
        hidden('Shift+F5', () => withActiveWc(wc => reloadFresh(wc))),
      ]),
      { label: 'Accueil',                     accelerator: IS_MAC ? 'Cmd+Shift+H' : 'Alt+Home', click: () => navigateActive(HOME_URL) },
      ...(IS_MAC ? [] : [hidden('Ctrl+Shift+H', () => navigateActive(HOME_URL))]),
      { label: 'Barre d\'adresse',            accelerator: 'CmdOrCtrl+L',       click: focusOmnibox },
      ...(IS_MAC ? [] : [hidden('Alt+D', focusOmnibox), hidden('F6', focusOmnibox), hidden('Ctrl+E', focusOmnibox), hidden('Ctrl+K', focusOmnibox)]),
      { type: 'separator' },
      { label: 'Ajouter aux favoris',         accelerator: 'CmdOrCtrl+D',       click: () => toggleBookmark() },
      { label: 'Afficher la barre de favoris', accelerator: 'CmdOrCtrl+Shift+B', click: () => { settings.showBookmarks = !settings.showBookmarks; saveSettings(); pushState(); pushPanelState(); } },
      { label: 'Historique',                  accelerator: IS_MAC ? 'Cmd+Y' : 'Ctrl+H',         click: () => openHistoryPanel() },
      { label: 'Téléchargements',             accelerator: IS_MAC ? 'Cmd+Shift+J' : 'Ctrl+J',   click: () => { openPanel(); showPanelDownloads(); } },
      { type: 'separator' },
      { label: 'Afficher le code source',     accelerator: IS_MAC ? 'Alt+Cmd+U' : 'Ctrl+U',     click: () => withActiveWc((wc, t) => openViewSource(wc.getURL(), t)) },
      { label: 'Outils de développement',     accelerator: IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => toggleDevTools(false) },
      ...(IS_MAC ? [] : [hidden('F12', () => toggleDevTools(false)), hidden('Ctrl+Shift+J', () => toggleDevTools(true))]),
    ]},
    { label: 'Affichage', submenu: [
      { label: 'Zoom avant',    accelerator: 'CmdOrCtrl+Plus',  click: () => setZoomPct((settings.zoomPct || 100) + 10) },
      hidden('CmdOrCtrl+=', () => setZoomPct((settings.zoomPct || 100) + 10)),
      hidden('CmdOrCtrl+numadd', () => setZoomPct((settings.zoomPct || 100) + 10)),
      { label: 'Zoom arrière',  accelerator: 'CmdOrCtrl+-',     click: () => setZoomPct((settings.zoomPct || 100) - 10) },
      hidden('CmdOrCtrl+numsub', () => setZoomPct((settings.zoomPct || 100) - 10)),
      { label: 'Taille réelle', accelerator: 'CmdOrCtrl+0',     click: () => setZoomPct(100) },
      hidden('CmdOrCtrl+num0', () => setZoomPct(100)),
      { type: 'separator' },
      { label: 'Plein écran', accelerator: IS_MAC ? 'Ctrl+Cmd+F' : 'F11',
        click: () => { if (mainWin) mainWin.setFullScreen(!mainWin.isFullScreen()); } },
    ]},
    ...(IS_MAC ? [{ role: 'windowMenu' }] : []),
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(async () => {
  ensureDataFolder();
  configureSecureDns();
  loadSettings();
  loadProfiles();
  loadSitePermissions();
  loadProfileData();   // favoris/raccourcis/historique/lanceur du profil courant
  loadAiChats();
  startIdeStatusWatcher();
  loadFeatures();
  registerProtocol();  // enregistre aussi téléchargements + permissions (invité)
  await waitForWidevine(4000);
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();
  startApi();
  const argvUrl = urlFromArgv(process.argv);
  if (argvUrl) createTab(argvUrl, true);
  runFeatureHooks('ready');
  if (E2E) runE2E(E2E);

  if (AGENT_SELFTEST) {
    runAgentSelfTest(AGENT_SELFTEST).catch((e) => {
      console.error('[selftest] échec inattendu :', e);
      app.exit(1);
    });
  }
});

// ----- Self-test de l'agent (développement) -----------------------------------
// ZAALIS_AGENT_SELFTEST=tools   : vérifie read_page/click/fill/curseur sur une
//                                 page locale, imprime un rapport puis quitte.
// ZAALIS_AGENT_SELFTEST=mistral : idem + boucle agent complète via zaalis labs
//                                 ide (provider Mistral) sur la même page.
// Self-test de l'agent IA (développement : npm run selftest).
// (code dans src/core/agent-selftest.js ; dépendances injectées ci-dessous)
const SELFTEST = require('./src/core/agent-selftest').init({
  get components() { return components; },
  get AGENT() { return AGENT; },
  get AUTO_GRANTED_PERMISSIONS() { return AUTO_GRANTED_PERMISSIONS; },
  get BLOCKED_EXTERNAL_SCHEMES() { return BLOCKED_EXTERNAL_SCHEMES; },
  get DEVTOOLS_GRIP() { return DEVTOOLS_GRIP; },
  get HOME_ACTIONS() { return HOME_ACTIONS; },
  get HOME_URL() { return HOME_URL; },
  get PANEL_ANIM_MS() { return PANEL_ANIM_MS; },
  get activeTab() { return activeTab; },
  get aiChatById() { return aiChatById; },
  get aiCurrentChatId() { return aiCurrentChatId; },
  get aiProvidersSnapshot() { return aiProvidersSnapshot; },
  get buildAppMenu() { return buildAppMenu; },
  get chromeView() { return chromeView; },
  get closeDevToolsFor() { return closeDevToolsFor; },
  get closeFindBar() { return closeFindBar; },
  get closePanel() { return closePanel; },
  get closeTab() { return closeTab; },
  get contentTop() { return contentTop; },
  get createTab() { return createTab; },
  get devToolsLayout() { return devToolsLayout; },
  get downloads() { return downloads; },
  get ensurePanelView() { return ensurePanelView; },
  get errorPageHtml() { return errorPageHtml; },
  get findBarOpen() { return findBarOpen; },
  get findText() { return findText; }, set findText(v) { findText = v; },
  get findView() { return findView; },
  get htmlFullscreenTabId() { return htmlFullscreenTabId; },
  get isExternalAppUrl() { return isExternalAppUrl; },
  get layoutAll() { return layoutAll; },
  get mainWin() { return mainWin; },
  get newAiChat() { return newAiChat; },
  get openDevToolsFor() { return openDevToolsFor; },
  get openFindBar() { return openFindBar; },
  get openNewTab() { return openNewTab; },
  get openPanel() { return openPanel; },
  get panelBoundsUpdates() { return panelBoundsUpdates; },
  get panelView() { return panelView; },
  get panelViewVisible() { return panelViewVisible; },
  get permissionContext() { return permissionContext; },
  get popupAllowed() { return popupAllowed; },
  get reservedDownloadPaths() { return reservedDownloadPaths; },
  get runFind() { return runFind; },
  get safeDownloadName() { return safeDownloadName; },
  get sealAvailable() { return sealAvailable; },
  get sealRead() { return sealRead; },
  get sealWrite() { return sealWrite; },
  get selectTab() { return selectTab; },
  get settings() { return settings; },
  get uniqueDownloadPath() { return uniqueDownloadPath; },
  get urlScheme() { return urlScheme; },
  get validAiChoice() { return validAiChoice; },
});
const { runAgentSelfTest } = SELFTEST;

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWin) createWindow();
});

// [zaalis IDE] Points d'entrée du navigateur intégré (zaalis-browser/host.js).
module.exports = {
  tabs, activeTab, createTab, closeTab, selectTab, navigateActive, resolveQuery,
  runAgentTool, setAiControlBorder, agentHoldCursor, waitLoad, quickPageContext,
  openAiPanel, settings,
  get ideStatus() { return ideStatus; },
};
