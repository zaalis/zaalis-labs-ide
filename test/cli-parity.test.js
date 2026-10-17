'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamState } = require('../src/cli/stream-state');
const { createConversationClient, conversationHistory } = require('../src/cli/conversations');
const { createConversationController } = require('../src/cli/conversation-commands');
const { workspaceCommand } = require('../src/cli/workspace-commands');

test('live lead deltas keep tool boundaries without leaking child responses', () => {
  const stream = createStreamState();
  const push = event => stream.accept({ type: 'rust_event', event });
  push({ type: 'agent_spawned', agent: { id: 'lead', role: { name: 'lead' } } });
  assert.equal(push({ type: 'text_delta', agent_id: 'child', text: 'private worker' }), null);
  assert.equal(push({ type: 'text_delta', session_id: 'session', agent_id: 'lead', segment_id: 'a', text: 'Bonjour ' }).delta, 'Bonjour ');
  push({ type: 'text_delta', agent_id: 'lead', segment_id: 'a', text: 'monde.' });
  assert.equal(push({ type: 'text_delta', agent_id: 'lead', segment_id: 'b', text: 'Terminé.' }).delta, '\n\nTerminé.');
  push({ type: 'reasoning_delta', agent_id: 'lead', text: 'Je vérifie.' });
  assert.equal(stream.state.text, 'Bonjour monde.\n\nTerminé.');
  assert.equal(stream.state.reasoning, 'Je vérifie.');
  assert.equal(stream.state.sessionId, 'session');
});

test('shared conversation client encodes IDs and propagates backend errors', async () => {
  const calls = [];
  const client = createConversationClient(async (...args) => {
    calls.push(args);
    return { status: 200, json: { conversation: { id: 'shared', apiHistory: [{ role: 'user', content: 'IDE message' }] } } };
  });
  const conversation = await client.get('a/b');
  assert.equal(calls[0][1], '/api/conversations/a%2Fb?kind=chat');
  assert.deepEqual(conversationHistory(conversation), [{ role: 'user', content: 'IDE message' }]);
  await client.fork('shared', 'Fork CLI');
  assert.deepEqual(calls[1][2], { kind: 'chat', title: 'Fork CLI' });
  const denied = createConversationClient(async () => ({ status: 404, json: { error: 'Absent' } }));
  await assert.rejects(denied.get('missing'), /Absent/);
});

test('CLI resumes IDE runtime identity, forks, and requires exact delete ID', async () => {
  const history = [], session = {};
  const original = { id: 'ide', title: 'IDE', sessionId: 'runtime', model: 'mistral', apiHistory: [{ role: 'assistant', content: 'Existing answer' }] };
  let deleted;
  const client = { list: async () => [original], get: async () => original,
    fork: async () => ({ ...original, id: 'fork', sessionId: null }), remove: async id => { deleted = id; } };
  const controller = createConversationController({ conversations: client, history, getSession: () => session,
    saveSession() {}, persistConversation() {}, projectRoot: () => '.', output() {} });
  await controller.conversationCommand('resume', 'ide');
  assert.equal(controller.active.sessionId, 'runtime');
  assert.equal(history[0].content, 'Existing answer');
  await controller.conversationCommand('fork');
  assert.equal(controller.active.id, 'fork');
  await assert.rejects(controller.conversationCommand('delete', 'wrong'), /fork/);
  await controller.conversationCommand('delete', 'fork');
  assert.equal(deleted, 'fork');
  assert.equal(controller.active, null);
  assert.equal(history.length, 0);
});

test('task creation is supervised; recurring schedule requires explicit flag', async () => {
  const calls = [];
  const options = { root: 'C:\\project', request: async (...args) => { calls.push(args); return { status: 200, json: { ok: true } }; } };
  await workspaceCommand('tasks', 'create vérifier le dépôt', options);
  assert.equal(calls[0][2].enabled, false);
  assert.equal(calls[0][2].permissionMode, 'supervised');
  await workspaceCommand('tasks', 'create --every 30 vérifier le dépôt', options);
  assert.equal(calls[1][2].intervalMinutes, 30);
  assert.equal(calls[1][2].enabled, true);
  assert.equal(calls[1][2].prompt, 'vérifier le dépôt');
  await assert.rejects(workspaceCommand('tasks', 'create --every nope vérifier', options), /minutes/);
  await assert.rejects(workspaceCommand('tasks', 'delete', options), /identifiant/);
});

