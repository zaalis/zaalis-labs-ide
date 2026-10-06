'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {Laboratory,validatePlan,fingerprint}=require('../laboratory');
function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-lab-test-')),project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'code.js'),'original');
 let id=0,active=0,maxActive=0;const sessions=new Map(),commands=[];
 const vm={async create(user,input){const s={id:String(++id),user,status:'ready',input};sessions.set(s.id,s);active++;maxActive=Math.max(active,maxActive);return s;},get(id,user){const s=sessions.get(id);if(s.user!==user)throw Error('owner');return s;},async wait(s,f){if(!f())throw Error('wait');},async importProject(){return{fingerprint:fingerprint(project).hash};},async exec(s,c){commands.push(c);return{exitCode:c.includes('bad')?1:0,output:'PROOF'};},async stop(s){if(s.status!=='stopped'){s.status='stopped';active--;}}};
 const lab=new Laboratory({dataDir:root,vm});const plan={problem:'Compilation discriminante',hypotheses:[{label:'wrong',checks:[{command:'bad'}]},{label:'right',checks:[{command:'good',contains:'PROOF'}]},{label:'unused',checks:[{command:'unused'}]}],finalChecks:[{command:'final',contains:'PROOF'}]};
 return{root,project,vm,lab,plan,commands,sessions,get maxActive(){return maxActive;},cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
}
async function finish(f,r){await f.lab.active.get(r.id)?.promise;return f.lab.get('owner',r.id);}
test('lab discriminates, stops early, retests in a new VM and persists proof',async()=>{const f=fixture();try{
 const r=await finish(f,await f.lab.create('owner',f.plan,f.project));assert.equal(r.status,'verified');assert.equal(r.attempts.length,2);assert.equal(r.final.status,'passed');assert.notEqual(r.final.machine,r.attempts[1].machine);
 assert.equal(f.commands.some(c=>c.includes('unused')),false);assert.equal(f.maxActive,1);assert.equal([...f.sessions.values()].every(s=>s.status==='stopped'),true);
 assert.equal(fs.readFileSync(f.lab.evidence('owner',r.id,r.final.checks[0].log),'utf8'),'PROOF');assert.throws(()=>f.lab.get('other',r.id),/inconnue/);assert.throws(()=>f.lab.evidence('owner',r.id,'../../secret'),/inconnue/);
 const restarted=new Laboratory({dataDir:f.root,vm:f.vm});assert.equal(restarted.get('owner',r.id).status,'verified');assert.equal(restarted.recall('owner',f.plan.problem,f.project)[0].exactSource,true);
 const again=await finish(f,await f.lab.create('owner',f.plan,f.project));assert.equal(again.memoryMatches,1);assert.equal(again.attempts.length,1);assert.equal(again.attempts[0].label,'right');
}finally{f.cleanup();}});
test('parallelism is bounded and Windows/economy are serial',async()=>{const f=fixture();try{
 const p={...f.plan,strategy:'balanced',parallel:2};const r=await finish(f,await f.lab.create('owner',p,f.project));assert.equal(r.status,'verified');assert.equal(f.maxActive,2);
 assert.equal(validatePlan({...p,system:'windows'}).parallel,1);assert.equal(validatePlan({...p,strategy:'economy'}).parallel,1);
}finally{f.cleanup();}});
test('marker assertions prevent false success and final regression prevents verified',async()=>{const f=fixture();try{
 let p={...f.plan,hypotheses:[{label:'wrong',checks:[{command:'good',contains:'ABSENT'}]}]};let r=await finish(f,await f.lab.create('owner',p,f.project));assert.equal(r.status,'refuted');
 p={...f.plan,finalChecks:[{command:'bad'}]};r=await finish(f,await f.lab.create('owner',p,f.project));assert.equal(r.status,'final_failed');
}finally{f.cleanup();}});
test('infrastructure failure and restart never silently replay uncertain work',async()=>{const f=fixture();try{
 f.vm.exec=async()=>{throw Error('connection lost');};const r=await finish(f,await f.lab.create('owner',f.plan,f.project));assert.equal(r.status,'inconclusive');assert.equal(r.attempts[0].status,'infrastructure_error');
 r.status='running';f.lab.save('owner',r);const next=new Laboratory({dataDir:f.root,vm:f.vm});assert.equal(next.get('owner',r.id).status,'interrupted');
}finally{f.cleanup();}});
test('cancel stops only owned experiment VMs and settles before reporting',async()=>{const f=fixture();try{
 f.vm.wait=async(s,fn)=>{await new Promise(resolve=>setTimeout(resolve,20));fn();};const r=await f.lab.create('owner',f.plan,f.project);
 await assert.rejects(f.lab.cancel('other',r.id),/inconnue/);const done=await f.lab.cancel('owner',r.id);assert.equal(done.status,'cancelled');assert.equal(f.lab.active.size,0);assert.equal([...f.sessions.values()].every(s=>s.status==='stopped'),true);
}finally{f.cleanup();}});
test('fingerprints ignore secrets, react to source edits and plans require a final oracle',()=>{const f=fixture();try{
 const a=fingerprint(f.project).hash;fs.writeFileSync(path.join(f.project,'.env'),'key');assert.equal(fingerprint(f.project).hash,a);fs.writeFileSync(path.join(f.project,'code.js'),'change');assert.notEqual(fingerprint(f.project).hash,a);
 assert.throws(()=>validatePlan({...f.plan,finalChecks:[]}),/test/);assert.throws(()=>validatePlan({...f.plan,parallel:9}),/Budget/);assert.throws(()=>validatePlan({...f.plan,hypotheses:[{label:'a',checks:[{command:'echo',contains:''}]}]}),/Assertion/);
}finally{f.cleanup();}});
