'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {settle}=require('./helpers/frontend-dom');
function setup({failStorage=false,failServer=false}={}){
  const requests=[],controls={};
  for(const id of ['settings-theme-select','gguf-ctx-input']) controls[id]={tagName:id==='gguf-ctx-input'?'INPUT':'SELECT',type:'text',value:id==='gguf-ctx-input'?'32768':'light',listeners:new Map(),addEventListener(name,fn){this.listeners.set(name,fn);}};
  const state={language:'fr',config:{theme:'dark',ggufCtx:16384}};
  const context={state,document:{getElementById:id=>controls[id],dispatchEvent(){}},window:{ZaalisUI:{text:fr=>fr},ZaalisSettings:{status:{dataset:{}}}},
    clampGgufCtx:Number,sharedHardwareConfigPayload:()=>({ggufCtx:state.config.ggufCtx}),applyAppearance(){},saveState(){if(failStorage)throw new Error('Storage unavailable');},setPermissionMode(){},setLanguage(){},
    fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:!failServer,json:async()=>({error:failServer?'Offline':undefined})};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../interface/script/settings-persistence.js'),'utf8'),context);
  return{context,controls,state,requests};
}
test('appearance autosave never writes credentials or MCP configuration',async()=>{
  const ui=setup();ui.controls['settings-theme-select'].listeners.get('change')();await settle();
  assert.equal(ui.state.config.theme,'light');assert.equal(ui.requests.length,0);assert.equal(ui.context.window.ZaalisSettings.status.textContent,'Enregistré');
});
test('failed preference saves restore the last confirmed value and expose the error',async()=>{
  const ui=setup({failStorage:true});ui.controls['settings-theme-select'].listeners.get('change')();await settle();
  assert.equal(ui.state.config.theme,'dark');assert.equal(ui.controls['settings-theme-select'].value,'dark');assert.equal(ui.context.window.ZaalisSettings.status.dataset.error,'true');
});
test('hardware save is scoped to the runtime endpoint and rolls back on failure',async()=>{
  const ui=setup({failServer:true});ui.controls['gguf-ctx-input'].listeners.get('blur')();await settle();
  assert.equal(ui.state.config.ggufCtx,16384);assert.deepEqual(ui.requests.map(r=>r.url),['/api/config']);assert.equal(ui.controls['gguf-ctx-input'].disabled,false);
});
