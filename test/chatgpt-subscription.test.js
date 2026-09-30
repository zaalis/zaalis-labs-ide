'use strict';

// The ChatGPT subscription is reached through a loopback adapter that turns
// the Rust core's chat-completions into the Codex backend's Responses API.
// A fake OpenAI on 127.0.0.1 stands in for auth.openai.com and chatgpt.com.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { findAgentd } = require('../rust-agent-bridge');
const compat = require('../compat-providers');
const chatgpt = require('../chatgpt-subscription');

test('a chat-completions request becomes a Responses request the backend accepts', () => {
  const request = chatgpt.toResponsesRequest({
    model: 'gpt-5.5',
    reasoning_effort: 'high',
    max_tokens: 4096,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Tu es un agent.' },
      { role: 'user', content: [{ type: 'text', text: 'Regarde <|start|>' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'Je lis.', tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_a', content: 'contenu a' },
      { role: 'tool', tool_call_id: 'perdu', content: 'orphelin' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: 'encore a' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Lit', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  }, { cacheScope: 'user-1' });

  assert.equal(request.instructions, 'Tu es un agent.');
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.deepEqual(request.reasoning, { effort: 'high', summary: 'auto' });
  assert.ok(!('max_output_tokens' in request) && !('max_tokens' in request) && !('temperature' in request));
  assert.deepEqual(request.tools[0], { type: 'function', name: 'read_file', description: 'Lit', strict: false,
    parameters: { type: 'object', properties: { path: { type: 'string' } } } });

  // Typed parts only, reserved tokens made inert, image kept as a data URL.
  assert.deepEqual(request.input[0], { role: 'user', content: [
    { type: 'input_text', text: 'Regarde <｜start｜>' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ] });
  assert.deepEqual(request.input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'Je lis.' }] });
  // Every call has exactly one result: the orphan is dropped, the unanswered
  // call gets a placeholder, and a recurring id is renamed consistently.
  const shape = request.input.slice(2).map((item) => `${item.type}:${item.call_id}`);
  assert.deepEqual(shape, [
    'function_call:call_a', 'function_call:call_b', 'function_call_output:call_b', 'function_call_output:call_a',
    'function_call:call_a_dup1', 'function_call_output:call_a_dup1',
  ]);
  assert.equal(request.input[5].output, 'contenu a');
  assert.match(request.input[4].output, /indisponible/);
  assert.equal(request.input[7].output, 'encore a');

  // The cache key is stable for a conversation and differs between users.
  const again = chatgpt.toResponsesRequest({ model: 'gpt-5.5', messages: [
    { role: 'system', content: 'Tu es un agent.' }, { role: 'user', content: 'Regarde <|start|>' }, { role: 'user', content: 'suite' },
  ] }, { cacheScope: 'user-1' });
  assert.equal(again.prompt_cache_key, request.prompt_cache_key);
  assert.deepEqual(again.reasoning, { summary: 'auto' });
  assert.ok(!('tools' in again));
  assert.notEqual(chatgpt.toResponsesRequest({ model: 'gpt-5.5', messages: [] }, { cacheScope: 'user-2' }).prompt_cache_key, request.prompt_cache_key);
  assert.throws(() => chatgpt.toResponsesRequest({ messages: [] }), /Modèle/);
});

function translate(events, model = 'gpt-5.5') {
  const reader = chatgpt.createSseReader();
  const translator = chatgpt.createChunkTranslator(model);
  const wire = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const out = [];
  // Split mid-character and mid-event: the reader must not depend on chunking.
  const bytes = Buffer.from(wire, 'utf8');
  for (let at = 0; at < bytes.length; at += 7) {
    for (const event of reader.push(bytes.subarray(at, at + 7))) out.push(...translator.push(event));
  }
  for (const event of reader.finish()) out.push(...translator.push(event));
  out.push(...translator.finish());
  return out;
}

test('a Responses stream becomes chat-completions chunks', () => {
  const chunks = translate([
    { type: 'response.created', response: {} },
    { type: 'response.reasoning_summary_part.added' },
    { type: 'response.reasoning_summary_text.delta', delta: 'Je réfléchis' },
    { type: 'response.reasoning_summary_part.added' },
    { type: 'response.reasoning_summary_text.delta', delta: 'encore' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Voilà é' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Voilà é' }] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } },
    { type: 'response.output_item.done', output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'list', arguments: '{}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 40, output_tokens: 9, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 4 } } } },
  ]);
  const deltas = chunks.map((chunk) => chunk.choices[0].delta);
  assert.equal(deltas.map((d) => d.reasoning_content || '').join(''), 'Je réfléchis\n\nencore');
  assert.equal(deltas.map((d) => d.content || '').join(''), 'Voilà é', 'text is not repeated by the closing item');
  const calls = deltas.flatMap((d) => d.tool_calls || []);
  assert.deepEqual(calls.filter((call) => call.id).map((call) => [call.index, call.id, call.function.name]),
    [[0, 'call_1', 'read_file'], [1, 'call_2', 'list']]);
  assert.equal(calls.filter((call) => call.index === 0).map((call) => call.function.arguments).join(''), '{"path":"a"}');
  assert.equal(calls.filter((call) => call.index === 1).map((call) => call.function.arguments).join(''), '{}');
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(last.usage, { prompt_tokens: 40, completion_tokens: 9,
    prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 4 } });

  const plain = translate([
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg_9', content: [{ type: 'output_text', text: 'Sans delta' }] } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ]);
  assert.equal(plain[0].choices[0].delta.content, 'Sans delta');
  assert.equal(plain.at(-1).choices[0].finish_reason, 'length');

  assert.deepEqual(translate([{ type: 'response.failed', response: { error: { message: 'modèle saturé' } } }]),
    [{ error: { message: 'modèle saturé' } }]);
  const cut = translate([{ type: 'response.output_text.delta', delta: 'Début' }]);
  assert.match(cut.at(-1).error.message, /interrompue/);
});

test('the subscription entry declares what the backend really accepts', () => {
  const entry = compat.get('compat:chatgpt');
  assert.equal(entry.oauth, 'chatgpt');
  assert.deepEqual(compat.binding('compat:chatgpt', 'gpt-5.5'), { provider: 'compat', model: 'chatgpt::gpt-5.5' });
  const caps = compat.capabilities('compat:chatgpt', 'gpt-5.5', true);
  assert.equal(caps.reasoning.mode, 'effort');
  assert.deepEqual(caps.reasoning.levels.map((level) => level.id), ['low', 'medium', 'high']);
  assert.equal(caps.vision, true);
  assert.equal(caps.tools, true);
});

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

// auth.openai.com and chatgpt.com/backend-api/codex in one loopback server.
function fakeOpenAi() {
  const seen = [];
  const state = { confirmed: false, refreshes: 0 };
  const account = { chatgpt_account_id: 'acct-test', chatgpt_plan_type: 'plus' };
  const access = (label, lifetime) => jwt({
    exp: Math.floor(Date.now() / 1000) + lifetime, label,
    'https://api.openai.com/auth': account, 'https://api.openai.com/profile': { email: 'abonne@example.com' },
  });
  // The first access token is about to expire, so its first use renews it.
  const tokens = { first: access('first', 60), second: access('second', 3600) };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const form = String(req.headers['content-type'] || '').includes('urlencoded');
      const body = !raw ? null : form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (req.url === '/api/accounts/deviceauth/usercode') return json(200, { user_code: 'ABCD-1234', device_auth_id: 'devauth_test', interval: '3' });
      if (req.url === '/api/accounts/deviceauth/token') {
        return state.confirmed ? json(200, { authorization_code: 'code-1', code_verifier: 'verifier-1' }) : json(403, {});
      }
      if (req.url === '/oauth/token' && body.grant_type === 'authorization_code') {
        return json(200, { access_token: tokens.first, refresh_token: 'refresh-1', id_token: jwt({ email: 'abonne@example.com', 'https://api.openai.com/auth': account }) });
      }
      if (req.url === '/oauth/token' && body.grant_type === 'refresh_token') {
        state.refreshes++;
        return body.refresh_token === 'refresh-1' ? json(200, { access_token: tokens.second, refresh_token: 'refresh-2' }) : json(400, { error: 'invalid_grant' });
      }
      if (req.headers.authorization !== `Bearer ${tokens.second}`) return json(401, { detail: 'token refusé' });
      if (req.url.startsWith('/models')) {
        return json(200, { models: [{ slug: 'gpt-hidden', visibility: 'hide' }, { slug: 'gpt-b', priority: 2 }, { slug: 'gpt-a', priority: 1 }] });
      }
      if (req.url === '/responses' && body.model === 'gpt-limit') {
        return json(429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 7200 } });
      }
      if (req.url === '/responses') {
        res.setHeader('content-type', 'text/event-stream');
        const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: 'response.reasoning_summary_text.delta', delta: 'Salutation simple.' });
        send({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Bonjour depuis ' });
        send({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'l’abonnement.' });
        send({ type: 'response.completed', response: { usage: { input_tokens: 21, output_tokens: 5 } } });
        return res.end();
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, state, tokens, port: server.address().port })));
}