test('tools and memory use shared APIs, and failed calls stay visible', async () => {
  const calls = [];
  const options = { root: '.', request: async (...args) => { calls.push(args); return { status: 200, json: {} }; } };
  await workspaceCommand('tools', 'describe filesystem', options);
  assert.equal(calls[0][1], '/api/tools/describe');
  assert.equal(calls[0][2].name, 'filesystem');
  await workspaceCommand('memory', 'add conserver cette décision', options);
  assert.equal(calls[1][2].content, 'conserver cette décision');
  await assert.rejects(workspaceCommand('memory', 'list', { ...options, request: async () => ({ status: 401, json: { error: 'Session expirée' } }) }), /Session expirée/);
});

test('real CLI process prints before done and continues the shared runtime session', { timeout: process.env.ZAALIS_TEST_CLI_EXE ? 60000 : 15000 }, async () => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-cli-parity-'));
  fs.writeFileSync(path.join(config, 'session.json'), JSON.stringify({ cookie: 'test-session=fixture', model: 'mistral' }));
  const conversation = { id: 'shared-id', title: 'Shared', projectPath: process.cwd(), apiHistory: [] };
  const prompts = [];
  const managementRequests = [];
  let completed = false, printedBeforeDone = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/me') return res.end(JSON.stringify({ authenticated: true }));
    if (req.url === '/api/config') return res.end(JSON.stringify({ config: {} }));
    if (req.url.startsWith('/api/conversations?')) { managementRequests.push('sessions'); return res.end(JSON.stringify({ conversations: [conversation] })); }
    if (req.url === '/api/tasks') { managementRequests.push('tasks'); return res.end(JSON.stringify({ tasks: [] })); }
    if (req.url.startsWith('/api/tools?')) { managementRequests.push('tools'); return res.end(JSON.stringify({ tools: [] })); }
    if (req.url.startsWith('/api/conversations')) return res.end(JSON.stringify({ conversation }));
    if (req.url !== '/api/agent-chat') { res.statusCode = 404; return res.end('{}'); }
    prompts.push(body);
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = event => res.write(JSON.stringify(event) + '\n');
    send({ type: 'rust_event', event: { type: 'agent_spawned', agent: { id: 'lead', role: { name: 'lead' } } } });
    send({ type: 'rust_event', event: { type: 'text_delta', session_id: 'runtime-id', agent_id: 'worker', text: 'HIDDEN' } });
    send({ type: 'rust_event', event: { type: 'text_delta', session_id: 'runtime-id', agent_id: 'lead', segment_id: 'a', text: 'Bonjour ' } });
    setTimeout(() => {
      send({ type: 'rust_event', event: { type: 'text_delta', agent_id: 'lead', segment_id: 'a', text: 'monde.' } });
      completed = true;
      conversation.sessionId = 'runtime-id';
      conversation.apiHistory.push({ role: 'user', content: body.message }, { role: 'assistant', content: 'Bonjour monde.' });
      res.end(JSON.stringify({ type: 'done', result: { response: 'Bonjour monde.', sessionId: 'runtime-id' } }) + '\n');
    }, 100);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = args => new Promise((resolve, reject) => {
    const packagedCli = process.env.ZAALIS_TEST_CLI_EXE;
    const child = spawn(packagedCli || process.execPath, packagedCli ? args : [path.join(__dirname, '..', 'src', 'app', 'cli.js'), ...args], {
      env: { ...process.env, ZAALIS_PORT: String(server.address().port), ZAALIS_CLI_CONFIG_DIR: config },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; if (!completed && stdout.includes('Bonjour ')) printedBeforeDone = true; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || 'Exit ' + code)));
  });
  try {
    assert.equal(await run(['-p', 'Premier tour']), 'Bonjour monde.\n');
    assert.equal(printedBeforeDone, true);
    assert.equal(prompts[0].conversationId, 'shared-id');
    assert.equal(prompts[0].persistTurn, true);
    assert.equal(await run(['-c', '-p', 'Continuer']), 'Bonjour monde.\n');
    assert.equal(prompts[1].sessionId, 'runtime-id');
    assert.equal(prompts[1].conversationId, 'shared-id');
    assert.equal(prompts[1].history[0].content, 'Premier tour');
    for (const command of ['sessions', 'tasks', 'tools']) await run([command]);
    assert.deepEqual(managementRequests, ['sessions', 'tasks', 'tools']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(config, { recursive: true, force: true });
  }
});
