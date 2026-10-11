'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { crypto, fail, text, publicData, fs, path, within } = require('./common');
class ExecutionTools {
  constructor(connections) { this.connections = connections; this.processes = new Map(); }
  async run(name, input, ctx) {
    if (name === 'terminal_backend_manage') {
      let config; try { config = this.connections.get(ctx.userId, 'execution'); } catch { return { backends: [{id:'local',type:'native',available:true,tools:['terminal','run','process','pty','execute_code']}], connection_required:true }; }
      return { backends: [{id:'local',type:'native',available:true},...(config.options.backends || []).map(({ secret, ...row }) => ({ ...row, available: ['docker', 'ssh', 'singularity'].includes(row.type) ? executable(row.type) : row.type==='daytona'&&!row.endpoint?!!(row.sandbox_id&&config.tokens?.[row.id]):row.type==='modal'&&!row.endpoint?null:!!row.endpoint, ...(row.type==='modal'&&!row.endpoint?{dependency:'Python Modal SDK and an existing sandbox',status:'dependency_unverified'}:{}), adapter: row.endpoint&&['modal','daytona','rpc'].includes(row.type)?'owner_execution_gateway':row.type==='modal'?'modal_python_sdk':row.type==='daytona'?'daytona_toolbox_api':row.type }))] };
    }
    if (name === 'remote_process' || name === 'remote_process_manage') return this.manage(input, ctx);
    const config = this.connections.get(ctx.userId, 'execution'), backend = (config.options.backends || []).find(row => row.id === input.backend);
    if (!backend) throw fail('Choose an execution backend configured by the user.', 'connection_required', 409);
    const command = text(input.command, 'command', 64000); let program, args;
    if (backend.type === 'docker') { program = 'docker'; args = ['exec', text(backend.container, 'container', 120), 'sh', '-lc', command]; }
    else if (backend.type === 'ssh') { program = 'ssh'; if (!/^[a-zA-Z0-9_.@-]+$/.test(backend.host || '') || backend.host.startsWith('-')) throw fail('Invalid SSH target.'); args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', String(backend.port || 22), '--', backend.host, command]; }
    else if (backend.type === 'singularity') { program = 'singularity'; args = ['exec', text(backend.image, 'image', 2000), 'sh', '-lc', command]; }
    else if(backend.type==='daytona'&&!backend.endpoint)return require('./backends/cloud').daytona(this.connections,config,backend,input,ctx);
    else if(backend.type==='modal'&&!backend.endpoint){
      const credentials=config.tokens?.[backend.id];if(!credentials?.tokenId||!credentials?.tokenSecret)throw fail('Modal credentials tokenId/tokenSecret are required.','connection_required',409);
      const directory=within(ctx.root,'.zaalis/helpers');fs.mkdirSync(directory,{recursive:true});const helper=path.join(directory,'modal-'+crypto.randomUUID()+'.py');fs.writeFileSync(helper,fs.readFileSync(path.join(__dirname,'backends/modal.py')),{mode:0o600});
      try{return await this.start(backend.python||'python',['-I',helper],{...input,background:false},ctx,{stdin:JSON.stringify({action:'execute',sandbox_id:text(backend.sandbox_id,'sandbox_id',160),command,timeout:Math.ceil((input.timeout_ms||120000)/1000)}),environment:{MODAL_TOKEN_ID:credentials.tokenId,MODAL_TOKEN_SECRET:credentials.tokenSecret}});}finally{if(fs.existsSync(helper))fs.unlinkSync(helper);}
    }
    else if (['modal', 'daytona', 'rpc'].includes(backend.type)) {
      const url = new URL(backend.endpoint); if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw fail('Remote execution gateway requires HTTPS.');
      const response = await this.connections.fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(config.tokens?.[backend.id] ? { Authorization: 'Bearer ' + config.tokens[backend.id] } : {}) }, body: JSON.stringify({ action: 'execute', command, workspace: backend.workspace, timeout_ms: Math.min(1800000, input.timeout_ms || 120000) }), signal: AbortSignal.any([ctx.signal || new AbortController().signal, AbortSignal.timeout(Math.max(1000,Math.min(1800000,input.timeout_ms||120000)))]) });
      const result = await require('./connections').boundedJson(response); if (!response.ok) throw fail('Remote execution HTTP ' + response.status, 'provider_error', response.status); return result;
    } else throw fail('Unknown execution backend.');
    return this.start(program, args, input, ctx);
  }
  start(program, args, input, ctx, internal = {}) {
    if([...this.processes.values()].filter(r=>r.userId===ctx.userId&&r.status==='running').length>=16)throw fail('Remote process limit reached.','concurrency_limit',429);
    for(const[id,row]of this.processes)if(this.processes.size>=200&&row.status!=='running')this.processes.delete(id);
    const id = crypto.randomUUID(), env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    if(internal.environment)Object.assign(env,internal.environment);
    const child = spawn(program, args, { cwd: ctx.root, env, windowsHide: true, detached:process.platform!=='win32', stdio: [internal.stdin?'pipe':'ignore', 'pipe', 'pipe'] });
    if(internal.stdin){child.stdin.on('error',()=>{});child.stdin.end(internal.stdin);}
    const row = { id, userId: ctx.userId, root: ctx.root, child, output: '', status: 'running', startedAt: Date.now() }; this.processes.set(id, row);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { row.output = (row.output + bytes.toString()).slice(-1024 * 1024); });
    const done = new Promise(resolve => { child.on('error', error => { row.error = error.message; row.status = 'failed';clearTimeout(timer);ctx.signal?.removeEventListener('abort',cancel); resolve(this.snapshot(row)); }); child.on('close', code => { if(row.status!=='cancelled')row.status = code === 0 ? 'completed' : 'failed'; row.exitCode = code; clearTimeout(timer); ctx.signal?.removeEventListener('abort', cancel); resolve(this.snapshot(row)); }); });
    const cancel = () => { killTree(child); row.status = 'cancelled'; }, timer = setTimeout(cancel, Math.max(1000,Math.min(1800000, input.timeout_ms || 120000))); timer.unref(); ctx.signal?.addEventListener('abort', cancel, { once: true });row.promise=done;
    return input.background ? { process_id: id, status: row.status } : done;
  }
  snapshot(row) { return publicData({ process_id: row.id, status: row.status, stdout: row.output, exit_code: row.exitCode, error: row.error, duration_ms: Date.now() - row.startedAt }); }
  async manage(input, ctx) {
    if (input.action === 'list') return { processes: [...this.processes.values()].filter(row => row.userId === ctx.userId && row.root === ctx.root).map(row => this.snapshot(row)) };
    const row = this.processes.get(input.process_id); if (!row || row.userId !== ctx.userId || row.root !== ctx.root) throw fail('Process not found.', 'not_found', 404);
    if (input.action === 'kill') { killTree(row.child); row.status = 'cancelled'; } else if (!['poll', 'log', 'wait'].includes(input.action)) throw fail('Unknown remote-process action.');
    if(input.action==='wait'&&row.status==='running')await Promise.race([row.promise,new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(60000,Number(input.timeout_ms)||30000))))]);return this.snapshot(row);
  }
  stop() { for (const row of this.processes.values()) if (row.status === 'running') killTree(row.child); }
}
function killTree(child){if(!Number.isInteger(child.pid)||child.pid<=0)return;try{if(process.platform==='win32'){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}
function executable(program) { const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [program], { windowsHide: true, encoding: 'utf8', timeout: 2000 }); return result.status === 0; }
module.exports = { ExecutionTools, executable };
