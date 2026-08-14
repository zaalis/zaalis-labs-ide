'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// A second launch must focus the existing window instead of spawning another
// local server.  This is deliberately acquired before `ready`, as required by
// Electron on macOS.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function configureLinuxSandbox() {
  if (process.platform !== 'linux') return;

  const sandboxPath = path.join(path.dirname(process.execPath), 'chrome-sandbox');
  try {
    const st = fs.statSync(sandboxPath);
    const hasSetuid = (st.mode & 0o4000) !== 0;
    if (st.uid === 0 && hasSetuid) return;
  } catch {}

  // Portable extractions or some graphical installers can lose chrome-sandbox
  // root/setuid permissions. The app only renders the local zaalis UI and
  // blocks external navigation, so this fallback is preferable to a hard crash.
  app.commandLine.appendSwitch('no-sandbox');
}

configureLinuxSandbox();
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,MediaRouter,OptimizationHints');

// Le nom de l'app et le dossier userData DOIVENT être fixés avant l'événement
// `ready` : le service réseau de Chromium (qui gère le magasin de cookies
// persistants, écrit dans <userData>/Network/Cookies) s'initialise au `ready`.
// S'ils étaient définis plus tard (dans whenReady().then()), le cookie de
// session zaalis_session n'était jamais persisté sur disque — il se comportait
// comme un cookie de session éphémère, d'où la reconnexion forcée à chaque
// relancement de l'app, que le flush du store en sortie ne pouvait pas régler.
app.setName('zaalis IDE');
app.setPath('userData', path.join(app.getPath('appData'), 'zaalis', 'electron'));

const DEFAULT_PORT = Number(process.env.ZAALIS_PORT || process.env.PORT) || 3000;
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : __dirname;
const BUNDLE_DIR = path.join(APP_ROOT, 'bundle');
const SERVER_BIN = process.platform === 'win32' ? 'zaalis-server.exe' : 'zaalis-server';
const SERVER_PATH = path.join(BUNDLE_DIR, SERVER_BIN);
const ICON_PATH = path.join(BUNDLE_DIR, 'image', process.platform === 'darwin' ? 'logo-zaalis.icns' : 'logo-zaalis.png');
const SPEECH_HELPER_PATH = app.isPackaged
  ? path.join(APP_ROOT, 'macos-speech-transcriber')
  : path.join(APP_ROOT, '..', 'macos-speech-transcriber');
const COMPUTER_HELPER_PATH = app.isPackaged
  ? path.join(APP_ROOT, 'macos-computer-bridge')
  : path.join(APP_ROOT, '..', 'macos-computer-bridge');

let serverProcess = null;
let mainWindow = null;
let serverOwnedByApp = false;
let isQuitting = false;
let speechProcess = null;
let computerBridge = null;
let computerBridgePort = 0;
let computerStopRequested = false;
let overlayWindows = [];
let controlDock = null;
const computerBridgeSecret = crypto.randomBytes(32).toString('hex');
let computerHelperBuild = null;

function logDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendLog(name, message) {
  try {
    fs.appendFileSync(path.join(logDir(), name), `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function healthCheck(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(res.statusCode === 200 && health && health.ok === true && health.apiRevision === 'desktop-launcher-v2');
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  if (await healthCheck(DEFAULT_PORT)) {
    return { port: DEFAULT_PORT, reuseExisting: true };
  }
  if (await canListen(DEFAULT_PORT)) {
    return { port: DEFAULT_PORT, reuseExisting: false };
  }
  // The server provides the IDE's local API, so it cannot be replaced with a
  // file:// index.html page.  Do not, however, silently start a second server
  // on a random port: that hides stale processes and breaks the bundled CLI.
  throw new Error(`Le port local ${DEFAULT_PORT} est déjà utilisé par une autre application. Quittez cette application, puis relancez zaalis IDE.`);
}

async function startServer(port, reuseExisting) {
  if (reuseExisting) return;
  if (!fs.existsSync(SERVER_PATH)) {
    throw new Error(`Server binary not found: ${SERVER_PATH}`);
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(SERVER_PATH, 0o755); } catch {}
  }

  serverOwnedByApp = true;
  const logs = logDir();
  const out = fs.openSync(path.join(logs, 'zaalis-server.out.log'), 'a');
  const err = fs.openSync(path.join(logs, 'zaalis-server.err.log'), 'a');
  // Le coeur Rust est livre dans le bundle, a cote de zaalis-server. Le shell
  // pose ici son propre PID : /api/app/close s'en sert pour fermer la fenetre
  // avant d'arreter le serveur (equivalent du taskkill de l'edition Windows).
  const agentdPath = path.join(BUNDLE_DIR, 'zaalis-agentd');
  try { fs.chmodSync(agentdPath, 0o755); } catch {}
  try { fs.chmodSync(path.join(BUNDLE_DIR, 'zaalis-sandbox'), 0o755); } catch {}

  serverProcess = spawn(SERVER_PATH, [], {
    cwd: BUNDLE_DIR,
    env: {
      ...process.env,
      ZAALIS_PORT: String(port),
      PORT: String(port),
      ZAALIS_DESKTOP: 'electron',
      ZAALIS_SHELL_PID: String(process.pid),
      ZAALIS_COMPUTER_BRIDGE_URL: computerBridgePort ? `http://127.0.0.1:${computerBridgePort}` : '',
      ZAALIS_COMPUTER_BRIDGE_SECRET: computerBridgeSecret,
      ...(fs.existsSync(agentdPath) ? { ZAALIS_AGENTD_PATH: agentdPath } : {}),
    },
    stdio: ['ignore', out, err],
    detached: false,
  });

  serverProcess.once('error', (error) => {
    appendLog('zaalis-electron.err.log', `server spawn error: ${error && error.stack ? error.stack : error}`);
  });

  serverProcess.once('exit', (code, signal) => {
    appendLog('zaalis-electron.log', `server exited code=${code} signal=${signal}`);
    serverProcess = null;
    // The UI is served entirely by zaalis-server. If the server we own goes
    // away (crash, or the in-app "Fermer l'IDE" button calling /api/app/close),
    // the window would otherwise be left on a dead page. Quit the whole app so
    // the experience matches the Windows shell, which the server used to close
    // itself via taskkill.
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });

  for (let i = 0; i < 80; i += 1) {
    if (await healthCheck(port)) return;
    await wait(250);
  }
  throw new Error('zaalis-server did not become ready in time.');
}

async function ensureComputerHelper() {
  if (process.platform !== 'darwin') return '';
  // The helper runs from a stable userData path so the TCC-visible location
  // survives reinstalls, but its content must follow the packaged binary:
  // pinning the first-ever copy forever kept shipping old helper bugs (e.g.
  // the accessibility preflight gate) after every application update. TCC
  // attributes Accessibility/Screen Recording to the responsible process —
  // the application — so refreshing the helper does not drop the approval.
  const stableHelper = path.join(app.getPath('userData'), 'macos-computer-bridge-stable');
  if (app.isPackaged) {
    try {
      if (fs.existsSync(COMPUTER_HELPER_PATH)) {
        const bundled = fs.readFileSync(COMPUTER_HELPER_PATH);
        const stale = !fs.existsSync(stableHelper)
          || crypto.createHash('sha256').update(bundled).digest('hex')
            !== crypto.createHash('sha256').update(fs.readFileSync(stableHelper)).digest('hex');
        if (stale) {
          // Write-then-rename: a helper instance currently executing keeps
          // its old inode instead of having its image rewritten underneath.
          const next = `${stableHelper}.next`;
          fs.writeFileSync(next, bundled, { mode: 0o755 });
          fs.renameSync(next, stableHelper);
        }
      }
      if (fs.existsSync(stableHelper)) return stableHelper;
    } catch {}
    return '';
  }
  if (fs.existsSync(COMPUTER_HELPER_PATH)) return COMPUTER_HELPER_PATH;
  if (computerHelperBuild) return computerHelperBuild;
  const source = path.join(__dirname, '..', 'macos_computer_bridge.swift');
  const output = path.join(app.getPath('userData'), 'macos-computer-bridge');
  computerHelperBuild = new Promise((resolve) => {
    if (!fs.existsSync(source)) return resolve('');
    const child = spawn('xcrun', ['swiftc', '-O', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', '-framework', 'ImageIO', '-framework', 'ScreenCaptureKit', source, '-o', output], { stdio: 'ignore' });
    child.once('error', () => resolve(''));
    child.once('close', (code) => resolve(code === 0 && fs.existsSync(output) ? output : ''));
  });
  return computerHelperBuild;
}

async function runComputerHelper(payload) {
  const helperPath = await ensureComputerHelper();
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ ok: false, error: 'unsupported-platform' });
    if (!helperPath) return resolve({ ok: false, error: 'helper-missing' });
    const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ ok: false, error: 'computer-timeout' }); }, 20_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message }); });
    child.once('close', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(stdout.trim() || '{}')); }
      catch { finish({ ok: false, error: stderr.trim() || 'invalid-helper-response' }); }
    });
    try { child.stdin.end(JSON.stringify(payload) + '\n'); }
    catch { clearTimeout(timer); finish({ ok: false, error: 'computer-helper-write-failed' }); }
  });
}

