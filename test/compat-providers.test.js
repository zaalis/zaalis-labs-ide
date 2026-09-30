'use strict';

// OpenAI-compatible providers are served by zaalis alone: the key is stored in
// the local vault and the Rust core calls the endpoint directly. A fake
// endpoint on 127.0.0.1 stands in for DeepSeek/OpenRouter/LM Studio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { findAgentd } = require('../rust-agent-bridge');
const compat = require('../compat-providers');

test('the catalogue only lists direct OpenAI-compatible endpoints', () => {
  assert.ok(compat.PROVIDERS.length >= 20);
  const ids = new Set();
  for (const provider of compat.PROVIDERS) {
    assert.ok(!ids.has(provider.id), `doublon ${provider.id}`);
    ids.add(provider.id);
    assert.doesNotMatch(provider.id, /::/);
    if (provider.id !== 'custom') assert.match(provider.baseUrl, /^https?:\/\/[^/]+/);
    if (provider.baseUrl.startsWith('http://')) assert.ok(provider.local, `${provider.id} doit être local pour rester en HTTP`);
  }
  assert.equal(compat.normalizeBaseUrl('file:///etc/passwd'), null);
  assert.equal(compat.normalizeBaseUrl('https://user:pw@example.com/v1'), null);
  assert.equal(compat.normalizeBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  assert.deepEqual(compat.binding('compat:deepseek', 'deepseek-v4-pro'), { provider: 'compat', model: 'deepseek::deepseek-v4-pro' });
  assert.equal(compat.binding('codex', 'gpt-5.6-sol'), null);
  assert.throws(() => compat.binding('compat:deepseek', ''), /modèle/);
});

function fakeProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: body ? JSON.parse(body) : null });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'fake-large' }, { id: 'fake-mini' }] }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.setHeader('content-type', 'text/event-stream');
        const chunk = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Bonjour depuis ' } }] });
        chunk({ choices: [{ index: 0, delta: { content: 'le fournisseur local.' } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('keys stay in the zaalis vault and chat goes straight to the endpoint', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-compat-test-'));
  const data = path.join(temp, 'data');
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  const fake = await fakeProvider();
  const port = 33000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: data, ZAALIS_RUST_CORE: 'on' },
  });
  const base = `http://127.0.0.1:${port}`;
  const api = (url, options = {}) => fetch(base + url, options);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await api('/')).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'server started');
    const register = await api('/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'compat-test@zaalis.local', password: 'password123' }),
    });
    assert.equal(register.status, 200);
    const headers = { cookie: register.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };

    const listed = await (await api('/api/compat/providers', { headers })).json();
    assert.ok(listed.providers.some((p) => p.id === 'openrouter' && !p.configured));
    assert.equal(listed.providers.find((p) => p.id === 'custom').configured, false);

    const refused = await api('/api/compat/keys', { method: 'PUT', headers, body: JSON.stringify({ baseUrls: { custom: 'file:///C:/Windows' } }) });
    assert.equal(refused.status, 400);

    const secret = 'sk-compat-local-test-0123456789';
    const saved = await api('/api/compat/keys', {
      method: 'PUT', headers,
      body: JSON.stringify({ keys: { custom: secret }, baseUrls: { custom: `http://127.0.0.1:${fake.port}/v1/` } }),
    });
    assert.equal(saved.status, 200);
    const custom = (await saved.json()).providers.find((p) => p.id === 'custom');
    assert.equal(custom.configured, true);
    assert.equal(custom.key.last4, secret.slice(-4));
    assert.equal(custom.baseUrl, `http://127.0.0.1:${fake.port}/v1`);
    assert.equal(fs.readFileSync(path.join(data, 'users.json'), 'utf8').includes(secret), false, 'clé chiffrée au repos');
    assert.equal(JSON.stringify(await (await api('/api/compat/providers', { headers })).json()).includes(secret), false);

    const models = await (await api('/api/compat/models?provider=custom', { headers })).json();
    assert.deepEqual(models.models, ['fake-large', 'fake-mini']);
    assert.equal(fake.seen.find((r) => r.url === '/v1/models').auth, `Bearer ${secret}`);

    const caps = await (await api('/api/model-capabilities?provider=compat%3Acustom&model=fake-large', { headers })).json();
    assert.equal(caps.ready, true);
    assert.equal(caps.tools, true);

    const traversal = await api('/api/gguf-delete', { method: 'POST', headers, body: JSON.stringify({ name: '../users.json' }) });
    assert.equal(traversal.status, 400);

    if (!findAgentd(path.join(__dirname, '..'))) {
      t.diagnostic('zaalis-agentd absent : partie Rust ignorée');
      return;
    }
    const chat = await api('/api/chat', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'compat:custom', submodel: 'fake-large', message: 'Dis bonjour', root: project, language: 'fr' }),
    });
    const answer = await chat.json();
    assert.equal(chat.status, 200, JSON.stringify(answer));
    assert.equal(answer.response, 'Bonjour depuis le fournisseur local.');
    const call = fake.seen.find((r) => r.url === '/v1/chat/completions');
    assert.ok(call, 'le cœur Rust a appelé le point de terminaison');
    assert.equal(call.auth, `Bearer ${secret}`);
    assert.equal(call.body.model, 'fake-large', 'seul l’ID réel du modèle est envoyé');
    assert.ok(!('reasoning_effort' in call.body));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fake.server.close();
    // The daemon outlives the server by an instant and still holds its folder.
    for (let attempt = 0; attempt < 40; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  }
});
