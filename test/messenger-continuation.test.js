'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MessengerContinuation } = require('../messenger-continuation');
const { MessengerIntegrations } = require('../messenger-integrations');
function fixture(t, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-continuation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (id, kind) => path.join(dir, `${id}-${kind}.json`);
  const c = new MessengerContinuation({ file, run });
  fs.writeFileSync(file('alice', 'chat'), JSON.stringify([{ id: 'conversation', title: 'Project work', projectPath: dir, execution: { model: 'ollama', submodel: 'fixture', permissionMode: 'plan' }, messages: [{ type: 'user', text: 'Existing project task' }, { type: 'ai', text: 'Existing plan' }] }]));
  return { c, dir, binding: { kind: 'chat', conversationId: 'conversation' } };
}
test('continuation uses the owned project, model, permissions and full IDE history; persists replies', async t => {
  let received;
  const { c, dir, binding } = fixture(t, async (id, input) => { received = input; return { response: 'Follow-up question?', sessionId: 'same-session' }; });
  assert.deepEqual(c.bind('alice', binding), binding);
  await assert.rejects(c.answer('bob', { binding, message: 'foreign' }), /introuvable/);
  await c.answer('alice', { binding, provider: 'telegram', message: 'Continue the plan' });
  assert.equal(received.root, dir); assert.equal(received.permissionMode, 'plan'); assert.equal(received.submodel, 'fixture');
  assert.deepEqual(received.history.map(x => x.content), ['Existing project task', 'Existing plan']);
  const conv = c.find('alice', binding); assert.equal(conv.messages.length, 4); assert.equal(conv.messages[3].text, 'Follow-up question?'); assert.equal(conv.sessionId, 'same-session');
  assert.equal(conv.messages[2].label, 'telegram'); assert.ok(conv.remoteRevision);
});
test('stale desktop save preserves messenger messages without duplicating them; acknowledged desktop updates keep their session', async t => {
  const { c, binding } = fixture(t, async () => ({ response: 'remote reply', sessionId: 'remote' }));
  const stale = c.read('alice', 'chat'); await c.answer('alice', { binding, message: 'remote prompt' });
  const merged = c.merge('alice', 'chat', stale); assert.equal(merged[0].messages.length, 4); assert.equal(merged[0].sessionId, 'remote');
  assert.equal(c.merge('alice', 'chat', merged)[0].messages.length, 4);
  merged[0].sessionId = 'desktop-next'; assert.equal(c.merge('alice', 'chat', merged)[0].sessionId, 'desktop-next');
});
test('both transports reject simultaneous runs on the same conversation and release locks after a failure', async t => {
  let finish; const { c, binding } = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const first = c.answer('alice', { binding, message: 'one' });
  await assert.rejects(c.answer('alice', { binding, message: 'two' }), /déjà/);
  finish({ error: 'provider failed' }); await assert.rejects(first, /provider failed/); assert.equal(c.active.size, 0);
});
test('missing or legacy conversation cannot silently become an unrelated messenger chat', t => {
  const { c, binding } = fixture(t, async () => ({}));
  assert.throws(() => c.bind('alice', { ...binding, conversationId: 'missing' }), /introuvable/);
  const list = c.read('alice', 'chat'); delete list[0].execution; fs.writeFileSync(c.file('alice', 'chat'), JSON.stringify(list));
  assert.throws(() => c.bind('alice', binding), /Ouvrez/);
});
test('messenger sends plan approval immediately and accepts the paired answer without waiting in the turn queue', async t => {
  let finish, event, decision; const { c, binding } = fixture(t, async (id, input, onEvent) => {
    event = onEvent; return new Promise(resolve => { finish = resolve; });
  });
  const users = [{ id: 'alice', messengers: { telegram: { binding, token: 'sealed-token', chatId: '7' } } }], sent = [];
  const m = new MessengerIntegrations({ loadUsers: () => users, saveUsers: () => {}, encrypt: x => x, decrypt: x => x, continuation: c,
    decide: async (id, body) => { decision = body; finish({ response: 'Approved plan completed' }); },
    fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body).text); return { ok: true, json: async () => ({ ok: true, result: {} }) }; } });
  const session = { connected: true, controller: new AbortController() }; m.sessions.set('alice:telegram', session);
  const turn = m.respond('alice', 'telegram', 'make a plan'); await new Promise(resolve => setImmediate(resolve));
  event({ type: 'plan_required', sessionId: 'session', requestId: 'request', content: 'A concrete project plan' });
  await new Promise(resolve => setImmediate(resolve)); assert.match(sent[0], /A concrete project plan/);
  const code = session.pending.code;
  assert.match(await m.respond('alice', 'telegram', '/approve deadbeef'), /introuvable/); assert.equal(decision, undefined);
  assert.match(await m.respond('alice', 'telegram', '/approve ' + code), /enregistrée/);
  assert.equal(decision.kind, 'plan'); assert.equal(decision.scope, 'once'); assert.equal(decision.allow, true);
  assert.equal(await turn, 'Approved plan completed'); assert.equal(c.find('alice', binding).messages.at(-1).text, 'Approved plan completed');
});

