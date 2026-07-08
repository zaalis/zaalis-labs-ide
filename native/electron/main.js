'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

const DEFAULT_PORT = Number(process.env.ZAALIS_PORT || process.env.PORT) || 3000;
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : __dirname;
const BUNDLE_DIR = path.join(APP_ROOT, 'bundle');
const SERVER_BIN = process.platform === 'win32' ? 'zaalis-server.exe' : 'zaalis-server';
const SERVER_PATH = path.join(BUNDLE_DIR, SERVER_BIN);
const ICON_PATH = path.join(BUNDLE_DIR, 'image', process.platform === 'darwin' ? 'logo-zaalis.icns' : 'logo-zaalis.png');
const SPEECH_HELPER_PATH = app.isPackaged
  ? path.join(APP_ROOT, 'macos-speech-transcriber')
  : path.join(APP_ROOT, '..', 'macos-speech-transcriber');

let serverProcess = null;
let mainWindow = null;
let serverOwnedByApp = false;
let isQuitting = false;
let speechProcess = null;

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
      path: '/api/auth/me',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.listen(0, '127.0.0.1');
  });
}

async function pickPort() {
  if (await healthCheck(DEFAULT_PORT)) {
    return { port: DEFAULT_PORT, reuseExisting: true };
  }
  if (await canListen(DEFAULT_PORT)) {
    return { port: DEFAULT_PORT, reuseExisting: false };
  }
  return { port: await getFreePort(), reuseExisting: false };
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
  serverProcess = spawn(SERVER_PATH, [], {
    cwd: BUNDLE_DIR,
    env: {
      ...process.env,
      ZAALIS_PORT: String(port),
      PORT: String(port),
      ZAALIS_DESKTOP: 'electron',
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

let cookiesFlushed = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  stopSpeechProcess();
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
  app.setName('zaalis IDE');
  app.setPath('userData', path.join(app.getPath('appData'), 'zaalis', 'electron'));

  ensureZaalisSymlink();

  try {
    const { port, reuseExisting } = await pickPort();
    await startServer(port, reuseExisting);
    createWindow(port);
  } catch (error) {
    dialog.showErrorBox('zaalis IDE', error && error.message ? error.message : String(error));
    app.quit();
  }
});
