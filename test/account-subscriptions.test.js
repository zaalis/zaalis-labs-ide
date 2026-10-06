'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../account-subscriptions');

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
  assert.equal(translator.push({ type: 'message_stop' })[0].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(translator.finish(), []);
});

test('xAI account uses the Responses endpoint and translates its stream', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, body: JSON.parse(init.body), authorization: init.headers.Authorization };
    return new Response('data: {"type":"response.output_text.delta","delta":"Bonjour"}\n\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const stream = await auth.openStream('xai', 'account-token', { model: 'grok-4.6',
    messages: [{ role: 'user', content: 'Salut' }] }, { fetchImpl });
  assert.equal(request.url, 'https://api.x.ai/v1/responses');
  assert.equal(request.authorization, 'Bearer account-token');
  assert.equal(request.body.input[0].content[0].text, 'Salut');
  const reader = auth.createSseReader();
  const translator = auth.createChunkTranslator('grok-4.6');
  const chunks = [];
  for await (const piece of stream.body) for (const event of reader.push(piece)) chunks.push(...translator.push(event));
  assert.equal(chunks[0].choices[0].delta.content, 'Bonjour');
  assert.equal(chunks[1].choices[0].finish_reason, 'stop');
});
