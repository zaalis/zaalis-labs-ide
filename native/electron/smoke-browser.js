'use strict';
// Run with the platform Electron executable; no visible windows or user data.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-electron-smoke-'));
app.setPath('userData', path.join(temp, 'electron'));
const { ElectronBrowserBridge } = require('./browser-bridge');
const { BrowserHost } = require('../../zaalis-browser/host');
let bridge, host, fixture, win;
app.whenReady().then(async () => {
  try {
    fixture = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Platform browser test</title><h1>Portage valide</h1><input id="name"><button onclick="document.querySelector(\'h1\').textContent=\'Action valide\'">Valider</button>'); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    bridge = new ElectronBrowserBridge();
    await bridge.start();
    win = new BrowserWindow({ show: !!process.env.ZAALIS_TEST_DISPLAY, width: 1100, height: 800 }); bridge.attach(win);
    bridge.panel = { x: 0, y: 0, width: 1000, height: 700 }; bridge.visible = true;
    const secret = path.join(temp, 'browser-secret'); fs.writeFileSync(secret, 'test-secret');
    host = new BrowserHost({ pipePath: bridge.pipe, token: bridge.token, dataDir: path.join(temp, 'Browser'), secretFile: secret, idePort: fixture.address().port });
    const connected = new Promise(resolve => host.once('available', resolve)); host.connect(); await connected;
    bridge.send({ ev: 'panel', visible: true });
    await host.ensureStarted();
    const url = `http://127.0.0.1:${fixture.address().port}/`;
    await host.open(url);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const result = await host.agentTool('read_page', {});
    assert.match(String(result), /Portage valide/);
    const tabs = await host.agentTool('tabs', {}); assert.match(String(tabs), /Platform browser test/);
    await host.agentTool('fill', { selector: '#name', value: 'Zaalis' });
    console.log('CLICK_RESULT=' + await host.agentTool('click', { selector: 'button' }));
    assert.match(String(await host.agentTool('read_page', {})), /Action valide/);
    const screenshot = await host.agentTool('screenshot', {});
    assert.ok(screenshot.image && Buffer.from(screenshot.image, 'base64').length > 1000);
    fs.writeFileSync(path.resolve(__dirname, '../../../ide-port-backup-20260930/browser.jpg'), Buffer.from(screenshot.image, 'base64'));
    const composite = await win.webContents.capturePage();
    fs.writeFileSync(path.resolve(__dirname, '../../../ide-port-backup-20260930/browser-ui.png'), composite.toPNG());
    console.log('BROWSER_SMOKE_OK: real Chromium navigation, read_page, tabs and screenshot');
    console.log('SCREENSHOT=' + path.join(temp, 'browser.jpg'));
    app.exit(0);
  } catch (error) { console.error(error.stack); app.exit(1); }
}).finally(() => { try { host?.socket?.destroy(); bridge?.close(); fixture?.close(); win?.destroy(); } catch {} });
setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 45000).unref();
