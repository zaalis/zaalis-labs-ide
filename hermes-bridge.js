const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CATALOG = require('./hermes-provider-catalog.json');
const PROVIDERS = new Map(CATALOG.map(provider => [provider.id, provider]));

function hermesHome() {
  return process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
}
function hermesExe() {
  return process.env.ZAALIS_HERMES_EXE || path.join(hermesHome(), 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes');
}
function localStatus() {
  const home = hermesHome();
  const modelsDir = path.join(home, 'models');
  let models = [];
  try { models = fs.readdirSync(modelsDir).filter(name => name.toLowerCase().endsWith('.gguf') && fs.statSync(path.join(modelsDir, name)).isFile()); } catch {}
  const runtimeDir = path.join(home, 'runtimes', 'llamacpp');
  let runtimes = [];
  try { runtimes = fs.readdirSync(runtimeDir).filter(name => {
    const root = path.join(runtimeDir, name);
    if (!fs.statSync(root).isDirectory()) return false;
    return ['cuda', 'vulkan', 'cpu'].some(variant => fs.existsSync(path.join(root, variant, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')));
  }); } catch {}
  return { installed: fs.existsSync(hermesExe()), models, runtimes };
}
function selectedProvider(value) {
  const id = String(value || '').replace(/^hermes:/, '');
  const provider = PROVIDERS.get(id);
  if (!provider) throw Object.assign(new Error('Fournisseur Hermes inconnu.'), { status: 400 });
  return provider;
}
function runChat({ providerId, model, message, root, key, reasoningLevel, permissionMode, signal, onEvent }) {
  const provider = selectedProvider(providerId);
  if (!fs.existsSync(hermesExe())) throw Object.assign(new Error('Hermes Agent n’est pas installé sur ce poste.'), { status: 503 });
  if (!model || !String(model).trim()) throw Object.assign(new Error('Choisissez un modèle Hermes.'), { status: 400 });
  const effort = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, Number(reasoningLevel) || 0))];
  const args = ['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json', '--provider', provider.id, '--model', String(model), '--reasoning', effort, '--source', 'tool', '--in', root, '--run-budget', '300'];
  if (permissionMode === 'auto') args.push('--yolo');
  const env = { ...process.env };
  if (provider.keyEnv && key) env[provider.keyEnv] = key;
  return new Promise((resolve, reject) => {
    const child = spawn(hermesExe(), args, { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let terminal = null;
    let fullText = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.stdin.end(String(message));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'text') { fullText += event.text || ''; onEvent?.({ type: 'text_delta', text: event.text || '' }); }
        else if (event.type === 'tool_use') onEvent?.({ type: 'tool_started', id: event.tool_call_id, tool: event.name, input: event.input });
        else if (event.type === 'tool_result') onEvent?.({ type: 'tool_done', id: event.tool_call_id, tool: event.name, text: event.output, error: event.is_error });
        else if (event.type === 'result') terminal = event;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(Object.assign(new Error('Requête annulée.'), { status: 499 }));
      if (!terminal || code || terminal.exit_code) return reject(Object.assign(new Error(terminal?.error || errors.trim().slice(-500) || `Hermes a quitté avec le code ${code}.`), { status: 502 }));
      resolve({ response: terminal.text || fullText, sessionId: terminal.session_id || '', usage: terminal.tokens || undefined });
    });
  });
}

module.exports = { CATALOG, PROVIDERS, LEVELS, hermesHome, localStatus, selectedProvider, runChat };
