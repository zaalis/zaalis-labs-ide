const test=require('node:test'),assert=require('node:assert/strict');const {compareRuns}=require('../engine-comparison');
const run={caseId:'one',sourceHash:'source',criteriaHash:'oracle',model:'fixed',input:1000,output:200,durationMs:3000,measured:true,passed:true};
test('measured comparisons preserve overruns and require equivalent successful runs',()=>{
 let r=compareRuns(run,{...run,input:800});assert.equal(r.saved,200);assert.equal(r.percent,200/1200*100);
 r=compareRuns(run,{...run,input:2000});assert.equal(r.saved,-1000);assert.ok(r.percent<0);
 for(const change of [{model:'different'},{sourceHash:'other'},{criteriaHash:'other'},{synthetic:true},{passed:false},{measured:false},{input:-1}])assert.throws(()=>compareRuns(run,{...run,...change}));
 assert.equal(compareRuns({...run,input:0,output:0},{...run,input:0,output:0}).percent,null);
});
test('paired ledger persists by owner and excludes damaged or synthetic references',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{recordPair,comparisonSummary}=require('../engine-comparison');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lab-pairs-'));try{
  const saved=recordPair(root,'owner',run,{...run,input:800});const data=comparisonSummary(root,'owner',0,Date.now()+1000);assert.equal(data.count,1);assert.equal(data.saved,200);assert.equal(comparisonSummary(root,'other',0,Date.now()+1000).count,0);
  assert.throws(()=>recordPair(root,'owner',run,{...run,synthetic:true}));fs.writeFileSync(path.join(path.dirname(saved.file),crypto.randomUUID()+'.json'),'broken');
  assert.equal(comparisonSummary(root,'owner',0,Date.now()+1000).rejected,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
