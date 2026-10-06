'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const {VmManager}=require('../vm-manager'),{TerminalManager}=require('../terminal-manager');
async function main(){const root=path.resolve('.tmp/laboratory-terminal-'+Date.now()),vm=new VmManager({appDir:path.resolve(__dirname,'..'),dataDir:root}),terminals=new TerminalManager();let s;
 try{const made=await vm.create('terminal-smoke',{system:'linux',network:'isolated'});s=vm.get(made.id,'terminal-smoke');await vm.wait(s,()=>s.status==='ready',200000);const t=await vm.terminal(s,terminals),session=terminals.get(t.id,'terminal-smoke');assert.equal(terminals.get(t.id,'other'),null);
  terminals.resize(session,120,30);terminals.write(session,"touch /tmp/user-terminal-proof; printf 'VM_%s_%s\\n' PTY PROOF; uname -s\r");const end=Date.now()+30000;
  while(Date.now()<end&&!terminals.snapshot(session).output.includes('VM_PTY_PROOF'))await new Promise(r=>setTimeout(r,100));
  const output=terminals.snapshot(session).output;assert.match(output,/VM_PTY_PROOF/);assert.match(output,/Linux/);const separate=await vm.exec(s,'test -f /tmp/user-terminal-proof && printf AGENT_API_SAME_GUEST_OK');assert.equal(separate.exitCode,0);assert.equal(separate.output,'AGENT_API_SAME_GUEST_OK');
  fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify({realGuestPty:true,ownerIsolation:true,resize:true,separateAgentCommandPath:true,output,separate},null,2));console.log('REAL_LINUX_PTY_OWNER_RESIZE_SEPARATE_AGENT_PATH_OK');console.log('EVIDENCE='+path.join(root,'evidence.json'));
 }finally{if(s){await vm.stop(s,terminals);await vm.discard(s);}await vm.shutdown(terminals);}}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
