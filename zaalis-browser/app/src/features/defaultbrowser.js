'use strict';
/* =============================================================================
 *  Navigateur par défaut (Windows)
 * -----------------------------------------------------------------------------
 *  - Enregistre zaalis Browser auprès de Windows (HKCU, sans droits admin) :
 *    StartMenuInternet\zaalisBrowser + Capabilities (http/https, .html, .pdf…),
 *    RegisteredApplications, ProgID zaalisHTML / zaalisURL. Les mêmes clés
 *    sont écrites par l'installeur (build/installer.nsh) ; le navigateur les
 *    réécrit au démarrage d'une version installée si l'emplacement a changé.
 *  - Détecte le navigateur par défaut (UserChoice de https).
 *  - Propose une seule fois de devenir le navigateur par défaut, et offre un
 *    bouton dans zaalis://security qui ouvre le réglage Windows correspondant
 *    (Windows ne permet plus de le changer sans l'utilisateur).
 * =========================================================================== */

const { execFile } = require('child_process');

const APP_KEY = 'zaalisBrowser';
const APP_NAME = 'zaalis Browser';
const PROGID_HTML = 'zaalisHTML';
const PROGID_URL = 'zaalisURL';
const FILE_EXTS = ['.htm', '.html', '.shtml', '.xht', '.xhtml', '.pdf', '.svg', '.webp'];
const URL_SCHEMES = ['http', 'https'];

// Liste des commandes reg.exe (tableaux d'arguments) qui enregistrent le
// navigateur. `root` permet de tout écrire sous une clé de test.
function registrationCommands(exe, root) {
  const R = root || 'HKCU\\Software';
  const icon = `"${exe}",0`;
  const open = `"${exe}" --single-argument %1`;
  const smi = `${R}\\Clients\\StartMenuInternet\\${APP_KEY}`;
  const caps = `${smi}\\Capabilities`;
  const add = (key, name, value, type) => ['add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', type || 'REG_SZ', '/d', value, '/f'];
  const cmds = [
    add(smi, null, APP_NAME),
    add(`${smi}\\DefaultIcon`, null, icon),
    add(`${smi}\\shell\\open\\command`, null, `"${exe}"`),
    add(caps, 'ApplicationName', APP_NAME),
    add(caps, 'ApplicationDescription', 'Navigateur web zaalis, basé sur Chromium.'),
    add(caps, 'ApplicationIcon', icon),
    add(`${caps}\\StartMenu`, 'StartMenuInternet', APP_KEY),
    add(`${R}\\RegisteredApplications`, APP_NAME, `Software\\Clients\\StartMenuInternet\\${APP_KEY}\\Capabilities`),
  ];
  for (const ext of FILE_EXTS) {
    cmds.push(add(`${caps}\\FileAssociations`, ext, PROGID_HTML));
    cmds.push(add(`${R}\\Classes\\${ext}\\OpenWithProgids`, PROGID_HTML, '', 'REG_SZ'));
  }
  for (const s of URL_SCHEMES) cmds.push(add(`${caps}\\URLAssociations`, s, PROGID_URL));
  for (const [id, label, isUrl] of [[PROGID_HTML, 'Document HTML zaalis', false], [PROGID_URL, 'URL zaalis', true]]) {
    const k = `${R}\\Classes\\${id}`;
    cmds.push(add(k, null, label));
    if (isUrl) cmds.push(add(k, 'URL Protocol', ''));
    cmds.push(add(`${k}\\Application`, 'ApplicationName', APP_NAME));
    cmds.push(add(`${k}\\Application`, 'ApplicationIcon', icon));
    cmds.push(add(`${k}\\Application`, 'AppUserModelId', 'com.zaalis.browser'));
    cmds.push(add(`${k}\\DefaultIcon`, null, icon));
    cmds.push(add(`${k}\\shell\\open\\command`, null, open));
  }
  return cmds;
}
function unregistrationCommands(root) {
  const R = root || 'HKCU\\Software';
  const del = (key, name) => ['delete', key, ...(name ? ['/v', name] : []), '/f'];
  const cmds = [
    del(`${R}\\Clients\\StartMenuInternet\\${APP_KEY}`),
    del(`${R}\\RegisteredApplications`, APP_NAME),
    del(`${R}\\Classes\\${PROGID_HTML}`),
    del(`${R}\\Classes\\${PROGID_URL}`),
  ];
  for (const ext of FILE_EXTS) cmds.push(del(`${R}\\Classes\\${ext}\\OpenWithProgids`, PROGID_HTML));
  return cmds;
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}
async function runAll(cmds) {
  let ok = true;
  for (const c of cmds) { const r = await reg(c); if (!r.ok && c[0] === 'add') ok = false; }
  return ok;
}
async function readValue(key, name) {
  const r = await reg(['query', key, ...(name ? ['/v', name] : ['/ve'])]);
  if (!r.ok) return null;
  const m = r.out.split(/\r?\n/).map(l => l.trim()).find(l => /\sREG_\w+\s/.test(l));
  if (!m) return null;
  return m.replace(/^.*?\sREG_\w+\s+/, '');
}
async function defaultProgIds() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations';
  return {
    http: await readValue(`${base}\\http\\UserChoice`, 'ProgId'),
    https: await readValue(`${base}\\https\\UserChoice`, 'ProgId'),
  };
}

