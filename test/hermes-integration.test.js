'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('Hermes catalog, encrypted keys and external GGUF stay scoped', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-hermes-test-'));
  const data = path.join(temp, 'data');
  const home = path.join(temp, 'hermes');
  fs.mkdirSync(path.join(home, 'models'), { recursive: true });
  fs.writeFileSync(path.join(home, 'models', 'local-test.gguf'), 'fixture');
  const port = 32000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: data, HERMES_HOME: home, ZAALIS_RUST_CORE: 'off' },
  });
  const base = `http://127.0.0.1:${port}`;
  const api = (url, options = {}) => fetch(base + url, options);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await api('/')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'server started');
    const register = await api('/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'hermes-test@zaalis.local', password: 'password123' }),
    });
    assert.equal(register.status, 200);
    const cookie = register.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'content-type': 'application/json' };
    const catalog = await (await api('/api/hermes/catalog', { headers })).json();
    assert.ok(catalog.providers.length >= 40);
    assert.ok(catalog.providers.some(provider => provider.id === 'fireworks'));
    assert.deepEqual(catalog.local.models, ['local-test.gguf']);
    const secret = 'test-fake-provider-key-1234567890';
    const saved = await api('/api/hermes/keys', { method: 'PUT', headers, body: JSON.stringify({ keys: { fireworks: secret } }) });
    assert.equal(saved.status, 200);
    const keyStatus = await (await api('/api/hermes/keys', { headers })).json();
    assert.equal(keyStatus.keys.fireworks.set, true);
    assert.equal(JSON.stringify(keyStatus).includes(secret), false);
    assert.equal(fs.readFileSync(path.join(data, 'users.json'), 'utf8').includes(secret), false);
    const gguf = await (await api('/api/gguf-models', { headers })).json();
    assert.ok(gguf.models.some(model => model.name === 'hermes:local-test.gguf' && model.removable === false));
    const forbidden = await api('/api/gguf-delete', { method: 'POST', headers, body: JSON.stringify({ name: 'hermes:local-test.gguf' }) });
    assert.equal(forbidden.status, 403);
    const traversal = await api('/api/gguf-delete', { method: 'POST', headers, body: JSON.stringify({ name: '../local-test.gguf' }) });
    assert.equal(traversal.status, 400);
    assert.ok(fs.existsSync(path.join(home, 'models', 'local-test.gguf')));
    const caps = await (await api('/api/model-capabilities?provider=gguf&model=hermes%3Alocal-test.gguf', { headers })).json();
    assert.equal(caps.reasoning.levels.length, 8);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
