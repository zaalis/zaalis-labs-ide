'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { seedIso } = require('./vm-seed');
const { sanitize } = require('../agent/secrets-mask');
const { cloudConfig } = require('./vm-firewall');
const { DockerBackend, SshHosts, IMAGE_PATTERN } = require('./vm-backends');
const SYSTEMS = ['linux', 'windows', 'docker', 'ssh'];
const SSH_PREFIX = 'ssh-';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) { error.message = sanitize(String(stderr || stdout || error.message)); reject(error); }
    else resolve(String(stdout));
  }));
}
const ps = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
// Host tools: Windows ships them as .exe (QEMU bundled, OpenSSH/tar from the
// system); a Linux host uses KVM, its own QEMU and OpenSSH from the distribution;
// a macOS host uses Hypervisor.framework (HVF), QEMU from Homebrew and the
// system OpenSSH. Apple Silicon runs the arm64 Debian image natively.
const WINDOWS = process.platform === 'win32', MACOS = process.platform === 'darwin';
const tool = name => WINDOWS ? name + '.exe' : name;
const ACCELERATOR = WINDOWS ? 'whpx' : MACOS ? 'hvf' : 'kvm';
const GUEST_ARM64 = MACOS && process.arch === 'arm64';
const QEMU_SYSTEM = GUEST_ARM64 ? 'qemu-system-aarch64' : 'qemu-system-x86_64';
const DEBIAN_IMAGE = GUEST_ARM64
  ? { url: 'https://cloud.debian.org/images/cloud/bookworm/20260923-2610/debian-12-genericcloud-arm64-20260923-2610.qcow2', sha512: '89a752d5c7d8e88bee39a57d88d496cca574f7d1e8df5df7a169825435f99feb11ed13ab27ec7bee96fe1584be4ff9479358fbca6cc859efa109f4aba18724c8' }
  : { url: 'https://cloud.debian.org/images/cloud/bookworm/20260923-2610/debian-12-genericcloud-amd64-20260923-2610.qcow2', sha512: '3d94c9dd66d8a283fde060b8810373b7ae04038b956ee00d553d1ae564f6fbdeaa2fd6e7404e87e53348b5a9509170f3ea7c0731ba737590c5c4cb8d559a47f8' };
