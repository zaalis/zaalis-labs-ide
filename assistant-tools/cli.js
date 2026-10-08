'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const commands=['tools','assistant-memory','sessions','schedule','jobs','tasks','skills','connections','attach','computer'];
async function command(name,arg,env){
  if(!commands.includes(name))return false;
  const words=arg.trim().split(/\s+/),action=words[0]||'list';
  const api=async(method,url,body)=>{const r=await env.authed(method,url,body);if(r.status!==200)throw Error(r.json?.error||'HTTP '+r.status);return r.json;};
  const view=(tool,input)=>api('GET','/api/assistant/manage/'+tool+'?root='+encodeURIComponent(env.root())+'&input='+encodeURIComponent(JSON.stringify(input)));
  const mutate=(tool,input)=>api('POST','/api/assistant/manage/'+tool,{root:env.root(),model:env.session.model,submodel:env.session.submodel,permissionMode:env.permission(),input});
  let result;
  if(name==='tools'){const data=await api('GET','/api/assistant/catalog');const query=arg.toLowerCase();result={shared:data.shared,tools:data.tools.filter(t=>!query||(`${t.name} ${t.family} ${t.description}`).toLowerCase().includes(query)).map(t=>({name:t.name,family:t.family,status:t.status,description:t.description}))};}
  else if(name==='attach'){const file=path.resolve(env.root(),arg);const {loadImage}=require('./media');env.images.push(loadImage(file));result={attached:path.basename(file),pending:env.images.length};}
  else if(name==='computer'){env.session.computerControl=action==='on';env.save();result={computerControl:env.session.computerControl};}
  else if(name==='connections'){
    if(action==='configure'){const file=path.resolve(env.root(),words.slice(1).join(' '));if(fs.statSync(file).size>128000)throw Error('Configuration too large.');result=await api('POST','/api/assistant/connections',JSON.parse(fs.readFileSync(file,'utf8')));}
    else result=['list','status','catalog','test'].includes(action)?await view('manage_connections',{action,id:words[1]}):await mutate('manage_connections',{action,id:words[1]});
  } else if(name==='skills'){
    if(['create','install','update'].includes(action)){const file=path.resolve(env.root(),words.slice(2).join(' '));if(fs.statSync(file).size>128000)throw Error('Skill too large.');result=await mutate('skill_manage',{action,name:words[1],content:fs.readFileSync(file,'utf8')});}
    else if(['delete','uninstall'].includes(action))result=await mutate('skill_manage',{action,name:words[1]});
    else result=await view(action==='list'?'skills_list':'skill_view',{action,name:words[1]||words[0]});
  } else if(name==='assistant-memory'){
    if(action==='add')result=await mutate('memory',{action,scope:'personal',text:words.slice(1).join(' ')});
    else if(action==='delete')result=await mutate('memory',{action,id:words[1]});
    else if(['on','off'].includes(action))result=await mutate('memory',{action:'settings',enabled:action==='on'});
    else result=await view('memory',{action:['list','search','read'].includes(action)?action:'search',query:action==='list'?'':words.slice(1).join(' '),id:action==='read'?words[1]:undefined});
  } else if(name==='sessions'){result=await view('session_search',{scope:'account',...(action==='read'?{session_id:words[1]}:{query:arg==='list'?'':arg})});}
  else if(name==='tasks')result=await view(action==='show'?'kanban_show':'kanban_list',{task_id:words[1]});
  else if(name==='schedule'){
    if(action==='create'||action==='update'){const raw=arg.slice(action.length).trim();result=await mutate('cronjob_manage',{...JSON.parse(raw),action});}
    else result=['list','history','status','runs'].includes(action)?await view('cronjob_manage',{action,scope:'account'}):await mutate('cronjob_manage',{action,job_id:words[1]});
  } else if(name==='jobs'){
    if(action==='start')result=await mutate('delegate_task',{action,goal:words.slice(1).join(' '),background:true});
    else if(['cancel','resume'].includes(action))result=await mutate('delegate_task',{action,delegation_id:words[1]});
    else if(action==='answer'){const answer=JSON.parse(words.slice(2).join(' '));result=await api('POST','/api/assistant/answer',{requestId:words[1],answer});}
    else if(action==='approve'||action==='deny')result=await api('POST','/api/rust-core/decision',{sessionId:words[1],requestId:words[2],kind:'permission',allow:action==='approve',scope:'once'});
    else if(action==='questions')result=await api('GET','/api/assistant/questions');
    else result=await view('delegate_task',{action:action==='list'?'list':'result',delegation_id:words[1],scope:'account'});
  }
  console.log(JSON.stringify(result,null,2));return true;
}
function readAnswer(label,secret=false){
  if(!process.stdin.isTTY)return Promise.resolve(null);
  return new Promise(resolve=>{const raw=process.stdin.isRaw;readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(label+': ');let value='';
    const key=(str,k)=>{if(k?.name==='return')done(value);else if(k?.name==='escape'||k?.ctrl&&k.name==='c')done(null);else if(k?.name==='backspace'){value=value.slice(0,-1);process.stdout.write('\b \b');}else if(str&&!k?.ctrl&&!k?.meta&&!/\x1b|[\x00-\x1f]/.test(str)){if(value.length<16000){value+=str;process.stdout.write(secret?'*'.repeat([...str].length):str);}}};
    function done(answer){process.stdin.removeListener('keypress',key);process.stdin.setRawMode(!!raw);if(!raw)process.stdin.pause();process.stdout.write('\n');resolve(answer);}process.stdin.on('keypress',key);
  });
}
async function question(event,authed){
  let answer={};process.stdout.write('\n'+event.question+'\n');
  if(!process.stdin.isTTY)answer={cancelled:true};
  else if(event.fields){for(const field of event.fields){const value=await readAnswer(field.label||field.name,field.type==='password'||event.secret);if(value===null){answer={cancelled:true};break;}answer[field.name]=value;}}
  else{if(event.options?.length)event.options.forEach((s,n)=>process.stdout.write(`${n+1}. ${s}\n`));const raw=await readAnswer('Réponse',event.secret);answer=raw===null?{cancelled:true}:{answer:event.multi_select?raw.split(/[, ]+/).filter(Boolean).map(v=>event.options?.[Number(v)-1]||v):event.options?.[Number(raw)-1]||raw};}
  const r=await authed('POST','/api/assistant/answer',{requestId:event.requestId,answer});if(r.status!==200)throw Error(r.json?.error||'Answer failed');
}
module.exports={commands,command,question,readAnswer};