// TCC (the macOS privacy service) evaluates the Electron application and the
// native input/capture helper independently.  Query both in the main process
// so the renderer gets a truthful, actionable result instead of treating a
// pending macOS prompt as a generic permission failure.
async function computerPermissionStatus(prompt = false) {
  if (process.platform !== 'darwin') return { ok: false, error: 'unsupported-platform' };
  let appAccessibility = false;
  let appScreenRecording = 'unknown';
  // The native helper, not Electron, performs the capture and input events.
  // Do not trigger a second app-level TCC prompt here: it would be revoked on
  // every ad-hoc application rebuild while adding no capability.
  try { appAccessibility = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
  try { appScreenRecording = systemPreferences.getMediaAccessStatus('screen'); } catch {}
  const helper = await runComputerHelper({ action: prompt ? 'request_permissions' : 'status' });
  if (!helper || !helper.ok) return { ok: false, error: helper && helper.error || 'helper-unavailable', appAccessibility, appScreenRecording };
  return {
    ...helper,
    // The helper is the process which actually captures the screen and posts
    // events, therefore its two values are the safety gate.
    appAccessibility,
    appScreenRecording,
    helperAccessibility: !!helper.accessibility,
    helperScreenRecording: !!helper.screenRecording,
  };
}

function overlayHTML() {
  // Bordure d'activité = le halo lumineux « setAiControlBorder » du navigateur
  // zaalis, porté ici trait pour trait : un dégradé horizontal qui défile en
  // continu (7 s), diffusé par un blur, découpé en cadre par un masque en
  // plumes (transparent au ras du bord, opaque un peu plus loin, puis
  // re-transparent vers l'intérieur). Deux différences voulues avec le
  // navigateur : les tons sont VIOLETS (au lieu de bleu/cyan), et tout est
  // DEUX FOIS plus épais — masque 20→80 px au lieu de 10→40, blur 28 au lieu
  // de 14, inset -6 au lieu de -3.
  const feather = ['right', 'left', 'bottom', 'top']
    .map((dir) => `linear-gradient(to ${dir},transparent,#000 20px,transparent 80px)`).join(',');
  const flow = 'linear-gradient(90deg,rgba(91,34,175,.85),rgba(157,89,255,.85),rgba(199,140,255,.85),rgba(157,89,255,.85),rgba(91,34,175,.85))';
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
    .edge{position:fixed;inset:-6px;pointer-events:none;opacity:.8;filter:blur(28px);background:${flow};background-size:200% 100%;animation:zflow 7s linear infinite;-webkit-mask:${feather};mask:${feather}}
    .mist{position:fixed;inset:-25%;background:radial-gradient(ellipse at 15% 20%,rgba(157,89,255,.28),transparent 32%),radial-gradient(ellipse at 80% 84%,rgba(102,45,210,.28),transparent 38%);filter:blur(20px);animation:drift 12s ease-in-out infinite alternate}
    @keyframes zflow{from{background-position:0% 50%}to{background-position:200% 50%}}@keyframes drift{to{transform:translate3d(3%, -2%, 0) scale(1.06)}}
  </style></head><body><div class="mist"></div><div class="edge"></div></body></html>`;
}

function dockHTML() {
  return `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.dock{box-sizing:border-box;height:54px;display:flex;align-items:center;gap:12px;padding:0 13px;border:1px solid rgba(214,187,255,.36);border-radius:18px;background:rgba(24,14,42,.88);box-shadow:0 16px 42px rgba(39,10,78,.45);color:#f4ecff;backdrop-filter:blur(18px)}.pulse{width:9px;height:9px;border-radius:50%;background:#b36cff;box-shadow:0 0 13px #b36cff;animation:pulse 1.6s ease-in-out infinite}.label{font-size:12px;font-weight:650;white-space:nowrap}.stop{border:0;border-radius:11px;background:#db3d56;color:white;padding:8px 12px;font-weight:700;font-size:12px;cursor:pointer}.stop:hover{background:#f05068}@keyframes pulse{50%{transform:scale(.6);opacity:.45}}
  </style></head><body><div class="dock"><span class="pulse"></span><span class="label">L’IA travaille sur ce Mac</span><button class="stop" onclick="window.zaalisNative.computer.stop()">Arrêter le travail</button></div></body></html>`;
}

function showComputerOverlay() {
  if (process.platform !== 'darwin' || overlayWindows.length) return;
  for (const display of require('electron').screen.getAllDisplays()) {
    const win = new BrowserWindow({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHTML())}`);
    overlayWindows.push(win);
  }
  const primary = require('electron').screen.getPrimaryDisplay().workArea;
  controlDock = new BrowserWindow({ width: 320, height: 58, x: Math.round(primary.x + (primary.width - 320) / 2), y: primary.y + primary.height - 92, transparent: true, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
  controlDock.setAlwaysOnTop(true, 'screen-saver');
  controlDock.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(dockHTML())}`);
  controlDock.on('closed', () => { controlDock = null; });
}

function hideComputerOverlay() {
  for (const win of overlayWindows.splice(0)) { try { if (!win.isDestroyed()) win.close(); } catch {} }
  try { if (controlDock && !controlDock.isDestroyed()) controlDock.close(); } catch {}
  controlDock = null;
}

function requestServerAutomationStop() {
  computerStopRequested = true;
  hideComputerOverlay();
  const req = http.request({ host: '127.0.0.1', port: DEFAULT_PORT, path: '/api/automation/stop-bridge', method: 'POST', headers: { 'x-zaalis-computer': computerBridgeSecret, 'Content-Length': '0' } });
  req.on('error', () => {}); req.end();
}

async function startComputerBridge() {
  if (computerBridge) return computerBridgePort;
  computerBridge = http.createServer(async (req, res) => {
    if (req.headers['x-zaalis-computer'] !== computerBridgeSecret) { res.writeHead(403); return res.end(); }
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); if (Buffer.concat(chunks).length > 12 * 1024 * 1024) { res.writeHead(413); return res.end(); } }
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid-json' })); }
    if (req.method === 'GET' && req.url === '/status') body = { action: 'status' };
    let result;
    if (body.action === 'overlay_start') { computerStopRequested = false; showComputerOverlay(); result = { ok: true }; }
    else if (body.action === 'overlay_stop') { hideComputerOverlay(); result = { ok: true }; }
    else if (body.action === 'cancel_status') result = { ok: true, stopped: computerStopRequested };
    else if (computerStopRequested) result = { ok: false, error: 'stopped' };
    else result = await runComputerHelper(body);
    res.writeHead(result.ok === false ? 409 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { computerBridge.once('error', reject); computerBridge.listen(0, '127.0.0.1', () => resolve()); });
  computerBridgePort = computerBridge.address().port;
  return computerBridgePort;
}

function createWindow(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const allowedOrigin = url.startsWith(baseUrl);
    callback(allowedOrigin && (permission === 'media' || permission === 'audioCapture'));
  });

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'zaalis IDE',
    backgroundColor: '#0b0f17',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadURL(baseUrl);
}

function emitSpeechEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mac-speech-event', payload);
}

function stopSpeechProcess() {
  return new Promise((resolve) => {
    if (!speechProcess) return resolve();
    const proc = speechProcess;
    speechProcess = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      emitSpeechEvent({ status: 'end' });
      resolve();
    };
    proc.once('exit', finish);
    try { proc.stdin.write('stop\n'); } catch {}
    setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGTERM'); } catch {}
      finish();
    }, 1500);
  });
}

function stopServer() {
  if (!serverOwnedByApp || !serverProcess) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      serverProcess.kill('SIGTERM');
    }
  } catch {}
  serverProcess = null;
}

ipcMain.handle('pick-folder', async () => {
  if (!mainWindow) return { cancelled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a Project',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { cancelled: true };
  return { path: result.filePaths[0] };
});

ipcMain.handle('mac-speech-supported', async () => {
  return process.platform === 'darwin' && fs.existsSync(SPEECH_HELPER_PATH);
});

ipcMain.handle('mac-speech-start', async (_event, language) => {
  if (process.platform !== 'darwin') return { ok: false, error: 'unsupported-platform' };
  if (!fs.existsSync(SPEECH_HELPER_PATH)) return { ok: false, error: 'helper-missing' };

  await stopSpeechProcess();

  let microphoneAllowed = true;
  try {
    microphoneAllowed = await systemPreferences.askForMediaAccess('microphone');
  } catch {
    microphoneAllowed = false;
  }
  if (!microphoneAllowed) return { ok: false, error: 'microphone-denied' };

  try { fs.chmodSync(SPEECH_HELPER_PATH, 0o755); } catch {}

  const lang = String(language || 'fr-FR');
  const proc = spawn(SPEECH_HELPER_PATH, [lang], {
    cwd: path.dirname(SPEECH_HELPER_PATH),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  speechProcess = proc;

  let stdout = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { emitSpeechEvent(JSON.parse(line)); }
      catch { emitSpeechEvent({ status: 'error', error: 'invalid-helper-output' }); }
    }
  });

  proc.stderr.on('data', (chunk) => {
    appendLog('zaalis-speech.err.log', chunk.toString('utf8').trim());
  });

  proc.once('error', (error) => {
    if (speechProcess === proc) speechProcess = null;
    emitSpeechEvent({ status: 'error', error: error && error.message ? error.message : String(error) });
  });

  proc.once('exit', (code, signal) => {
    if (speechProcess === proc) {
      speechProcess = null;
      emitSpeechEvent({ status: 'end', code, signal });
    }
  });

  return { ok: true };
});

ipcMain.handle('mac-speech-stop', async () => {
  await stopSpeechProcess();
  return { ok: true };
});

ipcMain.handle('mac-computer-status', async () => computerPermissionStatus(false));
ipcMain.handle('mac-computer-request-permissions', async () => computerPermissionStatus(true));
ipcMain.handle('computer-dock-stop', async () => {
  requestServerAutomationStop();
  return { ok: true };
});

let cookiesFlushed = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  stopSpeechProcess();
  hideComputerOverlay();
  try { computerBridge && computerBridge.close(); } catch {}
  stopServer();

  // Chromium écrit les cookies persistants (dont zaalis_session) de façon
  // différée. Sur un Cmd+Q / « Quitter » macOS, l'app peut se terminer avant
  // que le cookie de session n'ait été committé sur disque : au relancement il
  // manque et l'utilisateur doit se reconnecter. On force donc un flush du
  // cookie store avant de laisser l'app quitter réellement.
  if (cookiesFlushed) return;
  event.preventDefault();
  const done = () => {
    cookiesFlushed = true;
    app.quit();
  };
  const flush = session.defaultSession.cookies.flushStore();
  // Ne jamais bloquer la fermeture indéfiniment si le flush traîne.
  const safety = setTimeout(done, 1500);
  Promise.resolve(flush)
    .catch((error) => appendLog('zaalis-electron.err.log', `cookie flush error: ${error && error.stack ? error.stack : error}`))
    .finally(() => { clearTimeout(safety); done(); });
});
app.on('window-all-closed', () => app.quit());

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// On macOS, expose the `zaalis` CLI in the shell PATH by symlinking it into
// /usr/local/bin (if writable) or ~/.local/bin. The tar.gz installer already
// does this, but a plain drag-to-Applications from the .dmg does not; without
// it, `zaalis ide` in Terminal won't work. Silent on any failure — the app
// itself still runs fine without the shell shortcut.
function ensureZaalisSymlink() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const cliPath = path.join(BUNDLE_DIR, 'bin', process.platform === 'win32' ? 'zaalis.exe' : 'zaalis');
  if (!fs.existsSync(cliPath)) return;
  const targets = [];
  try { fs.accessSync('/usr/local/bin', fs.constants.W_OK); targets.push('/usr/local/bin/zaalis'); } catch {}
  if (!targets.length) {
    const userBin = path.join(os.homedir(), '.local', 'bin');
    try { fs.mkdirSync(userBin, { recursive: true }); targets.push(path.join(userBin, 'zaalis')); } catch {}
  }
  for (const link of targets) {
    try {
      const cur = fs.readlinkSync(link);
      if (cur === cliPath) continue; // already correct
      fs.unlinkSync(link);
    } catch {}
    try { fs.symlinkSync(cliPath, link); } catch {}
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  ensureZaalisSymlink();

  try {
    await startComputerBridge();
    const { port, reuseExisting } = await pickPort();
    await startServer(port, reuseExisting);
    createWindow(port);
  } catch (error) {
    dialog.showErrorBox('zaalis IDE', error && error.message ? error.message : String(error));
    app.quit();
  }
});