const HOST_TOOL_DIRS = ['/usr/bin', '/usr/local/bin', '/usr/sbin', ...(MACOS ? ['/opt/homebrew/bin', '/opt/local/bin'] : [])];
function onPath(name) { return String(process.env.PATH || '').split(path.delimiter).concat(HOST_TOOL_DIRS).filter(Boolean).map(dir => path.join(dir, name)).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }) || null; }
function kvmUsable() { try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } }
function hvfUsable() { try { return require('child_process').execFileSync('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], { timeout: 5000 }).toString().trim() === '1'; } catch { return false; } }
// UEFI firmware for the arm64 "virt" machine, shipped with Homebrew's QEMU.
function aarch64Firmware(qemuBinary) {
  const prefixes = [path.resolve(path.dirname(qemuBinary), '..'), '/opt/homebrew', '/usr/local', '/opt/local'];
  return prefixes.map(prefix => path.join(prefix, 'share', 'qemu', 'edk2-aarch64-code.fd')).find(file => fs.existsSync(file)) || null;
}
function brewBinary() { return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(file => fs.existsSync(file)) || null; }
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const shQuote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITY_TTL = 60000;
const UI_OUTPUT_TAIL = 128 * 1024;
// Windows ships bsdtar in System32. A `tar.exe` found earlier on PATH may be
// GNU tar (Git, MSYS), which reads "C:" in a path as a remote host and fails.
function tarExe() {
  if (process.platform !== 'win32') return 'tar';
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(system) ? system : 'tar.exe';
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
class VmManager {
  constructor({ appDir, dataDir, docker, sshHosts }) { this.assets = path.join(appDir, 'vm'); if (!fs.existsSync(this.assets)) this.assets = path.join(appDir, 'native', 'vm'); this.root = path.join(dataDir, 'virtual-machines'); fs.mkdirSync(this.root, { recursive: true }); this.sessions = new Map(); this.windowsStarting = false; this.templates = new (require("./vm-templates").VmTemplates)(this.root); this.probe = null;
    const dockerExe = MACOS ? onPath('docker') || '/Applications/Docker.app/Contents/Resources/bin/docker' : 'docker';
    this.docker = docker || new DockerBackend(this, { exe: dockerExe }); this.sshHosts = sshHosts || new SshHosts(this.root);
    const sweep = setImmediate(() => { this.sweep().catch(() => {}); }); if (sweep.unref) sweep.unref(); }
  // Sessions live in memory only: after a restart or a crash their folders (a
  // disk overlay that grows with use, keys, staged project copies) can no longer
  // be reached. Remove those whose owning server is gone, and old exports.
  async sweep() {
    try {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !UUID.test(entry.name) || this.sessions.has(entry.name) || this.sessions.has(SSH_PREFIX + entry.name)) continue;
        const dir = path.join(this.root, entry.name);
        try {
          let owner = null;
          try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch {}
          // A folder without an owner record predates this cleanup: keep it a
          // day in case another running instance still uses it.
          if (owner ? processAlive(owner.pid) : Date.now() - fs.statSync(dir).mtimeMs < 86400000) continue;
          // A server that was killed could not stop its QEMU, which would keep
          // its memory for ever. The image name is checked first: Windows
          // reuses process ids.
          if (!WINDOWS && processAlive(owner?.qemuPid)) continue;
          if (owner && WINDOWS && Number.isInteger(owner.qemuPid) && owner.qemuPid > 0) {
            try {
              const found = await run('tasklist.exe', ['/FI', `PID eq ${owner.qemuPid}`, '/FO', 'CSV', '/NH'], { timeout: 10000 });
              if (/^"qemu-system-x86_64\.exe"/im.test(found)) await run('taskkill.exe', ['/PID', String(owner.qemuPid), '/F'], { timeout: 10000 });
            } catch {}
          }
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
        } catch {}
      }
      const artifacts = path.join(this.root, 'artifacts');
      if (fs.existsSync(artifacts)) for (const name of fs.readdirSync(artifacts)) {
        const file = path.join(artifacts, name);
        try { const stat = fs.lstatSync(file); if (UUID.test(name) && stat.isFile() && Date.now() - stat.mtimeMs > 7 * 86400000) fs.unlinkSync(file); } catch {}
      }
    } catch {}
    try { if ((await this.docker.capabilities()).available) await this.docker.sweep(processAlive); } catch {}
  }
  // The feature probe starts PowerShell and queries CIM (one to three seconds).
  // The interface refreshes every few seconds, so the answer is shared and kept.
  hostProbe() {
    if (this.probe && Date.now() - this.probe.at < CAPABILITY_TTL) return this.probe.value;
    const value = ps("$v=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; $f=Get-CimInstance Win32_OptionalFeature -Filter \"Name='Containers-DisposableClientVM'\"; $h=Get-CimInstance Win32_OptionalFeature -Filter \"Name='HypervisorPlatform'\"; @{edition=$v.EditionID; build=$v.CurrentBuild; state=$f.InstallState; cli=[bool](Get-Command wsb.exe -ErrorAction SilentlyContinue);whpx=($h.InstallState -eq 1);ssh=[bool](Get-Command ssh.exe -ErrorAction SilentlyContinue)} | ConvertTo-Json -Compress").then(JSON.parse);
    const entry = { at: Date.now(), value };
    this.probe = entry;
    value.catch(() => { if (this.probe === entry) this.probe = null; });
    return value;
  }
  qemu(name) { const bundled = path.join(this.assets, 'qemu', tool(name)); return WINDOWS || fs.existsSync(bundled) ? bundled : onPath(name) || name; }
  baseImage() { const bundled = path.join(this.assets, 'images', 'debian.qcow2'); return WINDOWS || fs.existsSync(bundled) ? bundled : path.join(this.root, 'images', 'debian.qcow2'); }
  async capabilities() {
    let windows = { compatible: false, enabled: false, cli: false, reason: WINDOWS ? 'Windows Sandbox nécessite Windows Pro, Enterprise ou Education.' : 'Windows Sandbox nécessite un hôte Windows.' };
    let linuxHost={compatible:((WINDOWS||process.platform==='linux')&&process.arch==='x64')||(MACOS&&['x64','arm64'].includes(process.arch)),accelerationEnabled:false,sshAvailable:false,accelerator:ACCELERATOR.toUpperCase(),host:process.platform};
    if (process.platform === 'linux' || MACOS) {
      linuxHost.accelerationEnabled = MACOS ? hvfUsable() : kvmUsable(); linuxHost.sshAvailable = ['ssh', 'scp', 'ssh-keygen'].every(onPath);
      linuxHost.qemuAvailable = [QEMU_SYSTEM, 'qemu-img'].every(name => fs.existsSync(this.qemu(name))) && (!GUEST_ARM64 || !!aarch64Firmware(this.qemu(QEMU_SYSTEM)));
      if (MACOS) linuxHost.brewAvailable = !!brewBinary();
    }
    if (process.platform === 'win32') {
      try {
        const info = await this.hostProbe();
        linuxHost.accelerationEnabled=info.whpx;linuxHost.sshAvailable=info.ssh;
        windows = { ...windows, ...info, compatible: /Professional|Enterprise|Education/.test(info.edition), enabled: info.state === 1, cli: info.cli };
        windows.reason = !windows.compatible ? windows.reason : !windows.enabled ? 'Windows Sandbox est désactivé. Son activation peut nécessiter un redémarrage.' : !windows.cli ? 'Sandbox activé, mais son API wsb est absente. Mettez Windows Sandbox à jour.' : 'Prêt · Windows Sandbox';
      } catch (error) { windows.reason = error.message; }
    }
    const image = this.baseImage(), bundled=(WINDOWS ? fs.existsSync(this.qemu(QEMU_SYSTEM)) : linuxHost.qemuAvailable === true) && fs.existsSync(image);
    let docker = { available: false, reason: 'Docker non détecté.' };
    try { docker = await this.docker.capabilities(); } catch (error) { docker.reason = error.message; }
    const sshAvailable = WINDOWS ? linuxHost.sshAvailable : ['ssh', 'scp'].every(onPath);
    const ssh = { available: sshAvailable, reason: sshAvailable ? 'Client OpenSSH disponible' : 'Client OpenSSH absent.' };
    return { windows, linux: { ...linuxHost,bundled,available:bundled&&linuxHost.compatible&&linuxHost.accelerationEnabled&&linuxHost.sshAvailable, image: GUEST_ARM64 ? 'Debian 12 · serveur arm64' : 'Debian 12 · serveur', imageBytes: fs.existsSync(image) ? fs.statSync(image).size : 0 }, docker, ssh, mode: 'autonomous', maxLinux: 3, maxDocker: 4, maxSsh: 4 };
  }
  // `outputEnd` counts every character ever logged, so a client can append only
  // what is new even after the buffer has dropped its oldest part.
  snapshot(s, tail = Infinity) { const output = String(s.output || ''); return { id: s.id, system: s.system, name: s.name, status: s.status, memoryMB: s.memoryMB, cpus: s.cpus, network: s.network, output: sanitize(tail < output.length ? output.slice(-tail) : output), outputEnd: s.outputTotal || output.length, error: s.error || null, terminalId: s.terminalId || null, artifacts: (s.artifacts || []).map(({id,name,bytes}) => ({id,name,bytes})) }; }
  list(userId, tail = UI_OUTPUT_TAIL) { return [...this.sessions.values()].filter(s => s.userId === userId).map(s => this.snapshot(s, tail)); }
  get(id, userId) { const s = this.sessions.get(id); if (!s || s.userId !== userId) throw new Error('Machine virtuelle inconnue.'); return s; }
  log(s, data) { const text = String(data); s.outputTotal = (s.outputTotal || String(s.output || '').length) + text.length; s.output = (String(s.output || '') + text).slice(-512 * 1024); }
  async create(userId, input = {}, projectRoot = null) {
    const system = SYSTEMS.includes(input.system) ? input.system : null;
    if (!system) throw new Error('Système inconnu : linux, windows, docker ou ssh.');
    const caps = await this.capabilities();
    const active = kind => [...this.sessions.values()].filter(s => s.system === kind && !['stopped', 'error'].includes(s.status)).length;
    if (system === 'windows' && (!caps.windows.compatible || !caps.windows.enabled || !caps.windows.cli)) throw new Error(caps.windows.reason);
    if (system === 'linux' && !caps.linux.available) throw new Error(WINDOWS ? (!caps.linux.bundled?'Le pack Linux intégré est absent.':'Activez les composants Windows pour Linux dans les paramètres Machines virtuelles.') : MACOS ? 'Activez les composants Linux (QEMU, HVF, image Debian) dans les paramètres Machines virtuelles.' : 'Activez les composants Linux (QEMU, KVM, SSH, image Debian) dans les paramètres Machines virtuelles.');
    if (system === 'docker' && !caps.docker.available) throw new Error(caps.docker.reason);
    if (system === 'ssh' && !caps.ssh.available) throw new Error(caps.ssh.reason);
    if (system === 'windows' && (this.windowsStarting || active('windows'))) throw new Error('Une session Windows Sandbox est déjà gérée par l’IDE.');
    if (system === 'linux' && active('linux') >= 3) throw new Error('Limite de trois VM Linux simultanées atteinte.');
    if (system === 'docker' && active('docker') >= 4) throw new Error('Limite de quatre conteneurs simultanés atteinte.');
    if (system === 'ssh' && active('ssh') >= 4) throw new Error('Limite de quatre sessions SSH simultanées atteinte.');
    const memoryMB = Math.max(1024, Math.min(8192, Number(input.memoryMB) || 2048));
    const cpus = Math.max(1, Math.min(4, Math.floor(Number(input.cpus) || 2)));
    if (system !== 'ssh' && [...this.sessions.values()].filter(s => s.system !== 'ssh' && !['stopped', 'error'].includes(s.status)).reduce((n, s) => n + s.memoryMB, memoryMB) > os.totalmem() / 1024 / 1024 * .65) throw new Error('Mémoire disponible insuffisante pour cette VM.');
    const template = input.templateId ? this.templates.get(userId, input.templateId) : null;
    if (template && system !== 'linux') throw new Error('Un environnement figé requiert Linux.');
    if (system === 'docker' && input.image && !IMAGE_PATTERN.test(String(input.image))) throw new Error('Image Docker invalide.');
    const remote = system === 'ssh' ? this.sshHosts.get(userId, String(input.host || '')) : null;
    if (remote && !remote.verified) throw new Error('Hôte SSH non vérifié : testez la connexion depuis le panneau Machines virtuelles.');
    const uuid = crypto.randomUUID();
    const names = { linux: 'Debian', windows: 'Windows Sandbox', docker: 'Conteneur', ssh: remote?.name || 'SSH' };
    const s = { templateId: template?.id, image: system === 'docker' ? (input.image || null) : template?.image, id: system === 'ssh' ? SSH_PREFIX + uuid : uuid, userId, system,
      name: String(input.name || names[system]).slice(0, 80), memoryMB, cpus,
      network: system === 'ssh' ? 'remote' : input.network === 'internet' ? 'internet' : 'isolated', status: 'starting', output: '', queue: Promise.resolve(), remote };
    s.dir = path.join(this.root, uuid); fs.mkdirSync(s.dir); this.sessions.set(s.id, s);
    try { fs.writeFileSync(path.join(s.dir, 'owner.json'), JSON.stringify({ pid: process.pid, created: Date.now() })); } catch {}
    s.startTask=this.start(s).catch(async error => { const cancelled=s.stopRequested; try { await this.stop(s,undefined,true); } catch {} if(cancelled)return; s.error = error.message; s.status = 'error'; this.log(s, '\r\n' + error.message); });
    return this.snapshot(s);
  }
  async start(s) {
    const check=()=>{if(s.stopRequested)throw new Error('Démarrage interrompu.');};check();
    if (s.system === 'windows') {
      this.windowsStarting = true;
      try {
        // Do not adopt or stop a Sandbox belonging to another application.
        const existing = JSON.parse(await run('wsb.exe', ['list', '--raw']));
        check();
        if ((existing.WindowsSandboxEnvironments || []).length) throw new Error('Un Sandbox externe est ouvert. Fermez-le avant de démarrer celui de l’IDE.');
        s.inputDir=path.join(s.dir,'input');s.outputDir=path.join(s.dir,'output');fs.mkdirSync(s.inputDir);fs.mkdirSync(s.outputDir);
        for(const name of ['guest-bridge.ps1','watchdog.ps1'])fs.copyFileSync(path.join(this.assets,name),path.join(s.inputDir,name));
        // Read-only Sandbox mappings enumerate files at launch. Keep fixed
        // slots and update their contents instead of adding/renaming files.
        fs.writeFileSync(path.join(s.inputDir,'request.json'),'{}');fs.writeFileSync(path.join(s.inputDir,'project.tar'),Buffer.alloc(0));
        const heartbeat=()=>{try{fs.writeFileSync(path.join(s.inputDir,'heartbeat'),String(Date.now()));}catch{}};heartbeat();s.heartbeatTimer=setInterval(heartbeat,3000);s.heartbeatTimer.unref();
        const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const config = `<Configuration><MemoryInMB>${s.memoryMB}</MemoryInMB><Networking>${s.network === 'internet' ? 'Enable' : 'Disable'}</Networking><ClipboardRedirection>Disable</ClipboardRedirection><VGpu>Disable</VGpu><MappedFolders><MappedFolder><HostFolder>${xml(s.inputDir)}</HostFolder><SandboxFolder>C:\\ZaalisInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xml(s.outputDir)}</HostFolder><SandboxFolder>C:\\ZaalisBridge</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders></Configuration>`;
        const result = JSON.parse(await run('wsb.exe', ['start', '--raw', '--config', config])); s.sandboxId = result.Id;
        if (!/^[0-9a-f-]{36}$/i.test(s.sandboxId || '')) throw new Error('ID Sandbox invalide.');
        check();
        // wsb exec waits for its guest process. The bridge is intentionally
        // persistent, so readiness comes from the dedicated mapped directory.
        s.bridgeProc = spawn('wsb.exe', ['exec', '--id', s.sandboxId, '-r', 'System', '-c', 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\ZaalisInput\\guest-bridge.ps1'], { windowsHide: true });
        s.bridgeProc.on('error', error => { s.error = error.message; s.status = 'error'; });
        s.bridgeProc.stderr.on('data', data => this.log(s, data.toString()));
        s.bridgeProc.on('exit', code => { if (code && !s.stopRequested && s.status !== 'stopped') { s.error = 'Le pont Sandbox a échoué (' + code + ').'; s.status = 'error'; } });
        await this.wait(s, () => fs.existsSync(path.join(s.outputDir, 'ready')), 120000);
        this.log(s, 'Windows Sandbox · PowerShell\r\nPS C:\\> ');
      } finally { this.windowsStarting = false; }
    } else if (s.system === 'docker') {
      this.log(s, 'Docker · démarrage du conteneur\r\n');
      await this.docker.start(s);
      check();
      this.log(s, 'Conteneur prêt\r\n');
    } else if (s.system === 'ssh') {
      const probe = await run(process.platform === 'win32' ? 'ssh.exe' : 'ssh', [...this.sshArgs(s), `mkdir -p ${this.guestWorkspace(s)} && echo zaalis-ok`], { timeout: 20000 });
      if (!/zaalis-ok/.test(probe)) throw new Error('Hôte SSH injoignable.');
      this.log(s, `SSH prêt · ${s.remote.user}@${s.remote.host}\r\n`);
    } else {
      const key = path.join(s.dir, 'id_ed25519'); s.key = key;
      await run(tool('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      check();
      const pub = fs.readFileSync(key + '.pub', 'utf8').trim();
      const cloudInit = cloudConfig({ id: s.id, publicKey: pub, network: s.network });
      fs.writeFileSync(path.join(s.dir, 'seed.iso'), seedIso({ 'meta-data': cloudInit.meta, 'user-data': cloudInit.user }));
      await run(this.qemu('qemu-img'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', s.image || this.baseImage(), path.join(s.dir, 'disk.qcow2'), '24G']);
      check();
      s.port = await new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
      check();
      // The arm64 "virt" machine has no IDE bus: the cloud-init seed is a
      // read-only virtio disk (found by its cidata label) and UEFI boots it.
      const firmware = GUEST_ARM64 ? aarch64Firmware(this.qemu(QEMU_SYSTEM)) : null;
      if (GUEST_ARM64 && !firmware) throw new Error('Micrologiciel UEFI QEMU (edk2-aarch64-code.fd) introuvable. Réinstallez QEMU avec Homebrew.');
      const machine = GUEST_ARM64 ? ['-machine', 'virt', '-cpu', 'host', '-bios', firmware] : [];
      const seed = GUEST_ARM64 ? `file=${path.join(s.dir, 'seed.iso')},format=raw,if=virtio,readonly=on` : `file=${path.join(s.dir, 'seed.iso')},media=cdrom,readonly=on`;
      const args = [...machine, '-accel', ACCELERATOR, '-m', String(s.memoryMB), '-smp', String(s.cpus), '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-drive', `file=${path.join(s.dir, 'disk.qcow2')},format=qcow2,if=virtio`, '-drive', seed, '-netdev', `user,id=net0,restrict=${s.network === 'isolated' ? 'on' : 'off'},hostfwd=tcp:127.0.0.1:${s.port}-:22`, '-device', 'virtio-net-pci,netdev=net0'];
      s.proc = spawn(this.qemu(QEMU_SYSTEM), args, { windowsHide: true });
      try { fs.writeFileSync(path.join(s.dir, 'owner.json'), JSON.stringify({ pid: process.pid, created: Date.now(), qemuPid: s.proc.pid || null })); } catch {}
      s.proc.on('error', error => { s.error = error.message; s.status = 'error'; });
      s.proc.stdout.on('data', data => this.log(s, data.toString())); s.proc.stderr.on('data', data => this.log(s, data.toString()));
      // An exit we asked for is a normal stop, not a failure to report.
      s.proc.on('exit', code => { if (!s.stopRequested && s.status !== 'stopped') { s.status = 'error'; s.error = 'QEMU arrêté (' + code + '). ' + sanitize(s.output.slice(-600)); } });
      await this.wait(s, async () => { try { await run(tool('ssh'), [...this.sshArgs(s), 'true'], { timeout: 8000 }); return true; } catch { return false; } }, 180000);
      if (s.network === 'internet') await this.verifyGuestPolicy(s);
      this.log(s, '\r\nDebian prêt · SSH\r\n');
    }
    if (s.status === 'starting') s.status = 'ready';
  }
  // The guest policy is written by cloud-init; the host checks it took effect.
  async verifyGuestPolicy(s) {
    let report = '';
    try { report = await run(tool('ssh'), [...this.sshArgs(s), 'cat /run/zaalis-firewall 2>/dev/null'], { timeout: 15000 }); } catch (error) { report = error.message; }
    s.guestFirewall = report.trim() === 'active' ? 'active' : 'unavailable';
    if (s.guestFirewall !== 'active') this.log(s, '\r\nAttention : pare-feu invité indisponible, les services du PC hôte restent joignables depuis cette VM.\r\n');
  }
  guestWorkspace(s) { return s.system === 'ssh' ? `zaalis-workspace/${s.id.slice(SSH_PREFIX.length, SSH_PREFIX.length + 8)}` : '/home/zaalis/workspace'; }
  sshArgs(s) {
    if (s.system === 'ssh') return this.sshHosts.args(s.remote);
    return ['-i', s.key, '-p', String(s.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(s.dir, 'known_hosts'), 'zaalis@127.0.0.1'];
  }
  async wait(s, test, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { if (s.stopRequested||['stopping','stopped', 'error'].includes(s.status)) throw new Error(s.error || 'VM arrêtée.'); if (await test()) return; await delay(500); } throw new Error('Délai de démarrage ou de commande dépassé.'); }
  exec(s, command, options = {}) {
    const timeoutMs = Math.max(100, Math.min(120000, options.timeoutMs || 120000));
    if (s.status !== 'ready') return Promise.reject(new Error('La VM n’est pas prête.'));
    if (typeof command !== 'string' || !command.trim() || command.length > 32000) return Promise.reject(new Error('Commande invalide.'));
    const task = s.queue.catch(() => {}).then(async () => {
      if (s.status !== 'ready') throw new Error('VM arrêtée.');
      this.log(s, '\r\n$ ' + command + '\r\n');
      let result;
      if (s.system === 'docker') {
        result = await this.docker.exec(s, command, timeoutMs);
      } else if (s.system === 'linux' || s.system === 'ssh') {
        const seconds = Math.max(0.1, timeoutMs / 1000);
        // A remote host may lack GNU timeout; the VM always has it.
        const guestCommand = s.system === 'ssh'
          ? `if command -v timeout >/dev/null 2>&1; then timeout -s TERM -k 2 ${Math.ceil(seconds)} sh -c ${shQuote(command)}; else sh -c ${shQuote(command)}; fi`
          : `timeout --signal=TERM --kill-after=2s ${seconds}s sh -c ${shQuote(command)}`;
        result = await new Promise(resolve => { s.activeExec=execFile(process.platform === 'win32' ? 'ssh.exe' : 'ssh', [...this.sshArgs(s), guestCommand], { windowsHide: true, timeout: timeoutMs + 8000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => { s.activeExec=null; resolve({ output: String(stdout || '') + String(stderr || ''), exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, timedOut: !!error && (error.killed || error.code === 124), transportError: !!error && (error.code === 255 || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }); }); });
      } else {
        const id = crypto.randomUUID(), outputBase=path.join(s.outputDir,id);
        let published=false;for(let attempt=0;attempt<50;attempt++){try{fs.writeFileSync(path.join(s.inputDir,'request.json'),JSON.stringify({id,command}));published=true;break;}catch(error){if(!['EBUSY','EPERM'].includes(error.code))throw error;await delay(40);}}if(!published)throw new Error('Canal Sandbox occupé.');
        try { await this.wait(s, () => fs.existsSync(outputBase + '.result.json'), timeoutMs); } catch(error){await this.stop(s);throw error;}
        const file = outputBase + '.result.json';
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) throw new Error('Résultat Sandbox invalide.');
        result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));try{fs.unlinkSync(file);}catch{}
      }
      result.output = sanitize(String(result.output || '')); this.log(s, result.output + '\r\n' + (result.cwd ? `PS ${result.cwd}> ` : ''));
      return result;
    }); s.queue = task; return task;
  }
  async terminal(s, terminalManager) {
    if (s.system === 'windows') throw new Error('Windows utilise la console PowerShell persistante, sans PTY.');
    if (s.status !== 'ready') throw new Error('VM non prête.');
    const existing = s.terminalId && terminalManager.get(s.terminalId, s.userId); if (existing && !existing.closed) return terminalManager.snapshot(existing);
    const shell = s.system === 'docker' ? this.docker.exe || 'docker' : tool('ssh');
    const args = s.system === 'docker' ? this.docker.terminalArgs(s) : ['-tt', ...this.sshArgs(s)];
    const session = terminalManager.createExternal({ userId: s.userId, cwd: s.dir, shell, args, label: 'vm-' + s.system, origin: 'vm' }); s.terminalId = session.id; return terminalManager.snapshot(session);
  }
  async importProject(s, root) {
    if (s.status !== 'ready') throw new Error('VM non prête.');
    if (!root || !fs.statSync(root).isDirectory()) throw new Error('Aucun projet actif.');
    const dest = path.join(s.system==='windows'?(s.inputDir||s.dir):s.dir, 'project-copy'); fs.mkdirSync(dest, { recursive: true });
    // Clear only this session's staging copy so repeated imports do not retain old files.
    const expected=path.resolve(s.dir)+path.sep;
    if(!path.resolve(dest).startsWith(expected)||fs.lstatSync(dest).isSymbolicLink())throw new Error('Dossier de copie non sûr.');
    for(const name of fs.readdirSync(dest)) fs.rmSync(path.join(dest,name),{recursive:true,force:true});
    let bytes = 0, count = 0;
    const copy = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (require('./laboratory').excluded(entry.name) || entry.isSymbolicLink()) continue;
        const src = path.join(from, entry.name), dst = path.join(to, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copy(src, dst); }
        else if (entry.isFile()) { const size = fs.statSync(src).size; bytes += size; if (bytes > 256 * 1024 * 1024 || ++count > 12000) throw new Error('Projet trop volumineux : limite 256 Mo / 12 000 fichiers.'); fs.copyFileSync(src, dst); }
      }
    };
    copy(root, dest);
    const projectFingerprint = require('./laboratory').fingerprint(dest).hash;
    if (s.system === 'windows') {
      await run(tarExe(),['-cf',path.join(s.inputDir||s.dir,'project.tar'),'-C',dest,'.']);
      await this.exec(s, "if (Test-Path -LiteralPath C:\\workspace) { Remove-Item -LiteralPath C:\\workspace -Recurse -Force }; New-Item -ItemType Directory -Force C:\\workspace | Out-Null; tar.exe -xf C:\\ZaalisInput\\project.tar -C C:\\workspace; if ($LASTEXITCODE -ne 0) { throw 'Import du projet impossible' }");
    } else if (s.system === 'docker') {
      const archive = path.join(s.dir, 'project.tar'); await run(tarExe(), ['-cf', archive, '-C', dest, '.']);
      const guestPath = await this.docker.importArchive(s, archive);
      return { summary: 'Copie du projet importée dans le conteneur. Les fichiers sensibles et dépendances locales sont exclus.', files: count, bytes, fingerprint: projectFingerprint, guestPath };
    } else {
      const archive = path.join(s.dir, 'project.tar'); await run(tarExe(), ['-cf', archive, '-C', dest, '.']);
      const args = this.sshArgs(s); const host = args.pop(); const p = args.indexOf('-p'); args[p] = '-P';
      const remoteTar = s.system === 'ssh' ? `/tmp/zaalis-project-${s.id.slice(SSH_PREFIX.length, SSH_PREFIX.length + 8)}.tar` : '/tmp/zaalis-project.tar';
      await run(process.platform === 'win32' ? 'scp.exe' : 'scp', [...args, archive, host + ':' + remoteTar]);
      const workspace = this.guestWorkspace(s);
      const target = s.system === 'ssh' ? workspace : '~/workspace';
      const reset = s.system === 'ssh' ? `rm -rf -- ${shQuote(workspace)}` : 'rm -rf -- /home/zaalis/workspace';
      await this.exec(s, `${reset} && mkdir -p ${target} && tar -xf ${remoteTar} -C ${target} && rm ${remoteTar}`);
      if (s.system === 'ssh') return { summary: 'Copie du projet importée sur l’hôte SSH. Les fichiers sensibles et dépendances locales sont exclus.', files: count, bytes, fingerprint: projectFingerprint, guestPath: '~/' + workspace };
    }
    return { summary: 'Copie du projet importée. Les fichiers sensibles et dépendances locales sont exclus.', files: count, bytes, fingerprint: projectFingerprint, guestPath: s.system === 'linux' ? '/home/zaalis/workspace' : 'C:\\workspace' };
  }
  async exportFile(s, guestPath) {
    if (s.status !== 'ready') throw new Error('VM non prête.');
    if (typeof guestPath !== 'string' || !guestPath || guestPath.length > 1024 || /[\r\n\0]/.test(guestPath)) throw new Error('Chemin invité invalide.');
    const id=crypto.randomUUID(), name=guestPath.split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g,'_') || 'result.bin';
    const artifactRoot=path.join(this.root,'artifacts'); fs.mkdirSync(artifactRoot,{recursive:true}); const dest=path.join(artifactRoot,id);
    if (s.system === 'docker') {
      await this.docker.exportFile(s, guestPath, dest);
    } else if (s.system === 'linux' || s.system === 'ssh') {
      await new Promise((resolve,reject)=>execFile(process.platform === 'win32' ? 'ssh.exe' : 'ssh',[...this.sshArgs(s),`cat -- ${shQuote(guestPath)}`],{windowsHide:true,encoding:'buffer',timeout:120000,maxBuffer:32*1024*1024},(error,stdout)=>{if(error)return reject(error);fs.writeFileSync(dest,stdout);resolve();}));
    } else {
      const staging=path.join(s.outputDir,id+'.export');
      await this.exec(s,`$f=Get-Item -LiteralPath ${quote(guestPath)}; if ($f.PSIsContainer -or $f.Length -gt 33554432) { throw 'Export limité à un fichier de 32 Mo' }; Copy-Item -LiteralPath $f.FullName -Destination 'C:\\ZaalisBridge\\${id}.export'`);
      if(!fs.existsSync(staging)||fs.lstatSync(staging).isSymbolicLink()||fs.statSync(staging).size>32*1024*1024)throw new Error('Export invalide.');
      fs.copyFileSync(staging,dest);fs.unlinkSync(staging);
    }
    const artifact={id,name,bytes:fs.statSync(dest).size,path:dest};(s.artifacts ||= []).push(artifact);
    return {summary:'Fichier récupéré depuis la VM',artifact:{id,name,bytes:artifact.bytes,url:`/api/vm/${s.id}/artifacts/${id}`}};
  }
  // One stop at a time per session. `skipStart` is the start task cleaning up
  // after its own failure: it must not wait for itself.
  stop(s, terminalManager, skipStart = false) {
    if (skipStart) return this.stopNow(s, terminalManager);
    if (!s.stopTask) {
      s.stopTask = (async () => {
        s.stopRequested = true; if (s.status !== 'stopped') s.status = 'stopping';
        if (s.startTask) await s.startTask;
        return this.stopNow(s, terminalManager);
      })().finally(() => { s.stopTask = null; });
    }
    return s.stopTask;
  }
  // Every release step runs even when an earlier one fails, so a failed
  // `wsb list` can no longer leave QEMU, the bridge or the heartbeat behind,
  // nor a session shown as "stopping" for ever.
  async stopNow(s, terminalManager) {
    s.stopRequested = true; s.status = 'stopping';
    const failures = [];
    const step = async task => { try { await task(); } catch (error) { failures.push(sanitize(String(error.message || error))); } };
    await step(() => { if (s.activeExec) s.activeExec.kill(); });
    clearInterval(s.heartbeatTimer);
    await step(() => { if (s.terminalId && terminalManager) { terminalManager.close(terminalManager.get(s.terminalId, s.userId)); s.terminalId = null; } });
    if (s.sandboxId) await step(async () => { const list = JSON.parse(await run('wsb.exe', ['list', '--raw'])); if ((list.WindowsSandboxEnvironments || []).some(item => item.Id === s.sandboxId)) await run('wsb.exe', ['stop', '--id', s.sandboxId]); });
    if (s.proc && s.proc.exitCode === null && s.proc.signalCode === null) await step(async () => { s.proc.kill(); await Promise.race([new Promise(resolve => s.proc.once('exit', resolve)), delay(5000)]); if (s.proc.exitCode === null && s.proc.signalCode === null) throw new Error('QEMU n’a pas confirmé son arrêt.'); });
    await step(() => { if (s.bridgeProc) s.bridgeProc.kill(); });
    if (s.system === 'docker') await step(() => this.docker.remove(s));
    if (failures.length) { s.status = 'error'; s.error = 'Arrêt incomplet : ' + failures.join(' '); throw new Error(s.error); }
    s.status = 'stopped'; return this.snapshot(s, UI_OUTPUT_TAIL);
  }
  // Stops if needed, then frees the disk, the staged copies and the exported files.
  async remove(s, terminalManager) {
    if (s.status !== 'stopped') await this.stop(s, terminalManager);
    for (const artifact of s.artifacts || []) { try { fs.unlinkSync(artifact.path); } catch {} }
    await this.discard(s);
  }
  async convertDisk(source,target) { return run(this.qemu('qemu-img'),['convert','-c','-O','qcow2',source,target],{timeout:300000}); }
  async discard(s) {
    if(this.sessions.get(s.id)!==s||s.status!=='stopped')throw new Error('Arrêtez la VM avant de libérer son disque.');
    const folder=s.id.startsWith(SSH_PREFIX)?s.id.slice(SSH_PREFIX.length):s.id;
    const expected=path.resolve(this.root,folder),target=path.resolve(s.dir);
    if(!/^[0-9a-f-]{36}$/.test(folder)||target!==expected||!target.startsWith(path.resolve(this.root)+path.sep)||fs.lstatSync(target).isSymbolicLink())throw new Error('Dossier de VM non sûr.');
    // Windows may hold the disk image for a moment after QEMU exits.
    fs.rmSync(target,{recursive:true,force:true,maxRetries:6,retryDelay:250});this.sessions.delete(s.id);
  }
  async shutdown(terminals) { await Promise.allSettled([...this.sessions.values()].filter(s => s.status !== 'stopped').map(s => this.stop(s, terminals))); }
  async activate(system = 'windows') {
    const caps = await this.capabilities(); if(system==='windows'){if (!caps.windows.compatible) throw new Error(caps.windows.reason); if (caps.windows.enabled) return { enabled: true };}else if(!caps.linux.compatible)throw new Error('Linux intégré requiert un hôte Windows ou Linux x64, ou un Mac.');
    if (process.platform === 'linux') return this.activateLinuxHost(caps.linux);
    if (MACOS) return this.activateMacHost(caps.linux);
    const file = path.join(this.root, 'activation-' + crypto.randomUUID() + '.json');
    const commands=system==='windows'?"$r=Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart":"$r=Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart; if (!(Get-Command ssh.exe -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null }";
    const script = `$ErrorActionPreference='Stop'; try { ${commands}; @{ok=$true;restartNeeded=$r.RestartNeeded} | ConvertTo-Json | Set-Content -LiteralPath ${quote(file)} } catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath ${quote(file)} }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    this.probe = null;
    try { await ps(`Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile -EncodedCommand ${encoded}'`); }
    catch { throw new Error('Activation annulée : la demande administrateur Windows a été refusée ou interrompue.'); }
    finally { this.probe = null; }
    if (!fs.existsSync(file)) throw new Error('Activation interrompue avant son résultat. Réessayez.');
    const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); fs.unlinkSync(file); if (!result.ok) throw new Error(result.error); return result;
  }
  // Linux host: missing packages and KVM access through a graphical pkexec
  // prompt (the UAC equivalent), then the official Debian image, verified.
  async activateLinuxHost(caps) {
    let restartNeeded = false;
    const user = os.userInfo().username;
    if (!caps.qemuAvailable || !caps.sshAvailable || !caps.accelerationEnabled) {
      if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(user)) throw new Error('Nom d’utilisateur inattendu.');
      const install = 'if command -v apt-get >/dev/null 2>&1; then apt-get install -y qemu-system-x86 qemu-utils openssh-client; elif command -v dnf >/dev/null 2>&1; then dnf install -y qemu-system-x86 qemu-img openssh-clients; elif command -v pacman >/dev/null 2>&1; then pacman -S --needed --noconfirm qemu-base openssh; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install qemu-x86 qemu-tools openssh-clients; else echo "Gestionnaire de paquets non pris en charge" >&2; exit 3; fi';
      const kvm = `if [ -e /dev/kvm ]; then getent group kvm >/dev/null || groupadd -r kvm; usermod -aG kvm ${user}; else echo "KVM absent : activez la virtualisation (VT-x/AMD-V) dans le firmware" >&2; exit 4; fi`;
      const script = ['set -e', 'export DEBIAN_FRONTEND=noninteractive', !caps.qemuAvailable || !caps.sshAvailable ? install : '', !caps.accelerationEnabled ? kvm : ''].filter(Boolean).join('\n');
      await run('pkexec', ['sh', '-c', script], { timeout: 900000 });
      restartNeeded = !caps.accelerationEnabled;
    }
    const image = this.baseImage();
    if (!fs.existsSync(image)) await this.downloadImage(image);
    return { ok: true, restartNeeded };
  }
  // macOS host: HVF is built in and OpenSSH ships with the system; QEMU comes
  // from Homebrew (user install, no administrator prompt), then the verified image.
  async activateMacHost(caps) {
    if (!caps.accelerationEnabled) throw new Error('Hypervisor.framework est indisponible sur ce Mac (kern.hv_support = 0).');
    if (!caps.sshAvailable) throw new Error('Client OpenSSH du système introuvable (ssh, scp, ssh-keygen).');
    if (!caps.qemuAvailable) {
      const brew = brewBinary();
      if (!brew) throw new Error('QEMU est requis : installez Homebrew (https://brew.sh), puis relancez l’activation, ou exécutez « brew install qemu ».');
      await run(brew, ['install', 'qemu'], { timeout: 1800000, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', PATH: [path.dirname(brew), '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(':') } });
      if (![QEMU_SYSTEM, 'qemu-img'].every(name => fs.existsSync(this.qemu(name)))) throw new Error('QEMU installé, mais ' + QEMU_SYSTEM + ' reste introuvable.');
    }
    const image = this.baseImage();
    if (!fs.existsSync(image)) await this.downloadImage(image);
    return { ok: true, restartNeeded: false };
  }
  async downloadImage(target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = target + '.part', hash = crypto.createHash('sha512');
    const response = await fetch(DEBIAN_IMAGE.url, { redirect: 'follow', signal: AbortSignal.timeout(3600000) });
    if (!response.ok || !response.body) throw new Error('Téléchargement de l’image Debian impossible (' + response.status + ').');
    const out = fs.createWriteStream(temp);
    try {
      for await (const chunk of response.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve)); }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
      if (hash.digest('hex') !== DEBIAN_IMAGE.sha512) throw new Error('Empreinte de l’image Debian invalide.');
      fs.renameSync(temp, target);
    } catch (error) { out.destroy(); try { fs.unlinkSync(temp); } catch {} throw error; }
  }
  async action(userId, input, terminals, projectRoot) {
    switch (input.action) {
      case 'templates': return {summary:'Environnements Linux réutilisables',templates:this.templates.list(userId)};
      case 'save_template': return {summary:'Environnement Linux figé, VM arrêtée',template:await this.templates.save(userId,this.get(input.id,userId),this)};
      case 'list': return { summary: 'Machines virtuelles', capabilities: await this.capabilities(), machines: this.list(userId).map(({output, ...machine}) => machine) };
      case 'create': return { summary: 'Démarrage en cours ; utiliser status avant exec', machine: await this.create(userId, input, projectRoot) };
      case 'hosts': return { summary: 'Hôtes SSH enregistrés par l’utilisateur', hosts: this.sshHosts.list(userId).map(({ id, name, host, user, port, verified, system }) => ({ id, name, host, user, port, verified, system })) };
      case 'status': {
        const s = this.get(input.id, userId), waitMs = input.waitMs ?? 0;
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error('Attente invalide : waitMs entre 0 et 30000.');
        // Lets the agent wait for readiness in one call instead of polling.
        for (const end = Date.now() + waitMs; s.status === 'starting' && Date.now() < end;) await delay(250);
        return { summary: s.status === 'starting' ? 'VM encore en démarrage : rappeler status avec waitMs' : 'État de la VM', machine: this.snapshot(s, 4000) };
      }
      case 'exec': {
        if (input.timeoutMs != null && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120000)) throw new Error('timeoutMs invalide : entre 1000 et 120000.');
        const result = await this.exec(this.get(input.id, userId), input.command, input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}); return { summary: 'Commande exécutée dans la VM', ...result, output: result.output.slice(-32000), truncated: result.output.length > 32000 }; }
      case 'import_project': return this.importProject(this.get(input.id, userId), projectRoot);
      case 'export_file': return this.exportFile(this.get(input.id,userId),input.path);
      case 'reset': {
        const old=this.get(input.id,userId); if(old.status!=='stopped')await this.stop(old,terminals);
        const options={system:old.system,name:old.name,network:old.network,memoryMB:old.memoryMB,cpus:old.cpus,templateId:old.templateId,image:old.system==='docker'?old.image:undefined,host:old.remote?.id};
        // The replaced machine would otherwise stay listed and keep its disk.
        try{await this.remove(old,terminals);}catch{}
        return {summary:'Nouvel environnement propre ; utiliser le nouvel id',machine:await this.create(userId,options,old.projectRoot||projectRoot)};
      }
      case 'stop': return { summary: 'VM arrêtée', machine: await this.stop(this.get(input.id, userId), terminals) };
      case 'delete': { await this.remove(this.get(input.id, userId), terminals); return { summary: 'VM supprimée, disque libéré', id: input.id }; }
      default: throw new Error('Action VM inconnue.');
    }
  }
}
module.exports = { VmManager, run };
