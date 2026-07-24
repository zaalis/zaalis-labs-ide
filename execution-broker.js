'use strict';

// The broker is deliberately the only place where an agent command is spawned.
// Command-string filters are useful UX but never replace this OS boundary.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const MAX_OUTPUT = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = Math.max(30_000, Number(process.env.ZAALIS_COMMAND_TIMEOUT_MS) || 10 * 60_000);

function quoteProfilePath(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function hasCommand(command) {
  try { return spawnSync('/bin/sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0; } catch { return false; }
}
function safeProjectRoot(root) { return fs.realpathSync(path.resolve(root)); }

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function projectFile(root, relative) {
  const base = safeProjectRoot(root);
  const value = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('chemin de projet invalide');
  const full = path.resolve(base, value);
  if (!isInside(base, full)) throw new Error('chemin hors projet refusé');
  let cursor = base;
  for (const part of value.split('/')) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('lien symbolique refusé'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { base, full, relative: value };
}

function atomicWrite(full, content) {
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('répertoire symbolique refusé');
  const temp = path.join(parent, `.${path.basename(full)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, String(content || ''), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, full);
}

function applyEdits(content, hunks) {
  let next = String(content || '');
  for (const hunk of (Array.isArray(hunks) ? hunks : [])) {
    const search = String(hunk && hunk.search || ''); const replace = String(hunk && hunk.replace || '');
    if (!search) throw new Error('SEARCH vide refusé');
    const first = next.indexOf(search); const last = next.lastIndexOf(search);
    if (first < 0) throw new Error('SEARCH introuvable');
    if (first !== last) throw new Error('SEARCH apparaît plusieurs fois');
    next = next.slice(0, first) + replace + next.slice(first + search.length);
  }
  return next;
}

function sandboxEnvironment(tmpDir) {
  const pathValue = process.platform === 'win32'
    ? String(process.env.SystemRoot ? `${process.env.SystemRoot};${process.env.SystemRoot}\\System32` : process.env.PATH || '')
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin', path.dirname(process.execPath)].filter(Boolean).join(':');
  return {
    PATH: pathValue,
    HOME: tmpDir,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    LANG: String(process.env.LANG || 'en_US.UTF-8'),
    LC_ALL: String(process.env.LC_ALL || ''),
    TERM: 'dumb',
    NO_COLOR: '1',
  };
}

function macProfile({ root, tmpDir, write, network, runtimePath }) {
  // New macOS releases abort command-line binaries under a strict deny-default
  // profile unless their private dyld/XPC allowances are replicated. Start
  // with the platform baseline and remove user/private data instead, then
  // restore only the workspace and an ephemeral temp directory.
  const safeRoot = quoteProfilePath(root);
  const safeTemp = quoteProfilePath(tmpDir);
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-read* (subpath "/Users"))',
    '(deny file-read* (subpath "/Volumes"))',
    '(deny file-read* (subpath "/private/var/root"))',
    '(deny file-read* (subpath "/Library/Keychains"))',
    `(allow file-read* (subpath "${safeRoot}"))`,
    `(allow file-read* (subpath "${safeTemp}"))`,
    '(deny file-write*)',
    ...(write ? [`(allow file-write* (subpath "${safeRoot}"))`] : []),
    `(allow file-write* (subpath "${safeTemp}"))`,
    network ? '(allow network*)' : '(deny network*)',
  ].join('\n');
}

function append(current, chunk, cap) {
  const value = chunk.toString();
  const remaining = cap - Buffer.byteLength(current);
  if (remaining <= 0) return { value: current, truncated: true };
  if (Buffer.byteLength(value) > remaining) return { value: current + Buffer.from(value).subarray(0, remaining).toString(), truncated: true };
  return { value: current + value, truncated: false };
}

class ExecutionBroker {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, requireSandbox = true } = {}) {
    this.timeoutMs = timeoutMs;
    this.requireSandbox = requireSandbox;
  }

  backend() {
    if (process.platform === 'darwin' && hasCommand('sandbox-exec')) return 'seatbelt';
    if (process.platform === 'linux' && hasCommand('bwrap')) return 'bubblewrap';
    return 'none';
  }

  writeFile({ root, path: relative, content } = {}) {
    const target = projectFile(root, relative);
    atomicWrite(target.full, content);
    return { success: true, path: target.relative, sandbox: 'filesystem-broker' };
  }

  editFile({ root, path: relative, hunks } = {}) {
    const target = projectFile(root, relative);
    const current = fs.readFileSync(target.full, 'utf8');
    atomicWrite(target.full, applyEdits(current, hunks));
    return { success: true, path: target.relative, sandbox: 'filesystem-broker' };
  }

  async run({ command, root, cwd, write = true, network = false, allowedDomains = [], timeoutMs } = {}) {
    const input = String(command || '').trim();
    if (!input) return { exitCode: 2, error: 'commande vide', sandbox: this.backend() };
    if (allowedDomains.length && !network) return { exitCode: 2, error: 'domaines réseau fournis alors que le réseau est désactivé', sandbox: this.backend() };
    // Seatbelt cannot constrain DNS names safely. Prefer denial to a pretend
    // allow-list; a proxy backend can be added later without changing callers.
    if (allowedDomains.length) return { exitCode: 2, error: 'liste de domaines non prise en charge par ce backend sécurisé', sandbox: this.backend(), sandboxViolation: true };
    let project;
    try { project = safeProjectRoot(root); } catch { return { exitCode: 2, error: 'racine de projet inaccessible', sandbox: this.backend() }; }
    // Optional working directory, always confined to the project root. The caller
    // (agent-engine) already resolves a leading `cd` into this, so a path with
    // spaces reaches spawn as a single argv entry instead of breaking the shell.
    let workdir = project;
    if (cwd) {
      try {
        const full = fs.realpathSync(path.resolve(project, String(cwd)));
        const rel = path.relative(project, full);
        if ((rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) && fs.statSync(full).isDirectory()) workdir = full;
      } catch {}
    }
    let temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-agent-'));
    try { temp = fs.realpathSync(temp); } catch {}
    try { fs.chmodSync(temp, 0o700); } catch {}
    const backend = this.backend();
    if (this.requireSandbox && backend === 'none') {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
      return { exitCode: 126, error: 'sandbox indisponible : exécution agent refusée (fail closed)', sandbox: 'none', sandboxViolation: true };
    }
    let file = '/bin/sh'; let args = ['-lc', input];
    if (backend === 'seatbelt') {
      file = 'sandbox-exec';
      args = ['-p', macProfile({ root: project, tmpDir: temp, write: !!write, network: !!network, runtimePath: process.execPath }), '/bin/sh', '-lc', input];
    } else if (backend === 'bubblewrap') {
      const bwrap = ['--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--bind', temp, temp, '--chdir', workdir];
      bwrap.push(write ? '--bind' : '--ro-bind', project, project);
      if (!network) bwrap.push('--unshare-net');
      args = [...bwrap, '/bin/sh', '-lc', input]; file = 'bwrap';
    }
    return await new Promise((resolve) => {
      let stdout = '', stderr = '', truncated = false, timedOut = false, settled = false;
      let child;
      try {
        child = spawn(file, args, { cwd: workdir, env: sandboxEnvironment(temp), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        return resolve({ exitCode: 1, error: error.message, sandbox: backend });
      }
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') child.kill('SIGTERM');
        else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
        setTimeout(() => { if (child.exitCode == null) { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 3000).unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1000, Math.min(Number(timeoutMs) || this.timeoutMs, this.timeoutMs)));
      const finish = (result) => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
        resolve({ ...result, stdout, stderr, outputTruncated: truncated, timedOut, timeoutMs: this.timeoutMs, sandbox: backend, sandboxed: backend !== 'none' });
      };
      child.stdout.on('data', (chunk) => { const r = append(stdout, chunk, MAX_OUTPUT); stdout = r.value; truncated ||= r.truncated; });
      child.stderr.on('data', (chunk) => { const r = append(stderr, chunk, MAX_OUTPUT); stderr = r.value; truncated ||= r.truncated; });
      child.once('error', (error) => finish({ exitCode: 1, error: error.message }));
      child.once('close', (code, signal) => finish({ exitCode: timedOut ? 124 : (Number.isInteger(code) ? code : 1), signal, error: '' }));
    });
  }
}

module.exports = { ExecutionBroker, sandboxEnvironment, macProfile, projectFile, atomicWrite, applyEdits, DEFAULT_TIMEOUT_MS };
