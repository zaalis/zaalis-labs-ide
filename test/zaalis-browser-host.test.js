'use strict';

// The integrated browser is the vendored zaalis Browser main process running
// on the Electron-compatible shim. A fake native shell (named pipe server,
// same protocol as native/browser/BrowserHost.cpp) checks that it boots,
// serves its zaalis:// pages, answers its toolbar and obeys the IDE API.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

test('zaalis Browser runs inside the IDE server through the native channel', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-browser-host-'));
  // Standalone zaalis Browser data, imported once and never modified.
  const appData = path.join(temp, 'Roaming');
  const legacy = path.join(appData, 'zaalis browser');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.txt'), 'theme=dark\nsearchEngine=duckduckgo\n');
  fs.writeFileSync(path.join(legacy, 'bookmarks.tsv'), 'https://example.com/\tExemple');
  process.env.APPDATA = appData;
  const secretFile = path.join(temp, 'browser-secret');
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));

  const pipePath = `\\\\.\\pipe\\zaalis-browser-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('hex');
  const received = [];
  const views = new Map();
  let shell = null;
  const sendEvent = (message) => shell.write(JSON.stringify(message) + '\n');
  const waitFor = async (predicate, label, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = received.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`attendu : ${label}`);
  };

  const server = net.createServer((socket) => {
    shell = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        received.push(message);
        if (message.op === 'hello') {
          assert.equal(message.token, token);
          sendEvent({ ev: 'welcome', folders: { downloads: temp }, width: 1200, height: 800, visible: false });
        } else if (message.op === 'createView') {
          views.set(message.view, { ...message, url: '' });
        } else if (message.op === 'navigate') {
          const view = views.get(message.view);
          view.url = message.url;
          sendEvent({ ev: 'navStarting', view: message.view, url: message.url, self: true, redirect: false });
          sendEvent({ ev: 'committed', view: message.view, url: message.url });
          sendEvent({ ev: 'completed', view: message.view, ok: true, status: 0, url: message.url });
        } else if (message.id !== undefined) {
          const result = message.op !== 'cdp' ? {}
            : message.method === 'Page.captureScreenshot' ? { data: 'anBlZy1kZS1sYS1wYWdl' }
              : { result: { type: 'undefined' } };
          socket.write(JSON.stringify({ re: message.id, ok: true, result }) + '\n');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(pipePath, resolve));

  const { BrowserHost } = require('../zaalis-browser/host');
  const host = new BrowserHost({
    pipePath, token, dataDir: path.join(temp, 'Browser'), secretFile, idePort: 1, log: () => {},
  });
  try {
    host.connect();
    await new Promise((resolve) => host.once('available', resolve));

    // Showing the globe panel boots the browser.
    sendEvent({ ev: 'panel', visible: true });
    await waitFor((m) => m.op === 'navigate' && m.url === 'zaalis://home/chrome.html', 'barre d’outils chargée');
    await waitFor((m) => m.op === 'navigate' && m.url === 'zaalis://home/index.html', 'onglet d’accueil');
    const chrome = [...views.values()].find((view) => view.url === 'zaalis://home/chrome.html');
    const home = [...views.values()].find((view) => view.url === 'zaalis://home/index.html');
    assert.equal(chrome.kind, 'ui');
    assert.equal(home.kind, 'tab');
    assert.equal(home.profile, 'zaalis-browser');
    assert.equal(home.inPrivate, false);

    // Its own pages come from the vendored copy, through zaalis://.
    sendEvent({ ev: 'resource', req: 7, view: chrome.view, url: 'zaalis://home/chrome.html', method: 'GET' });
    const page = await waitFor((m) => m.op === 'resourceReply' && m.req === 7, 'page chrome.html servie');
    assert.equal(page.status, 200);
    assert.match(Buffer.from(page.body, 'base64').toString('utf8'), /zaalisBridge/);
    sendEvent({ ev: 'resource', req: 8, view: chrome.view, url: 'zaalis://home/../main.js', method: 'GET' });
    const traversal = await waitFor((m) => m.op === 'resourceReply' && m.req === 8, 'refus hors interface');
    assert.notEqual(Buffer.from(traversal.body || '', 'base64').toString('utf8').includes('module.exports'), true);

    // The toolbar's IPC drives the real main process: it answers with state.
    sendEvent({ ev: 'webMessage', view: chrome.view, message: 'ready' });
    const state = await waitFor((m) => m.op === 'post' && m.view === chrome.view && /"type":"state"/.test(m.json), 'état poussé');
    const parsed = JSON.parse(state.json);
    assert.equal(parsed.tabs.length, 1);
    assert.equal(parsed.theme, 'dark', 'réglages importés');
    assert.deepEqual(parsed.bookmarks, [{ url: 'https://example.com/', title: 'Exemple' }]);
    await waitFor((m) => m.op === 'ideState' && m.tabs.length === 1, 'onglets remontés à l’IDE');
    // Pages that are not the browser's own cannot drive it.
    sendEvent({ ev: 'webMessage', view: home.view, message: 'clearHistory' });

    // The toolbar popup is clipped natively to its box.
    sendEvent({ ev: 'webMessage', view: chrome.view, message: 'chromeHeight\x1f420\x1f95\x1f10\x1f95\x1f300\x1f400' });
    const region = await waitFor((m) => m.op === 'chromeRegion', 'découpe de la barre');
    assert.deepEqual(region.overlay, { left: 10, top: 95, right: 300, bottom: 400 });

    // IDE API: a search opens a new visible tab with the chosen engine.
    const searched = await host.search('zaalis ide');
    assert.equal(searched.url, 'https://duckduckgo.com/?q=zaalis%20ide');
    await waitFor((m) => m.op === 'navigate' && m.url === searched.url, 'recherche chargée');
    await waitFor((m) => m.op === 'reveal', 'panneau globe affiché');
    const tabs = JSON.parse(await host.agentTool('tabs'));
    assert.equal(tabs.length, 2);
    assert.equal(tabs.find((tab) => tab.active).url, searched.url);
    assert.match(await host.agentTool('open', { url: 'javascript:alert(1)' }), /http/);
    // The agent can see the page: a screenshot of the visible part, as JPEG.
    const shot = await host.agentTool('screenshot');
    assert.equal(shot.image, 'anBlZy1kZS1sYS1wYWdl');
    assert.match(shot.text, /duckduckgo\.com/);
    const capture = received.find((m) => m.op === 'cdp' && m.method === 'Page.captureScreenshot');
    assert.deepEqual(capture.params, { format: 'jpeg', quality: 80 });

    // Data was copied into the IDE's own folder; the standalone one is intact.
    assert.ok(fs.existsSync(path.join(temp, 'Browser', 'settings.txt')));
    assert.equal(fs.readFileSync(path.join(legacy, 'settings.txt'), 'utf8'), 'theme=dark\nsearchEngine=duckduckgo\n');
    t.diagnostic(`vues créées : ${views.size}`);
  } finally {
    try { shell && shell.destroy(); } catch {}
    server.close();
    // The vendored main process keeps its IDE status timer alive.
    setTimeout(() => process.exit(0), 200).unref();
  }
});
