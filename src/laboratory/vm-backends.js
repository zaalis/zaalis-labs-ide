'use strict';

// Additional execution environments for the `vm` tool, next to QEMU Debian and
// Windows Sandbox:
//
// * Docker containers — disposable, no host folder mounted, no network unless
//   the user confirmed a connected machine, no privilege escalation. A pentest
//   container runs a Kali-based image whose egress is limited to the scope;
//   agent commands run as an unprivileged user that cannot change the rules.
// * SSH hosts — servers the USER registered and verified from the VM panel
//   (host key pinned on first contact). The agent can only pick one of them; it
//   can never add a host or a key.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { sanitize } = require('../agent/secrets-mask');
const { containerFirewall, PENTEST_PACKAGES } = require('./vm-firewall');

const PENTEST_IMAGE = 'zaalis/pentest:1';
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/;
const owner = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);

function execute(exe, args, options = {}) {
  return new Promise(resolve => {
    const child = execFile(exe, args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!error?.killed, error });
    });
    if (options.input !== undefined) { child.stdin.end(options.input); }
  });
}

// Kali rolling with the usual tools and an unprivileged `pentest` account. The
// container runs with no-new-privileges, so file capabilities cannot apply:
// scanners use connect scans (nmap -sT) as that user.
function pentestDockerfile() {
  return [
    'FROM kalilinux/kali-rolling',
    'ENV DEBIAN_FRONTEND=noninteractive',
    `RUN apt-get update -q && for p in ${[...PENTEST_PACKAGES.filter(p => !['nftables', 'testssl.sh'].includes(p)), 'iptables', 'testssl.sh', 'nuclei', 'exploitdb', 'netcat-traditional'].join(' ')}; do apt-get install -y -q --no-install-recommends "$p" || echo "ABSENT $p"; done && rm -rf /var/lib/apt/lists/*`,
    'RUN useradd -m -u 1000 -s /bin/bash pentest && mkdir -p /home/pentest/workspace && chown -R pentest:pentest /home/pentest',
    'LABEL zaalis.pentest=1',
    'CMD ["sleep", "infinity"]',
  ].join('\n') + '\n';
}

