'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
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

let serverProcess = null;
let mainWindow = null;
let serverOwnedByApp = false;

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
  });

  for (let i = 0; i < 80; i += 1) {
    if (await healthCheck(port)) return;
    await wait(250);
  }
  throw new Error('zaalis-server did not become ready in time.');
}

function createWindow(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
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

app.on('before-quit', stopServer);
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  app.setName('zaalis IDE');
  app.setPath('userData', path.join(app.getPath('appData'), 'zaalis', 'electron'));

  try {
    const { port, reuseExisting } = await pickPort();
    await startServer(port, reuseExisting);
    createWindow(port);
  } catch (error) {
    dialog.showErrorBox('zaalis IDE', error && error.message ? error.message : String(error));
    app.quit();
  }
});
