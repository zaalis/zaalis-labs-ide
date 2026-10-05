'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { seedIso } = require('./vm-seed');
const { sanitize } = require('./secrets-mask');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) { error.message = sanitize(String(stderr || stdout || error.message)); reject(error); }
    else resolve(String(stdout));
  }));
}
const ps = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const shQuote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
class VmManager {
  constructor({ appDir, dataDir }) { this.assets = path.join(appDir, 'vm'); if (!fs.existsSync(this.assets)) this.assets = path.join(appDir, 'native', 'vm'); this.root = path.join(dataDir, 'virtual-machines'); fs.mkdirSync(this.root, { recursive: true }); this.sessions = new Map(); this.windowsStarting = false; }
  async capabilities() {
    let windows = { compatible: false, enabled: false, cli: false, reason: 'Windows Sandbox nécessite Windows Pro, Enterprise ou Education.' };
    let linuxHost={compatible:process.platform==='win32'&&process.arch==='x64',accelerationEnabled:false,sshAvailable:false};
    if (process.platform === 'win32') {
      try {
        const info = JSON.parse(await ps("$v=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; $f=Get-CimInstance Win32_OptionalFeature -Filter \"Name='Containers-DisposableClientVM'\"; $h=Get-CimInstance Win32_OptionalFeature -Filter \"Name='HypervisorPlatform'\"; @{edition=$v.EditionID; build=$v.CurrentBuild; state=$f.InstallState; cli=[bool](Get-Command wsb.exe -ErrorAction SilentlyContinue);whpx=($h.InstallState -eq 1);ssh=[bool](Get-Command ssh.exe -ErrorAction SilentlyContinue)} | ConvertTo-Json -Compress"));
        linuxHost.accelerationEnabled=info.whpx;linuxHost.sshAvailable=info.ssh;
        windows = { ...windows, ...info, compatible: /Professional|Enterprise|Education/.test(info.edition), enabled: info.state === 1, cli: info.cli };
        windows.reason = !windows.compatible ? windows.reason : !windows.enabled ? 'Windows Sandbox est désactivé. Son activation peut nécessiter un redémarrage.' : !windows.cli ? 'Sandbox activé, mais son API wsb est absente. Mettez Windows Sandbox à jour.' : 'Prêt · Windows Sandbox';
      } catch (error) { windows.reason = error.message; }
    }
    const bundled=fs.existsSync(path.join(this.assets, 'qemu', 'qemu-system-x86_64.exe')) && fs.existsSync(path.join(this.assets, 'images', 'debian.qcow2'));
    return { windows, linux: { ...linuxHost,bundled,available:bundled&&linuxHost.compatible&&linuxHost.accelerationEnabled&&linuxHost.sshAvailable, image: 'Debian 12 · serveur', imageBytes: fs.existsSync(path.join(this.assets, 'images', 'debian.qcow2')) ? fs.statSync(path.join(this.assets, 'images', 'debian.qcow2')).size : 0 }, mode: 'autonomous', maxLinux: 3 };
  }
  snapshot(s) { return { id: s.id, system: s.system, name: s.name, status: s.status, memoryMB: s.memoryMB, cpus: s.cpus, network: s.network, output: sanitize(s.output), error: s.error || null, terminalId: s.terminalId || null, artifacts: (s.artifacts || []).map(({id,name,bytes}) => ({id,name,bytes})) }; }
  list(userId) { return [...this.sessions.values()].filter(s => s.userId === userId).map(s => this.snapshot(s)); }
  get(id, userId) { const s = this.sessions.get(id); if (!s || s.userId !== userId) throw new Error('Machine virtuelle inconnue.'); return s; }
  log(s, data) { s.output = (s.output + data).slice(-512 * 1024); }
  async create(userId, input = {}) {
    const system = input.system === 'windows' ? 'windows' : input.system === 'linux' ? 'linux' : null;
    if (!system) throw new Error('Système inconnu.');
    const caps = await this.capabilities();
    if (system === 'windows' && (!caps.windows.compatible || !caps.windows.enabled || !caps.windows.cli)) throw new Error(caps.windows.reason);
    if (system === 'linux' && !caps.linux.available) throw new Error(!caps.linux.bundled?'Le pack Linux intégré est absent.':'Activez les composants Windows pour Linux dans les paramètres Machines virtuelles.');
    if (system === 'windows' && (this.windowsStarting || [...this.sessions.values()].some(s => s.system === 'windows' && !['stopped', 'error'].includes(s.status)))) throw new Error('Une session Windows Sandbox est déjà gérée par l’IDE.');
    if (system === 'linux' && [...this.sessions.values()].filter(s => s.system === 'linux' && !['stopped', 'error'].includes(s.status)).length >= 3) throw new Error('Limite de trois VM Linux simultanées atteinte.');
    const memoryMB = Math.max(1024, Math.min(8192, Number(input.memoryMB) || 2048));
    const cpus = Math.max(1, Math.min(4, Math.floor(Number(input.cpus) || 2)));
    if ([...this.sessions.values()].filter(s => !['stopped', 'error'].includes(s.status)).reduce((n, s) => n + s.memoryMB, memoryMB) > os.totalmem() / 1024 / 1024 * .65) throw new Error('Mémoire disponible insuffisante pour cette VM.');
    const s = { id: crypto.randomUUID(), userId, system, name: String(input.name || (system === 'linux' ? 'Debian' : 'Windows Sandbox')).slice(0, 80), memoryMB, cpus, network: input.network === 'internet' ? 'internet' : 'isolated', status: 'starting', output: '', queue: Promise.resolve() };
    s.dir = path.join(this.root, s.id); fs.mkdirSync(s.dir); this.sessions.set(s.id, s);
    this.start(s).catch(async error => { const cancelled=s.stopRequested; try { await this.stop(s); } catch {} if(cancelled)return; s.error = error.message; s.status = 'error'; this.log(s, '\r\n' + error.message); });
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
        s.bridgeProc.on('exit', code => { if (code && s.status !== 'stopped') { s.error = 'Le pont Sandbox a échoué (' + code + ').'; s.status = 'error'; } });
        await this.wait(s, () => fs.existsSync(path.join(s.outputDir, 'ready')), 120000);
        this.log(s, 'Windows Sandbox · PowerShell\r\nPS C:\\> ');
      } finally { this.windowsStarting = false; }
    } else {
      const key = path.join(s.dir, 'id_ed25519'); s.key = key;
      await run('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      check();
      const pub = fs.readFileSync(key + '.pub', 'utf8').trim();
      fs.writeFileSync(path.join(s.dir, 'seed.iso'), seedIso({ 'meta-data': `instance-id: ${s.id}\nlocal-hostname: zaalis-vm\n`, 'user-data': `#cloud-config\nusers:\n  - name: zaalis\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - ${pub}\nssh_pwauth: false\ndisable_root: true\n` }));
      const qemuDir = path.join(this.assets, 'qemu');
      await run(path.join(qemuDir, 'qemu-img.exe'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', path.join(this.assets, 'images', 'debian.qcow2'), path.join(s.dir, 'disk.qcow2'), '24G']);
      check();
      s.port = await new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
      check();
      const args = ['-accel', 'whpx', '-m', String(s.memoryMB), '-smp', String(s.cpus), '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-drive', `file=${path.join(s.dir, 'disk.qcow2')},format=qcow2,if=virtio`, '-drive', `file=${path.join(s.dir, 'seed.iso')},media=cdrom,readonly=on`, '-netdev', `user,id=net0,restrict=${s.network === 'isolated' ? 'on' : 'off'},hostfwd=tcp:127.0.0.1:${s.port}-:22`, '-device', 'virtio-net-pci,netdev=net0'];
      s.proc = spawn(path.join(qemuDir, 'qemu-system-x86_64.exe'), args, { windowsHide: true });
      s.proc.on('error', error => { s.error = error.message; s.status = 'error'; });
      s.proc.stdout.on('data', data => this.log(s, data.toString())); s.proc.stderr.on('data', data => this.log(s, data.toString()));
      s.proc.on('exit', code => { if (s.status !== 'stopped') { s.status = 'error'; s.error = 'QEMU arrêté (' + code + '). ' + s.output.slice(-600); } });
      await this.wait(s, async () => { try { await run('ssh.exe', [...this.sshArgs(s), 'true'], { timeout: 8000 }); return true; } catch { return false; } }, 180000);
      this.log(s, '\r\nDebian prêt · SSH\r\n');
    }
    if (s.status === 'starting') s.status = 'ready';
  }
  sshArgs(s) { return ['-i', s.key, '-p', String(s.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(s.dir, 'known_hosts'), 'zaalis@127.0.0.1']; }
  async wait(s, test, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { if (['stopped', 'error'].includes(s.status)) throw new Error(s.error || 'VM arrêtée.'); if (await test()) return; await delay(500); } throw new Error('Délai de démarrage ou de commande dépassé.'); }
  exec(s, command) {
    if (s.status !== 'ready') return Promise.reject(new Error('La VM n’est pas prête.'));
    if (typeof command !== 'string' || !command.trim() || command.length > 32000) return Promise.reject(new Error('Commande invalide.'));
    const task = s.queue.catch(() => {}).then(async () => {
      if (s.status !== 'ready') throw new Error('VM arrêtée.');
      this.log(s, '\r\n$ ' + command + '\r\n');
      let result;
      if (s.system === 'linux') {
        result = await new Promise(resolve => execFile('ssh.exe', [...this.sshArgs(s), command], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ output: String(stdout || '') + String(stderr || ''), exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0 })));
      } else {
        const id = crypto.randomUUID(), outputBase=path.join(s.outputDir,id);
        let published=false;for(let attempt=0;attempt<50;attempt++){try{fs.writeFileSync(path.join(s.inputDir,'request.json'),JSON.stringify({id,command}));published=true;break;}catch(error){if(!['EBUSY','EPERM'].includes(error.code))throw error;await delay(40);}}if(!published)throw new Error('Canal Sandbox occupé.');
        try { await this.wait(s, () => fs.existsSync(outputBase + '.result.json'), 120000); } catch(error){await this.stop(s);throw error;}
        const file = outputBase + '.result.json';
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) throw new Error('Résultat Sandbox invalide.');
        result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));try{fs.unlinkSync(file);}catch{}
      }
      result.output = sanitize(String(result.output || '')); this.log(s, result.output + '\r\n' + (result.cwd ? `PS ${result.cwd}> ` : '')); return result;
    }); s.queue = task; return task;
  }
  async terminal(s, terminalManager) {
    if (s.system !== 'linux') throw new Error('Windows utilise la console PowerShell persistante, sans PTY.');
    if (s.status !== 'ready') throw new Error('VM non prête.');
    const existing = s.terminalId && terminalManager.get(s.terminalId, s.userId); if (existing && !existing.closed) return terminalManager.snapshot(existing);
    const session = terminalManager.createExternal({ userId: s.userId, cwd: s.dir, shell: 'ssh.exe', args: ['-tt', ...this.sshArgs(s)], label: 'vm-linux', origin: 'vm' }); s.terminalId = session.id; return terminalManager.snapshot(session);
  }
  async importProject(s, root) {
    if (s.status !== 'ready') throw new Error('VM non prête.');
    if (!root || !fs.statSync(root).isDirectory()) throw new Error('Aucun projet actif.');
    const dest = path.join(s.system==='windows'?(s.inputDir||s.dir):s.dir, 'project-copy'); fs.mkdirSync(dest, { recursive: true });
    let bytes = 0, count = 0;
    const copy = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'server-data', '.zaalis', '.codex', 'target', '.ssh', '.aws', '.azure', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519'].includes(entry.name) || /^\.env(?:\.|$)/i.test(entry.name) || /\.(pem|key|p12|pfx)$/i.test(entry.name) || entry.isSymbolicLink()) continue;
        const src = path.join(from, entry.name), dst = path.join(to, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copy(src, dst); }
        else if (entry.isFile()) { const size = fs.statSync(src).size; bytes += size; if (bytes > 256 * 1024 * 1024 || ++count > 12000) throw new Error('Projet trop volumineux : limite 256 Mo / 12 000 fichiers.'); fs.copyFileSync(src, dst); }
      }
    };
    copy(root, dest);
    if (s.system === 'windows') {
      await run('tar.exe',['-cf',path.join(s.inputDir||s.dir,'project.tar'),'-C',dest,'.']);
      await this.exec(s, "New-Item -ItemType Directory -Force C:\\workspace | Out-Null; tar.exe -xf C:\\ZaalisInput\\project.tar -C C:\\workspace; if ($LASTEXITCODE -ne 0) { throw 'Import du projet impossible' }");
    } else {
      const archive = path.join(s.dir, 'project.tar'); await run('tar.exe', ['-cf', archive, '-C', dest, '.']);
      const args = this.sshArgs(s); const host = args.pop(); const p = args.indexOf('-p'); args[p] = '-P';
      await run('scp.exe', [...args, archive, host + ':/tmp/zaalis-project.tar']);
      await this.exec(s, 'mkdir -p ~/workspace && tar -xf /tmp/zaalis-project.tar -C ~/workspace && rm /tmp/zaalis-project.tar');
    }
    return { summary: 'Copie du projet importée. Les fichiers sensibles et dépendances locales sont exclus.', files: count, bytes, guestPath: s.system === 'linux' ? '/home/zaalis/workspace' : 'C:\\workspace' };
  }
  async exportFile(s, guestPath) {
    if (s.status !== 'ready') throw new Error('VM non prête.');
    if (typeof guestPath !== 'string' || !guestPath || guestPath.length > 1024 || /[\r\n\0]/.test(guestPath)) throw new Error('Chemin invité invalide.');
    const id=crypto.randomUUID(), name=guestPath.split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g,'_') || 'result.bin';
    const artifactRoot=path.join(this.root,'artifacts'); fs.mkdirSync(artifactRoot,{recursive:true}); const dest=path.join(artifactRoot,id);
    if (s.system === 'linux') {
      await new Promise((resolve,reject)=>execFile('ssh.exe',[...this.sshArgs(s),`cat -- ${shQuote(guestPath)}`],{windowsHide:true,encoding:'buffer',timeout:120000,maxBuffer:32*1024*1024},(error,stdout)=>{if(error)return reject(error);fs.writeFileSync(dest,stdout);resolve();}));
    } else {
      const staging=path.join(s.outputDir,id+'.export');
      await this.exec(s,`$f=Get-Item -LiteralPath ${quote(guestPath)}; if ($f.PSIsContainer -or $f.Length -gt 33554432) { throw 'Export limité à un fichier de 32 Mo' }; Copy-Item -LiteralPath $f.FullName -Destination 'C:\\ZaalisBridge\\${id}.export'`);
      if(!fs.existsSync(staging)||fs.lstatSync(staging).isSymbolicLink()||fs.statSync(staging).size>32*1024*1024)throw new Error('Export invalide.');
      fs.copyFileSync(staging,dest);fs.unlinkSync(staging);
    }
    const artifact={id,name,bytes:fs.statSync(dest).size,path:dest};(s.artifacts ||= []).push(artifact);
    return {summary:'Fichier récupéré depuis la VM',artifact:{id,name,bytes:artifact.bytes,url:`/api/vm/${s.id}/artifacts/${id}`}};
  }
  async stop(s, terminalManager) {
    s.stopRequested=true;s.status='stopping';
    clearInterval(s.heartbeatTimer);
    if(s.terminalId&&terminalManager)terminalManager.close(terminalManager.get(s.terminalId,s.userId));
    if(s.sandboxId){const list=JSON.parse(await run('wsb.exe',['list','--raw']));if((list.WindowsSandboxEnvironments||[]).some(item=>item.Id===s.sandboxId))await run('wsb.exe',['stop','--id',s.sandboxId]);}
    if(s.proc&&s.proc.exitCode===null){s.proc.kill();await Promise.race([new Promise(resolve=>s.proc.once('exit',resolve)),delay(5000)]);if(s.proc.exitCode===null&&s.proc.signalCode===null)throw new Error('QEMU n’a pas confirmé son arrêt.');}
    if(s.bridgeProc)s.bridgeProc.kill();s.status='stopped';return this.snapshot(s);
  }
  async shutdown(terminals) { await Promise.allSettled([...this.sessions.values()].filter(s => s.status !== 'stopped').map(s => this.stop(s, terminals))); }
  async activate(system = 'windows') {
    const caps = await this.capabilities(); if(system==='windows'){if (!caps.windows.compatible) throw new Error(caps.windows.reason); if (caps.windows.enabled) return { enabled: true };}else if(!caps.linux.compatible)throw new Error('Linux intégré requiert un hôte Windows x64.');
    const file = path.join(this.root, 'activation-' + crypto.randomUUID() + '.json');
    const commands=system==='windows'?"$r=Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart":"$r=Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart; if (!(Get-Command ssh.exe -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null }";
    const script = `$ErrorActionPreference='Stop'; try { ${commands}; @{ok=$true;restartNeeded=$r.RestartNeeded} | ConvertTo-Json | Set-Content -LiteralPath ${quote(file)} } catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath ${quote(file)} }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await ps(`Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile -EncodedCommand ${encoded}'`);
    const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); fs.unlinkSync(file); if (!result.ok) throw new Error(result.error); return result;
  }
  async action(userId, input, terminals, projectRoot) {
    switch (input.action) {
      case 'list': return { summary: 'Machines virtuelles', capabilities: await this.capabilities(), machines: this.list(userId).map(({output, ...machine}) => machine) };
      case 'create': return { summary: 'Démarrage en cours ; utiliser status avant exec', machine: await this.create(userId, input) };
      case 'status': { const machine = this.snapshot(this.get(input.id, userId)); machine.output = machine.output.slice(-4000); return { summary: 'État de la VM', machine }; }
      case 'exec': { const result = await this.exec(this.get(input.id, userId), input.command); return { summary: 'Commande exécutée dans la VM', ...result, output: result.output.slice(-32000), truncated: result.output.length > 32000 }; }
      case 'import_project': return this.importProject(this.get(input.id, userId), projectRoot);
      case 'export_file': return this.exportFile(this.get(input.id,userId),input.path);
      case 'reset': { const old=this.get(input.id,userId); if(old.status!=='stopped')await this.stop(old,terminals); return {summary:'Nouvel environnement propre',machine:await this.create(userId,{system:old.system,name:old.name,network:old.network,memoryMB:old.memoryMB,cpus:old.cpus})}; }
      case 'stop': return { summary: 'VM arrêtée', machine: await this.stop(this.get(input.id, userId), terminals) };
      default: throw new Error('Action VM inconnue.');
    }
  }
}
module.exports = { VmManager, run };
