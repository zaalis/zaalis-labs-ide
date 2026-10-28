'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { beginSignIn, validateIdentity } = require('../src/accounts/chatgpt-sign-in');
const chatgpt = require('../src/accounts/chatgpt-subscription');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({format:'jwk'}), kid:'test-key', alg:'RS256', use:'sig' };
function jwt(claims) {
  const head = Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${head}.${body}.${crypto.sign('sha256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url')}`;
}
const response = body => new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json'}});
const identity = extra => ({iss:'https://auth.openai.com',aud:'issued-client',sub:'account-1',nonce:'nonce-1',exp:Math.floor(Date.now()/1000)+3600,...extra});
const discoveryFetch = async url => String(url).endsWith('openid-configuration')
  ? response({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/jwks'}) : response({keys:[jwk]});

test('official sign-in validates signature, issuer, client, nonce and expiry', async () => {
  const options={issuer:'https://auth.openai.com',clientId:'issued-client',nonce:'nonce-1',fetchImpl:discoveryFetch};
  assert.equal((await validateIdentity(jwt(identity()),options)).sub,'account-1');
  for(const claims of [{nonce:'wrong'},{aud:'other-client'},{iss:'https://evil.test'},{exp:1},{aud:['issued-client','other'],azp:'other'}]) {
    await assert.rejects(validateIdentity(jwt(identity(claims)),options),/Identité/);
  }
  const altered = jwt(identity()).split('.'); altered[1]=Buffer.from(JSON.stringify(identity({sub:'forged'}))).toString('base64url');
  await assert.rejects(validateIdentity(altered.join('.'),options),/Signature/);
  await assert.rejects(validateIdentity(jwt(identity()),{...options,fetchImpl:async()=>response({issuer:options.issuer,jwks_uri:'https://evil.test/keys'})}),/Autorité/);
});

test('browser sign-in uses PKCE, issued client and token scopes; callback is single use', async t => {
  let auth, saved, exchange;
  const fetchImpl = async (url,options) => {
    if(String(url).endsWith('/api/accounts/oauth/token')) {
      exchange=Object.fromEntries(options.body);
      assert.equal(crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'));
      return response({access_token:'opaque-access-token',refresh_token:'refresh-token',token_type:'Bearer',expires_in:3600,scope:'openid resource.invoke chatgpt.tokens.use.direct',id_token:jwt(identity({nonce:auth.searchParams.get('nonce')}))});
    }
    return discoveryFetch(url,options);
  };
  const flow=await beginSignIn({hostId:'urn:uuid:test-host',fetchImpl,onSession:s=>{saved=s;}}); t.after(()=>flow.cancel());
  auth=new URL(flow.verificationUrl);
  assert.equal(auth.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(auth.searchParams.get('agent_name_hint'),'Zaalis Labs IDE');
  assert.equal(auth.searchParams.get('resource'),'https://api.openai.com/v1');
  const callback=new URL(auth.searchParams.get('redirect_uri'));
  callback.searchParams.set('state','forged');
  assert.equal((await fetch(callback)).status,400);
  assert.equal(flow.poll().status,'pending');
  callback.searchParams.set('state',auth.searchParams.get('state')); callback.searchParams.set('client_id','issued-client');callback.searchParams.set('code','authorization-code');
  assert.equal((await fetch(callback)).status,200);
  assert.equal(flow.poll().status,'connected');
  assert.equal(exchange.client_id,'issued-client'); assert.equal(exchange.redirect_uri,auth.searchParams.get('redirect_uri'));
  assert.equal(saved.transport,'public'); assert.equal(saved.subject,'account-1'); assert.equal(saved.accessToken,'opaque-access-token');
  assert.ok(saved.expiresAt>Date.now());
});

test('Responses preserves explicit cyber selection and namespaces subscription tools', async () => {
  const chat={model:'gpt-6-luna',messages:[{role:'user',content:'Inspect'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],reasoning_effort:'high'};
  for(const cyber of ['standard','daybreak_blue','daybreak_red']) {
    const request=chatgpt.toResponsesRequest(chat,{publicApi:true,cyber});
    assert.deepEqual(request.access_programs,{cyber}); assert.equal(request.tools[0].type,'function');
  }
  const sub=chatgpt.toResponsesRequest(chat,{publicApi:true,subscription:true});
  assert.equal(sub.tools[0].type,'namespace');assert.equal(sub.tools[0].tools[0].name,'read');
  assert.throws(()=>chatgpt.toResponsesRequest(chat,{publicApi:true,cyber:'unlocked'}),/invalide/);
  assert.throws(()=>chatgpt.toResponsesRequest(chat,{cyber:'daybreak_red'}),/Reconnectez/);
  let sent;
  await chatgpt.openResponseStream('api-key',sub,{publicApi:true,fetchImpl:async(url,opts)=>{sent={url,opts};return new Response('');}});
  assert.equal(sent.url,'https://api.openai.com/v1/responses');
  assert.equal(sent.opts.headers.Authorization,'Bearer api-key');
  assert.ok(!('ChatGPT-Account-ID' in sent.opts.headers));
  let attempts=0;
  await assert.rejects(chatgpt.openResponseStream('api-key',sub,{publicApi:true,fetchImpl:async()=>{attempts++;return new Response(JSON.stringify({error:{code:'access_program_not_enabled',message:'Project not authorized'}}),{status:403});}}),/Project not authorized/);
  assert.equal(attempts,1,'no silent downgrade after a Daybreak refusal');
});

test('public subscription renewal uses its issued client and public token endpoint', async () => {
  let sent;
  const previous={transport:'public',clientId:'issued-client',subject:'account-1',hostId:'host',refreshToken:'refresh-old',email:'account@example.test'};
  const renewed=await chatgpt.refreshSession(previous,{fetchImpl:async(url,opts)=>{sent={url,body:Object.fromEntries(opts.body)};return response({access_token:'renewed',refresh_token:'rotated',expires_in:3600});}});
  assert.equal(sent.url,'https://auth.openai.com/api/accounts/oauth/token');
  assert.equal(sent.body.client_id,'issued-client');assert.equal(sent.body.resource,'https://api.openai.com/v1');
  assert.equal(renewed.transport,'public');assert.equal(renewed.subject,'account-1');assert.equal(renewed.refreshToken,'rotated');
});
