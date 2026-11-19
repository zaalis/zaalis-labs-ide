#!/usr/bin/env node
'use strict';
// Renders glyphes/media/video.html frame by frame through a headless Edge or
// Chrome (DevTools protocol, no extra dependency) and encodes an MP4 with ffmpeg.
//   node glyphes/media/render-video.js [variant] [out.mp4]
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const variant = process.argv[2] || 'nova';
const out = path.resolve(process.argv[3] || path.join(__dirname, `glyphe-${variant}.mp4`));
const browsers = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(p => fs.existsSync(p));
if (!browsers.length) throw new Error('Edge ou Chrome introuvable.');
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-frames-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-profile-'));
const port = 9300 + Math.floor(Math.random() * 500);

async function main() {
    const browser = spawn(browsers[0], [`--remote-debugging-port=${port}`, '--headless=new', `--user-data-dir=${profile}`,
        '--allow-file-access-from-files', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1080,1080', 'about:blank'], { stdio: 'ignore' });
    try {
        let targets;
        for (let i = 0; i < 50 && !targets; i++) {
            await new Promise(r => setTimeout(r, 200));
            targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => null);
        }
        const page = targets.find(t => t.type === 'page');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        let id = 0; const pending = new Map(), waiters = [];
        ws.onmessage = event => {
            const msg = JSON.parse(event.data);
            if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
            else if (msg.method) waiters.splice(0).forEach(w => w(msg));
        };
        const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
        await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1080, deviceScaleFactor: 1, mobile: false });
        const url = 'file:///' + path.join(__dirname, 'video.html').replace(/\\/g, '/') + `?variant=${variant}`;
        await send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 1500));
        const total = (await send('Runtime.evaluate', { expression: 'window.TOTAL_FRAMES', returnByValue: true })).result.value;
        if (!total) throw new Error('Page vidéo non chargée.');
        for (let i = 0; i < total; i++) {
            await send('Runtime.evaluate', { expression: `renderFrame(${i})` });
            const shot = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(frames, `f${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
            if (i % 120 === 0) process.stdout.write(`frame ${i}/${total}\n`);
        }
        ws.close();
    } finally { browser.kill(); }
    const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(frames, 'f%05d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: 'inherit' });
    if (enc.status !== 0) throw new Error('ffmpeg a échoué.');
    // Still icon from the first frame, and a looping GIF-free poster for the docs.
    fs.copyFileSync(path.join(frames, 'f00030.png'), out.replace(/\.mp4$/, '.png'));
    fs.rmSync(frames, { recursive: true, force: true });
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    console.log('OK', out);
}
main().catch(error => { console.error(error); process.exit(1); });
