'use strict';
// Opt-in live smoke test. Reads existing local credentials in memory, uses an
// isolated account/project and never refreshes or changes the installed account.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {spawn}=require('node:child_process');const {once}=require('node:events');
const repo=path.resolve(__dirname,'../..');
const source=process.env.ZAALIS_LIVE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'zaalis','server-data');
const output=path.join(repo,'.tmp',process.env.ZAALIS_LIVE_DYNAMIC==='1'?'skills-live-background.json':'skills-live-results.json');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report=[];
let child,temp;
const decode=(key,blob)=>{const [iv,data,tag]=blob.split('.').map(v=>Buffer.from(v,'base64'));const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(data),d.final()]).toString();};
const encode=(key,text)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const enc=Buffer.concat([c.update(text),c.final()]);return [iv,enc,c.getAuthTag()].map(b=>b.toString('base64')).join('.');};
async function main(){
 const users=JSON.parse(fs.readFileSync(path.join(source,'users.json'),'utf8'));
 const selected=users.find(u=>u.apiKeys?.mistral||u.chatgptAuth);
 if(!selected)throw Error('Aucun accès Mistral ou ChatGPT configuré.');
 const key=crypto.scryptSync(fs.readFileSync(path.join(source,'secret'),'utf8'),'zaalis-api-key-vault',32);
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-live-skills-'));
 const project=path.join(temp,'project'),data=path.join(temp,'data');fs.mkdirSync(project);fs.mkdirSync(data);
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'reverse-fixture',main:'index.js',type:'commonjs'}));
 fs.writeFileSync(path.join(project,'math.js'),'exports.total = (price, quantity) => price * quantity;\n');
 fs.writeFileSync(path.join(project,'index.js'),"const { total } = require('./math');\nconsole.log(total(7, 6));\n");
 fs.writeFileSync(path.join(project,'server.js'),"const http = require('http');\nconst server = http.createServer((req,res) => res.end('ZAALIS_BACKGROUND_OK'));\nserver.listen(0, '127.0.0.1', () => console.log('READY', server.address().port));\n");
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 child=spawn(process.execPath,['src/app/server.js'],{cwd:repo,windowsHide:true,stdio:'ignore',env:{...process.env,ZAALIS_PORT:String(port),ZAALIS_DATA_DIR:data}});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<160;i++){try{if((await fetch(base)).ok)break;}catch{}await pause(50);}
 const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'live-skills@example.test',password:crypto.randomBytes(20).toString('hex')})});
 const headers={'Content-Type':'application/json',cookie:registration.headers.get('set-cookie').split(';')[0]};
 const file=path.join(data,'users.json'),testUsers=JSON.parse(fs.readFileSync(file,'utf8')),target=testUsers[0];
 const targetKey=crypto.scryptSync(fs.readFileSync(path.join(data,'secret'),'utf8'),'zaalis-api-key-vault',32);
 target.apiKeys={};
 if(selected.apiKeys?.mistral)target.apiKeys.mistral=encode(targetKey,decode(key,selected.apiKeys.mistral));
 if(selected.chatgptAuth){const session=JSON.parse(decode(key,selected.chatgptAuth));session.refreshToken='';session.expiresAt=0;target.chatgptAuth=encode(targetKey,JSON.stringify(session));}
 fs.writeFileSync(file,JSON.stringify(testUsers));
 const models=[{label:'Mistral',model:'mistral',submodel:'mistral-small-latest',available:!!target.apiKeys.mistral},{label:'GPT Luna',model:'compat:chatgpt',submodel:'gpt-6-luna',available:!!target.chatgptAuth}];
 for(const model of models){
  if(process.env.ZAALIS_LIVE_MODELS && !process.env.ZAALIS_LIVE_MODELS.split(',').includes(model.label))continue;
  if(!model.available){report.push({model:model.label,status:'unavailable'});continue;}
  const started=Date.now();
  const observedTools=[];
  try{
   const dynamic=process.env.ZAALIS_LIVE_DYNAMIC==='1';
   const prompt=dynamic ? '/revers --dynamic Test explicitement autorisé sur ce petit serveur de validation créé pour cette tâche. Lis server.js, démarre node server.js en arrière-plan avec process start, interroge ses logs avec process poll pour vérifier READY, puis arrête ce seul processus avec process kill. N’utilise ni sous-agent ni recherche web ni VM. Ne termine pas avant d’avoir arrêté ton processus. Rends un mini rapport de 100 mots avec les preuves.' : '/revers Analyse uniquement package.json, index.js et math.js avec les outils read. Explique leur relation et la valeur affichée, avec chemins et preuves. Réponse finale de 150 mots maximum. Ne lance pas de sous-agent et ne fais pas de recherche web.';
   const answer=await fetch(base+'/api/agent-chat',{method:'POST',headers:{...headers,Accept:'application/x-ndjson'},signal:AbortSignal.timeout(180000),body:JSON.stringify({model:model.model,submodel:model.submodel,root:project,permissionMode:dynamic?'auto':'read-only',message:prompt})});
   let buffer='',result={};
   async function event(line){
    if(!line.trim())return;const item=JSON.parse(line);
    if(item.type==='done')result=item.result||{};
    if(item.type==='error')result.error=item.error;
    if(item.type==='tool_started'||item.type==='tool_done'){
     const observation={event:item.type,tool:item.tool,action:item.input?.action,error:item.error,blocked:item.blocked};
     observedTools.push(observation);console.log(JSON.stringify(observation));
    }
    if(item.type==='permission_required'){
     const allow=dynamic && (item.target==='node server.js'||/^process (kill|poll|remove) /.test(item.target||''));
     console.log(JSON.stringify({event:item.type,allowedFixtureAction:allow,target:item.target}));
     await fetch(base+'/api/rust-core/decision',{method:'POST',headers,body:JSON.stringify({sessionId:item.sessionId,requestId:item.requestId,kind:'permission',allow,scope:'once'})});
    }
    if(['plan_required','budget_required'].includes(item.type))throw Error('Unexpected interactive decision: '+item.type);
   }
   for await(const chunk of answer.body){buffer+=Buffer.from(chunk).toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);await event(line);}}
   if(buffer.trim())await event(buffer);
   const tools=(result.toolResults||[]).map(r=>({tool:r.tool,action:r.input?.action,error:!!r.error,blocked:!!r.blocked,summary:r.summary}));
   const verified=dynamic ? tools.some(r=>r.tool==='process'&&r.action==='start'&&!r.error)&&tools.some(r=>r.tool==='process'&&r.action==='kill'&&!r.error) : /42|quarante.deux/.test(result.response||'')&&tools.some(r=>r.tool==='read'&&!r.error);
   report.push({model:model.label,modelId:model.submodel,scenario:dynamic?'background-process':'static-reverse',status:result.error?'failed':verified?'passed':'incomplete',http:answer.status,durationMs:Date.now()-started,tools,response:result.response||'',error:result.error||null});
  }catch(e){report.push({model:model.label,modelId:model.submodel,status:'failed',durationMs:Date.now()-started,observedTools,error:e.name==='TimeoutError'?'Timeout 180s':e.message});}
  console.log(JSON.stringify(report.at(-1)));
 }
}
main().catch(e=>{report.push({status:'setup_failed',error:e.message});process.exitCode=1;}).finally(async()=>{
 if(child?.exitCode===null){child.kill();await once(child,'exit');}
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),results:report},null,2));
 if(report.some(item=>item.status!=='passed'))process.exitCode=1;
 // Remove only the verified temporary workspace created above.
 if(temp&&path.dirname(temp)===os.tmpdir()&&path.basename(temp).startsWith('zaalis-live-skills-'))for(let i=0;i<30;i++){try{fs.rmSync(temp,{recursive:true,force:true});break;}catch{await pause(100);}}
});
