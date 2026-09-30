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
  process.stdout.write('Packaged Windows server: static UI, reasoning, GGUF, preferences, ChatGPT sign-in OK\n');
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
