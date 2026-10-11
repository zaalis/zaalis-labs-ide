'use strict';
const {text,fail}=require('../common');
const {boundedJson,validateBase}=require('../connections');
async function daytona(connections,config,backend,input,ctx){
  const id=encodeURIComponent(text(backend.sandbox_id||input.sandbox_id,'sandbox_id',160));
  const base=validateBase(backend.toolboxUrl||`https://proxy.app.daytona.io/toolbox/${id}/`);
  const url=new URL('process/execute',base.href.replace(/\/?$/,'/'));
  const credentials=config.tokens?.[backend.id],token=typeof credentials==='string'?credentials:credentials?.apiKey;
  if(!token)throw fail('Daytona API credentials are required.','connection_required',409);
  const response=await connections.fetch(url,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({command:text(input.command,'command',64000),cwd:backend.cwd||'workspace',timeout:Math.ceil(Math.min(1800000,Math.max(1000,Number(input.timeout_ms)||120000))/1000)}),signal:AbortSignal.any([ctx.signal||new AbortController().signal,AbortSignal.timeout(1800000)])});
  const result=await boundedJson(response);if(!response.ok)throw fail('Daytona execution HTTP '+response.status,'provider_error',502);return result;
}
module.exports={daytona};
