'use strict';
const assert=require('assert/strict');
const base=process.env.ZAALIS_VM_URL||'http://127.0.0.1:34881';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function login(email){const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'vm-smoke-fixture-2026'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
async function main(){
 const cookie=await login('vm-multi-'+Date.now()+'@zaalis.local'),other=await login('vm-other-'+Date.now()+'@zaalis.local');
 const call=async(body,cookieValue=cookie)=>{const r=await fetch(base+'/api/vm/action',{method:'POST',headers:{cookie:cookieValue,'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;};
 const sessions=[];
 try{
  for(let i=0;i<2;i++){const result=await call({action:'create',system:'linux',name:'API Linux '+i});sessions.push(result.machine.id);}
  for(const id of sessions){const until=Date.now()+180000;for(;;){const result=await call({action:'status',id});if(result.machine.status==='ready')break;if(result.machine.status==='error')throw new Error(result.machine.error);if(Date.now()>until)throw new Error('VM readiness timeout');await pause(1000);}}
  for(let i=0;i<2;i++){const r=await call({action:'exec',id:sessions[i],command:`printf VM_${i}_ISOLATED > /tmp/marker; cat /tmp/marker`});assert.equal(r.exitCode,0);assert.equal(r.output,`VM_${i}_ISOLATED`);}
  const a=await call({action:'exec',id:sessions[0],command:'cat /tmp/marker'});assert.equal(a.output,'VM_0_ISOLATED');
  await assert.rejects(call({action:'status',id:sessions[0]},other),/inconnue/);
  const net=await call({action:'exec',id:sessions[0],command:'curl --connect-timeout 2 --max-time 3 -s https://example.com'});assert.notEqual(net.exitCode,0);
  console.log('PACKAGED_TWO_LINUX_ISOLATION_OK');console.log('PACKAGED_USER_OWNERSHIP_OK');console.log('PACKAGED_OUTBOUND_NETWORK_DISABLED_OK');
  if(process.argv.includes('--windows')){
    const windows=await call({action:'create',system:'windows'});sessions.push(windows.machine.id);
    const until=Date.now()+150000;for(;;){const r=await call({action:'status',id:windows.machine.id});if(r.machine.status==='ready')break;if(r.machine.status==='error')throw new Error(r.machine.error);if(Date.now()>until)throw new Error('Sandbox readiness timeout');await pause(1000);}
    const fs=require('fs'),path=require('path');const root=path.join(process.cwd(),'.tmp','vm-api-fixture');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'result.txt'),'PACKAGED_WINDOWS_COPY_OK');
    await call({action:'import_project',id:windows.machine.id,root});
    const r=await call({action:'exec',id:windows.machine.id,command:"Get-Content -LiteralPath C:\\workspace\\result.txt"});assert.match(r.output,/PACKAGED_WINDOWS_COPY_OK/);assert.equal(r.exitCode,0);
    const artifact=await call({action:'export_file',id:windows.machine.id,path:'C:\\workspace\\result.txt'});const download=await fetch(base+artifact.artifact.url,{headers:{cookie}});assert.equal(download.status,200);assert.equal(await download.text(),'PACKAGED_WINDOWS_COPY_OK');
    console.log('PACKAGED_WINDOWS_COMMAND_IMPORT_DOWNLOAD_OK');
  }
 } finally {for(const id of sessions)await call({action:'stop',id});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
