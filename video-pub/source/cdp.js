'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch({ port = 9333, width = 1600, height = 1000, scale = 2 } = {}) {
  const profile = path.join(__dirname, '.chrome-profile-' + port);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-gpu-vsync', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  let info;
  for (let i = 0; i < 80; i++) { try { info = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (info.find(t => t.type === 'page')) break; } catch {} await sleep(150); }
  const page = info.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } else listeners.forEach(l => l(m)); };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  listeners.push(m => { if (m.method === 'Runtime.consoleAPICalled' && process.env.CDP_LOG) console.log('[page]', m.params.args.map(a => a.value).join(' ')); if (m.method === 'Runtime.exceptionThrown') console.log('[page error]', m.params.exceptionDetails.exception?.description?.slice(0, 300)); });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  const api = {
    send,
    async goto(url) { await send('Page.navigate', { url }); await sleep(400); for (let i = 0; i < 100; i++) { const r = await api.eval('document.readyState'); if (r === 'complete') break; await sleep(100); } },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    async shot(file, opts = {}) { const r = await send('Page.captureScreenshot', { format: opts.format || 'png', quality: opts.quality, captureBeyondViewport: false, clip: opts.clip }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); },
    async close() { try { await send('Browser.close'); } catch {} try { proc.kill(); } catch {} },
    sleep,
  };
  return api;
}
module.exports = { launch, sleep };
