'use strict';
// Real server/daemon + a local scripted provider; no personal account/model call.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-memory-terminal-'));
const project=path.join(temp,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'bug.txt'),'broken');
let server, provider, seen=[], transcript='';
const packaged=process.env.ZAALIS_TEST_PACKAGED==='1';
async function main(){
  provider=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    if(req.method==='GET'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'fixture'}]}));}
    const body=JSON.parse(raw);seen.push(body);const messages=body.messages||[],index=messages.findLastIndex(m=>m.role==='user'),current=String(messages[index]?.content),results=messages.slice(index+1).filter(m=>m.role==='tool');
    const fix=current.includes('Fix unique regression');
    const tool=fix?results.length===0?{name:'write',arguments:JSON.stringify({path:'bug.txt',content:'fixed'})}:results.length===1?{name:'run',arguments:JSON.stringify({command:'node --check bug.txt',timeout_ms:10000})}:null:null;
    // .txt syntax check intentionally fails. First classify as attempted, then
    // repeat using a successful real Node check of an actual JS fixture.
    if(tool?.name==='run')tool.arguments=JSON.stringify({command:'node --check check.js',timeout_ms:10000});
    res.setHeader('content-type','text/event-stream');
    const delta=tool?{tool_calls:[{index:0,id:'call_'+seen.length,type:'function',function:tool}]}:{content:'Correction: recorder owned by session.'};
    res.write('data: '+JSON.stringify({choices:[{index:0,delta}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');
  });await new Promise(r=>provider.listen(0,'127.0.0.1',r));fs.writeFileSync(path.join(project,'check.js'),'const value = 1;');
  const port=36500+Math.floor(Math.random()*400),base='http://127.0.0.1:'+port;
  const env={...process.env,ZAALIS_PORT:String(port),ZAALIS_DATA_DIR:path.join(temp,'data'),ZAALIS_CLI_CONFIG_DIR:path.join(temp,'cli'),ZAALIS_RUST_CORE:'on'};
  server=spawn(packaged?path.join(root,'native/dist/zaalis-server.exe'):process.execPath,packaged?[]:['server.js'],{cwd:root,env,windowsHide:true,stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'memory-test@zaalis.local',password:'password123'})});assert.equal(registration.status,200);
  const cookie=registration.headers.get('set-cookie').split(';')[0],headers={cookie,'content-type':'application/json'};
  await fetch(base+'/api/compat/keys',{method:'PUT',headers,body:JSON.stringify({keys:{custom:'fixture-token'},baseUrls:{custom:'http://127.0.0.1:'+provider.address().port+'/v1'}})});
  async function run(message){const response=await fetch(base+'/api/agent-chat',{method:'POST',headers,body:JSON.stringify({root:project,model:'compat:custom',submodel:'fixture',message,permissionMode:'auto'})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.error,undefined);return result;}
  const first=await run('Fix unique regression');assert.equal(first.memorySaved?.status,'verified',JSON.stringify(first));assert.equal(fs.readFileSync(path.join(project,'bug.txt'),'utf8'),'fixed');
  await run('Explain unique regression');assert.ok(seen.at(-1).messages.some(m=>String(m.content).includes('EXPÉRIENCES MÉMORISÉES')));
  fs.mkdirSync(env.ZAALIS_CLI_CONFIG_DIR);fs.writeFileSync(path.join(env.ZAALIS_CLI_CONFIG_DIR,'session.json'),JSON.stringify({cookie,model:'compat:custom',submodel:'fixture',permissionMode:'read-only'}));
  async function cli(args){const child=spawn(packaged?path.join(root,'native/dist/zaalis-terminal.exe'):process.execPath,packaged?args:[path.join(root,'cli.js'),...args],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>text+=c);const code=await new Promise(r=>child.on('exit',r));assert.equal(code,0,text);transcript+=text;return text;}
  const models=await cli(['models']);for(const label of ['ChatGPT (abonnement)','Grok / xAI (abonnement)','MiniMax (abonnement)'])assert.ok(models.includes(label),models);
  if(packaged){
    const pty=require('node-pty');
    const terminal=pty.spawn('powershell.exe',['-NoProfile','-Command',"& '"+path.join(root,'native/dist/zaalis-terminal.exe').replaceAll("'","''")+"'"],{cwd:project,env,cols:140,rows:40});
    let screen='';const listener=terminal.onData(data=>screen+=data);
    try {
      async function waitFor(pattern){for(let i=0;i<150;i++){if(pattern.test(screen))return;await new Promise(r=>setTimeout(r,50));}throw new Error('TTY output missing '+pattern+' : '+screen.slice(-3000));}
      await waitFor(/Ecrivez votre message|Écrivez votre message/);
      terminal.write('/models\r');await new Promise(r=>setTimeout(r,150));terminal.write('\r');
      await waitFor(/MiniMax \(abonnement\)/);
      terminal.write('/exit\r');await new Promise(r=>setTimeout(r,150));terminal.write('\r');
      console.log('PowerShell TTY OK: interactive composer and subscription catalogue.');
    }finally{listener.dispose();terminal.kill();}
  }
  assert.match(await cli(['memory']),/Fix unique regression/);
  await cli(['-p','Explain unique regression']);assert.ok(seen.at(-1).messages.some(m=>String(m.content).includes('EXPÉRIENCES MÉMORISÉES')));
  await cli(['memory','off']);const before=seen.length;await run('Explain unique regression');assert.ok(!seen[before].messages.some(m=>String(m.content).includes('EXPÉRIENCES MÉMORISÉES')));
  console.log('Memory + terminal OK: real Rust correction/check, automatic recall across new chats/CLI, subscription catalogue, project opt-out.');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
  if(server){server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));}
  if(provider)await new Promise(r=>provider.close(r));
  assert.ok(path.dirname(temp)===os.tmpdir()&&path.basename(temp).startsWith('zaalis-memory-terminal-'));
  for(let i=0;i<40;i++){try{fs.rmSync(temp,{recursive:true,force:true});break;}catch{await new Promise(r=>setTimeout(r,100));}}
});