class DockerBackend {
  constructor(manager, { run = execute, spawnProcess = spawn, exe = 'docker' } = {}) {
    this.manager = manager; this.run = run; this.spawn = spawnProcess; this.exe = exe; this.probe = null; this.build = null;
  }
  async capabilities() {
    if (this.probe && Date.now() - this.probe.at < 60000) return this.probe.value;
    const result = await this.run(this.exe, ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
    const version = result.code === 0 ? result.stdout.trim() : '';
    const value = version ? { available: true, version, reason: 'Prêt · Docker ' + version }
      : { available: false, version: null, reason: /not recognized|ENOENT|introuvable|not found/i.test(result.stderr + (result.error?.code || '')) ? 'Docker n’est pas installé sur ce PC.' : 'Le service Docker ne répond pas (Docker Desktop arrêté ?).' };
    if (version) {
      const image = await this.run(this.exe, ['image', 'inspect', PENTEST_IMAGE, '--format', '{{.Id}}'], { timeout: 8000 });
      value.pentestImage = image.code === 0;
    }
    this.probe = { at: Date.now(), value };
    return value;
  }
  name(s) { return 'zaalis-' + s.id.replace(/-/g, '').slice(0, 16); }
  user(s) { return s.profile === 'pentest' ? ['-u', 'pentest', '-w', '/home/pentest/workspace'] : ['-w', '/workspace']; }
  workspace(s) { return s.profile === 'pentest' ? '/home/pentest/workspace' : '/workspace'; }
  async start(s) {
    const image = s.profile === 'pentest' ? PENTEST_IMAGE : (s.image || 'debian:12-slim');
    if (!IMAGE_PATTERN.test(image)) throw new Error('Image Docker invalide.');
    const args = ['run', '-d', '--name', this.name(s), '--hostname', 'zaalis-ctr', '--label', 'zaalis.managed=1', '--label', `zaalis.owner=${process.pid}`,
      '--memory', `${s.memoryMB}m`, '--cpus', String(s.cpus), '--pids-limit', '512', '--security-opt', 'no-new-privileges'];
    if (s.network === 'isolated') args.push('--network', 'none');
    if (s.profile === 'pentest') {
      // NET_ADMIN serves root's policy setup only: agent commands run as
      // `pentest`, without capabilities, under no-new-privileges.
      args.push('--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER');
      if (s.egress?.hostAll || s.egress?.hostPorts?.length) args.push('--add-host', 'host.docker.internal:host-gateway');
    }
    args.push(image, 'sleep', 'infinity');
    const created = await this.run(this.exe, args, { timeout: 900000 });
    if (created.code !== 0) throw new Error('Docker : ' + sanitize((created.stderr || created.stdout).trim().slice(-600)));
    s.containerId = created.stdout.trim().slice(0, 64);
    if (s.profile !== 'pentest') {
      const prepared = await this.run(this.exe, ['exec', this.name(s), 'sh', '-c', 'mkdir -p /workspace'], { timeout: 30000 });
      if (prepared.code !== 0) throw new Error('Conteneur inutilisable : ' + sanitize(prepared.stderr.slice(-300)));
      return;
    }
    // Policy first, as root; then prove the agent account cannot change it.
    let hostAddress = null;
    if (s.egress?.hostAll || s.egress?.hostPorts?.length) {
      const resolved = await this.run(this.exe, ['exec', '-u', '0', this.name(s), 'sh', '-c', "getent ahostsv4 host.docker.internal | awk 'NR==1{print $1}'"], { timeout: 15000 });
      hostAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(resolved.stdout.trim()) ? resolved.stdout.trim() : null;
    }
    const policy = await this.run(this.exe, ['exec', '-u', '0', this.name(s), 'sh', '-c', containerFirewall({ ...(s.egress || {}), hostAddress })], { timeout: 30000 });
    const probe = await this.run(this.exe, ['exec', '-u', 'pentest', this.name(s), 'sh', '-c', 'cat /run/zaalis-firewall; iptables -A OUTPUT -j ACCEPT 2>/dev/null && echo ESCAPED || echo LOCKED'], { timeout: 15000 });
    if (policy.code !== 0 || !/active/.test(probe.stdout) || !/LOCKED/.test(probe.stdout)) {
      throw new Error('Pare-feu du conteneur pentest non vérifié : machine refusée. ' + sanitize((policy.stderr || '').slice(-300)));
    }
    s.guestFirewall = 'active';
  }
  exec(s, command, timeoutMs) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    // `$0` carries the command: no shell quoting of user text on the host.
    const wrapper = `if command -v timeout >/dev/null 2>&1; then exec timeout -s TERM -k 2 ${seconds} sh -c "$0"; else exec sh -c "$0"; fi`;
    return new Promise(resolve => {
      s.activeExec = execFile(this.exe, ['exec', ...this.user(s), this.name(s), 'sh', '-c', wrapper, command], { windowsHide: true, timeout: timeoutMs + 8000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        s.activeExec = null;
        const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({ output: String(stdout || '') + String(stderr || ''), exitCode: code, timedOut: !!error && (error.killed || code === 124), transportError: !!error && (code === 125 || code === 126 && /Error response from daemon/.test(String(stderr))) });
      });
    });
  }
  async importArchive(s, archive) {
    const copied = await this.run(this.exe, ['cp', archive, `${this.name(s)}:/tmp/zaalis-project.tar`], { timeout: 120000 });
    if (copied.code !== 0) throw new Error('Copie vers le conteneur impossible : ' + sanitize(copied.stderr.slice(-300)));
    const target = this.workspace(s);
    const owner = s.profile === 'pentest' ? ` && chown -R pentest:pentest ${target}` : '';
    const unpacked = await this.run(this.exe, ['exec', '-u', '0', this.name(s), 'sh', '-c', `rm -rf ${target} && mkdir -p ${target} && tar -xf /tmp/zaalis-project.tar -C ${target} && rm /tmp/zaalis-project.tar${owner}`], { timeout: 120000 });
    if (unpacked.code !== 0) throw new Error('Import du projet impossible : ' + sanitize(unpacked.stderr.slice(-300)));
    return target;
  }
  async exportFile(s, guestPath, dest) {
    const size = await this.run(this.exe, ['exec', ...this.user(s), this.name(s), 'sh', '-c', 'test -f "$0" && stat -c %s "$0"', guestPath], { timeout: 20000 });
    const bytes = Number(size.stdout.trim());
    if (size.code !== 0 || !Number.isFinite(bytes)) throw new Error('Fichier invité introuvable.');
    if (bytes > 32 * 1024 * 1024) throw new Error('Export limité à un fichier de 32 Mo.');
    const absolute = guestPath.startsWith('/') ? guestPath : path.posix.join(this.workspace(s), guestPath);
    const copied = await this.run(this.exe, ['cp', `${this.name(s)}:${absolute}`, dest], { timeout: 120000 });
    if (copied.code !== 0 || !fs.existsSync(dest) || !fs.lstatSync(dest).isFile()) throw new Error('Export impossible.');
  }
  terminalArgs(s) { return ['exec', '-it', ...this.user(s), this.name(s), 'sh', '-c', 'command -v bash >/dev/null && exec bash || exec sh']; }
  async remove(s) {
    const removed = await this.run(this.exe, ['rm', '-f', this.name(s)], { timeout: 60000 });
    if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) throw new Error('Docker : ' + sanitize(removed.stderr.slice(-300)));
  }
  // Containers left by a server that is gone.
  async sweep(alive) {
    const listed = await this.run(this.exe, ['ps', '-a', '--filter', 'label=zaalis.managed=1', '--format', '{{.Names}} {{.Label "zaalis.owner"}}'], { timeout: 15000 });
    if (listed.code !== 0) return;
    for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
      const [name, pid] = line.trim().split(/\s+/);
      if (/^zaalis-[0-9a-f]{16}$/.test(name) && !alive(Number(pid))) await this.run(this.exe, ['rm', '-f', name], { timeout: 30000 });
    }
  }
  // Builds the Kali-based pentest image. Needs Internet on the host.
  buildPentestImage() {
    if (this.build?.status === 'running') return this.build;
    const build = { status: 'running', startedAt: Date.now(), log: '', image: PENTEST_IMAGE };
    this.build = build;
    const child = this.spawn(this.exe, ['build', '-t', PENTEST_IMAGE, '-'], { windowsHide: true });
    const append = data => { build.log = (build.log + sanitize(String(data))).slice(-64 * 1024); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    child.on('error', error => { build.status = 'failed'; build.error = error.message; });
    child.on('exit', code => { build.status = code === 0 ? 'done' : 'failed'; build.finishedAt = Date.now(); if (code !== 0) build.error = 'docker build a échoué (' + code + ')'; this.probe = null; });
    child.stdin?.end(pentestDockerfile());
    return build;
  }
}

