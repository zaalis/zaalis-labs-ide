'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {cloneInput,mountProjectClone}=require('../src/services/project-clone');
test('clone accepts only remote HTTPS/SSH URLs and a new safe destination', t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-clone-test-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const good=cloneInput({url:'git@github.com:team/project.git',parent});
  assert.equal(good.url,'ssh://git@github.com/team/project.git');assert.equal(good.destination,path.join(parent,'project'));
  for(const url of ['file:///C:/repo','ext::sh -c echo','http://host/repo','https://secret@host/repo','ssh://user:secret@host/repo']) assert.throws(()=>cloneInput({url,parent}));
  for(const name of ['../escape','..','NUL','file.','one\\two'])assert.throws(()=>cloneInput({url:'https://host/repo',parent,name}));
  fs.mkdirSync(good.destination);assert.throws(()=>cloneInput({url:good.url,parent}));
});
test('clone stages work, uses argv without a shell, and refuses to overwrite a raced destination',t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-clone-test-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  let handler,stage;const child=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;
  mountProjectClone({post(_route,fn){handler=fn;}},(exe,args,options)=>{
    assert.equal(exe,'git');assert.equal(args[1],'--');assert.equal(options.shell,undefined);assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');stage=args.at(-1);return child;
  });
  const res=new EventEmitter();res.status=code=>{res.code=code;return res;};res.json=body=>{res.body=body;res.writableEnded=true;};
  handler({body:{url:'https://example.com/repo.git',parent}},res);
  fs.mkdirSync(path.join(parent,'repo'));fs.writeFileSync(path.join(parent,'repo','owned'),'keep');
  child.exitCode=0;child.emit('close',0);
  assert.equal(res.code,400);assert.equal(fs.readFileSync(path.join(parent,'repo','owned'),'utf8'),'keep');assert.equal(fs.existsSync(stage),false);
});