function init(ctx) {
  const { app, path, electron } = ctx;
  const { shell, dialog } = electron;
  const isWin = process.platform === 'win32';
  const prefsFile = () => path.join(ctx.dataFolder, 'default-browser.json');
  let prefs = { prompted: false, registeredExe: '', registeredVersion: '' };
  let status = { isDefault: false, progId: '', checked: false };

  async function check() {
    if (!isWin) { status = { isDefault: false, progId: '', checked: true, unsupported: true }; return status; }
    const ids = await defaultProgIds();
    status = { isDefault: ids.https === PROGID_URL, progId: ids.https || '', checked: true, registered: !!prefs.registeredExe };
    return status;
  }
  async function register(force) {
    if (!isWin || !app.isPackaged) return false;
    const exe = process.execPath;
    if (!force && prefs.registeredExe === exe && prefs.registeredVersion === app.getVersion()) return true;
    const ok = await runAll(registrationCommands(exe));
    if (ok) {
      prefs.registeredExe = exe; prefs.registeredVersion = app.getVersion();
      ctx.writeJson(prefsFile(), prefs);
    }
    return ok;
  }
  function openSettings() {
    // Windows 10/11 : page « Applications par défaut » de zaalis Browser.
    return shell.openExternal('ms-settings:defaultapps?registeredAppUser=' + encodeURIComponent(APP_NAME))
      .catch(() => shell.openExternal('ms-settings:defaultapps'));
  }
  async function setDefault() {
    if (!isWin) return false;
    await register(false);
    await openSettings();
    return true;
  }

  // Proposition unique, discrète, quelques secondes après le démarrage.
  async function maybePrompt() {
    if (!isWin || !app.isPackaged || prefs.prompted || process.env.ZAALIS_E2E) return;
    const s = await check();
    if (s.isDefault) return;
    prefs.prompted = true;
    ctx.writeJson(prefsFile(), prefs);
    const win = ctx.mainWin;
    if (!win) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: APP_NAME,
      message: 'zaalis Browser n\'est pas votre navigateur par défaut',
      detail: 'Ouvrir les liens et les fichiers web avec zaalis Browser ? Vous pourrez changer d\'avis à tout moment dans zaalis://security.',
      buttons: ['Définir par défaut', 'Pas maintenant'],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 0) setDefault();
  }

  prefs = Object.assign(prefs, ctx.readJson(prefsFile(), {}));
  ctx.on('ready', () => {
    register(false).catch(() => {}).finally(() => {
      const t = setTimeout(() => { maybePrompt().catch(() => {}); }, 20000);
      if (t.unref) t.unref();
    });
  });

  ctx.rpc('defaultBrowserStatus', () => check(), { pages: ['security.html'] });
  ctx.rpc('defaultBrowserSet', async () => { await setDefault(); return check(); }, { pages: ['security.html'] });
  ctx.action('setDefaultBrowser', () => { setDefault(); });

  return { check, register, setDefault, registrationCommands, unregistrationCommands, defaultProgIds, readValue, runAll };
}

module.exports = { init, registrationCommands, unregistrationCommands, APP_KEY, APP_NAME, PROGID_HTML, PROGID_URL, FILE_EXTS };