test('plan feedback stays in the same run and a new approval emitted during the reply is preserved', async t => {
  let event, finish; const { c, binding } = fixture(t, (id, input, onEvent) => { event = onEvent; return new Promise(resolve => { finish = resolve; }); });
  const users = [{ id: 'alice', messengers: { telegram: { binding, token: 'token', chatId: '7' } } }]; let decision;
  const m = new MessengerIntegrations({ loadUsers: () => users, saveUsers: () => {}, encrypt: x => x, decrypt: x => x, continuation: c,
    decide: async (id, body) => { decision = body; if (!body.allow) event({ type: 'plan_required', sessionId: 'run', requestId: 'revised', content: 'Revised plan with tests' }); else finish({ response: 'Done' }); },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }) });
  const session = { connected: true, controller: new AbortController() }; m.sessions.set('alice:telegram', session);
  const turn = m.respond('alice', 'telegram', 'Plan this project'); await new Promise(resolve => setImmediate(resolve));
  event({ type: 'plan_required', sessionId: 'run', requestId: 'original', content: 'Initial plan' });
  const firstCode = session.pending.code;
  assert.match(await m.respond('alice', 'whatsapp', '/approve ' + firstCode), /introuvable/); assert.equal(decision, undefined);
  assert.match(await m.respond('alice', 'telegram', 'Add regression tests to the plan'), /révise/);
  assert.equal(decision.allow, false); assert.equal(decision.feedback, 'Add regression tests to the plan');
  assert.equal(session.pending.requestId, 'revised'); assert.notEqual(session.pending.code, firstCode);
  await m.respond('alice', 'telegram', '/approve ' + session.pending.code); assert.equal(await turn, 'Done');
});

