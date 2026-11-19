'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/accounts/account-subscriptions');

const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('xAI connection uses a device code, holds the secret server-side, and refreshes tokens', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/.well-known/openid-configuration')) return reply({ token_endpoint: 'https://auth.x.ai/oauth2/token' });
    if (url.endsWith('/oauth2/device/code')) return reply({ device_code: 'private-device', user_code: 'ABCD',
      verification_uri: 'https://accounts.x.ai/device', expires_in: 600, interval: 2 });
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'refresh_token') return reply({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    if (calls.filter(([address]) => address.endsWith('/oauth2/token')).length === 1) return reply({ error: 'authorization_pending' }, 400);
    return reply({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  };
  const flow = await auth.start('xai', { fetchImpl });
  assert.equal(flow.userCode, 'ABCD');
  assert.equal(flow.deviceCode, 'private-device');
  assert.equal(await auth.poll(flow, { fetchImpl }), null);
  const session = await auth.poll(flow, { fetchImpl });
  assert.equal(session.accessToken, 'access');
  const renewed = await auth.refresh(session, { fetchImpl });
  assert.equal(renewed.accessToken, 'new-access');
  assert.equal(renewed.refreshToken, 'new-refresh');
});

test('xAI payment refusal explains the account entitlement without claiming a specific plan', async () => {
  const flow = { provider: 'xai', tokenEndpoint: 'https://auth.x.ai/oauth2/token', deviceCode: 'private-device' };
  await assert.rejects(auth.poll(flow, { fetchImpl: async () => reply({}, 402) }), error =>
    error.status === 402 && /abonnement SuperGrok ou X Premium\+/.test(error.message));
});

test('MiniMax connection validates state and translates tools to Anthropic Messages', async () => {
  const fetchImpl = async (url, init = {}) => {
    const body = new URLSearchParams(init.body);
    if (url.endsWith('/oauth/code')) return reply({ state: body.get('state'), user_code: 'QWER',
      verification_uri: 'https://www.minimax.io/authorize', expired_in: Date.now() + 600000 });
    return reply({ status: 'success', access_token: 'access', refresh_token: 'refresh', expired_in: Date.now() + 3600000 });
  };
  const flow = await auth.start('minimax', { fetchImpl });
  assert.equal(flow.userCode, 'QWER');
  const session = await auth.poll(flow, { fetchImpl });
  assert.equal(session.provider, 'minimax');
  assert.ok(session.expiresAt > Date.now() + 3000000);
  const wire = auth.miniMaxRequest({ model: 'MiniMax-M2.7', messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Read a file' },
    { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'content' },
  ], tools: [{ function: { name: 'read', parameters: { type: 'object' } } }] });
  assert.equal(wire.system, 'You are helpful.');
  assert.equal(wire.messages[1].content[0].type, 'tool_use');
  assert.equal(wire.messages[2].content[0].type, 'tool_result');
  assert.equal(wire.tools[0].name, 'read');
});

test('MiniMax stream becomes chat-completions text and tool chunks', () => {
  const translator = auth.miniMaxTranslator('MiniMax-M2.7');
  const text = translator.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour' } });
  assert.equal(text[0].choices[0].delta.content, 'Bonjour');
  const call = translator.push({ type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'call-1', name: 'read', input: {} } });
  assert.equal(call[0].choices[0].delta.tool_calls[0].function.name, 'read');
  const args = translator.push({ type: 'content_block_delta', index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } });
  assert.equal(args[0].choices[0].delta.tool_calls[0].function.arguments, '{"path":"a"}');
  translator.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  const stop = translator.push({ type: 'message_stop' })[0];
  assert.equal(stop.choices[0].finish_reason, 'tool_calls');
  assert.equal(stop.usage, undefined, 'no reported usage must stay unmeasured');
  assert.deepEqual(translator.finish(), []);
});

test('MiniMax provider usage reaches the ledger with cache reads in the prompt', () => {
  const translator = auth.miniMaxTranslator('MiniMax-M2.7');
  translator.push({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 100, output_tokens: 1 } } });
  translator.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
  translator.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 37 } });
  const [last] = translator.push({ type: 'message_stop' });
  assert.deepEqual(last.usage, { prompt_tokens: 112, completion_tokens: 37, prompt_tokens_details: { cached_tokens: 100 } });
});

test('a Responses stream without usage is not recorded as zero tokens', () => {
  const translator = auth.createChunkTranslator('grok-4.6');
  const [last] = translator.push({ type: 'response.completed', response: { usage: {} } });
  assert.equal(last.usage, undefined);
});

