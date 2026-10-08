'use strict';
const { Store,crypto,fail,publicData }=require('./common');
const {definitions,classify,aliases}=require('./catalog');
const {MemoryTools}=require('./memory'),{SessionTools}=require('./sessions'),{SkillTools}=require('./skills'),{KanbanTools}=require('./kanban'),{TaskTools}=require('./tasks'),{Connections}=require('./connections'),{BrowserTools}=require('./browser'),{MediaTools}=require('./media'),{DesktopTools}=require('./desktop'),{ExecutionTools}=require('./execution');
const connectors={discord:require('./connectors/discord'),spotify:require('./connectors/spotify'),feishu:require('./connectors/feishu'),homeassistant:require('./connectors/homeassistant'),a2a:require('./connectors/a2a')};
class AssistantTools {
  constructor(options){
    this.options=options;this.store=new Store(options.dataDir);this.questions=new Map();this.streams=new Map();
    this.connections=new Connections(this.store,options);this.a2a=new connectors.a2a.A2ATools(this.connections,this.store);this.memory=new MemoryTools(this.store);this.sessions=new SessionTools(this.store,options.dataDir);this.skills=new SkillTools(options.dataDir);this.kanban=new KanbanTools(this.store);this.tasks=new TaskTools(this.store,options.run,(user,event)=>this.emit(user,event));this.browser=new BrowserTools(this.store,this.connections,options);this.media=new MediaTools(this.connections,options);this.desktop=new DesktopTools({...options,emit:(user,event)=>this.emit(user,event)});this.execution=new ExecutionTools(this.connections);
  }
  manifest(){return definitions;}
  catalogue(userId){return {version:1,shared:['IDE','CLI'],tools:definitions.map(d=>({...d,status:this.availability(userId,d)})),connections:this.connections.list(userId)};}
  availability(user,d){
    if(['window_read','read_window_below'].includes(d.name))return 'requires_computer_control';
    if(['discord','spotify','feishu','homeassistant','a2a','yuanbao','execution'].includes(d.family)) {if(d.name==='terminal_backend_manage')return 'ready';try{this.connections.get(user,d.family);return 'configured_unverified';}catch{return 'connection_required';}}
    if(d.family==='browser')return this.options.browserAvailable()? 'ready': (()=>{try{this.connections.get(user,'cdp');return 'configured_unverified';}catch{return 'service_unavailable';}})();
    if(d.family==='media'&&!['vision_analyze','video_analyze','text_to_speech'].includes(d.name)){try{this.connections.get(user,'media');return 'configured_unverified';}catch{return 'connection_required';}}
    if(d.name==='video_analyze')return 'requires_ffmpeg_and_vision';if(d.name==='vision_analyze')return 'requires_vision_model';if(d.name==='text_to_speech')return process.platform==='win32'?'ready':'connection_required';return 'ready';
  }
  async execute(name,input,context){
    const d=definitions.find(d=>d.name===name);if(!d)throw fail('Unknown assistant tool.','not_found',404);
    const ctx={...context,ask:question=>this.ask(context,question)};
    if(['read-only','read_only','plan'].includes(ctx.permissionMode)&&!['read','network'].includes(classify(d,input)))throw fail('This action is blocked by the effective permission mode.','permission_denied',403);
    let value;
    name=aliases[name]||name;
    switch(d.family){
      case 'memory':value=this.memory.run(input,ctx);break;
      case 'sessions':value=this.sessions.run(input,ctx);break;
      case 'skills':value=this.skills.run(name,input,ctx);break;
      case 'kanban':value=this.kanban.run(name,input,ctx);break;
      case 'schedule':value=this.tasks.cron(input,ctx);break;
      case 'tasks':value=await this.tasks.delegate(input,ctx);break;
      case 'questions':value=await ctx.ask(input);if(input.secret||input.fields?.some(f=>f.type==='password'))value={answered:true,secret:true};break;
      case 'connections':value=await this.connections.run(input,ctx);break;
      case 'mcp':value=await this.options.mcp(ctx,name==='mcp_discover'?'tools':'call',input);break;
      case 'browser':value=await this.browser.run(name,input,ctx);break;
      case 'media':value=await this.media.run(name,input,ctx);break;
      case 'desktop':value=await this.desktop.run(name,input,ctx);break;
      case 'execution':value=await this.execution.run(name,input,ctx);break;
      case 'a2a':value=await this.a2a.run(name,input,ctx);break;
      case 'yuanbao':{const c=this.connections.get(ctx.userId,'yuanbao');value=await this.options.mcp(ctx,'call',{server:c.mcpServer,tool:name,arguments:input});break;}
      default:{const mod=connectors[d.family];if(!mod)throw fail('No handler for '+name);const fn=mod.run||mod[d.family]||Object.values(mod).find(v=>typeof v==='function');value=await fn(this.connections,name,input,ctx);}
    }
    return publicData(value);
  }
  ask(ctx,input){
    if(!input.options&&input.choices)input={...input,options:input.choices};
    if(typeof input.question!=='string'||!input.question.trim()||input.question.length>8000)throw fail('A question up to 8000 characters is required.');
    if(input.options&&(!Array.isArray(input.options)||input.options.length>12||input.options.some(s=>typeof s!=='string'||s.length>500)))throw fail('Invalid question options.');
    if(input.fields&&(!Array.isArray(input.fields)||input.fields.length>8||input.fields.some(f=>!(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/).test(f.name)||!['text','password'].includes(f.type||'text'))))throw fail('Invalid question fields.');
    const requestId=crypto.randomUUID(),event={type:'question_required',requestId,question:input.question,options:input.options,fields:input.fields,secret:!!input.secret,multi_select:!!input.multi_select};
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(fail('Question timed out.','timeout',408)),600000);timer.unref();const abort=()=>finish(fail('Question cancelled.','cancelled',499));const finish=(error,answer)=>{clearTimeout(timer);ctx.signal?.removeEventListener('abort',abort);this.questions.delete(requestId);error?reject(error):resolve(answer);};this.questions.set(requestId,{userId:ctx.userId,event,finish});if(ctx.signal?.aborted)return abort();ctx.signal?.addEventListener('abort',abort,{once:true});ctx.emit?.(event);this.emit(ctx.userId,event);});
  }
  answer(user,id,answer){const pending=this.questions.get(id);if(!pending||pending.userId!==user)throw fail('Question not found.','not_found',404);if(answer.cancelled){pending.finish(fail('User cancelled.','cancelled',499));return {cancelled:true};}if(JSON.stringify(answer).length>16000)throw fail('Answer too large.');const clean={};if(pending.event.fields){for(const f of pending.event.fields){if(typeof answer[f.name]!=='string')throw fail('Missing field '+f.name);clean[f.name]=answer[f.name];}}else{if(pending.event.multi_select){if(!Array.isArray(answer.answer)||answer.answer.length>12||answer.answer.some(v=>typeof v!=='string'))throw fail('Expected selected answers.');}else if(typeof answer.answer!=='string')throw fail('Missing answer.');clean.answer=answer.answer;}pending.finish(null,clean);return {answered:true};}
  emit(user,event){for(const res of this.streams.get(user)||[])try{res.write('data: '+JSON.stringify(publicData(event))+'\n\n');}catch{}}
  attach(user,res){res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.flushHeaders?.();let set=this.streams.get(user);if(!set)this.streams.set(user,set=new Set());set.add(res);res.write('data: {"type":"connected"}\n\n');const timer=setInterval(()=>res.write(': keepalive\n\n'),25000);timer.unref();res.once('close',()=>{clearInterval(timer);set.delete(res);});}
  close(){this.tasks.stop();this.browser.close();this.execution.stop();for(const q of this.questions.values())q.finish(fail('Server stopped.'));for(const set of this.streams.values())for(const res of set)res.end();}
}
module.exports={AssistantTools};
