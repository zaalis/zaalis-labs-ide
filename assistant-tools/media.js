'use strict';
const { fs, path, crypto, within, text, fail } = require('./common');
const { spawn } = require('node:child_process');
const { boundedJson } = require('./connections');
class MediaTools {
  constructor(connections, options) { this.connections = connections; this.analyze = options.analyze; this.fetch = connections.fetch; }
  async run(name, i, ctx) {
    if (name === 'vision_analyze' || name === 'video_analyze') {
      const file = within(ctx.root, text(i.path, 'path', 2048), true), images = [];
      let temporary;
      try {
        if (name === 'video_analyze') {
          temporary = path.join(ctx.root, '.zaalis', 'media', crypto.randomUUID()); fs.mkdirSync(temporary, { recursive: true });
          await program('ffmpeg', ['-nostdin','-v','error','-i',file,'-vf','fps=1/5,scale=1024:-1','-frames:v',String(Math.max(1,Math.min(12,Number(i.max_frames)||6))),path.join(temporary,'frame-%02d.jpg')], ctx);
          for (const frame of fs.readdirSync(temporary).filter(f=>/^frame-\d+\.jpg$/.test(f))) images.push(loadImage(path.join(temporary, frame)));
        } else images.push(loadImage(file));
        if (!images.length) throw fail('No video frames could be extracted.');
        return this.analyze(ctx, String(i.question || 'Describe and analyze these images precisely.'), images);
      } finally { if (temporary) for (const f of fs.readdirSync(temporary)) if (/^frame-\d+\.jpg$/.test(f)) fs.unlinkSync(path.join(temporary,f)); if (temporary) fs.rmdirSync(temporary); }
    }
    if (name === 'text_to_speech' && (i.provider || 'local') === 'local') {
      if (process.platform === 'linux') return linuxSpeech(i, ctx);
      if (process.platform !== 'win32') throw fail('Local speech requires Windows or Linux; configure an API speech provider.', 'service_unavailable', 503);
      const output = outputFile(ctx, i.output, 'wav'), script = path.join(path.dirname(output), crypto.randomUUID()+'.ps1');
      const quote = value => "'" + String(value).replace(/'/g,"''") + "'";
      fs.writeFileSync(script, `Add-Type -AssemblyName System.Speech\n$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry { ${i.voice ? '$speaker.SelectVoice('+quote(i.voice)+')' : ''}\n$speaker.SetOutputToWaveFile(${quote(output)})\n$speaker.Speak(${quote(text(i.text,'text',16000))})\n} finally { $speaker.Dispose() }`, 'utf8');
      try { await program('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],ctx); } finally { fs.unlinkSync(script); }
      return { path:output, format:'wav', bytes:fs.statSync(output).size, provider:'windows' };
    }
    const connection = this.connections.get(ctx.userId, 'media'), options = connection.options || {};
    if (name === 'text_to_speech') {
      const response = await this.api(connection, options.speechPath || '/audio/speech', { model:i.model || options.speechModel, voice:i.voice || 'alloy', input:text(i.text,'text',16000), response_format:'mp3' },ctx);
      const buffer = await boundedBytes(response, 16*1024*1024), output=outputFile(ctx,i.output,'mp3'); fs.writeFileSync(output,buffer); return {path:output,bytes:buffer.length,format:'mp3'};
    }
    if (name === 'speech_to_text') {
      const file=within(ctx.root,text(i.path,'path',2048),true); if(fs.statSync(file).size>25*1024*1024)throw fail('Audio limit is 25 MiB.');
      const form=new FormData(); form.append('file',new Blob([fs.readFileSync(file)]),path.basename(file)); form.append('model',i.model||options.transcriptionModel||'whisper-1'); if(i.language)form.append('language',i.language);
      return boundedJson(await this.api(connection,options.transcriptionPath||'/audio/transcriptions',form,ctx));
    }
    if (name === 'image_generate') {
      let body={model:i.model||options.imageModel,prompt:text(i.prompt,'prompt',16000),size:i.size||'1024x1024',n:1,response_format:'b64_json'}, route=options.imagePath||'/images/generations';
      if(i.path) { const file=within(ctx.root,i.path,true), image=loadImage(file),form=new FormData(); form.append('image',new Blob([Buffer.from(image.data,'base64')],{type:image.mime}),path.basename(file)); for(const[k,v]of Object.entries(body))if(v!==undefined&&k!=='response_format')form.append(k,String(v)); body=form;route=options.imageEditPath||'/images/edits'; }
      const data=await boundedJson(await this.api(connection,route,body,ctx),30*1024*1024), outputs=[];
      for(const item of (data.data||[]).slice(0,4)) {
        const output=outputFile(ctx,null,'png');
        if(item.b64_json) { const bytes=Buffer.from(item.b64_json,'base64');if(bytes.length>20*1024*1024)throw fail('Image output limit.');fs.writeFileSync(output,bytes); }
        else if(item.url) { const url=new URL(item.url);if(url.protocol!=='https:'||url.username||url.password)throw fail('Invalid provider asset URL.'); const response=await this.fetch(url,{redirect:'error',signal:ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});if(!response.ok)throw fail('Provider asset download failed.');fs.writeFileSync(output,await boundedBytes(response,20*1024*1024)); }
        else continue;
        outputs.push({path:output,revised_prompt:item.revised_prompt});
      }
      if(!outputs.length)throw fail('Provider did not return an image.','provider_error',502); return {images:outputs};
    }
    if(name==='x_search')return boundedJson(await this.api(connection,options.responsesPath||'/responses',{model:i.model||options.searchModel||'grok-4',input:text(i.query,'query',16000),tools:[{type:'x_search'}]},ctx));
    if(['video_generate','xai_video_edit','xai_video_extend'].includes(name)) {
      if(i.action==='status')return boundedJson(await this.api(connection,(options.videoStatusPath||'/videos/')+encodeURIComponent(text(i.request_id,'request_id',200)),null,ctx,'GET'));
      const route=name==='xai_video_edit'?(options.videoEditPath||'/videos/edits'):name==='xai_video_extend'?(options.videoExtendPath||'/videos/extensions'):(options.videoPath||'/videos/generations');
      return boundedJson(await this.api(connection,route,{model:i.model||options.videoModel,prompt:text(i.prompt,'prompt',16000),...(i.video_url?{video:{url:i.video_url}}:{}),...(i.image_url?{image:{url:i.image_url}}:{}),...(i.duration?{duration:i.duration}:{})},ctx));
    }
    throw fail('Unknown media tool.');
  }
  api(connection, route, body, ctx, method) { return api(this.fetch, connection, route, body, ctx, method); }
}
function loadImage(file) { const mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif'}[path.extname(file).toLowerCase()];if(!mime)throw fail('Supported image formats: PNG/JPEG/WebP/GIF.');if(fs.statSync(file).size>12*1024*1024)throw fail('Image limit is 12 MiB.');return {mime,data:fs.readFileSync(file).toString('base64')}; }
function outputFile(ctx,relative,extension){ const target=within(ctx.root,relative||path.join('.zaalis','media',crypto.randomUUID()+'.'+extension));fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target))throw fail('Output already exists.');return target; }
async function api(fetcher,connection,route,body,ctx,method='POST') { const base=new URL(connection.baseUrl.replace(/\/$/,'')+'/'),url=new URL(route.replace(/^\//,''),base);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw fail('Invalid media route.'); const form=body instanceof FormData;
  const response=await fetcher(url,{method,redirect:'error',signal:ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),headers:{Authorization:'Bearer '+(connection.token||connection.apiKey||''),...(!form&&body?{'Content-Type':'application/json'}:{})},...(body?{body:form?body:JSON.stringify(body)}:{})});if(!response.ok)throw fail('Media provider HTTP '+response.status,'provider_error',502);return response; }
async function boundedBytes(response,limit){const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw fail('Media response too large.');chunks.push(chunk);}return Buffer.concat(chunks);}
// Linux: espeak-ng, the distribution's offline synthesizer, writes the WAV.
// The text goes through a file so it is never parsed as an option.
async function linuxSpeech(i,ctx){
  if(!speechEngine())throw fail('Local speech requires espeak-ng (sudo apt install espeak-ng) or an API speech provider.','service_unavailable',503);
  const output=outputFile(ctx,i.output,'wav'),input=path.join(path.dirname(output),crypto.randomUUID()+'.txt');
  const voice=String(i.voice||String(process.env.LANG||'').slice(0,2)||'en');
  if(!/^[A-Za-z0-9_+-]{1,64}$/.test(voice))throw fail('Invalid voice.');
  fs.writeFileSync(input,text(i.text,'text',16000),'utf8');
  try { await program(speechEngine(),['-v',voice,'-w',output,'-f',input],ctx); } finally { fs.unlinkSync(input); }
  return { path:output, format:'wav', bytes:fs.statSync(output).size, provider:'espeak-ng' };
}
function speechEngine(){return ['/usr/bin/espeak-ng','/usr/local/bin/espeak-ng','/usr/bin/espeak'].find(file=>fs.existsSync(file))||null;}
function program(command,args,ctx){return new Promise((resolve,reject)=>{const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT',...(process.platform==='win32'?[]:['HOME','LANG','LC_ALL','XDG_RUNTIME_DIR'])])if(process.env[key])env[key]=process.env[key];const child=spawn(command,args,{cwd:ctx.root,env,windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',v=>{error=(error+v).slice(-4000)});const abort=()=>child.kill(),timer=setTimeout(abort,120000);ctx.signal?.addEventListener('abort',abort,{once:true});child.once('error',done);child.once('close',code=>done(code===0?null:fail('Media helper failed: '+error,'service_unavailable',503)));function done(err){clearTimeout(timer);ctx.signal?.removeEventListener('abort',abort);err?reject(err):resolve();}});}
module.exports={MediaTools,loadImage,program,speechEngine};
