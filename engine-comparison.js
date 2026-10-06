'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
function compareRuns(baseline,candidate) {
  for(const k of ['caseId','sourceHash','model','criteriaHash'])if(!baseline[k]||baseline[k]!==candidate[k])throw new Error('Références non comparables : '+k);
  for(const r of [baseline,candidate]) {
    if(r.measured!==true||r.passed!==true||r.synthetic===true)throw new Error('Référence non mesurée ou résultat non validé.');
    for(const k of ['input','output','durationMs'])if(!Number.isSafeInteger(r[k])||r[k]<0)throw new Error('Mesure invalide.');
  }
  const reference=baseline.input+baseline.output,actual=candidate.input+candidate.output;
  return {caseId:baseline.caseId,model:baseline.model,reference,actual,saved:reference-actual,percent:reference?(reference-actual)/reference*100:null,durationMs:{reference:baseline.durationMs,actual:candidate.durationMs},basis:'paired_measured',ts:Date.now()};
}
function comparisonSummary(dataDir,user,from,to) {
  const root=path.join(dataDir,'engine-comparisons',crypto.createHash('sha256').update(String(user)).digest('hex'));
  const pairs=[];let rejected=0;
  if(fs.existsSync(root))for(const f of fs.readdirSync(root).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f))) {
    try {const item=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
      if(item.ts>=from&&item.ts<to) {const comparison=compareRuns(item.baseline,item.candidate);pairs.push({...comparison,ts:item.ts});}
    }catch{rejected++;}
  }
  const reference=pairs.reduce((n,p)=>n+p.reference,0),actual=pairs.reduce((n,p)=>n+p.actual,0);
  return {count:pairs.length,rejected,reference,actual,saved:reference-actual,percent:reference?(reference-actual)/reference*100:null,basis:pairs.length?'paired_measured':'unavailable',pairs};
}
function recordPair(dataDir,user,baseline,candidate) {
  const comparison=compareRuns(baseline,candidate),root=path.join(dataDir,'engine-comparisons',crypto.createHash('sha256').update(String(user)).digest('hex'));
  fs.mkdirSync(root,{recursive:true});const file=path.join(root,crypto.randomUUID()+'.json');
  require('./laboratory').atomic(file,{ts:comparison.ts,baseline,candidate});return {file,comparison};
}
module.exports={compareRuns,comparisonSummary,recordPair};
