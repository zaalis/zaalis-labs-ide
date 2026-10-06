'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.ZAALIS_TEST_URL||'http://127.0.0.1:34882',root=path.resolve('.tmp/laboratory-packaged-project');
async function main(){fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(root,'app.cs'),'public class PackagedProof { public static string Run() { return "PACKAGED_OK"; } }');
 const request=async(url,{cookie,body,method='GET'}={})=>{const r=await fetch(base+url,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],body:await r.text()};};
 const login=await request('/api/auth/login',{method:'POST',body:{email:'lab-ui@example.test',password:'local-fixture-only-2026'}});assert.equal(login.status,200);const cookie=login.cookie;
 const email='lab-other-'+Date.now()+'@example.test',second=await request('/api/auth/register',{method:'POST',body:{email,password:'local-fixture-only'}});assert.equal(second.status,200);
 assert.equal((await request('/api/vm/laboratory')).status,401);assert.equal((await request('/api/internal/rust-lab',{method:'POST',body:{action:'list'}})).status,401);
 assert.equal((await request('/api/usage?from=0&to=1',{cookie})).status,200);assert.equal((await request('/api/usage?from=2&to=1',{cookie})).status,400);
 await request('/api/recent-projects',{cookie,method:'PUT',body:{projects:[root]}});
 const command="Add-Type -Path .\\app.cs; if ([PackagedProof]::Run() -ne 'PACKAGED_OK') { throw 'bad' }; Write-Output PACKAGED_OK",plan={action:'run',root,problem:'Preuve du serveur Windows empaqueté',system:'windows',maxMs:600000,hypotheses:[{label:'Compilation C#',checks:[{command,contains:'PACKAGED_OK'}]}],finalChecks:[{command,contains:'PACKAGED_OK'}],outputs:['app.cs']};
 assert.equal((await request('/api/vm/laboratory',{cookie,method:'POST',body:{...plan,finalChecks:[]}})).status,400);
 const created=await request('/api/vm/laboratory',{cookie,method:'POST',body:plan});assert.equal(created.status,200);const id=JSON.parse(created.body).experiment.id;let record;
 for(let i=0;i<24;i++){const r=await request('/api/vm/laboratory',{cookie,method:'POST',body:{action:'status',id,waitMs:30000}});assert.equal(r.status,200);record=JSON.parse(r.body).experiment;if(!['queued','running','verifying'].includes(record.status))break;}
 assert.equal(record.status,'verified',JSON.stringify(record));
 const log=record.final.checks[0].log,a=record.final.artifacts[0],proof=await request(`/api/vm/laboratory/${id}/evidence/${log}`,{cookie});assert.equal(proof.status,200);assert.match(proof.body,/PACKAGED_OK/);
 assert.equal((await request(`/api/vm/laboratory/${id}/evidence/${log}`,{cookie:second.cookie})).status,404);
 assert.equal((await request(`/api/vm/laboratory/${id}/artifacts/${a.id}`,{cookie:second.cookie})).status,404);
 assert.equal((await request(`/api/vm/laboratory/${id}/artifacts/${a.id}`,{cookie})).status,200);
 assert.equal((await request('/api/vm/laboratory',{cookie,method:'POST',body:{action:'apply',id,root}})).status,200);
 const machine=await request('/api/vm/action',{cookie,method:'POST',body:{action:'create',system:'linux',network:'isolated'}});assert.equal(machine.status,200);const vmId=JSON.parse(machine.body).machine.id;let terminal;
 try{let ready=false;for(let i=0;i<120;i++){const status=JSON.parse((await request('/api/vm/action',{cookie,method:'POST',body:{action:'status',id:vmId}})).body).machine;if(status.status==='error')throw Error(status.error);if(status.status==='ready'){ready=true;break;}await new Promise(r=>setTimeout(r,500));}assert.equal(ready,true);
  const opened=await request(`/api/vm/${vmId}/terminal`,{cookie,method:'POST',body:{}});assert.equal(opened.status,200);terminal=JSON.parse(opened.body).id;
  assert.equal((await request(`/api/terminal/sessions/${terminal}`,{cookie:second.cookie})).status,404);
  assert.equal((await request(`/api/terminal/sessions/${terminal}/input`,{cookie,method:'POST',body:{data:"touch /tmp/packaged-terminal-proof; printf 'PACKAGED_%s_%s\\n' PTY OK; uname -s\r"}})).status,200);
  let text='';for(let i=0;i<60;i++){text=JSON.parse((await request(`/api/terminal/sessions/${terminal}`,{cookie})).body).output;if(text.includes('PACKAGED_PTY_OK'))break;await new Promise(r=>setTimeout(r,500));}assert.match(text,/PACKAGED_PTY_OK/);assert.match(text,/Linux/);
  const separate=await request('/api/vm/action',{cookie,method:'POST',body:{action:'exec',id:vmId,command:'test -f /tmp/packaged-terminal-proof && printf SEPARATE_AGENT_OK'}});assert.equal(JSON.parse(separate.body).output,'SEPARATE_AGENT_OK');
  console.log('PACKAGED_REAL_LINUX_PTY_OWNER_SEPARATE_AGENT_PATH_OK');
 }finally{await request('/api/vm/action',{cookie,method:'POST',body:{action:'stop',id:vmId}});}
 fs.writeFileSync(path.resolve('.tmp/laboratory-packaged-evidence.json'),JSON.stringify({id,record,unauthenticatedRejected:true,internalTokenRejected:true,invalidDatesRejected:true,invalidOracleRejected:true,crossUserDownloadsRejected:true,artifactDownloaded:true,apply:true,realPackagedLinuxPty:true,terminalOwnerRejected:true,separateAgentPath:true,root},null,2));
 console.log('PACKAGED_SERVER_REAL_WINDOWS_LAB_AUTH_ARTIFACT_APPLY_OK');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
