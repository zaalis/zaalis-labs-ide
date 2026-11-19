'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const owner=u=>crypto.createHash('sha256').update(String(u)).digest('hex');
class VmTemplates {
 constructor(root){this.root=path.join(root,'templates');fs.mkdirSync(this.root,{recursive:true});}
 dir(user){const d=path.join(this.root,owner(user));fs.mkdirSync(d,{recursive:true});return d;}
 list(user){return fs.readdirSync(this.dir(user)).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f)).map(f=>this.get(user,f.slice(0,-5))).map(({image,...v})=>v);}
 get(user,id){if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Environnement inconnu.');const dir=this.dir(user),file=path.join(dir,id+'.json');if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())throw Error('Environnement inconnu.');const metadata=JSON.parse(fs.readFileSync(file,'utf8')),image=path.join(dir,id+'.qcow2');if(!fs.existsSync(image)||fs.lstatSync(image).isSymbolicLink()||!fs.lstatSync(image).isFile())throw Error('Image d’environnement invalide.');return {...metadata,id,image};}
 async save(user,s,manager){
  if(s.userId!==user||s.system!=='linux')throw Error('Les environnements réutilisables nécessitent une VM Linux possédée.');
  if(s.status!=='ready')throw Error('La VM doit être prête avant de figer son environnement.');
  const prepared=await manager.exec(s,'sudo cloud-init clean --logs && sync');
  if(prepared.exitCode!==0||prepared.timedOut)throw Error('Impossible de préparer une identité propre pour le clone.');
  await manager.stop(s);const dir=this.dir(user),id=crypto.randomUUID(),image=path.join(dir,id+'.qcow2'),temp=image+'.tmp';
  try{await manager.convertDisk(path.join(s.dir,'disk.qcow2'),temp);fs.renameSync(temp,image);const value={id,name:s.name,created:Date.now(),bytes:fs.statSync(image).size,network:s.network,system:'linux'};fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(value));return value;}
  catch(e){for(const f of [temp,image])if(fs.existsSync(f))fs.unlinkSync(f);throw e;}
 }
}
module.exports={VmTemplates};