class SshHosts {
  constructor(root, { run = execute, sshExe = process.platform === 'win32' ? 'ssh.exe' : 'ssh' } = {}) {
    this.root = path.join(root, 'ssh-hosts'); fs.mkdirSync(this.root, { recursive: true }); this.run = run; this.sshExe = sshExe;
  }
  file(user) { return path.join(this.root, owner(user) + '.json'); }
  all(user) { try { return JSON.parse(fs.readFileSync(this.file(user), 'utf8')); } catch { return []; } }
  write(user, list) { fs.writeFileSync(this.file(user), JSON.stringify(list, null, 2), { mode: 0o600 }); }
  public(host) { const { identityFile, knownHosts, ...rest } = host; return { ...rest, identity: path.basename(identityFile) }; }
  list(user) { return this.all(user).map(host => this.public(host)); }
  get(user, id) {
    const host = this.all(user).find(item => item.id === id);
    if (!host) throw new Error('Hôte SSH inconnu : enregistrez-le dans le panneau Machines virtuelles.');
    return host;
  }
  // Only the authenticated IDE routes call add/remove/verify; the agent tool
  // never reaches them.
  add(user, input) {
    const name = String(input.name || '').trim().slice(0, 80);
    const host = String(input.host || '').trim();
    const login = String(input.user || '').trim();
    const port = Number(input.port || 22);
    const identityFile = path.resolve(String(input.identityFile || ''));
    if (!name || !/^[A-Za-z0-9.-]{1,253}$/.test(host) || host.startsWith('-')) throw new Error('Hôte invalide.');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(login) || login.startsWith('-')) throw new Error('Utilisateur invalide.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invalide.');
    if (!fs.existsSync(identityFile) || !fs.statSync(identityFile).isFile() || fs.statSync(identityFile).size > 64 * 1024) throw new Error('Clé privée introuvable.');
    const list = this.all(user);
    if (list.length >= 20) throw new Error('20 hôtes SSH maximum.');
    const id = 'h' + crypto.randomBytes(6).toString('hex');
    const record = { id, name, host, port, user: login, identityFile, knownHosts: path.join(this.root, `${owner(user)}-${id}.known_hosts`), verified: false, fingerprint: null, addedAt: Date.now() };
    list.push(record); this.write(user, list); return this.public(record);
  }
  remove(user, id) {
    const host = this.get(user, id);
    try { fs.unlinkSync(host.knownHosts); } catch {}
    this.write(user, this.all(user).filter(item => item.id !== id));
  }
  args(host, { firstContact = false } = {}) {
    return ['-i', host.identityFile, '-p', String(host.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'IdentitiesOnly=yes',
      '-o', `StrictHostKeyChecking=${firstContact ? 'accept-new' : 'yes'}`, '-o', 'UserKnownHostsFile=' + host.knownHosts, `${host.user}@${host.host}`];
  }
  // First contact pins the host key (trust on first use, by the user).
  async verify(user, id) {
    const host = this.get(user, id);
    const result = await this.run(this.sshExe, [...this.args(host, { firstContact: !host.verified }), 'echo zaalis-ok && uname -sm'], { timeout: 20000 });
    if (result.code !== 0 || !/zaalis-ok/.test(result.stdout)) throw new Error('Connexion SSH impossible : ' + sanitize((result.stderr || result.stdout).trim().slice(-300)));
    const list = this.all(user), record = list.find(item => item.id === id);
    record.verified = true; record.system = result.stdout.split(/\r?\n/)[1]?.trim() || null; record.verifiedAt = Date.now();
    try { record.fingerprint = fs.readFileSync(host.knownHosts, 'utf8').trim().split(/\r?\n/).pop().split(' ').slice(1, 2).join(' '); } catch {}
    this.write(user, list); return this.public(record);
  }
}

module.exports = { DockerBackend, SshHosts, pentestDockerfile, PENTEST_IMAGE, IMAGE_PATTERN, execute };
