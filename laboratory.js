'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitize } = require('./secrets-mask');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const excluded = name => ['.git','node_modules','target','server-data','.zaalis','.codex','.tmp','.ssh','.aws','.azure','.gnupg','.npmrc','.pypirc','.netrc','.git-credentials','id_rsa','id_ed25519'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
function fingerprint(root) {
  const digest=crypto.createHash('sha256'); let bytes=0, files=0;
  const walk=(dir,rel='')=> { for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(excluded(e.name)||e.isSymbolicLink())continue;
    const p=path.join(dir,e.name),r=rel+'/'+e.name;
    if(e.isDirectory())walk(p,r);
    else if(e.isFile()) { const b=fs.readFileSync(p); bytes+=b.length;files++;if(bytes>256*1024*1024||files>12000)throw new Error('Projet supérieur aux limites du laboratoire.');digest.update(r);digest.update('\0');digest.update(hash(b)); }
  }}; walk(root);return {hash:digest.digest('hex'),files,bytes};
}
function atomic(file,value) { const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));try{fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);} }
function text(v,max=32000) { if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw new Error('Texte de laboratoire invalide.');return v; }
function validatePlan(input) {
  const p={system:input.system||'linux',templateId:input.templateId||null,network:input.network||'isolated',problem:text(input.problem,3000),strategy:input.strategy||'economy',parallel:input.parallel??1,maxMs:input.maxMs??600000,setup:input.setup||[],outputs:input.outputs||[],hypotheses:input.hypotheses,finalChecks:input.finalChecks};
  if(!['linux','windows'].includes(p.system)||!['isolated','internet'].includes(p.network)||!['economy','balanced','deep'].includes(p.strategy))throw new Error('Configuration du laboratoire invalide.');
  if(!Number.isInteger(p.parallel)||p.parallel<1||p.parallel>2||!Number.isInteger(p.maxMs)||p.maxMs<1000||p.maxMs>1200000)throw new Error('Budget du laboratoire invalide.');
  if(p.system==='windows')p.parallel=1;if(p.strategy==='economy')p.parallel=1;
  const commands=a=>{if(!Array.isArray(a)||a.length>8)throw new Error('Trop de commandes de préparation.');return a.map(c=>text(c));};p.setup=commands(p.setup);
  const checks=a=>{if(!Array.isArray(a)||a.length<1||a.length>8)throw new Error('Un test explicite au minimum est requis.');return a.map(c=>{
    const v={command:text(c.command),expectedExit:c.expectedExit??0,contains:c.contains??null};
    if(!Number.isInteger(v.expectedExit)||v.expectedExit<0||v.expectedExit>255||v.contains!==null&&(typeof v.contains!=='string'||!v.contains||v.contains.length>2000))throw new Error('Assertion de test invalide.');return v;
  });};
  if(!Array.isArray(p.hypotheses)||p.hypotheses.length<1||p.hypotheses.length>4)throw new Error('Une à quatre hypothèses requises.');
  p.hypotheses=p.hypotheses.map((h,i)=>({id:'h'+(i+1),label:text(h.label,300),changes:commands(h.changes||[]),checks:checks(h.checks)}));
  p.finalChecks=checks(p.finalChecks);
  if(!Array.isArray(p.outputs)||p.outputs.length>8)throw new Error("Huit fichiers produits au maximum.");
  p.outputs=p.outputs.map(v=>{text(v,512);if(v.includes("\\")||v.startsWith("/")||v.split("/").some(part=>!part||part==="."||part===".."||excluded(part))||/[:\r\n]/.test(v))throw new Error("Chemin de résultat invalide.");return v;});
  return p;
}
class Laboratory {
  constructor({dataDir,vm,terminals}) {
    this.root=path.join(dataDir,'laboratory');fs.mkdirSync(this.root,{recursive:true});this.vm=vm;this.terminals=terminals;this.active=new Map();
    // A daemon restart never replays an uncertain command.
    for(const user of fs.readdirSync(this.root)) { const d=path.join(this.root,user);if(!fs.lstatSync(d).isDirectory()||fs.lstatSync(d).isSymbolicLink())continue;
      for(const f of fs.readdirSync(d).filter(x=>/^[0-9a-f-]{36}\.json$/.test(x))) {const file=path.join(d,f);try{const r=JSON.parse(fs.readFileSync(file));if(['queued','running','verifying'].includes(r.status)){r.status='interrupted';r.finished=Date.now();atomic(file,r);}}catch(e){console.error('Laboratoire: dossier illisible',e.code||e.message);}}
    }
  }
  dir(user) { const d=path.join(this.root,hash(String(user)));fs.mkdirSync(d,{recursive:true});return d; }
  file(user,id) { if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Expérience inconnue.');return path.join(this.dir(user),id+'.json'); }
  get(user,id) { const file=this.file(user,id);if(!fs.existsSync(file))throw new Error('Expérience inconnue.');return JSON.parse(fs.readFileSync(file,'utf8')); }
  save(user,r) { atomic(this.file(user,r.id),r); }
  compact(r) {return {...r,project:undefined,plan:undefined,attempts:r.attempts.map(a=>({...a,checks:(a.checks||[]).map(c=>({...c,output:c.output?.slice(-2000)}))}))};}
  list(user, all = false) {return fs.readdirSync(this.dir(user)).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f)).map(f=>all ? this.get(user,f.slice(0,-5)) : this.compact(this.get(user,f.slice(0,-5)))).sort((a,b)=>b.started-a.started).slice(0,all ? Infinity : 100);}
  async create(user,input,project) {
    if(!project||!fs.statSync(project).isDirectory())throw new Error('Sélectionnez un projet pour le laboratoire.');
    if([...this.active.values()].filter(a=>a.user===user).length>=1)throw new Error('Une mission de laboratoire est déjà en cours.');
    const plan=validatePlan(input),fp=fingerprint(project);
    if(plan.templateId)this.vm.templates.get(user,plan.templateId);
    const r={id:crypto.randomUUID(),problem:sanitize(plan.problem),project:path.resolve(project),fingerprint:fp.hash,environment:hash(JSON.stringify({system:plan.system,network:plan.network,setup:plan.setup,templateId:plan.templateId})),plan,status:'queued',started:Date.now(),attempts:[],winner:null,final:null};
    const task={user,cancelled:false,vms:new Set()};this.active.set(r.id,task);this.save(user,r);
    task.promise=this.run(user,r,task).catch(e=>{r.status=task.cancelled?'cancelled':'infrastructure_error';r.error=sanitize(e.message);r.finished=Date.now();this.save(user,r);}).finally(()=>this.active.delete(r.id));
    return this.compact(r);
  }
  async cancel(user,id) {this.get(user,id);const task=this.active.get(id);if(!task)return this.compact(this.get(user,id));task.cancelled=true;await Promise.allSettled([...task.vms].map(s=>this.vm.stop(s,this.terminals)));await task.promise;return this.compact(this.get(user,id));}
  async run(user,r,task) {
    const deadline=r.started+r.plan.maxMs;
    const check=()=>{if(task.cancelled)throw new Error('Expérience annulée.');if(Date.now()>=deadline)throw new Error('Budget de temps épuisé.');};
    const perform=async(h,final=false)=> {
      const a={hypothesis:h.id,label:h.label,status:'running',started:Date.now(),checks:[]};if(!final)r.attempts.push(a);else r.final=a;this.save(user,r);
      let s;
      try {
        check();const machine=await this.vm.create(user,{system:r.plan.system,network:r.plan.network,templateId:r.plan.templateId,name:'Lab · '+h.label.slice(0,40)});s=this.vm.get(machine.id,user);task.vms.add(s);a.machine=s.id;this.save(user,r);
        await this.vm.wait(s,()=>{check();return s.status==='ready';},Math.min(200000,deadline-Date.now()));
        check();const imported=await this.vm.importProject(s,r.project);
        if(imported.fingerprint && imported.fingerprint!==r.fingerprint)throw new Error('Projet modifié pendant le démarrage : relancez depuis un état stable.');
        const wrap=cmd=>r.plan.system==='linux'?`cd /home/zaalis/workspace && ( ${cmd}\n)`:`Set-Location -LiteralPath 'C:\\workspace'; ${cmd}`;
        for(const cmd of [...r.plan.setup,...h.changes]) {check();const result=await this.vm.exec(s,wrap(cmd),{timeoutMs:Math.min(120000,deadline-Date.now())});if(result.timedOut||result.transportError||result.exitCode!==0)throw new Error('Préparation impossible : '+result.output.slice(-1500));}
        for(const assertion of final?r.plan.finalChecks:h.checks) {check();const t=Date.now();const result=await this.vm.exec(s,wrap(assertion.command),{timeoutMs:Math.min(120000,deadline-Date.now())});
          const output=sanitize(String(result.output||''));const log=crypto.randomUUID()+'.log';fs.writeFileSync(path.join(this.dir(user),log),output);
          const evidence={command:assertion.command,expectedExit:assertion.expectedExit,contains:assertion.contains,exitCode:result.exitCode,timedOut:!!result.timedOut,durationMs:Date.now()-t,output:output.slice(-6000),log,sha256:hash(output),passed:!result.timedOut&&!result.transportError&&result.exitCode===assertion.expectedExit&&(!assertion.contains||output.includes(assertion.contains))};
          a.checks.push(evidence);this.save(user,r);if(!evidence.passed){a.status=result.timedOut?'infrastructure_error':'refuted';return a;}
        }
        if(final) {
          a.artifacts=[];
          for(const relative of r.plan.outputs) {
            check();const guest=r.plan.system==='linux'?'/home/zaalis/workspace/'+relative:'C:\\workspace\\'+relative.replaceAll('/','\\');
            const result=await this.vm.exportFile(s,guest),source=(s.artifacts||[]).find(x=>x.id===result.artifact.id);
            if(!source||fs.lstatSync(source.path).isSymbolicLink())throw new Error('Fichier produit invalide.');
            const id=crypto.randomUUID(),dest=path.join(this.dir(user),id+'.artifact');fs.copyFileSync(source.path,dest);
            const bytes=fs.readFileSync(dest),original=path.join(s.system==='windows'?s.inputDir:s.dir,'project-copy',...relative.split('/'));
            const baseHash=fs.existsSync(original)?hash(fs.readFileSync(original)):null;
            a.artifacts.push({id,path:relative,bytes:bytes.length,sha256:hash(bytes),baseHash});this.save(user,r);
          }
        }
        a.status='passed';return a;
      } catch(e) {a.status=task.cancelled?'cancelled':'infrastructure_error';a.error=sanitize(e.message);return a;}
      finally {if(s){try{await this.vm.stop(s,this.terminals);if(this.vm.discard)await this.vm.discard(s);}catch(e){a.status='infrastructure_error';a.error=sanitize(e.message);}task.vms.delete(s);}a.finished=Date.now();this.save(user,r);}
    };
    r.status='running';this.save(user,r);
    // Exact source and recipe matches may reorder a plan, never skip evidence.
    const history=this.list(user).filter(x=>x.id!==r.id&&x.fingerprint===r.fingerprint&&x.environment===r.environment&&x.problem===r.problem&&x.status==='verified');
    const labels=history.map(x=>x.attempts.find(a=>a.hypothesis===x.winner)?.label);
    const hypotheses=[...r.plan.hypotheses].sort((a,b)=>Number(labels.includes(b.label))-Number(labels.includes(a.label)));
    r.memoryMatches=history.length;
    for(let i=0;i<hypotheses.length;i+=r.plan.parallel) {
      check();const wave=await Promise.all(hypotheses.slice(i,i+r.plan.parallel).map(h=>perform(h)));
      const winner=wave.find(a=>a.status==='passed');
      if(winner){r.winner=winner.hypothesis;break;}
    }
    if(task.cancelled)r.status='cancelled';
    else if(r.winner) {check();r.status='verifying';this.save(user,r);const h=r.plan.hypotheses.find(h=>h.id===r.winner);const final=await perform(h,true);r.status=final.status==='passed'?'verified':final.status==='refuted'?'final_failed':'infrastructure_error';}
    else r.status=r.attempts.some(a=>a.status==='infrastructure_error')?'inconclusive':'refuted';
    r.finished=Date.now();this.save(user,r);
  }
  recall(user,problem,project) {const fp=fingerprint(project);const words=new Set(text(problem,3000).toLowerCase().split(/\W+/).filter(x=>x.length>3));return this.list(user,true).map(r=>({record:r,score:r.problem.toLowerCase().split(/\W+/).filter(x=>words.has(x)).length,exactSource:r.fingerprint===fp.hash})).filter(x=>x.score>0).sort((a,b)=>Number(b.exactSource)-Number(a.exactSource)||b.score-a.score).slice(0,5);}
  evidence(user,id,log) {const r=this.get(user,id);if(![...r.attempts,r.final].filter(Boolean).some(a=>a.checks.some(c=>c.log===log)))throw new Error('Preuve inconnue.');return path.join(this.dir(user),log);}
  artifact(user,id,artifact) {const r=this.get(user,id);const a=r.final?.artifacts?.find(x=>x.id===artifact);if(!a)throw new Error('Fichier produit inconnu.');return {record:r,artifact:a,file:path.join(this.dir(user),a.id+'.artifact')};}
  apply(user,id,project) {
    const r=this.get(user,id);
    if(r.status!=='verified'||!r.final?.artifacts?.length)throw new Error('Aucun candidat vérifié à intégrer.');
    if(!project||fs.realpathSync(project)!==fs.realpathSync(r.project)||fingerprint(project).hash!==r.fingerprint)throw new Error('Le projet a changé : retestez avant intégration.');
    const root=fs.realpathSync(project),edits=[];
    for(const a of r.final.artifacts) {
      const parts=a.path.split('/');let dir=root;
      const stat=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
      for(const part of parts.slice(0,-1)) {dir=path.join(dir,part);const s=stat(dir);if(s&&(!s.isDirectory()||s.isSymbolicLink()))throw new Error('Chemin de résultat non sûr.');}
      const target=path.join(root,...parts),s=stat(target);if(s&&(!s.isFile()||s.isSymbolicLink()))throw new Error('Cible non sûre.');
      const before=fs.existsSync(target)?fs.readFileSync(target):null,content=fs.readFileSync(this.artifact(user,id,a.id).file);
      if((before?hash(before):null)!==a.baseHash||hash(content)!==a.sha256)throw new Error('Le fichier ou sa preuve a changé.');
      edits.push({target,before,content});
    }
    const backup=path.join(this.dir(user),r.id+'.backup');fs.mkdirSync(backup,{recursive:true});
    for(let i=0;i<edits.length;i++)if(edits[i].before)fs.writeFileSync(path.join(backup,String(i)),edits[i].before);
    atomic(path.join(backup,'manifest.json'),{files:edits.map((e,i)=>({index:i,path:path.relative(root,e.target),existed:e.before!==null}))});
    const applied=[];
    try {for(const e of edits){fs.mkdirSync(path.dirname(e.target),{recursive:true});const tmp=e.target+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,e.content);fs.renameSync(tmp,e.target);applied.push(e);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}}
    catch(e){for(const v of applied.reverse())if(v.before)fs.writeFileSync(v.target,v.before);else fs.unlinkSync(v.target);throw e;}
    r.applied={ts:Date.now(),files:r.final.artifacts.map(a=>a.path),hostRetested:false};this.save(user,r);
    return {summary:'Fichiers vérifiés intégrés. Sauvegarde conservée ; validation sur le PC hôte non exécutée.',files:r.applied.files};
  }
  async shutdown() {await Promise.allSettled([...this.active].map(([id,t])=>this.cancel(t.user,id)));}
  async action(user,input,project) {switch(input.action){case 'apply':return this.apply(user,input.id,project);case 'list':return {summary:'Expériences du laboratoire',experiments:this.list(user)};case 'recall':return {summary:'Pistes mémorisées à retester',matches:this.recall(user,input.problem,project)};case 'run':return {summary:'Expérience démarrée ; consulter status avec waitMs=30000 pour éviter les appels inutiles',experiment:await this.create(user,input,project)};case 'status':{
    this.get(user,input.id);const task=this.active.get(input.id),wait=input.waitMs??0;
    if(!Number.isInteger(wait)||wait<0||wait>30000)throw new Error('Attente invalide.');
    if(task&&wait){let timer;try{await Promise.race([task.promise,new Promise(resolve=>{timer=setTimeout(resolve,wait);})]);}finally{clearTimeout(timer);}}
    return {summary:'État de l’expérience',experiment:this.compact(this.get(user,input.id))};
  }case 'cancel':return {summary:'Expérience annulée',experiment:await this.cancel(user,input.id)};default:throw new Error('Action laboratoire inconnue.');}}
}
module.exports={Laboratory,validatePlan,fingerprint,excluded,atomic};