test('xAI account uses the CLI proxy and a body that proxy accepts', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response('data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call-1","name":"zaalis_tool_search"}}\n\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call-1","name":"zaalis_tool_search","arguments":"{}"}}\n\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const stream = await auth.openStream('xai', 'account-token', { model: 'grok-4.7',
    messages: [{ role: 'user', content: 'Salut' }],
    tools: [
      { function: { name: 'tool_search', description: 'Chercher', parameters: { type: 'object', properties: {} } } },
      { function: { name: 'read', description: 'Lire', parameters: { type: 'object', properties: {} } } },
    ] }, { fetchImpl });
  assert.equal(request.url, 'https://cli-chat-proxy.grok.com/v1/responses');
  assert.equal(request.headers.Authorization, 'Bearer account-token');
  assert.equal(request.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.equal(request.headers['x-grok-model-override'], 'grok-4.7');
  assert.equal(request.body.input[0].content[0].text, 'Salut');
  assert.equal(request.body.reasoning.summary, 'concise');
  assert.equal(request.body.reasoning.effort, 'high');
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.equal(request.body.tools[0].name, 'zaalis_tool_search');
  assert.equal(request.body.tools[0].strict, undefined);
  assert.equal(request.body.tools[1].name, 'read');
  const reader = auth.createSseReader();
  const translator = auth.createChunkTranslator('grok-4.7', { aliases: stream.zaalisToolAliases });
  const chunks = [];
  for await (const piece of stream.body) for (const event of reader.push(piece)) chunks.push(...translator.push(event));
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'tool_search');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('xAI string error bodies stay visible', () => {
  assert.equal(auth.xaiDetail('{"code":"invalid-argument","error":"Model does not support parameter reasoningEffort."}'),
    'Model does not support parameter reasoningEffort.');
  const shaped = auth.shapeXaiRequest({ model: 'grok-build-0.1', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'max' });
  assert.deepEqual(shaped.request.reasoning, { summary: 'concise' });
});

test('xAI non-reasoning models never receive a reasoning effort', () => {
  const shaped = auth.shapeXaiRequest({ model: 'grok-4.20-0309-non-reasoning', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'high' });
  assert.deepEqual(shaped.request.reasoning, { summary: 'concise' });
});

test('xAI retries once without effort when a model rejects it', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response('{"code":"invalid-argument","error":"Model grok-9 does not support parameter reasoningEffort."}', { status: 400 });
    }
    return new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const stream = await auth.openStream('xai', 'account-token', { model: 'grok-9', messages: [{ role: 'user', content: 'Hi' }] }, { fetchImpl });
  assert.equal(stream.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning.effort, 'high');
  assert.deepEqual(bodies[1].reasoning, { summary: 'concise' });
});

test('xAI rate-limit headers become usage windows', () => {
  const headers = new Headers({ 'x-ratelimit-limit-requests': '480', 'x-ratelimit-remaining-requests': '360',
    'x-ratelimit-limit-tokens': '10000000', 'x-ratelimit-remaining-tokens': '10000000' });
  const limits = auth.xaiRateLimits(headers);
  assert.deepEqual(limits.windows.map((w) => [w.kind, w.limit, w.remaining, w.usedPercent]),
    [['requests', 480, 360, 25], ['tokens', 10000000, 10000000, 0]]);
  assert.equal(auth.xaiRateLimits(new Headers()), null);
});

test('MiniMax plan quota becomes 5-hour and weekly windows', async () => {
  let url;
  const fetchImpl = async (target) => { url = target; return new Response(JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [
    { model_name: 'video', current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
    { model_name: 'general', start_time: 0, end_time: 18000000, current_interval_remaining_percent: 73,
      weekly_start_time: 0, weekly_end_time: 604800000, current_weekly_remaining_percent: 95 },
  ] })); };
  const limits = await auth.fetchMiniMaxLimits('t', { fetchImpl });
  assert.equal(url, 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains');
  assert.deepEqual(limits.windows, [
    { usedPercent: 27, windowMinutes: 300, resetsAt: 18000000 },
    { usedPercent: 5, windowMinutes: 10080, resetsAt: 604800000 },
  ]);
  await assert.rejects(auth.fetchMiniMaxLimits('t', { fetchImpl: async () => new Response('', { status: 401 }) }), { status: 401 });
});
