'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubIntegration, repository } = require('../github-integration');
function fixture() {
 let users = [{ id: 'u', github: { token: 'encrypted', login: 'alice', permissions: { 'alice/project': { mode: 'read', id: 12 } } } }];
 const calls = [];
 const g = new GitHubIntegration({ loadUsers: () => structuredClone(users), saveUsers: u => { users = u; }, encrypt: s => 'sealed:'+s, decrypt: () => 'secret-token',
  fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => url.endsWith('/user') ? { login: 'alice' } : { id: 12, default_branch: 'main', permissions: { push: true } } }; } });
 return { g, calls };
}
test('repository identity admits only exact github.com remotes', () => {
 for (const u of ['https://github.com/Alice/Project.git','git@github.com:Alice/Project.git','ssh://git@github.com/Alice/Project']) assert.equal(repository(u),'alice/project');
 for (const u of ['https://github.com.evil/a/b','https://token@github.com/a/b','https://github.com/a/b/extra','file:///repo']) assert.equal(repository(u),null);
});
test('connection validates account and returns no credential', async () => {
 const { g, calls }=fixture();const status=await g.connect('u','github_pat_valid_token');assert.equal(status.login,'alice');assert.equal(status.connected,true);assert.ok(!JSON.stringify(status).includes('github_pat'));
 assert.equal(calls[0].opts.redirect,'error');assert.ok(g.user('u').github.token.startsWith('sealed:'));
});
test('all write actions rejected in read-only before filesystem or remote mutation', async () => {
 for (const action of ['push','merge','create_pull']) { const {g,calls}=fixture();await assert.rejects(g.action('u','invalid',{action,repo:'alice/project'}),/Lecture seule/);assert.ok(calls.every(c=>c.opts.method==='GET')); }
});
test('ungranted repo and changed identity never reach a write', async () => {
 const {g,calls}=fixture();await assert.rejects(g.action('u','invalid',{action:'push',repo:'other/project'}),/pas autorisé/);assert.equal(calls.length,0);
 g.request=async()=>({id:99});await assert.rejects(g.action('u','invalid',{action:'read',repo:'alice/project',path:'README.md'}),/identité/);
});
test('write grant requires a verified root and actual GitHub push permission', async () => {
 const {g}=fixture();await assert.rejects(g.permission('u',{repo:'alice/project',mode:'write'}),/Associez/);
 g.request=async()=>({id:12,permissions:{push:false}});await assert.rejects(g.permission('u',{repo:'alice/project',mode:'write',root:'wrong'}),/ne vous accorde pas/);
});
test('read actions use bounded encoded repository paths', async () => {
 const {g,calls}=fixture();await g.action('u','invalid',{action:'read',repo:'alice/project',path:'folder/a b.txt'});assert.ok(calls.at(-1).url.includes('folder/a%20b.txt'));
 await assert.rejects(g.action('u','invalid',{action:'read',repo:'alice/project',path:'../secret'}),/Chemin invalide/);
});
test('push identity mismatch refuses before remote mutation', async () => {
 const {g,calls}=fixture();g.save('u',u=>{u.github.permissions['alice/project']={mode:'write',id:12,root:'root'};});g.readOnly=async()=>false;g.verify=async()=>{throw Error('remote origin différent');};
 await assert.rejects(g.action('u','root',{action:'push',repo:'alice/project'}),/origin/);assert.ok(calls.every(c=>c.opts.method==='GET'));
});
test('disconnect removes grants and encrypted token', () => {const {g}=fixture();assert.equal(g.disconnect('u').connected,false);assert.equal(g.user('u').github,undefined);});
test('device flow requires configured application and expires', async()=>{const {g}=fixture();g.clientId='';await assert.rejects(g.start('u'),/CLIENT_ID/);g.devices.set('u',{expires:0});await assert.rejects(g.poll('u'),/expirée/);});

test('browser sign-in polls authorization and seals the token without exposing device secrets', async () => {
 const {g}=fixture();g.configure('u','public-client-id');let polls=0;
 g.fetch=async(url,opts)=>({ok:true,status:200,json:async()=>{
  if(url.endsWith('/device/code')) { assert.equal(JSON.parse(opts.body).client_id,'public-client-id');return {device_code:'private-device-secret',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:900,interval:5}; }
  if(url.endsWith('/access_token')) return ++polls===1?{error:'slow_down'}:polls===2?{error:'authorization_pending'}:{access_token:'github_oauth_secret_token'};
  return {login:'alice'};
 }});
 const start=await g.start('u');assert.equal(start.url,'https://github.com/login/device');assert.ok(!JSON.stringify(start).includes('private-device-secret'));
 assert.deepEqual(await g.poll('u'),{pending:true,interval:10});assert.ok(g.devices.get('u').next>=Date.now()+9000);
 g.devices.get('u').next=0;assert.deepEqual(await g.poll('u'),{pending:true,interval:10});g.devices.get('u').next=0;
 const status=await g.poll('u');assert.equal(status.connected,true);assert.equal(status.login,'alice');assert.ok(!JSON.stringify(status).includes('github_oauth_secret_token'));assert.equal(g.devices.size,0);
});

