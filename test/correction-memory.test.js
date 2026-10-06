'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CorrectionMemory} = require('../correction-memory');
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-memory-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,m:new CorrectionMemory(dir)}; }
test('memory persists, isolates accounts/projects and shares only explicit records',t=>{
  const {dir,m}=fixture(t), a=path.join(dir,'a'),b=path.join(dir,'b');
  const r=m.save('alice',a,{problem:'dictation restart bug',summary:'Bind recorder to session',status:'verified'});
  assert.equal(new CorrectionMemory(dir).list('alice',a).length,1);
  assert.equal(m.list('bob',a).length,0);assert.equal(m.list('alice',b).length,0);
  m.settings('alice',b,{crossProject:true});assert.equal(m.list('alice',b).length,0);
  m.save('alice',a,{id:r.id,shared:true});assert.equal(m.list('alice',b).length,1);
  assert.match(m.recall('alice',a,'dictation'),/Bind recorder/);
  assert.throws(()=>m.remove('alice',b,r.id));m.remove('alice',a,r.id);assert.equal(m.list('alice',a).length,0);
});
test('verification requires a successful check after the last mutation; cancellation never saves',t=>{
  const {dir,m}=fixture(t);const edit={tool:'edit',input:{path:'app.js'}};
  const check=code=>({tool:'run',input:{command:'npm test'},text:JSON.stringify({exit_code:code,success:code===0})});
  const capture=tools=>m.capture('a',dir,'bug',{response:'Fixed',toolResults:tools});
  assert.equal(capture([edit,check(0)]).status,'verified');
  assert.equal(capture([check(0),edit]).status,'attempted');assert.equal(capture([edit,check(1)]).status,'attempted');
  assert.equal(capture([edit,{tool:'read',input:{path:'app.js'}}]).status,'attempted');
  assert.equal(m.capture('a',dir,'bug',{toolResults:[edit,check(0)]},true),null);
  m.settings('a',dir,{enabled:false});assert.equal(capture([edit,check(0)]),null);assert.equal(m.recall('a',dir,'bug'),'');
});
test('laboratory import sees all history, preserves deletion and redacts common secrets',t=>{
  const {dir,m}=fixture(t),id=require('node:crypto').randomUUID();
  const lab={list:(u,all)=>{assert.equal(all,true);return [{id,project:dir,problem:'bug api_key=abcdef',status:'verified',attempts:[{hypothesis:'a',label:'fixed'}],winner:'a',final:{checks:[{command:'npm test',passed:true,exitCode:0}]}}];}};
  m.importLaboratory('a',lab);assert.match(m.list('a',dir)[0].problem,/secret supprimé/);
  m.remove('a',dir,id);m.importLaboratory('a',lab);assert.equal(m.list('a',dir).length,0);
});
test('automatic retrieval searches beyond 100 records',t=>{
  const {dir,m}=fixture(t);m.save('a',dir,{problem:'old distinct failure',summary:'solution'});
  for(let i=0;i<105;i++)m.save('a',dir,{problem:'recent '+i,summary:'different'});
  assert.equal(m.list('a',dir,'distinct').length,1);
});