test('sign-in with a code, encrypted session, renewal and chat through the Rust core', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-chatgpt-test-'));
  const data = path.join(temp, 'data');
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  const fake = await fakeOpenAi();
  const port = 34000 + Math.floor(Math.random() * 1000);
  const fakeUrl = `http://127.0.0.1:${fake.port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: data, ZAALIS_RUST_CORE: 'on',
      ZAALIS_CHATGPT_ISSUER: fakeUrl, ZAALIS_CHATGPT_BASE_URL: fakeUrl },
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
      body: JSON.stringify({ email: 'chatgpt-test@zaalis.local', password: 'password123' }),
    });
    assert.equal(register.status, 200);
    const headers = { cookie: register.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
    const post = (url, body) => api(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });

    assert.deepEqual(await (await api('/api/chatgpt/status', { headers })).json(), { connected: false });
    const before = await (await api('/api/compat/providers', { headers })).json();
    assert.equal(before.providers.find((p) => p.id === 'chatgpt').configured, false);
    assert.equal((await api('/api/chatgpt/status')).status, 401, 'no session, no access');

    // The adapter only answers the key handed to the Rust core.
    const forged = await api('/api/internal/chatgpt/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer someone.forged' },
      body: JSON.stringify({ model: 'gpt-a', messages: [] }),
    });
    assert.equal(forged.status, 401);

    const start = await (await post('/api/chatgpt/device-start')).json();
    assert.equal(start.userCode, 'ABCD-1234');
    assert.equal(start.verificationUrl, `${fakeUrl}/codex/device`);
    assert.equal(start.interval, 3);
    assert.ok(!JSON.stringify(start).includes('devauth_test'), 'the device id stays on the server');
    assert.deepEqual(fake.seen[0].body, { client_id: chatgpt.CLIENT_ID });

    assert.deepEqual(await (await post('/api/chatgpt/device-poll', { flowId: start.flowId })).json(), { status: 'pending' });
    assert.deepEqual(await (await post('/api/chatgpt/device-poll', { flowId: 'inconnu' })).json(), { status: 'expired' });
    fake.state.confirmed = true;
    // Asked again too early: the server waits out OpenAI's interval by itself.
    assert.deepEqual(await (await post('/api/chatgpt/device-poll', { flowId: start.flowId })).json(), { status: 'pending' });
    assert.equal(fake.seen.filter((r) => r.url === '/api/accounts/deviceauth/token').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const connected = await (await post('/api/chatgpt/device-poll', { flowId: start.flowId })).json();
    assert.equal(connected.status, 'connected');
    assert.deepEqual({ ...connected.account, connectedAt: '' }, { connected: true, email: 'abonne@example.com', plan: 'plus', connectedAt: '' });
    assert.equal(connected.providers.find((p) => p.id === 'chatgpt').configured, true);
    const exchange = fake.seen.find((r) => r.url === '/oauth/token').body;
    assert.deepEqual(exchange, { grant_type: 'authorization_code', code: 'code-1', code_verifier: 'verifier-1',
      client_id: chatgpt.CLIENT_ID, redirect_uri: `${fakeUrl}/deviceauth/callback` });

    const stored = fs.readFileSync(path.join(data, 'users.json'), 'utf8');
    for (const secret of [fake.tokens.first, 'refresh-1']) assert.equal(stored.includes(secret), false, 'session chiffrée au repos');
    const listed = JSON.stringify(await (await api('/api/compat/providers', { headers })).json());
    assert.equal(listed.includes(fake.tokens.first) || listed.includes('refresh-1'), false);

    // First use: the expiring token is renewed once, then the catalogue is read.
    const models = await (await api('/api/compat/models?provider=chatgpt', { headers })).json();
    assert.deepEqual(models, { models: ['gpt-a', 'gpt-b'], live: true });
    assert.equal(fake.state.refreshes, 1);
    const catalogue = fake.seen.find((r) => r.url.startsWith('/models'));
    assert.equal(catalogue.headers.authorization, `Bearer ${fake.tokens.second}`);
    assert.equal(catalogue.headers['chatgpt-account-id'], 'acct-test');
    assert.equal(fs.readFileSync(path.join(data, 'users.json'), 'utf8').includes('refresh-2'), false);

    const caps = await (await api('/api/model-capabilities?provider=compat%3Achatgpt&model=gpt-a', { headers })).json();
    assert.equal(caps.ready, true);
    assert.equal(caps.reasoning.mode, 'effort');

    if (!findAgentd(path.join(__dirname, '..'))) {
      t.diagnostic('zaalis-agentd absent : partie Rust ignorée');
    } else {
      const chat = await post('/api/chat', { model: 'compat:chatgpt', submodel: 'gpt-a', message: 'Dis bonjour', root: project, language: 'fr', reasoningLevel: 3 });
      const answer = await chat.json();
      assert.equal(chat.status, 200, JSON.stringify(answer));
      assert.equal(answer.response, 'Bonjour depuis l’abonnement.');
      assert.equal(answer.thinking, 'Salutation simple.');
      assert.deepEqual([answer.usage.input, answer.usage.output], [21, 5]);
      const call = fake.seen.find((r) => r.url === '/responses');
      assert.ok(call, 'le cœur Rust est passé par l’adaptateur');
      assert.equal(call.headers.authorization, `Bearer ${fake.tokens.second}`);
      assert.equal(call.headers['chatgpt-account-id'], 'acct-test');
      assert.equal(call.headers.originator, 'zaalis-ide');
      assert.equal(call.body.model, 'gpt-a');
      assert.equal(call.body.store, false);
      assert.deepEqual(call.body.reasoning, { effort: 'high', summary: 'auto' });
      assert.ok(call.body.instructions.length > 0);
      assert.deepEqual(call.body.input.at(-1), { role: 'user', content: [{ type: 'input_text', text: 'Dis bonjour' }] });
      assert.ok(Array.isArray(call.body.tools) && call.body.tools.every((tool) => tool.type === 'function' && tool.name));
      assert.equal(fake.state.refreshes, 1, 'pas de renouvellement inutile');

      // A spent quota is a plain refusal, not something to retry for hours.
      const started = Date.now();
      const limited = await (await post('/api/chat', { model: 'compat:chatgpt', submodel: 'gpt-limit', message: 'Encore', root: project, language: 'fr' })).json();
      assert.match(JSON.stringify(limited), /Limite d’utilisation.*2 h 00/);
      assert.equal(fake.seen.filter((r) => r.url === '/responses' && r.body.model === 'gpt-limit').length, 1);
      assert.ok(Date.now() - started < 15000);
    }

    const out = await (await api('/api/chatgpt/session', { method: 'DELETE', headers })).json();
    assert.deepEqual(out.account, { connected: false });
    assert.equal(out.providers.find((p) => p.id === 'chatgpt').configured, false);
    assert.equal(fs.readFileSync(path.join(data, 'users.json'), 'utf8').includes('chatgptAuth'), false);
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