test('cancelled browser authorization cannot restore credentials from an in-flight poll', async () => {
 const {g}=fixture();g.devices.set('u',{code:'private',clientId:'public-client-id',expires:Date.now()+90000,interval:5000,next:0});
 let resolve;g.fetch=()=>new Promise(r=>{resolve=r;});const pending=g.poll('u');g.cancel('u');resolve({ok:true,json:async()=>({access_token:'github_oauth_secret_token'})});
 await assert.rejects(pending,/annulée/);assert.equal(g.user('u').github.token,'encrypted');
});

test('invalid browser authorization destinations are refused', async () => {
 const {g}=fixture();g.configure('u','public-client-id');g.fetch=async()=>({ok:true,json:async()=>({device_code:'private',user_code:'ABCD',verification_uri:'https://evil.invalid',expires_in:900})});
 await assert.rejects(g.start('u'),/indisponible/);assert.equal(g.devices.size,0);assert.throws(()=>g.configure('u','bad id'),/invalide/);
});

function writable() {
 const {g}=fixture(),requests=[],gitCalls=[];
 g.save('u',u=>{u.github.permissions['alice/project']={mode:'write',root:'verified-root',id:12};});
 g.readOnly=async()=>false;g.verify=async()=> 'verified-root';
 g.request=async(id,url,method='GET',body)=>{requests.push({url,method,body});if(url.includes('/git/trees/'))return {tree:[{type:'blob',path:'README.md'}]};if(url.includes('/git/ref/'))return {object:{sha:'a'.repeat(40)}};return {id:12,default_branch:'main',permissions:{push:true}};};
 g.git=async(root,args,env)=>{gitCalls.push({args,env});if(args[0]==='ls-tree')return 'README.md';if(args[0]==='rev-parse')return 'b'.repeat(40);return '';};
 return {g,requests,gitCalls};
}
test('push keeps credentials out of command arguments and rejects dirty work',async()=>{
 const {g,gitCalls}=writable();const result=await g.action('u','root',{action:'push',repo:'alice/project',branch:'main'});assert.equal(result.sha,'b'.repeat(40));const push=gitCalls.find(c=>c.args.includes('push'));assert.ok(push.args.includes('HEAD:refs/heads/main'));assert.ok(!JSON.stringify(push.args).includes('secret-token'));assert.equal(push.env.GIT_CONFIG_COUNT,'1');assert.ok(push.env.GIT_CONFIG_VALUE_0.startsWith('Authorization: Basic '));
 const other=writable();const git=other.g.git;other.g.git=async(root,args,env)=>args[0]==='status'?' M README.md':git(root,args,env);await assert.rejects(other.g.action('u','root',{action:'push',repo:'alice/project'}),/pas commités/);assert.ok(!other.gitCalls.some(c=>c.args.includes('push')));
});
test('pull request creation and merge retain verified identity and exact head SHA',async()=>{
 const {g,requests}=writable();await g.action('u','root',{action:'create_pull',repo:'alice/project',title:'Change',head:'feature',branch:'main',draft:true});assert.deepEqual(requests.at(-1),{url:'/repos/alice/project/pulls',method:'POST',body:{title:'Change',body:'',head:'feature',base:'main',draft:true}});
 await assert.rejects(g.action('u','root',{action:'merge',repo:'alice/project',number:1}),/SHA exact/);
 await g.action('u','root',{action:'merge',repo:'alice/project',number:1,sha:'c'.repeat(40)});assert.equal(requests.at(-1).method,'PUT');assert.equal(requests.at(-1).body.sha,'c'.repeat(40));
});
test('unrelated history or truncated remote tree blocks every mutation',async()=>{
 const {g,requests}=writable();const git=g.git;g.git=async(root,args,env)=>{if(args[0]==='merge-base')throw Error('unrelated');return git(root,args,env);};await assert.rejects(g.action('u','root',{action:'create_pull',repo:'alice/project',title:'Change',head:'feature'}),/historique/);assert.ok(requests.every(r=>r.method==='GET'));
});

test('real Git validates root, origin and push destination without contacting GitHub',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-github-identity-')),git=args=>execFileSync('git',['-C',root,...args],{windowsHide:true,stdio:'ignore'});
 git(['init']);git(['remote','add','origin','https://github.com/alice/project.git']);const {g}=fixture();assert.ok(await g.verify(root,'alice/project'));
 git(['remote','set-url','--push','origin','https://github.com/other/project.git']);await assert.rejects(g.verify(root,'alice/project'),/correspond pas/);
 git(['remote','set-url','--push','origin','https://github.com/alice/project.git']);git(['config','url.https://evil.invalid/.insteadOf','https://github.com/']);await assert.rejects(g.verify(root,'alice/project'),/correspond pas/);
});
