'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { VmManager } = require('../src/laboratory/vm-manager');
test('VM ownership cannot be changed by an id or user supplied in tool arguments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-unit-'));
  try {
    const v = new VmManager({ appDir:root,dataDir:root });
    v.sessions.set('one',{id:'one',userId:'owner',output:'private'});
    assert.throws(()=>v.get('one','other'),/inconnue/);
    assert.deepEqual(v.list('other'),[]);
    await assert.rejects(v.action('other',{action:'exec',id:'one',userId:'owner',command:'echo test'}),/inconnue/);
    await assert.rejects(v.action('owner',{action:'activate'}),/inconnue/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('project import uses a copy, excludes secrets and skips links', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-copy-'));
  try {
    const project=path.join(root,'project'), dir=path.join(root,'session');fs.mkdirSync(project);fs.mkdirSync(dir);
    fs.writeFileSync(path.join(project,'source.js'),'safe');fs.writeFileSync(path.join(project,'.env'),'secret');fs.writeFileSync(path.join(project,'server.key'),'secret');
    fs.mkdirSync(path.join(project,'node_modules'));fs.writeFileSync(path.join(project,'node_modules','dependency'),'excluded');
    const v=new VmManager({appDir:root,dataDir:root});let command;
    v.exec=async(s,c)=>{command=c;return {exitCode:0,output:''};};
    const r=await v.importProject({status:'ready',system:'windows',dir},project);
    assert.equal(r.files,1);assert.deepEqual(fs.readdirSync(path.join(dir,'project-copy')),['source.js']);assert.match(command,/C:\\workspace/);
    assert.equal(fs.readFileSync(path.join(project,'source.js'),'utf8'),'safe');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('console output keeps a running total so a client appends only what is new', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-log-'));
  try {
    const v = new VmManager({ appDir:root,dataDir:root });
    const s = {id:'one',userId:'owner',output:''};
    v.log(s,'a'.repeat(600*1024));v.log(s,'tail');
    assert.equal(s.output.length,512*1024);
    const shot=v.snapshot(s,8);
    assert.equal(shot.output,'aaaatail');assert.equal(shot.outputEnd,600*1024+4);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('stop releases everything even when one step fails, and concurrent stops share one run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-stop-'));
  try {
    const v = new VmManager({ appDir:root,dataDir:root });
    let killed=0,closed=0;
    const proc={exitCode:null,signalCode:null,kill(){killed++;this.exitCode=1;setImmediate(()=>this.handler&&this.handler());},once(_,h){this.handler=h;}};
    const s={id:'one',userId:'owner',status:'ready',output:'',proc,terminalId:'t',bridgeProc:{kill(){killed++;}}};
    const terminals={get(){throw new Error('terminal en panne');},close(){closed++;}};
    const [a,b]=await Promise.allSettled([v.stop(s,terminals),v.stop(s,terminals)]);
    assert.equal(a.status,'rejected');assert.equal(b.status,'rejected');
    assert.equal(killed,2,'QEMU and the bridge are stopped once each despite the terminal failure');
    assert.equal(s.status,'error');assert.match(s.error,/Arrêt incomplet/);
    s.terminalId=null;
    assert.equal((await v.stop(s,terminals)).status,'stopped');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('delete frees the session folder and its exported files; status waits for a starting VM', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-delete-'));
  try {
    const v = new VmManager({ appDir:root,dataDir:root });
    const id='11111111-1111-4111-8111-111111111111',dir=path.join(v.root,id),artifact=path.join(root,'export.bin');
    fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'disk.qcow2'),'disk');fs.writeFileSync(artifact,'data');
    const s={id,userId:'owner',status:'starting',output:'',dir,artifacts:[{id:'a',name:'export.bin',bytes:4,path:artifact}]};
    v.sessions.set(id,s);
    setTimeout(()=>{s.status='ready';},300);
    const started=Date.now(),status=await v.action('owner',{action:'status',id,waitMs:5000});
    assert.equal(status.machine.status,'ready');assert.ok(Date.now()-started<3000);
    await assert.rejects(v.action('owner',{action:'status',id,waitMs:90000}),/waitMs/);
    await assert.rejects(v.action('owner',{action:'exec',id,command:'true',timeoutMs:5}),/timeoutMs/);
    await assert.rejects(v.action('other',{action:'delete',id}),/inconnue/);
    await v.action('owner',{action:'delete',id});
    assert.equal(fs.existsSync(dir),false);assert.equal(fs.existsSync(artifact),false);assert.deepEqual(v.list('owner'),[]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('startup removes folders of sessions whose server is gone and keeps live or recent ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-sweep-'));
  try {
    const base=path.join(root,'virtual-machines');
    const dead=path.join(base,'22222222-2222-4222-8222-222222222222'),live=path.join(base,'33333333-3333-4333-8333-333333333333'),legacy=path.join(base,'44444444-4444-4444-8444-444444444444');
    for(const d of [dead,live,legacy,path.join(base,'templates','keep')])fs.mkdirSync(d,{recursive:true});
    fs.writeFileSync(path.join(dead,'owner.json'),JSON.stringify({pid:2147483646}));
    fs.writeFileSync(path.join(live,'owner.json'),JSON.stringify({pid:process.pid}));
    const v = new VmManager({ appDir:root,dataDir:root });
    await v.sweep();
    assert.equal(fs.existsSync(dead),false);assert.equal(fs.existsSync(live),true);
    assert.equal(fs.existsSync(legacy),true,'a recent folder without an owner record is kept');
    assert.equal(fs.existsSync(path.join(base,'templates','keep')),true);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
