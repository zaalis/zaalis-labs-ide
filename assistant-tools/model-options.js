'use strict';
// The IDE and terminal receive these facts from /api/model-capabilities.
function reasoningOptions(capabilities) {
  if(capabilities?.reasoning?.supported && Array.isArray(capabilities.reasoning.levels) && capabilities.reasoning.levels.length)
    return capabilities.reasoning.levels.map(item=>({label:String(item.id||item.label).toUpperCase(),level:Number(item.value)}));
  return [{label:!capabilities?'INDISPONIBLE':capabilities.reasoning?.mode==='native'?'NATIF':'OFF',level:0}];
}
module.exports={reasoningOptions};
