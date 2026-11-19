'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('skills and Daybreak flow through the real HTTP adapter and Rust tool runtime', {timeout:60000}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-skills-runtime-'));
  const project = path.join(temp,'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'fixture.js'),'export const answer = 42;\n');
  const seen=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw||'{}');seen.push({url:req.url,body});
    if(body.access_programs?.cyber==='daybreak_red') {res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{code:'access_program_not_enabled',message:'Daybreak Red requires project approval'}}));}
    res.setHeader('Content-Type','text/event-stream');
    const send=event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const answered=body.input?.some(item=>item.type==='function_call_output');
    if(!answered) {
      send({type:'response.output_item.done',output_index:0,item:{type:'function_call',id:'fc_read',call_id:'call_read',name:'read',arguments:'{"path":"fixture.js"}'}});
    } else {
      send({type:'response.output_text.delta',delta:'fixture.js exports answer = 42. Evidence: fixture.js:1.'});
    }
    send({type:'response.completed',response:{model:body.model,access_programs:body.access_programs,usage:{input_tokens:50,output_tokens:20}}});res.end();
  });
  const upstreamPort=await listen(upstream);
  const portServer=http.createServer();const port=await listen(portServer);await new Promise(resolve=>portServer.close(resolve));
  const child=spawn(process.execPath,['src/app/server.js'],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:'ignore',env:{...process.env,ZAALIS_PORT:String(port),ZAALIS_DATA_DIR:path.join(temp,'data'),ZAALIS_OPENAI_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`}});
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false;
    for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await wait(50);}
    assert.ok(ready);
    assert.equal((await fetch(base+'/api/skills')).status,401);
    const register=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'skills-runtime@example.test',password:'test-password123'})});
    const headers={'Content-Type':'application/json',cookie:register.headers.get('set-cookie').split(';')[0]};
    const api=async(url,method='GET',body)=>{const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
    const query='?root='+encodeURIComponent(project);
    assert.deepEqual((await api('/api/skills'+query)).data.skills.filter(s=>s.scope==='builtin').map(s=>s.name),['pentest','revers']);
    assert.equal((await api('/api/skills','POST',{instructions:'---\nname: review\ndescription: Review\n---\n# Steps\nRead fixture.js.'})).status,201);
    assert.equal((await api('/api/skills','POST',{instructions:'---\nname: ../outside\n---\nBad'})).status,400);
    await api('/api/keys','PUT',{keys:{openai:'sk-runtime-fake-only'}});
    const chat={model:'codex',submodel:'gpt-6-luna',root:project,message:'/revers Analyse fixture.js avec preuves.',permissionMode:'auto'};
    const result=await api('/api/agent-chat','POST',chat);
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.ok(!result.data.error,JSON.stringify(result.data));
    assert.match(result.data.response,/42/);
    assert.ok(result.data.toolResults.some(r=>r.tool==='read'));
    assert.match(seen[0].body.instructions,/SKILL EXPLICITEMENT DEMANDÉE : revers/);
    assert.deepEqual(seen[0].body.access_programs,{cyber:'standard'});
    assert.equal(seen[0].body.model,'gpt-6-luna');
    await api('/api/skills/revers'+query,'PUT',{enabled:false});
    assert.equal((await api('/api/agent-chat','POST',chat)).status,409);
    await api('/api/skills/revers'+query,'PUT',{enabled:true});
    await api('/api/openai/access','PUT',{program:'daybreak_blue'});
    const blue=await api('/api/agent-chat','POST',{...chat,submodel:'gpt-6-sol'});
    assert.ok(!blue.data.error,JSON.stringify(blue.data));
    assert.equal((await api('/api/openai/access')).data.lastRequest.applied,'daybreak_blue');
    assert.equal((await api('/api/openai/access','PUT',{program:'unlock'})).status,400);
    await api('/api/openai/access','PUT',{program:'daybreak_red'});
    const count=seen.length;
    const red=await api('/api/chat','POST',{...chat,submodel:'gpt-daybreak-red-latest',message:'Inspect'});
    assert.match(red.data.error,/approval/);
    assert.equal(seen.length,count+1,'Daybreak refusal is not retried with standard safeguards');
    assert.equal((await api('/api/openai/access')).data.lastRequest.status,'failed','a refused request does not leave an old successful status visible');
    assert.equal((await api('/api/internal/openai/v1/chat/completions','POST',{})).status,401);
  } finally {
    if(child.exitCode===null){child.kill();await once(child,'exit');}
    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    for(let i=0;i<30;i++){try{fs.rmSync(temp,{recursive:true,force:true});break;}catch{await wait(100);}}
  }
});
