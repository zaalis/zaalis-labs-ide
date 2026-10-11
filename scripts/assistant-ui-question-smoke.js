'use strict';
// Companion to ZAALIS_SMOKE_KEEP=1. Answer its question in the local test UI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function main(){
  const context=JSON.parse(fs.readFileSync(path.join(__dirname,'../.assistant-smoke-context.json'),'utf8'));
  const login=await fetch(context.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:context.email,password:context.password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await fetch(context.base+'/api/agent-chat',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({root:context.root,model:'compat:custom',submodel:'fixture',message:'PARITY_SHARED UI validation',permissionMode:'auto',stream:true}),signal:AbortSignal.timeout(180000)});
  let buffer='',question=false,result;for await(const chunk of response.body){buffer+=Buffer.from(chunk).toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='question_required'){question=true;console.log('Awaiting the answer in the test IDE.');}if(event.type==='done')result=event.result;if(event.type==='error')throw Error(event.error);}}
  assert.ok(question);assert.equal(result.response,'PARITY_COMPLETE');assert.equal(result.error,undefined);assert.ok(result.toolResults.some(t=>t.tool==='clarify'&&String(t.text).includes('Proceed')));console.log('IDE structured question answered and real agent resumed.');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
