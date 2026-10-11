'use strict';
const {fail}=require('./common');
function binding(v){if(v==null)return null;if(typeof v.provider!=='string'||!v.provider.trim()||v.provider.length>128||typeof v.model!=='string'||!v.model.trim()||v.model.length>250)throw fail('Choose a provider and a model for each slot.');return {provider:v.provider,model:v.model,reasoning:Number.isInteger(v.reasoning)?Math.min(7,Math.max(0,v.reasoning)):0};}
function validate(input={}){
  const fallback=input.fallback||[];const references=input.moa?.references||[];
  if(!Array.isArray(fallback)||fallback.length>8||!Array.isArray(references)||references.length>8)throw fail('At most eight fallback or reference models.');
  const value={main:binding(input.main),auxiliary:binding(input.auxiliary),fallback:fallback.map(binding),moa:{enabled:input.moa?.enabled===true,fanout:input.moa?.fanout==='per_iteration'?'per_iteration':'user_turn',references:references.map(binding),aggregator:binding(input.moa?.aggregator)}};
  if(value.fallback.some(v=>!v)||value.moa.references.some(v=>!v))throw fail('Empty model slots are not allowed.');
  if(value.moa.enabled&&(!references.length||!value.moa.aggregator))throw fail('MoA requires reference models and an aggregator.');
  return value;
}
class ModelPolicy {
  constructor(store){this.store=store;}
  get(user){return validate(this.store.read(user,'model-policy',{}));}
  save(user,input){const value=validate(input);this.store.write(user,'model-policy',value);return value;}
  async saveWithCapabilities(user,input,resolve){
    const value=validate(input),cache=new Map();
    const normalize=async b=>{if(!b)return;const key=b.provider+'\0'+b.model;if(!cache.has(key))cache.set(key,resolve(b));const facts=await cache.get(key);const levels=facts?.reasoning?.supported?facts.reasoning.levels?.map(v=>v.value)||[]:[];if(!levels.includes(b.reasoning))b.reasoning=levels.length?levels.reduce((a,v)=>Math.abs(v-b.reasoning)<Math.abs(a-b.reasoning)?v:a,levels[0]):0;};
    await Promise.all([value.main,value.auxiliary,...value.fallback,...value.moa.references,value.moa.aggregator].map(normalize));
    this.store.write(user,'model-policy',value);return value;
  }
  runtime(user,main,resolve){const p=this.get(user);return {main:resolve(main),fallback:p.fallback.map(resolve),moa:{...p.moa,references:p.moa.references.map(resolve),aggregator:p.moa.aggregator&&resolve(p.moa.aggregator)}};}
}
module.exports={ModelPolicy,validate,binding};
