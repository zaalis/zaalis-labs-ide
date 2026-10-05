'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const { VmManager } = require('../vm-manager');
const { TerminalManager } = require('../terminal-manager');
const v = new VmManager({ appDir: process.env.ZAALIS_VM_APP_DIR || path.resolve(__dirname, '..'), dataDir: path.resolve(__dirname, '../server-data/vm-smoke') });
const terminals = new TerminalManager();
async function main() {
  for (const system of process.argv.slice(2).length ? process.argv.slice(2) : ['linux', 'windows']) {
    const snap = await v.create('smoke', { system }); const s = v.get(snap.id, 'smoke');
    try {
      await v.wait(s, () => s.status === 'ready', 200000);
      const r = await v.exec(s, system === 'linux' ? 'uname -s; printf ZAALIS_VM_OK; test ! -d /mnt/c' : "[Environment]::OSVersion.VersionString; Write-Output 'ZAALIS_VM_OK'");
      console.log(JSON.stringify({ system, command: r })); assert.equal(r.exitCode, 0); assert.match(r.output, /ZAALIS_VM_OK/);
      const failed = await v.exec(s, system === 'linux' ? 'exit 7' : 'cmd /c exit 7'); assert.equal(failed.exitCode, 7);
      const fs=require('fs');const fixture=path.join(s.dir,'fixture');fs.mkdirSync(fixture);fs.writeFileSync(path.join(fixture,'marker.txt'),'PROJECT_COPY_OK');fs.writeFileSync(path.join(fixture,'.env'),'must not copy');
      const imported=await v.importProject(s,fixture);assert.equal(imported.files,1);
      const guestPath=system==='linux'?'/home/zaalis/workspace/marker.txt':'C:\\workspace\\marker.txt';
      const exported=await v.exportFile(s,guestPath);assert.equal(fs.readFileSync(s.artifacts[0].path,'utf8'),'PROJECT_COPY_OK');console.log(system.toUpperCase()+'_IMPORT_EXPORT_OK');
      if(system==='windows') {const protectedInput=await v.exec(s,"$writable=$true; try { Set-Content -LiteralPath 'C:\\ZaalisInput\\heartbeat' -Value 'bad' -ErrorAction Stop } catch { $writable=$false }; if ($writable) { throw 'Readonly mapping was writable' }; Write-Output 'INPUT_READ_ONLY_OK'");assert.match(protectedInput.output,/INPUT_READ_ONLY_OK/);console.log('WINDOWS_READONLY_INPUT_OK');}
      assert.throws(() => v.get(s.id, 'another-user'), /inconnue/);
      if (system === 'linux') { const terminal = await v.terminal(s, terminals); const live=terminals.get(terminal.id,'smoke'); terminals.write(live, 'printf PTY_INTERACTIVE_OK\\n\r'); await v.wait(s,()=>live.buffer.includes('PTY_INTERACTIVE_OK'),10000); console.log('LINUX_PTY_OK'); }
      console.log(system.toUpperCase() + '_SMOKE_OK');
      if(system==='windows'&&process.env.ZAALIS_VM_TEST_WATCHDOG==='1') {clearInterval(s.heartbeatTimer);const {run}=require('../vm-manager');const end=Date.now()+65000;for(;;){const list=JSON.parse(await run('wsb.exe',['list','--raw']));if(!list.WindowsSandboxEnvironments.some(x=>x.Id===s.sandboxId))break;if(Date.now()>end)throw new Error('Guest watchdog failed');await new Promise(r=>setTimeout(r,2000));}console.log('WINDOWS_WATCHDOG_OK');}
    } catch (error) { console.error(system.toUpperCase() + '_SMOKE_FAILED: ' + error.message + '\n' + s.output.slice(-4000)); throw error; }
    finally { await v.stop(s, terminals); }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
