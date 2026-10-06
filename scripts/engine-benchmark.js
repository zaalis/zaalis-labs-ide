'use strict';
// Opt-in live evaluation. No fixture tokens, estimated usage or failed run can
// enter the dashboard comparison ledger. This is one case, not a fleet claim.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {VmManager}=require('../vm-manager'),{Laboratory,fingerprint}=require('../laboratory'),{RustAgentBridge}=require('../rust-agent-bridge'),{recordPair}=require('../engine-comparison');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
async function benchmark({dataDir,user='benchmark',key,model='mistral-small-latest',system='windows'}) {
 if(!key)throw Error('ZAALIS_BENCH_MISTRAL_KEY requis pour un essai réel.');
 if(!['windows','linux'].includes(system))throw Error('Système invalide.');
 const base=path.resolve(__dirname,'..'),work=path.join(dataDir,'benchmark-runs',crypto.randomUUID());fs.mkdirSync(work,{recursive:true});
 const root=path.join(work,'source');fs.mkdirSync(root);const file=system==='windows'?'app.cs':'app.sh';
 fs.writeFileSync(path.join(root,file),system==='windows'?'public class BenchmarkProof { public static string Run() { return "BUG"; } }':"printf 'BUG\\n'\n");
 const command=system==='windows'?"Add-Type -Path .\\app.cs; if ([BenchmarkProof]::Run() -ne 'BENCH_OK') { throw 'wrong result' }; Write-Output VALIDATED":"sh -n app.sh && test \"$(sh app.sh)\" = BENCH_OK && printf VALIDATED";
 const criteriaHash=hash(JSON.stringify({system,command,exit:0,marker:'VALIDATED'})),sourceHash=fingerprint(root).hash,caseId='repair-literal-'+system+'-v1';
 const common={caseId,sourceHash,criteriaHash,model,synthetic:false},runs={};
 for(const mode of ['baseline','candidate']) {
  const modeData=path.join(work,mode),vm=new VmManager({appDir:base,dataDir:modeData}),lab=new Laboratory({dataDir:modeData,vm}),bridge=new RustAgentBridge({baseDir:base,dataDir:modeData}),secret=crypto.randomBytes(32).toString('hex');let exported=null;
  const server=http.createServer(async(req,res)=>{try{if(req.headers.authorization!=='Bearer '+secret)throw Error('Unauthorized');let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);let value;
   if(req.url==='/api/internal/rust-lab'&&mode==='candidate')value=await lab.action(user,input,root);
   else if(req.url==='/api/internal/rust-vm'&&mode==='baseline') {value=await vm.action(user,input,null,root);if(input.action==='export_file'&&value.artifact){const s=vm.get(input.id,user),a=s.artifacts.find(a=>a.id===value.artifact.id);exported=fs.readFileSync(a.path);}}
   else throw Error('Tool not allowed in this benchmark mode');
   res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}});
  const started=Date.now();let result;
  try {
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const guest=system==='windows'?'C:\\workspace':'/home/zaalis/workspace';
   const instruction=`Corrige ${file} : sa sortie doit être BENCH_OK au lieu de BUG. Système ${system}, réseau isolé. Critère obligatoire : ${command}. Projet importé à ${guest}.`;
   const route=mode==='baseline'?`Utilise uniquement vm : créer, attendre ready, import_project, modifier le fichier, exécuter le critère, export_file de ${guest}/${file}, puis arrêter. Ne demande pas de validation hôte.`:`Utilise uniquement laboratory : propose les changements et checks, finalChecks identiques au critère, outputs ["${file}"], maxMs 600000, stratégie economy. Consulte status avec waitMs=30000 jusqu'au résultat. Termine après verified.`;
   result=await bridge.run({userId:user,keys:{mistral:key},root,model:'mistral',submodel:model,permissionMode:'supervised',budget:{max_tokens:60000,max_rounds:30,max_wall_time_ms:900000},runtimeConfig:{workspaceEndpoint:`http://127.0.0.1:${server.address().port}/api/internal/rust-workspace`,workspaceToken:secret},message:instruction+' '+route},event=>{if(event.type==='permission_required')bridge.decide(user,{...event,kind:'permission',allow:false}).catch(()=>{});if(event.type==='budget_required')bridge.decide(user,{...event,kind:'budget',stop:true}).catch(()=>{});});
   if(result.error)throw Error(result.error);
   if(mode==='candidate'){const record=lab.list(user)[0];if(record?.status!=='verified')throw Error('Candidat non vérifié');const a=record.final.artifacts?.find(a=>a.path===file);if(!a)throw Error('Résultat candidat absent');exported=fs.readFileSync(lab.artifact(user,record.id,a.id).file);}
   if(!exported)throw Error('Résultat exporté absent');
   await vm.shutdown();
   // Identical external oracle on a fresh guest for BOTH arms.
   const verifyRoot=path.join(modeData,'oracle');fs.mkdirSync(verifyRoot);fs.writeFileSync(path.join(verifyRoot,file),exported);
   const made=await vm.create(user,{system,network:'isolated'}),s=vm.get(made.id,user);await vm.wait(s,()=>s.status==='ready',200000);await vm.importProject(s,verifyRoot);
   const proof=await vm.exec(s,system==='windows'?`Set-Location C:\\workspace; ${command}`:`cd /home/zaalis/workspace && (${command})`);
   const passed=proof.exitCode===0&&!proof.timedOut&&!proof.transportError&&proof.output.includes('VALIDATED');
   fs.writeFileSync(path.join(modeData,'oracle-evidence.json'),JSON.stringify(proof,null,2));
   const usage=await bridge.usage(user,{},started,Date.now()+1000);
   runs[mode]={...common,input:usage.total.input,output:usage.total.output,measured:usage.total.calls>0&&usage.total.unmeasured===0&&usage.total.unfinished===0,passed,durationMs:Date.now()-started};
   fs.writeFileSync(path.join(modeData,'run.json'),JSON.stringify(runs[mode],null,2));
   if(!passed)throw Error('Oracle externe échoué. Aucune économie enregistrée.');
  }finally{await bridge.close();await lab.shutdown();await vm.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));}
 }
 return {...recordPair(dataDir,user,runs.baseline,runs.candidate),evidence:work};
}
if(require.main===module){if(!process.argv.includes('--run')){console.log('Essai réel, volontaire : ZAALIS_BENCH_MISTRAL_KEY=<clé> node scripts/engine-benchmark.js --run [--linux]. Deux exécutions API facturables ; preuves dans .tmp/engine-benchmark.');}else benchmark({dataDir:path.resolve(process.env.ZAALIS_BENCH_DATA_DIR||'.tmp/engine-benchmark'),user:process.env.ZAALIS_BENCH_USER||'benchmark',key:process.env.ZAALIS_BENCH_MISTRAL_KEY,model:process.env.ZAALIS_BENCH_MODEL||'mistral-small-latest',system:process.argv.includes('--linux')?'linux':'windows'}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={benchmark};
