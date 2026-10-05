'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { VmManager } = require('../vm-manager');
test('VM ownership cannot be changed by an id or user supplied in tool arguments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-unit-'));
  try {
    const v = new VmManager({ appDir:root,dataDir:root });
    v.sessions.set('one',{id:'one',userId:'owner',output:'private'});
    assert.throws(()=>v.get('one','other'),/inconnue/);
    assert.deepEqual(v.list('other'),[]);
    await assert.rejects(v.action('other',{action:'exec',id:'one',userId:'owner',command:'echo test'}),/inconnue/);
    await assert.rejects(v.action('owner',{action:'activate'}),/inconnue/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('project import uses a copy, excludes secrets and skips links', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-vm-copy-'));
  try {
    const project=path.join(root,'project'), dir=path.join(root,'session');fs.mkdirSync(project);fs.mkdirSync(dir);
    fs.writeFileSync(path.join(project,'source.js'),'safe');fs.writeFileSync(path.join(project,'.env'),'secret');fs.writeFileSync(path.join(project,'server.key'),'secret');
    fs.mkdirSync(path.join(project,'node_modules'));fs.writeFileSync(path.join(project,'node_modules','dependency'),'excluded');
    const v=new VmManager({appDir:root,dataDir:root});let command;
    v.exec=async(s,c)=>{command=c;return {exitCode:0,output:''};};
    const r=await v.importProject({status:'ready',system:'windows',dir},project);
    assert.equal(r.files,1);assert.deepEqual(fs.readdirSync(path.join(dir,'project-copy')),['source.js']);assert.match(command,/C:\\workspace/);
    assert.equal(fs.readFileSync(path.join(project,'source.js'),'utf8'),'safe');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
