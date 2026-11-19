'use strict';
// Native differences imported from the former Linux/macOS branches. Shared
// auth, agent permissions and the UI remain in one implementation on main.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile,execFileSync,spawn}=require('node:child_process');
const paths=platform=>platform==='win32'?path.win32:path.posix;
function dataDir(appDir,packaged,platform=process.platform,env=process.env,home=os.homedir()){
 const p=paths(platform);if(env.ZAALIS_DATA_DIR)return path.resolve(env.ZAALIS_DATA_DIR);
 if(packaged){if(platform==='win32'&&env.LOCALAPPDATA)return p.join(env.LOCALAPPDATA,'zaalis','server-data');if(platform==='darwin')return p.join(home,'Library','Application Support','zaalis','server-data');if(platform==='linux')return p.join(env.XDG_DATA_HOME||p.join(home,'.local','share'),'zaalis','server-data');}return p.join(appDir,'server-data');
}
function environment(platform=process.platform,env=process.env,home=os.homedir()){
 if(platform==='win32')return {...env};const extra=platform==='darwin'?['/opt/homebrew/bin','/opt/homebrew/sbin','/usr/local/bin','/usr/local/sbin']:['/usr/local/bin','/usr/local/sbin'];
 return {...env,PATH:[...new Set([...String(env.PATH||'').split(':'),...extra,'/usr/bin','/bin','/usr/sbin','/sbin',path.posix.join(home,'.local','bin')].filter(Boolean))].join(':')};
}
function browserDir(platform=process.platform,env=process.env,home=os.homedir()){
 const p=paths(platform);if(platform==='win32')return p.join(env.APPDATA||p.join(home,'AppData','Roaming'),'zaalis','Browser');if(platform==='darwin')return p.join(home,'Library','Application Support','zaalis','Browser');return p.join(env.XDG_CONFIG_HOME||p.join(home,'.config'),'zaalis','Browser');
}
function normalizeEngine(variant,platform=process.platform,fallback='cpu'){
 const v=String(variant||'').toLowerCase();if(platform==='darwin')return v==='cpu'?'cpu':'metal';if(platform==='linux')return ['rocm','vulkan','cpu'].includes(v)?v:['cuda','metal'].includes(v)?'vulkan':fallback;return ['cuda','vulkan','cpu'].includes(v)?v:fallback;
}
function detectPosixEngine(){
 if(process.platform==='darwin')return 'metal';let names='';for(const bin of ['lspci','lshw']){try{names=execFileSync(bin,bin==='lshw'?['-C','display']:[],{timeout:9000,env:environment(),stdio:['ignore','pipe','ignore']}).toString();if(names)break;}catch{}}
 if(/amd|radeon/i.test(names)&&['/opt/rocm/lib/libamdhip64.so','/opt/rocm/lib64/libamdhip64.so'].some(p=>fs.existsSync(p)))return 'rocm';return /nvidia|geforce|rtx|quadro|tesla|amd|radeon|intel.*(?:vga|graphics)|arc|iris/i.test(names)?'vulkan':'cpu';
}
function engineAssets(tag,variant,platform=process.platform,arch=process.arch){
 const base=`https://github.com/ggml-org/llama.cpp/releases/download/${tag}/`;
 if(platform==='darwin')return [base+`llama-${tag}-bin-macos-${arch==='arm64'?'arm64':'x64'}.tar.gz`];
 if(platform==='linux'){if(arch!=='x64')throw Error('Les archives Linux configurées ciblent x64.');const suffix=variant==='rocm'?'-rocm-7.2-x64':variant==='vulkan'?'-vulkan-x64':'-x64';return [base+`llama-${tag}-bin-ubuntu${suffix}.tar.gz`];}throw Error('Utilisez les archives Windows natives.');
}
const engineBinary=()=>process.platform==='win32'?'llama-server.exe':'llama-server';
function extractPosix(archive,destination){const args=/\.(tar\.gz|tgz)$/i.test(archive)?['tar',['-xzf',archive,'-C',destination]]:['unzip',['-q','-o',archive,'-d',destination]];execFileSync(args[0],args[1],{timeout:300000,env:environment()});}
function executable(file){if(process.platform!=='win32'&&file)fs.chmodSync(file,0o755);return file;}
function openExternal(url){const child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{detached:true,stdio:'ignore',env:environment()});child.on('error',()=>{});child.unref();return true;}
function pickFolder(res){const pickers=process.platform==='darwin'?[['osascript',['-e','POSIX path of (choose folder with prompt "Choisissez le dossier du projet")']]]:[['zenity',['--file-selection','--directory','--title=Choisissez le dossier du projet']],['kdialog',['--getexistingdirectory',os.homedir()]],['qarma',['--file-selection','--directory']]];
 const next=index=>{if(index>=pickers.length)return res.status(501).json({error:'Aucun sélecteur de dossier disponible. Installez zenity ou kdialog.'});const [bin,args]=pickers[index];execFile(bin,args,{timeout:180000,env:environment()},(error,stdout)=>{if(error&&(error.code==='ENOENT'||error.code===127))return next(index+1);if(error&&(error.code===1||/User canceled|-128/i.test(error.message)))return res.json({cancelled:true});if(error)return res.status(500).json({error:error.message});const selected=String(stdout||'').trim();res.json(selected?{path:selected}:{cancelled:true});});};next(0);
}
function updateAsset(name,platform=process.platform,arch=process.arch){if(platform==='win32')return /^zaalis-setup.*\.exe$/i.test(name)||/\.exe$/i.test(name);if(platform==='darwin')return new RegExp(`macos-${arch==='arm64'?'arm64':'x64'}.*\\.dmg$`,'i').test(name);return /linux.*(?:\.deb|\.AppImage)$/i.test(name);}
function updateExtension(url,platform=process.platform){const file=new URL(url).pathname;if(platform==='win32'&&/\.exe$/i.test(file))return '.exe';if(platform==='darwin'&&/\.dmg$/i.test(file))return '.dmg';if(platform==='linux'&&/\.deb$/i.test(file))return '.deb';if(platform==='linux'&&/\.AppImage$/i.test(file))return '.AppImage';throw Error('Le paquet de mise à jour ne correspond pas à cette plateforme.');}
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function linuxUpdateScript(installer,scriptPath,log,relaunch,appImage){
 const image=/\.AppImage$/i.test(installer);const install=image?(appImage?`cp -f ${quote(installer)} ${quote(appImage)} && chmod +x ${quote(appImage)} || fallback`:`chmod +x ${quote(installer)}; fallback`):`pkexec env DEBIAN_FRONTEND=noninteractive sh -c 'apt-get install -y --allow-downgrades "$1" || dpkg -i "$1"' sh ${quote(installer)} || fallback`;
 return ['#!/bin/sh',`exec >>${quote(log)} 2>&1`,'fallback() {',`xdg-open ${quote(installer)} 2>/dev/null || true`,`rm -f ${quote(scriptPath)}`,'exit 0','}','sleep 1','pkill -x zaalis-agentd 2>/dev/null || true','pkill -x zaalis-server 2>/dev/null || true','pkill -x zaalis-ide 2>/dev/null || true','sleep 2',install,relaunch?`setsid ${quote(relaunch)} >/dev/null 2>&1 &`:'',`rm -f ${quote(scriptPath)}`,''].join('\n');
}
function installPosixUpdate(installer,appDir){
 if(!installer||!fs.existsSync(installer))throw Error('Téléchargez le paquet avant de lancer la mise à jour.');updateExtension('https://github.com/'+path.basename(installer));
 if(process.platform==='darwin'){openExternal(installer);return {success:true,installerPath:installer,silent:false};}
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-update-')),script=path.join(work,'runner.sh'),log=path.join(work,'update.log'),relaunch=process.env.APPIMAGE||process.env.ZAALIS_SHELL_EXE||path.join(appDir,'../../../zaalis-ide');
 fs.writeFileSync(script,linuxUpdateScript(installer,script,log,fs.existsSync(relaunch)?relaunch:'',process.env.APPIMAGE),{mode:0o700});const child=spawn('sh',[script],{detached:true,stdio:'ignore',env:environment()});child.on('error',()=>{});child.unref();return {success:true,installerPath:installer,silent:true,log};
}
function startPosixOllama(){const candidates=process.platform==='darwin'?['/Applications/Ollama.app/Contents/Resources/ollama','/opt/homebrew/bin/ollama','/usr/local/bin/ollama']:['/usr/local/bin/ollama','/usr/bin/ollama',path.join(os.homedir(),'.local/bin/ollama')];const exe=candidates.find(p=>fs.existsSync(p))||'ollama';const child=spawn(exe,['serve'],{detached:true,stdio:'ignore',env:environment()});child.on('error',()=>{});child.unref();}
module.exports={dataDir,environment,browserDir,normalizeEngine,detectPosixEngine,engineAssets,engineBinary,extractPosix,executable,openExternal,pickFolder,updateAsset,updateExtension,linuxUpdateScript,installPosixUpdate,startPosixOllama};
