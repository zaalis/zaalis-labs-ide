'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function cloneInput(input) {
  let url = String(input.url || '').trim();
  if (/^git@[a-z0-9.-]+:[^\s]+$/i.test(url)) url = 'ssh://' + url.replace(':', '/');
  let parsed; try { parsed = new URL(url); } catch { throw new Error('URL du dépôt invalide.'); }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname || parsed.password || parsed.search || parsed.hash || parsed.protocol === 'https:' && parsed.username) throw new Error('Utilisez une URL HTTPS ou SSH sans identifiants intégrés.');
  const parent = fs.realpathSync(String(input.parent || ''));
  if (!fs.statSync(parent).isDirectory()) throw new Error('Le dossier parent est invalide.');
  const name = String(input.name || decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')).replace(/\.git$/i, '');
  if (!name || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(\.|\.\.|con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new Error('Nom de dossier invalide.');
  const destination = path.join(parent, name);
  if (fs.existsSync(destination)) throw new Error('Ce dossier existe déjà. Choisissez un autre nom.');
  return { url: parsed.toString(), parent, destination };
}

function mountProjectClone(app, spawnProcess = spawn) {
  app.post('/api/projects/clone', (req, res) => {
    let args; try { args = cloneInput(req.body || {}); } catch (error) { return res.status(400).json({ error: error.message }); }
    const stage = fs.mkdtempSync(path.join(args.parent, '.zaalis-clone-'));
    let stderr = '', timedOut = false;
    const child = spawnProcess('git', ['clone', '--', args.url, stage], { cwd: args.parent, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, stdio: ['ignore', 'ignore', 'pipe'] });
    const stop = () => {
      if (child.exitCode !== null) return;
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());
      else { try { process.kill(-child.pid,'SIGTERM'); } catch { child.kill(); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 180000);
    res.on('close', () => { if (!res.writableEnded) stop(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    let handled = false;
    const finish = (code, error) => {
      if (handled) return; handled = true; clearTimeout(timer);
      try {
        if (code !== 0 || error) throw new Error(timedOut ? 'Clonage interrompu après trois minutes.' : error?.code === 'ENOENT' ? 'Git n’est pas installé ou accessible.' : stderr.replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(-1000) || 'Clonage interrompu.');
        if (fs.existsSync(args.destination)) throw new Error('Le dossier de destination a été créé entre-temps.');
        fs.renameSync(stage, args.destination);
        if (!res.destroyed) res.json({ path: args.destination });
      } catch (problem) {
        // Only our own freshly-created staging folder can be removed.
        if (path.dirname(stage) === args.parent && path.basename(stage).startsWith('.zaalis-clone-')) fs.rmSync(stage, { recursive: true, force: true });
        if (!res.destroyed) res.status(400).json({ error: problem.message });
      }
    };
    child.once('error', error => finish(null, error)); child.once('close', code => finish(code));
  });
}
module.exports = { mountProjectClone, cloneInput };
