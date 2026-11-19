'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {frontend}=require('./helpers/frontend-dom');
function setup(api){
 const ui=frontend([],api);
 for(const id of ['skills-status','skills-list','skills-filter','skills-refresh','skills-import','cyber-program','cyber-status']){
  const el=ui.document.createElement(id==='cyber-program'?'select':'div');el.id=id;ui.document.body.append(el);
 }
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../interface/script/skills.js'),'utf8'),ui.context);
 return ui;
}
test('skills render imported instructions as text and restore a toggle after server refusal',async()=>{
 const instructions='<script>throw new Error("untrusted")</script>';
 const ui=setup(request=>request.method==='PUT'?{error:'Not allowed'}:{skills:[{name:'review',scope:'user',description:'Review',instructions,enabled:true}]});
 await ui.context.window.ZaalisSkills.refresh();
 assert.equal(ui.all().find(e=>e.tagName==='PRE').textContent,instructions);
 assert.equal(ui.all().filter(e=>e.tagName==='SCRIPT').length,0);
 const toggle=ui.all().find(e=>e.type==='checkbox');toggle.checked=false;
 await toggle.emit('change');
 assert.equal(toggle.checked,true);assert.equal(toggle.disabled,false);
 assert.equal(ui.document.getElementById('skills-status').textContent,'Not allowed');
 assert.equal(ui.button('Utiliser').disabled,false);
 assert.equal(ui.requests[1].path,'/api/skills/review?root=C%3A%5Cproject');
});
test('Daybreak settings restore the server-confirmed program and custom selector after a failed save',async()=>{
 const ui=setup(request=>request.method==='PUT'?{error:'Save refused'}:{program:'daybreak_blue',lastRequest:null});
 const select=ui.document.getElementById('cyber-program');let refreshes=0;select._customSelectRefresh=()=>refreshes++;
 await ui.context.window.ZaalisSkills.access();assert.equal(select.value,'daybreak_blue');
 select.value='daybreak_red';await select.emit('change');
 assert.equal(select.value,'daybreak_blue');assert.equal(select.disabled,false);assert.equal(refreshes,2);
 assert.equal(ui.document.getElementById('cyber-status').textContent,'Save refused');
});