for (const mode of ['supervised', 'plan']) test(`real Rust ${mode} continuation routes approvals through Telegram before changing the project`, { timeout: 20000 }, async t => {
  const http = require('node:http'), { RustAgentBridge } = require('../rust-agent-bridge');
  const seen = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}'); seen.push(body);
    const messages = body.messages || [], index = messages.findLastIndex(m => m.role === 'user');
    const planning = mode === 'plan' && !messages.some(m => String(m.content).includes('Plan approuvé. Passe maintenant'));
    const tool = planning || messages.slice(index + 1).some(m => m.role === 'tool') ? null : { name: 'write', arguments: JSON.stringify({ path: 'continued.txt', content: 'Continued from Telegram' }) };
    res.setHeader('content-type', 'text/event-stream');
    const delta = tool ? { tool_calls: [{ index: 0, id: 'write_continuation', type: 'function', function: tool }] } : { content: planning ? 'Plan : créer continued.txt après votre validation.' : 'Project updated. What shall we do next?' };
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\n'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const { c, dir, binding } = fixture({ after() {} }, null), bridge = new RustAgentBridge({ baseDir: path.resolve(__dirname, '..'), dataDir: path.join(dir, 'daemon-data') });
  t.after(async () => { provider.closeAllConnections(); await Promise.all([...bridge.clients.values()].map(x => x.client.stop())); await new Promise(resolve => provider.close(resolve)); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const runtimeConfig = { compatEndpoints: [{ id: 'custom', base_url: `http://127.0.0.1:${provider.address().port}/v1`, key: 'fixture-key' }] };
  c.run = (id, input, onEvent) => bridge.run({ ...input, model: 'compat', submodel: 'custom::fixture', userId: id, keys: {}, runtimeConfig }, onEvent);
  const projectDir = path.join(dir, 'project'); fs.mkdirSync(projectDir);
  const list = c.read('alice', 'chat'); list[0].projectPath = projectDir; list[0].execution = { model: 'compat:custom', submodel: 'fixture', permissionMode: mode };
  fs.writeFileSync(c.file('alice', 'chat'), JSON.stringify(list));
  const users = [{ id: 'alice', messengers: { telegram: { binding, token: 'fixture', chatId: '7' } } }]; const sent = [];
  const m = new MessengerIntegrations({ loadUsers: () => users, saveUsers: () => {}, encrypt: x => x, decrypt: x => x, continuation: c,
    decide: (id, body) => bridge.decide(id, body), fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true, result: {} }) }; } });
  const session = { connected: true, controller: new AbortController() }; m.sessions.set('alice:telegram', session);
  const turn = m.respond('alice', 'telegram', 'Create continued.txt in this project');
  for (let i = 0; i < 150 && !session.pending; i++) await new Promise(resolve => setTimeout(resolve, 50));
  if (mode === 'plan') {
    assert.equal(session.pending?.kind, 'plan'); const firstCode = session.pending.code;
    assert.equal(fs.existsSync(path.join(projectDir, 'continued.txt')), false);
    await m.respond('alice', 'telegram', '/approve ' + firstCode);
    for (let i = 0; i < 150 && (!session.pending || session.pending.code === firstCode); i++) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(session.pending?.kind, 'permission', JSON.stringify({sent,seen:seen.length,first:seen[0], response: await Promise.race([turn, new Promise(r=>setTimeout(()=>r('pending'),100))])})); assert.equal(fs.existsSync(path.join(projectDir, 'continued.txt')), false);
  assert.ok(sent.some(text => text.includes('/approve')));
  await m.respond('alice', 'telegram', '/approve ' + session.pending.code);
  assert.match(await turn, /What shall we do next/); assert.equal(fs.readFileSync(path.join(projectDir, 'continued.txt'), 'utf8'), 'Continued from Telegram');
  assert.ok(seen[0].messages.some(message => String(message.content).includes('Existing project task')));
  assert.match(c.find('alice', binding).messages.at(-1).text, /Project updated\. What shall we do next\?$/);
  if (mode === 'plan') assert.match(c.find('alice', binding).messages.at(-1).text, /validation\.\n\nProject updated/);
});
test('a failed messenger turn is written in the IDE conversation with a readable reason', async t => {
  let during;
  const { c, binding } = fixture(t, async () => { during = c.find('alice', binding).remoteRunning; return { error: '[invalid_request] Limite d’utilisation de votre abonnement ChatGPT atteinte.' }; });
  await assert.rejects(c.answer('alice', { binding, provider: 'whatsapp', message: 'Analyse le projet' }), /^Error: Limite d’utilisation/);
  assert.equal(during, 'whatsapp');
  const conv = c.find('alice', binding), last = conv.messages.at(-1);
  assert.equal(conv.remoteRunning, undefined);
  assert.equal(last.type, 'system'); assert.match(last.text, /depuis WhatsApp : Limite d’utilisation de votre abonnement ChatGPT atteinte\.$/);
});
test('the integration page sees received, failed and ignored WhatsApp messages', async t => {
  const { c, binding } = fixture(t, async () => ({ error: '[rate_limited] Quota atteint.' }));
  const { EventEmitter } = require('node:events');
  let users = [{ id: 'alice', messengers: { whatsapp: { binding } } }], sent = [];
  const client = Object.assign(new EventEmitter(), { isGateway: true, mode: 'self-chat', info: { wid: { _serialized: '1@s.whatsapp.net' } }, initialize: async () => {}, destroy: async () => {}, sendMessage: async (to, text) => { sent.push(text); } });
  const m = new MessengerIntegrations({ loadUsers: () => structuredClone(users), saveUsers: v => { users = v; }, encrypt: v => v, decrypt: v => v, dataDir: 'x', appDir: 'x', continuation: c, whatsappFactory: async () => client });
  await m.startWhatsApp('alice'); client.emit('ready');
  const msg = (id, body) => ({ id: { _serialized: id }, body, fromMe: true, peer: '1@s.whatsapp.net', gatewayMessage: true, timestamp: Math.floor(Date.now() / 1000) });
  client.emit('message_create', msg('a', 'une note')); assert.equal(m.status('alice', 'whatsapp').activity.kind, 'ignored');
  client.emit('message_create', msg('b', 'zaalis! analyse')); await new Promise(r => setTimeout(r, 30));
  const activity = m.status('alice', 'whatsapp').activity;
  assert.equal(activity.kind, 'failed'); assert.equal(activity.detail, 'Quota atteint.'); assert.match(sent.at(-1), /L’IA n’a pas pu répondre : Quota atteint\./);
});
