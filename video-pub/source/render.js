// node render.js stills 1.2 3.5 ...   |   node render.js all
const { launch } = require('./cdp');
const path = require('path');
const fs = require('fs');
(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  const b = await launch({ port: Number(process.env.CDP_PORT || 9340), width: 1920, height: 1080, scale: 1 });
  const FILM = process.env.FILM || 'film.html', THEME = process.env.THEME || 'dark';
  const url = 'file:///' + path.join(__dirname, FILM).split(path.sep).join('/') + '?render&theme=' + THEME;
  await b.goto(url);
  await b.eval('window.ready');
  const frame = async T => { await b.eval(`render(${T}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`); };
  if (mode === 'stills') {
    const dir = path.join(__dirname, process.env.STILLS || 'stills'); fs.mkdirSync(dir, { recursive: true });
    for (const s of rest) { await frame(Number(s)); await b.shot(path.join(dir, `t${String(s).padStart(5, '0')}.png`)); }
  } else {
    const FPS = 24; const dir = path.join(__dirname, process.env.FRAMES || 'frames'); fs.mkdirSync(dir, { recursive: true });
    const dur = await b.eval('window.DURATION'); const n = Math.round(dur * FPS);
    const from = Number(rest[0] || 0), to = Number(rest[1] || n);
    for (let f = from; f < to; f++) {
      await frame(f / FPS);
      await b.shot(path.join(dir, `f${String(f).padStart(5, '0')}.png`));
      if (f % 48 === 0) process.stdout.write(`frame ${f}/${n}\n`);
    }
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
