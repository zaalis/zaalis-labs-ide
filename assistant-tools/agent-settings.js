'use strict';
const {fail}=require('./common');
const DEFAULTS=Object.freeze({maxSteps:500,maxSubagents:10,subagentTurns:250});
function validate(input={}){
  const out={...DEFAULTS};
  for(const key of Object.keys(DEFAULTS))if(input[key]!==undefined){
    if(!Number.isInteger(input[key])||input[key]<1||input[key]>DEFAULTS[key])throw fail(`${key}: expected an integer from 1 to ${DEFAULTS[key]}.`);
    out[key]=input[key];
  }
  return out;
}
class AgentSettings {
  constructor(store){this.store=store;}
  get(user){return validate(this.store.read(user,'agent-settings',{}));}
  save(user,input){const value=validate({...this.get(user),...input});this.store.write(user,'agent-settings',value);return value;}
  budget(user,child=false){const v=this.get(user);return {max_rounds:child?v.subagentTurns:v.maxSteps,max_depth:3};}
}
module.exports={AgentSettings,DEFAULTS,validate};
