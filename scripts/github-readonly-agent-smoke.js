'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-github-readonly-')),project=path.join(temp,'project'),data=path.join(temp,'data');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'marker.txt'),'unchanged');
execFileSync('git',['init',project],{windowsHide:true,stdio:'ignore'});execFileSync('git',['-C',project,'remote','add','origin','https://github.com/fixture/project.git'],{windowsHide:true,stdio:'ignore'});
let count=0,child;
const provider=http.createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
 const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks)),messages=body.messages||[],idx=messages.findLastIndex(m=>m.role==='user');const answer=messages.slice(idx+1).some(m=>m.role==='tool');
 const commands={read:{name:'read',arguments:'{"path":"marker.txt"}'},write:{name:'write',arguments:'{"path":"marker.txt","content":"changed"}'},run:{name:'run',arguments:'{"command":"echo changed > marker.txt"}'},artifact:{name:'workspace',arguments:'{"action":"create_artifact","format":"csv","name":"proof.csv","rows":[["changed"]]}'},push:{name:'workspace',arguments:'{"action":"github","input":{"action":"push","repo":"fixture/project","branch":"main"}}'}};
 const command=commands[String(messages[idx]?.content).split('\n').at(-1)];const delta=!answer&&command?{tool_calls:[{index:0,id:'call_'+(++count),type:'function',function:command}]}:{content:'Terminé.'};
 res.setHeader('content-type','text/event-stream');res.write(`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`);res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:!answer&&command?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\n`);res.end('data: [DONE]\n\n');
});
async function main(){
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const port=36500+Math.floor(Math.random()*200),base=`http://127.0.0.1:${port}`;
 const packaged=process.argv.includes('--packaged');child=spawn(packaged?path.join(root,'native/dist/zaalis-server.exe'):process.execPath,packaged?[]:['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ZAALIS_PORT:String(port),ZAALIS_DATA_DIR:data}});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'readonly@zaalis.local',password:'password123'})});assert.equal(registration.status,200);const headers={cookie:registration.headers.get('set-cookie').split(';')[0],'content-type':'application/json'};
 const users=JSON.parse(fs.readFileSync(path.join(data,'users.json')));users[0].github={login:'fixture',token:'',permissions:{'fixture/project':{mode:'read',root:fs.realpathSync(project).toLowerCase(),id:123}}};fs.writeFileSync(path.join(data,'users.json'),JSON.stringify(users));
 const set=await fetch(base+'/api/compat/keys',{method:'PUT',headers,body:JSON.stringify({keys:{custom:'sk-fixture-readonly-0123456789'},baseUrls:{custom:`http://127.0.0.1:${provider.address().port}/v1`}})});assert.equal(set.status,200);
 let session;const results=[];
 for(const action of ['read','write','run','artifact','push']){const response=await fetch(base+'/api/agent-chat',{method:'POST',headers,body:JSON.stringify({model:'compat:custom',submodel:'fixture',permissionMode:'auto',message:action,root:project,sessionId:session})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));session=result.sessionId;const outcome=result.toolResults.at(-1);assert.ok(outcome,JSON.stringify(result));if(action==='read')assert.ok(outcome.text.includes('unchanged'));else assert.equal(outcome.blocked,true,JSON.stringify(outcome));assert.equal(fs.readFileSync(path.join(project,'marker.txt'),'utf8'),'unchanged');results.push({action,blocked:!!outcome.blocked});}
 assert.equal(fs.existsSync(path.join(project,'artifacts/proof.csv')),false);
 const usage=await(await fetch(base+`/api/usage?from=${Date.now()-86400000}&to=${Date.now()+1000}`,{headers})).json();assert.ok(usage.profile.total>0,JSON.stringify(usage));assert.equal(usage.profile.activeDays,1);assert.equal(usage.profile.currentStreak,1);
 console.log(JSON.stringify({status:'passed',packaged,results,lifetime:usage.profile.total,immutable:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{child?.kill();await new Promise(r=>provider.close(r));});
