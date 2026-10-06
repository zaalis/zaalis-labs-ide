const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Laboratory,fingerprint}=require('../laboratory');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('integration rejects stale project and corrupt artifacts; saves rollback bytes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lab-artifact-')),project=path.join(root,'project');fs.mkdirSync(project);const target=path.join(project,'a.txt');fs.writeFileSync(target,'old');const lab=new Laboratory({dataDir:root,vm:{}});
 const id=crypto.randomUUID(),artifactId=crypto.randomUUID(),artifact={id:artifactId,path:'a.txt',bytes:3,sha256:hash('new'),baseHash:hash('old')};
 const r={id,project,fingerprint:fingerprint(project).hash,status:'verified',attempts:[],final:{artifacts:[artifact]}};lab.save('a',r);const file=path.join(lab.dir('a'),artifactId+'.artifact');fs.writeFileSync(file,'new');
 try{assert.throws(()=>lab.apply('b',id,project),/inconnue/);fs.writeFileSync(target,'changed');assert.throws(()=>lab.apply('a',id,project),/changé/);fs.writeFileSync(target,'old');fs.writeFileSync(file,'bad');assert.throws(()=>lab.apply('a',id,project),/preuve/);fs.writeFileSync(file,'new');
 lab.apply('a',id,project);assert.equal(fs.readFileSync(target,'utf8'),'new');assert.equal(fs.readFileSync(path.join(lab.dir('a'),id+'.backup','0'),'utf8'),'old');assert.equal(lab.get('a',id).applied.hostRetested,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('integration rejects a junction parent and never changes its external target',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lab-link-')),project=path.join(root,'project'),external=path.join(root,'external');fs.mkdirSync(project);fs.mkdirSync(external);
 fs.symlinkSync(external,path.join(project,'linked'),process.platform==='win32'?'junction':'dir');const lab=new Laboratory({dataDir:root,vm:{}}),id=crypto.randomUUID(),artifactId=crypto.randomUUID();
 const r={id,project,fingerprint:fingerprint(project).hash,status:'verified',attempts:[],final:{artifacts:[{id:artifactId,path:'linked/a.txt',sha256:hash('new'),baseHash:null}]}};lab.save('a',r);fs.writeFileSync(path.join(lab.dir('a'),artifactId+'.artifact'),'new');
 try{assert.throws(()=>lab.apply('a',id,project),/non sûr/);assert.equal(fs.existsSync(path.join(external,'a.txt')),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
