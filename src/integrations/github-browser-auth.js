'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Delegate OAuth to the official client, with an isolated ephemeral config.
// Existing gh sessions, credentials, Git helpers and configuration are untouched.
class GitHubBrowserAuth {
  constructor({ appDir, dataDir, binary, spawnImpl = spawn, runImpl = run }) {
    this.binary = binary || [path.join(appDir, 'github', 'gh.exe'), path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe')].find(p => fs.existsSync(p)) || '';
    this.dir = path.join(dataDir, 'github-signin');
    this.spawn = spawnImpl; this.run = runImpl; this.flows = new Map();
  }
  get available() { return !!this.binary; }
  clean(flow) {
    if (!flow) return;
    clearTimeout(flow.timer);
    flow.cancelReject?.(Error('Connexion annulée.')); flow.cancelReject = null;
    flow.child?.kill();
    if (flow.dir && path.dirname(flow.dir) === path.resolve(this.dir) && path.basename(flow.dir).startsWith('signin-')) {
      try { fs.rmSync(flow.dir, { recursive: true, force: true }); } catch { /* A closing client may briefly hold its config file. */ }
    }
  }
  cancel(id) { const flow = this.flows.get(id); this.flows.delete(id); this.clean(flow); }
  async start(id) {
    if (!this.available) throw Error('Client GitHub indisponible. Réinstallez la dernière version de Zaalis.');
    this.cancel(id);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(path.resolve(this.dir), 'signin-'));
    const env = { ...process.env, GH_CONFIG_DIR: dir, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'GH_FORCE_TTY']) delete env[key];
    const flow = { dir, env, done: false, error: false };
    this.flows.set(id, flow);
    return new Promise((resolve, reject) => {
      flow.cancelReject = reject;
      let output = '', announced = false;
      const fail = () => { if (this.flows.get(id) !== flow) return; flow.error = true; if (!announced) { this.cancel(id); reject(Error('La connexion GitHub a échoué. Réessayez.')); } };
      try {
        const child = this.spawn(this.binary, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--insecure-storage'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        flow.child = child;
        const read = chunk => {
          if (this.flows.get(id) !== flow) return;
          output = (output + chunk.toString()).slice(-8192);
          const match = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
          if (match && !announced) { announced = true; flow.cancelReject = null; output = ''; resolve({ code: match[1], url: 'https://github.com/login/device', interval: 2, expiresIn: 900, method: 'github-cli' }); }
        };
        child.stdout.on('data', read); child.stderr.on('data', read);
        child.on('error', fail); child.on('close', code => { flow.child = null; if (this.flows.get(id) !== flow) { this.clean(flow); return; } flow.done = code === 0; if (code !== 0) fail(); });
        flow.timer = setTimeout(() => { if (this.flows.get(id) === flow) { fail(); this.cancel(id); } }, 900000); flow.timer.unref();
      } catch { fail(); }
    });
  }
  async poll(id) {
    const flow = this.flows.get(id);
    if (!flow || flow.error) { this.cancel(id); throw Error('Connexion GitHub refusée, annulée ou expirée.'); }
    if (!flow.done) return { pending: true, interval: 2 };
    try {
      const { stdout } = await this.run(this.binary, ['auth', 'token', '--hostname', 'github.com'], { env: flow.env, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
      if (this.flows.get(id) !== flow) throw Error('Connexion annulée.');
      return { token: stdout.trim() };
    } catch { throw Error('Impossible de terminer la connexion GitHub. Réessayez.'); }
    finally { if (this.flows.get(id) === flow) this.cancel(id); }
  }
}
module.exports = { GitHubBrowserAuth };
