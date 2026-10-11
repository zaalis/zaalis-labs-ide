'use strict';
const {fail,text,crypto}=require('../common');
const catalog=require('../../interface/script/integration-catalog');
const segment=v=>encodeURIComponent(text(v,'target',500));
async function run(connections,name,input,ctx){
 const id=text(input.service,'service',80),info=catalog.find(c=>c.id===id);if(!info||info.adapter==='native')throw fail('Use the dedicated WhatsApp or Telegram integration.');
 const row=connections.get(ctx.userId,id),action=name==='messaging_send'?'send':input.action==='test'?'test':'read';
 if(info.adapter==='mcp'){
  if(!row.mcpServer)throw fail('An owner-configured MCP bridge is required.','connection_required',409);
  if(!row.options?.tools?.[action])throw fail('Configure the MCP tool mapping for this action.','connection_required',409);
  return connections.mcp(ctx,'call',{server:row.mcpServer,tool:row.options.tools[action],arguments:action==='send'?(input.arguments||{target:input.target,text:input.text}):{target:input.target,limit:50,action}});
 }
 if(!['read','send','test','request'].includes(action))throw fail('Unsupported messaging action.');
 const target=input.target||row.options.target;
 const message=action==='send'?text(input.text,'message',32000):undefined;
 const request=async(route,method='GET',body,query)=>{const result=await connections.request(ctx.userId,id,route,{method,body,query,signal:ctx.signal});if(id==='slack'&&result.ok===false)throw fail(`Slack API: ${String(result.error||'request failed').slice(0,200)}`,'provider_error',502);return result;};
 switch(id){
  case 'slack':return request(action==='test'?'auth.test':action==='send'?'chat.postMessage':'conversations.history',action==='send'?'POST':'GET',message?{channel:target,text:message}:undefined,action==='read'?{channel:target,limit:50}:undefined);
  case 'mattermost':return action==='test'?request('users/me'):action==='send'?request('posts','POST',{channel_id:target,message}):request(`channels/${segment(target)}/posts`);
  case 'matrix':return action==='test'?request('_matrix/client/v3/account/whoami'):action==='send'?request(`_matrix/client/v3/rooms/${segment(target)}/send/m.room.message/${crypto.randomUUID()}`,'PUT',{msgtype:'m.text',body:message}):request(`_matrix/client/v3/rooms/${segment(target)}/messages`,'GET',undefined,{dir:'b',limit:50});
  case 'discord':return action==='test'?request('users/@me'):action==='send'?request(`channels/${segment(target)}/messages`,'POST',{content:message}):request(`channels/${segment(target)}/messages`,'GET',undefined,{limit:50});
  case 'googlechat':return request(`${String(target||'').replace(/^\//,'')}/messages`,action==='send'?'POST':'GET',message?{text:message}:undefined);
  case 'ntfy':return action==='send'?request('','POST',{topic:text(target,'topic',200),message}):request(`${segment(target)}/json`,'GET',undefined,{poll:1,since:'all'});
  case 'line':return action==='test'?request('info'):action==='send'?request('message/push','POST',{to:target,messages:[{type:'text',text:message}]}):request(`profile/${segment(target)}`);
  case 'teams':return request(`chats/${segment(target)}/messages`,action==='send'?'POST':'GET',message?{body:{contentType:'text',content:message}}:undefined);
  case 'microsoftgraph':return request(action==='test'?'me':input.route||'subscriptions',action==='send'?'POST':'GET',input.body);
  case 'whatsappcloud':if(action==='send')return request(`${segment(row.options.phoneId)}/messages`,'POST',{messaging_product:'whatsapp',to:target,type:'text',text:{body:message}});return request(segment(row.options.phoneId));
  case 'signal':return action==='send'?request('v2/send','POST',{number:row.options.number,recipients:[target],message}):request(action==='test'?'v1/about':`v1/receive/${segment(row.options.number)}`);
  case 'bluebubbles':return action==='send'?request('api/v1/message/text','POST',{chatGuid:target,message,tempGuid:crypto.randomUUID(),method:'apple-script'},{password:row.password}):request('api/v1/server/info','GET',undefined,{password:row.password});
  case 'twilio':{
   const sid=text(row.options.accountSid,'account SID',100),auth=Buffer.from(sid+':'+text(row.password||row.token,'credential',300)).toString('base64');
   const url=new URL(`Accounts/${segment(sid)}/Messages.json`,row.baseUrl.replace(/\/$/,'')+'/');const response=await connections.fetch(url,{method:action==='send'?'POST':'GET',headers:{Authorization:'Basic '+auth,...(action==='send'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},redirect:'error',signal:ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),...(action==='send'?{body:new URLSearchParams({To:target,From:row.options.from,Body:message})}:{})});const result=await require('../connections').boundedJson(response);if(!response.ok)throw fail(`Twilio HTTP ${response.status}`,'provider_error',response.status);return result;
  }
  case 'webhooks':case 'apiserver':return request(input.route||'',action==='send'?'POST':'GET',action==='send'?input.body||{text:message}:undefined);
  default:throw fail('Use this service’s dedicated tools.','dedicated_adapter',409);
 }
}
module.exports={run};
