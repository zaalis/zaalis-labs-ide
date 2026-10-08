'use strict';
// Bounded real ChatGPT subscription check. Personal stores remain untouched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),source=process.env.ZAALIS_ACCOUNT_SOURCE||path.join(process.env.LOCALAPPDATA,'zaalis','server-data');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-luna-smoke-')),data=path.join(temp,'data'),root=path.join(temp,'project');fs.mkdirSync(data);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'hello.txt'),'Zaalis Luna fixture.');let server,log='';
async function main(){
  const owner=JSON.parse(fs.readFileSync(path.join(source,'users.json'))).find(u=>u.chatgptAuth);if(!owner)throw Error('No existing ChatGPT subscription account found.');
  const secret=fs.readFileSync(path.join(source,'secret'),'utf8');fs.writeFileSync(path.join(data,'secret'),secret,{mode:0o600});
  const user={...owner,apiKeys:{},accountAuth:{},mcpServers:[],brainMcp:false,opale:{connected:false},blender:{connected:false},github:undefined,messengers:undefined,recentProjects:[],permissionMode:'auto'};
  fs.writeFileSync(path.join(data,'users.json'),JSON.stringify([user]),{mode:0o600});
  const cookie='zaalis_session='+user.id+'.'+crypto.createHmac('sha256',secret).update(user.id).digest('hex');
  const port=38900+Math.floor(Math.random()*100),base='http://127.0.0.1:'+port;
  server=spawn(process.execPath,[path.join(repo,'server.js')],{cwd:repo,env:{...process.env,ZAALIS_PORT:String(port),ZAALIS_DATA_DIR:data,ZAALIS_RUST_CORE:'on'},windowsHide:true,stdio:['ignore','pipe','pipe']});server.stdout.on('data',v=>log=(log+v).slice(-4000));server.stderr.on('data',v=>log=(log+v).slice(-4000));
  for(let n=0;n<150;n++){try{if((await fetch(base)).ok)break;}catch{}if(server.exitCode!==null)throw Error('Test server failed.');await new Promise(r=>setTimeout(r,50));}
  const headers={cookie,'Content-Type':'application/json'};
  const status=await (await fetch(base+'/api/chatgpt/status',{headers})).json();assert.equal(status.connected,true,'Existing subscription is not connected.');
  const catalogue=await (await fetch(base+'/api/assistant/catalog?root='+encodeURIComponent(root),{headers})).json();assert.ok(catalogue.tools.length>130);
  if(process.env.ZAALIS_LUNA_CLI_ONLY==='1') {
    const config=path.join(temp,'cli');fs.mkdirSync(config);fs.writeFileSync(path.join(config,'session.json'),JSON.stringify({cookie,model:'compat:chatgpt',submodel:'gpt-6-luna',permissionMode:'read-only'}),{mode:0o600});
    await fetch(base+'/api/assistant/manage/memory',{method:'POST',headers,body:JSON.stringify({root,input:{action:'add',text:'LUNA_CLI_PARITY fixture note'}})});
    const args=['-p',"Test borné : utilise tool_call pour memory action='search', query='LUNA_CLI_PARITY'. Si une note est réellement trouvée, réponds seulement LUNA_CLI_OK. Aucun autre outil ni modification."],output=[];
    const child=spawn(path.join(repo,'native/dist/zaalis-terminal.exe'),args,{cwd:root,env:{...process.env,ZAALIS_PORT:String(port),ZAALIS_CLI_CONFIG_DIR:config},windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>output.push(v));child.stderr.on('data',v=>output.push(v));
    const exit=await new Promise(resolve=>child.on('exit',resolve)),response=Buffer.concat(output).toString();assert.equal(exit,0,response);assert.match(response,/LUNA_CLI_OK/);
    const proof={status:'passed',provider:'ChatGPT subscription',model:'gpt-6-luna',surface:'packaged terminal',response:response.trim(),personalStores:'unchanged'};fs.mkdirSync(path.join(repo,'reports'),{recursive:true});fs.writeFileSync(path.join(repo,'reports','assistant-luna-cli-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));return;
  }
  const request={root,model:'compat:chatgpt',submodel:'gpt-6-luna',permissionMode:'auto',stream:true,reasoningLevel:1,message:"Test fonctionnel borné de Zaalis dans ce dossier temporaire. Appelle tool_search avec query='memory' ; tool_describe pour memory et execute_code ; tool_call pour memory action='add', scope='project', text='LUNA_PARITY_TEST note temporaire' ; puis tool_call pour execute_code avec code=\"notes = tools.memory(action='search', query='LUNA_PARITY_TEST')\\nresult = {'value': 42, 'notes': len(notes['records'])}\". Le code doit contenir un véritable retour à la ligne. Vérifie les résultats réels (42 et une note), puis réponds très brièvement. Aucun appel de réseau externe supplémentaire, aucune génération de média, aucun autre fichier à modifier."};
  const response=await fetch(base+'/api/agent-chat',{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(180000)});assert.equal(response.status,200,'Luna HTTP '+response.status);
  let buffer='',result,error;const decisions=[];
  for await(const chunk of response.body){buffer+=Buffer.from(chunk).toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;const e=JSON.parse(line);if(e.type==='permission_required'){const allow=/execute_code|python code/.test(e.summary+' '+e.target);decisions.push(fetch(base+'/api/rust-core/decision',{method:'POST',headers,body:JSON.stringify({sessionId:e.sessionId,requestId:e.requestId,kind:'permission',allow,scope:'once'})}));}if(e.type==='question_required')decisions.push(fetch(base+'/api/assistant/answer',{method:'POST',headers,body:JSON.stringify({requestId:e.requestId,answer:{cancelled:true}})}));if(e.type==='done')result=e.result;if(e.type==='error')error=e.error;}}
  await Promise.all(decisions);if(error||result?.error)throw Error(error||result.error);assert.ok(result,'Missing completed response');
  const code=result.toolResults.find(t=>t.tool==='execute_code'&&!t.error&&!t.blocked);assert.ok(code,'Luna did not successfully call execute_code: '+JSON.stringify(result.toolResults.map(t=>({tool:t.tool,error:t.error,blocked:t.blocked,summary:t.summary}))));
  const proof=JSON.parse(code.text);assert.equal(proof.result.value,42);assert.equal(proof.result.notes,1);
  const output={status:'passed',provider:'ChatGPT subscription',model:'gpt-6-luna',tools:catalogue.tools.length,called:[...new Set(result.toolResults.map(t=>t.tool))],codeResult:proof.result,response:result.response,usage:result.usage,personalStores:'unchanged'};
  fs.mkdirSync(path.join(repo,'reports'),{recursive:true});fs.writeFileSync(path.join(repo,'reports','assistant-luna-proof.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
}
main().catch(error=>{console.error(require('../secrets-mask').sanitize(error.message));process.exitCode=1;}).finally(async()=>{if(server){server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));}assert.equal(path.dirname(temp),os.tmpdir());for(let n=0;n<40;n++){try{fs.rmSync(temp,{recursive:true,force:true});break;}catch{await new Promise(r=>setTimeout(r,100));}}});
