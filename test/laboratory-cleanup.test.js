const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {VmManager}=require('../vm-manager');
test('disposable VM reclamation requires a stopped owned session and its exact managed folder',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lab-discard-')),vm=new VmManager({appDir:root,dataDir:root}),outside=path.join(root,'external');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'keep');
 const s={id:crypto.randomUUID(),status:'ready',dir:outside};vm.sessions.set(s.id,s);
 try{await assert.rejects(vm.discard(s),/Arrêtez/);s.status='stopped';await assert.rejects(vm.discard(s),/non sûr/);assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'keep');
  s.dir=path.join(vm.root,s.id);fs.mkdirSync(s.dir);fs.writeFileSync(path.join(s.dir,'disk.qcow2'),'disposable');await vm.discard(s);assert.equal(fs.existsSync(s.dir),false);assert.equal(vm.sessions.has(s.id),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('stop waits for a pending start and wait observes cancellation immediately',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lab-stop-')),vm=new VmManager({appDir:root,dataDir:root});let settled=false;
 const s={status:'starting',startTask:new Promise(resolve=>setTimeout(()=>{settled=true;resolve();},20))};
 try{await vm.stop(s);assert.equal(settled,true);assert.equal(s.status,'stopped');await assert.rejects(vm.wait(s,()=>true,1000),/arrêtée/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
