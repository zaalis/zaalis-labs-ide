'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const path = require('path');

// A native PTY addon must never prevent the IDE from starting.  In a packaged
// build it is loaded only when the user opens the integrated terminal, so a
// damaged/mismatched optional addon degrades that feature instead of taking
// down the local server (and therefore Electron) at boot.
let pty = null;
let ptyLoadError = null;
function ptyModule() {
  if (pty || ptyLoadError) return pty;
  try {
    // pkg keeps JS in its snapshot but a .node addon must live on disk. The
    // macOS packager places the matching architecture beside zaalis-server.
    // Never use pkg's cache extraction: it may contain a different Node ABI.
    const packagedModule = process.pkg && path.join(path.dirname(process.execPath), 'node_modules', 'node-pty');
    pty = packagedModule ? require(packagedModule) : require('node-pty');
  }
  catch (error) { ptyLoadError = error; }
  return pty;
}

const MAX_BUFFER = 512 * 1024;

class TerminalManager {
  constructor() { this.sessions = new Map(); }

  create({ userId, cwd }) {
    const ptyRuntime = ptyModule();
    if (!ptyRuntime) throw new Error(`Terminal intégré indisponible : ${ptyLoadError && ptyLoadError.message ? ptyLoadError.message : 'module natif non chargé'}`);
    const id = crypto.randomUUID();
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh';
    const args = process.platform === 'win32' ? [] : ['-il'];
    const proc = ptyRuntime.spawn(shell, args, { name: 'xterm-256color', cols: 100, rows: 26, cwd, env: { ...process.env, TERM: 'xterm-256color' } });
    let readyResolve = null;
    const session = { id, userId, cwd, proc, buffer: '', events: new EventEmitter(), closed: false, ready: new Promise((resolve) => { readyResolve = resolve; }) };
    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.events.emit('data', data);
      if (readyResolve) { readyResolve(); readyResolve = null; }
    });
    proc.onExit(({ exitCode, signal }) => { session.closed = true; session.events.emit('exit', { exitCode, signal }); });
    this.sessions.set(id, session);
    return session;
  }

  get(id, userId) {
    const session = this.sessions.get(id);
    return session && session.userId === userId ? session : null;
  }

  latest(userId, cwd) {
    for (const session of Array.from(this.sessions.values()).reverse()) if (!session.closed && session.userId === userId && session.cwd === cwd) return session;
    return this.create({ userId, cwd });
  }

  snapshot(session) { return { id: session.id, cwd: session.cwd, closed: session.closed, output: session.buffer }; }

  write(session, data) { if (session.closed) throw new Error('Terminal fermé.'); session.proc.write(String(data || '')); }
  resize(session, cols, rows) { if (!session.closed) session.proc.resize(Math.max(20, Math.min(320, Number(cols) || 100)), Math.max(5, Math.min(120, Number(rows) || 26))); }
  close(session) { if (!session || session.closed) return; session.closed = true; try { session.proc.kill(); } catch {} this.sessions.delete(session.id); }

  async runCommand({ userId, cwd, command, waitMs = 10 * 60_000 }) {
    const session = this.latest(userId, cwd);
    await Promise.race([session.ready, new Promise((resolve) => setTimeout(resolve, 1200))]);
    const before = session.buffer.length;
    const marker = `__ZAALIS_DONE_${crypto.randomUUID().replace(/-/g, '')}`;
    this.write(session, `${command}\rprintf '\\n${marker}:%s\\n' "$?"\r`);
    await new Promise((resolve) => {
      let timer = null;
      const done = () => { session.events.removeListener('data', onData); resolve(); };
      const onData = () => { if (session.buffer.slice(before).includes(marker)) { if (timer) clearTimeout(timer); done(); } };
      timer = setTimeout(done, waitMs);
      session.events.on('data', onData);
    });
    const raw = session.buffer.slice(before);
    const match = raw.match(new RegExp(`${marker}:(\\d+)`));
    return { session, output: raw.replace(new RegExp(`\\n?${marker}:\\d+\\r?\\n?`), '').slice(-64 * 1024), exitCode: match ? Number(match[1]) : 124, timedOut: !match };
  }
}

module.exports = { TerminalManager };
