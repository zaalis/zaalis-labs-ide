#!/usr/bin/env node
'use strict';
// Renders the app icons (PNG) of the Glyphes web app with a headless Edge or
// Chrome over the DevTools protocol, then scales them with ffmpeg.
//   node glyphes/media/render-icons.js [variant]
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const variant = process.argv[2] || 'nova';
const outDir = path.join(__dirname, '..', '..', 'interface', 'glyphes', 'icons');
const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
if (!browser) throw new Error('Edge ou Chrome introuvable.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-icons-'));
const port = 9800 + Math.floor(Math.random() * 150);

async function main() {
    fs.mkdirSync(outDir, { recursive: true });
    const proc = spawn(browser, [`--remote-debugging-port=${port}`, '--headless=new', `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
    try {
        let targets;
        for (let i = 0; i < 50 && !targets; i++) { await new Promise(r => setTimeout(r, 200)); targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => null); }
        const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        let id = 0; const pending = new Map();
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
        const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
        await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 600, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        await send('Page.navigate', { url: 'file:///' + path.join(__dirname, 'icons.html').replace(/\\/g, '/') });
        await new Promise(r => setTimeout(r, 1200));
        const shot = async (kind, size, file) => {
            await send('Runtime.evaluate', { expression: `show(${JSON.stringify(kind)}, ${JSON.stringify(variant)})` });
            await new Promise(r => setTimeout(r, 100));
            const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
        };
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-icon-'));
        await shot('icon', 512, path.join(tmp, 'icon.png'));
        await shot('mask', 512, path.join(tmp, 'mask.png'));
        await shot('badge', 96, path.join(tmp, 'badge.png'));
        // The badge is an alpha mask: key out the (opaque) background.
        spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'badge.png'), '-vf', 'format=rgba,colorkey=0x000000:0.3:0.1', path.join(outDir, 'badge-96.png')]);
        ws.close();
        const scale = (src, size, dest) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${size}:${size}:flags=lanczos`, dest]); if (r.status) throw new Error('ffmpeg'); };
        fs.copyFileSync(path.join(tmp, 'icon.png'), path.join(outDir, 'glyph-512.png'));
        fs.copyFileSync(path.join(tmp, 'mask.png'), path.join(outDir, 'glyph-maskable-512.png'));
        scale(path.join(tmp, 'icon.png'), 192, path.join(outDir, 'glyph-192.png'));
        scale(path.join(tmp, 'icon.png'), 180, path.join(outDir, 'glyph-180.png'));
        scale(path.join(tmp, 'icon.png'), 64, path.join(outDir, 'glyph-64.png'));
        fs.rmSync(tmp, { recursive: true, force: true });
    } finally { proc.kill(); }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    console.log('OK', fs.readdirSync(outDir).join(', '));
}
main().catch(e => { console.error(e); process.exit(1); });
