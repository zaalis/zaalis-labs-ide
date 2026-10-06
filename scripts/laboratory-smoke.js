'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {VmManager}=require('../vm-manager');const {Laboratory}=require('../laboratory');
const base=path.resolve(__dirname,'..'),data=path.join(base,'.tmp','laboratory-real-'+Date.now());fs.mkdirSync(data,{recursive:true});
const vm=new VmManager({appDir:process.env.ZAALIS_VM_APP_DIR||base,dataDir:data}),lab=new Laboratory({dataDir:data,vm});
async function main(){
 const evidence=[];
 const systems=process.argv.slice(2).filter(x=>!x.startsWith('--'));
 for(const system of process.argv.includes('--templates-only')?[]:systems.length?systems:['linux','windows']){
  const root=path.join(data,system);fs.mkdirSync(root);const file=system==='linux'?'app.sh':'app.cs';
  const initial=system==='linux'?"printf 'BUG\\n'\n":'public class LabProof { public static string Run() { return "BUG"; } }';fs.writeFileSync(path.join(root,file),initial);fs.writeFileSync(path.join(root,'.env'),'EXCLUDED_SECRET');
  const command=system==='linux'?"test ! -e .env && sh -n app.sh && test \"$(sh app.sh)\" = 'LAB_PROOF_OK' && printf 'VALIDATED\\n'":"if (Test-Path .env) { throw 'excluded file leaked' }; Add-Type -Path .\\app.cs; if ([LabProof]::Run() -ne 'LAB_PROOF_OK') { throw 'wrong output' }; Write-Output VALIDATED";
  const change=marker=>system==='linux'?`printf "printf '${marker}\\\\n'\\n" > app.sh`:`Set-Content -LiteralPath .\\app.cs -Value 'public class LabProof { public static string Run() { return "${marker}"; } }'`;
  const plan={problem:'Compilation et résultat réel '+system,system,maxMs:600000,hypotheses:[{label:'Candidat incorrect',changes:[change('WRONG')],checks:[{command,contains:'VALIDATED'}]},{label:'Correction exacte',changes:[change('LAB_PROOF_OK')],checks:[{command,contains:'VALIDATED'}]},{label:'Inutile',checks:[{command:'exit 99'}]}],finalChecks:[{command,contains:'VALIDATED'}],outputs:[file]};
  const created=await lab.create('smoke',plan,root);await lab.active.get(created.id).promise;const r=lab.get('smoke',created.id);
  assert.equal(r.status,'verified',JSON.stringify(r));assert.equal(r.attempts.length,2);assert.equal(r.attempts[0].status,'refuted');assert.equal(r.final.status,'passed');assert.notEqual(r.final.machine,r.attempts[1].machine);
  assert.equal(fs.readFileSync(path.join(root,file),'utf8'),initial);const artifact=lab.artifact('smoke',r.id,r.final.artifacts[0].id);assert.match(fs.readFileSync(artifact.file,'utf8'),/LAB_PROOF_OK/);
  assert.throws(()=>lab.artifact('other',r.id,r.final.artifacts[0].id),/inconnue/);const restarted=new Laboratory({dataDir:data,vm});assert.equal(restarted.get('smoke',r.id).status,'verified');
  lab.apply('smoke',r.id,root);assert.match(fs.readFileSync(path.join(root,file),'utf8'),/LAB_PROOF_OK/);assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'EXCLUDED_SECRET');
  evidence.push({system,id:r.id,status:r.status,attempts:r.attempts.map(a=>({label:a.label,status:a.status,checks:a.checks})),final:r.final,sourcePreservedUntilApply:true,ownership:true,restored:true});
  console.log(system.toUpperCase()+'_LAB_COMPILE_ASSERT_RETEST_ARTIFACT_APPLY_OK');
 }
 if(process.argv.includes('--cases-only')){fs.writeFileSync(path.join(data,'evidence.json'),JSON.stringify(evidence,null,2));console.log('EVIDENCE='+path.join(data,'evidence.json'));return;}
 // Real guest timeout, reusable environment and fresh SSH identity on clones.
 const made=await vm.create('smoke',{system:'linux',name:'Prepared fixture'}),s=vm.get(made.id,'smoke');
 await vm.wait(s,()=>s.status==='ready',200000);
 await vm.exec(s,'printf PREPARED_TEMPLATE > ~/prepared-marker');const template=await vm.templates.save('smoke',s,vm);assert.throws(()=>vm.templates.get('other',template.id),/inconnu/);
 const clone=await vm.create('smoke',{system:'linux',templateId:template.id}),c=vm.get(clone.id,'smoke');
 try{await vm.wait(c,()=>c.status==='ready',200000);const r=await vm.exec(c,'cat ~/prepared-marker');assert.equal(r.output,'PREPARED_TEMPLATE');const timeout=await vm.exec(c,'sleep 10',{timeoutMs:300});assert.equal(timeout.timedOut,true);assert.equal(timeout.exitCode,124);console.log('LINUX_TEMPLATE_CLONE_TIMEOUT_OK');evidence.push({templateClone:true,timeout});}
 finally{await vm.stop(c);}
 fs.writeFileSync(path.join(data,'evidence.json'),JSON.stringify(evidence,null,2));console.log('EVIDENCE='+path.join(data,'evidence.json'));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await lab.shutdown();await vm.shutdown();});
