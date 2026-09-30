'use strict';

// Run after build:server. Exercises the actual packaged Windows server with
// disposable account data, leaving the user's installed account untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const exe = path.resolve(__dirname, '..', 'native', 'dist', 'zaalis-server.exe');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-package-smoke-'));
const base = 'http://127.0.0.1:31958';
const child = spawn(exe, [], {
  cwd: path.dirname(exe),
  env: { ...process.env, ZAALIS_PORT: '31958', ZAALIS_DATA_DIR: dataDir, ZAALIS_RUST_CORE: 'off' },
  stdio: 'ignore', windowsHide: true,
});

async function main() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`packaged server exited: ${child.exitCode}`);
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const home = await fetch(base);
  assert.equal(home.status, 200);
  const page = await home.text();
  assert.match(page, /gguf-install-shortcut/);
  assert.match(page, /chatgpt-sub-connect/);
  assert.match(page, /remote-qr-stage/);
  const historyScript = await (await fetch(base + '/script/ai.js')).text();
  assert.match(historyScript, /'live-agent-body'/);
  const navScript = await (await fetch(base + '/script/workspace.js')).text();
  assert.match(navScript, /createConversationMenu/);
  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'package-smoke@zaalis.local', password: 'password123' }),
  });
  assert.equal(register.status, 200);
  const cookie = register.headers.get('set-cookie');
  const headers = { cookie, 'content-type': 'application/json' };
  const caps = await (await fetch(`${base}/api/model-capabilities?provider=codex&model=gpt-5.6-sol`, { headers })).json();
  assert.equal(caps.reasoning.supported, true);
  assert.equal(caps.reasoning.levels.length, 5);
  const gguf = await (await fetch(`${base}/api/gguf-models`, { headers })).json();
  assert.deepEqual(gguf.models, []);
  const pref = await fetch(`${base}/api/preferences`, { method: 'PUT', headers,
    body: JSON.stringify({ permissionMode: 'auto' }) });
  assert.equal(pref.status, 200);
  assert.equal((await (await fetch(`${base}/api/preferences`, { headers })).json()).permissionMode, 'auto');
  assert.deepEqual(await (await fetch(`${base}/api/chatgpt/status`, { headers })).json(), { connected: false });
  const providers = (await (await fetch(`${base}/api/compat/providers`, { headers })).json()).providers;
  assert.equal(providers.find((provider) => provider.id === 'chatgpt').oauth, 'chatgpt');
  // Personal MCP servers (stdio transport) and the built-in Blender connection
  // are in the packaged server; the entries of the former Blender preset are
  // dropped, and nothing is installed into Blender without consent.
  assert.equal((await fetch(base + '/image/blender.png')).status, 200);
  assert.ok(fs.statSync(path.join(path.dirname(exe), 'blender', 'mcp-1.0.3.zip')).size > 0);
  const legacy = await (await fetch(`${base}/api/mcp`, { method: 'PUT', headers,
    body: JSON.stringify({ servers: [{ id: 'blender', name: 'Blender MCP', endpoint: 'http://127.0.0.1:9876/mcp' }, { id: 'notes', name: 'Notes', command: 'npx', args: ['-y', 'x'] }] }) })).json();
  assert.deepEqual(legacy.servers.map((server) => [server.id, server.transport]), [['notes', 'stdio']]);
  const blenderStatus = await (await fetch(`${base}/api/blender/status`, { headers })).json();
  assert.equal(blenderStatus.id, 'blender');
  assert.ok(['missing', 'unsupported', 'install', 'ready'].includes(blenderStatus.state));
  const refused = await fetch(`${base}/api/blender/install`, { method: 'POST', headers, body: '{}' });
  assert.equal(refused.status, 400);
  assert.equal((await fetch(`${base}/api/internal/blender-mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
  const missing = await (await fetch(`${base}/api/mcp/test`, { method: 'POST', headers,
    body: JSON.stringify({ server: { name: 'missing', command: 'zaalis-no-such-program' } }) })).json();
  assert.equal(missing.ok, false);
  assert.match(missing.error, /introuvable/);
  // Dictation: the local engine is shipped beside the server, the endpoint
  // exists, and silence costs no transcription. (/api/voice-status is left
  // alone here: it would start the one-time download of the speech model.)
  const dictation = await (await fetch(base + '/script/ai.js')).text();
  assert.match(dictation, /\/api\/stt/);
  assert.ok(fs.statSync(path.join(path.dirname(exe), 'whisper', 'whisper-cli.exe')).size > 0);
  const silence = Buffer.alloc(44 + 16000 * 2);
  silence.write('RIFF', 0, 'ascii'); silence.writeUInt32LE(36 + 32000, 4); silence.write('WAVEfmt ', 8, 'ascii');
  silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16000, 24);
  silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34);
  silence.write('data', 36, 'ascii'); silence.writeUInt32LE(32000, 40);
  const heard = await (await fetch(`${base}/api/stt`, { method: 'POST', headers,
    body: JSON.stringify({ audio: silence.toString('base64'), language: 'fr' }) })).json();
  assert.deepEqual(heard, { text: '', engine: 'none', silent: true });
  process.stdout.write('Packaged Windows server: static UI, reasoning, GGUF, preferences, ChatGPT sign-in, MCP stdio, Blender, dictation OK\n');
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; })
  .finally(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep;
    if (!fs.realpathSync(dataDir).startsWith(tempRoot) || path.basename(dataDir).indexOf('zaalis-package-smoke-') !== 0) {
      throw new Error(`Unexpected cleanup target: ${dataDir}`);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
