'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {GitHubBrowserAuth}=require('../github-browser-auth');
test('official GitHub client uses isolated config, sanitizes token env and cleans credentials', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-gh-test-'));let launch,child;
 const auth=new GitHubBrowserAuth({appDir:dir,dataDir:dir,binary:'gh-fixture',spawnImpl:(binary,args,opts)=>{launch={binary,args,opts};child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>child.stderr.emit('data',Buffer.from('! First copy your one-time code: ABCD-EFGH')));return child;},runImpl:async()=>({stdout:'github_valid_oauth_token\n'})});
 const start=await auth.start('alice');assert.equal(start.code,'ABCD-EFGH');assert.equal(start.url,'https://github.com/login/device');assert.ok(launch.args.includes('--web'));assert.ok(launch.args.includes('--insecure-storage'));assert.equal(launch.opts.env.GH_TOKEN,undefined);assert.ok(launch.opts.env.GH_CONFIG_DIR.startsWith(path.join(dir,'github-signin','signin-')));
 assert.deepEqual(await auth.poll('alice'),{pending:true,interval:2});child.emit('close',0);assert.deepEqual(await auth.poll('alice'),{token:'github_valid_oauth_token'});assert.equal(auth.flows.size,0);assert.equal(fs.existsSync(launch.opts.env.GH_CONFIG_DIR),false);
});

test('cancelling before GitHub provides a code rejects the pending start and removes the config', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-gh-cancel-'));let child;
 const auth=new GitHubBrowserAuth({appDir:dir,dataDir:dir,binary:'gh-fixture',spawnImpl:()=>{child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};return child;}});
 const pending=auth.start('alice');auth.cancel('alice');await assert.rejects(pending,/annulée/);child.stderr.emit('data',Buffer.from('! First copy your one-time code: ABCD-EFGH'));assert.equal(auth.flows.size,0);
});

test('the closing client of an abandoned login cannot cancel its replacement', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-gh-race-')),children=[];
 const auth=new GitHubBrowserAuth({appDir:dir,dataDir:dir,binary:'gh-fixture',spawnImpl:()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};children.push(child);return child;}});
 const first=auth.start('alice');const rejected=assert.rejects(first,/annulée/);const second=auth.start('alice');await rejected;children[0].emit('close',1);children[1].stderr.emit('data',Buffer.from('! First copy your one-time code: EFGH-ABCD'));assert.equal((await second).code,'EFGH-ABCD');assert.equal(auth.flows.size,1);auth.cancel('alice');
});
