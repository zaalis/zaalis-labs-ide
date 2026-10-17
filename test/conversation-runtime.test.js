'use strict';

// Real HTTP server + actual Rust daemon, with every provider request confined
// to this process's loopback fixture. No user account or external API is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { findAgentd } = require('../src/agent/rust-agent-bridge');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function until(read, predicate, label, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(75);
  }
  throw new Error('Timed out: ' + label);
}

test('canonical conversations continue, fork, recall memory, and execute persisted tasks through real agentd', { timeout: 90000 }, async t => {
  const repo = path.resolve(__dirname, '..');
  const executable = findAgentd(repo);
  assert.ok(executable, 'real Rust daemon is required');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-conversation-runtime-'));
  const project = path.join(temp, 'project'); fs.mkdirSync(project);
  const calls = [];
  const fixture = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }));
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
    const body = JSON.parse(raw); calls.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const send = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    const asksClarification = body.messages.some(message => message.role === 'user' && String(message.content).includes('Clarification fixture demand'));
    const hasAnswer = body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'clarify-fixture');
    if (asksClarification && !hasAnswer) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'clarify-fixture', type: 'function', function: {
        name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'format', prompt: 'Quel format ?', options: [{ label: 'Court', description: 'Réponse courte' }], allow_free_text: true }] }),
      } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return res.end('data: [DONE]\n\n');
    }
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Réponse ' } }] });
    await pause(20);
    send({ choices: [{ index: 0, delta: { content: 'locale.' } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } });
    res.end('data: [DONE]\n\n');
  });
  const fixturePort = await listen(fixture);
  const reservation = http.createServer(); const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  let serverOutput = '';
  const packagedServer = process.env.ZAALIS_TEST_SERVER_EXE;
  const child = spawn(packagedServer || process.execPath, packagedServer ? [] : ['src/app/server.js'], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: path.join(temp, 'data'),
      ZAALIS_RUST_CORE: 'on', ZAALIS_AGENTD_PATH: executable },
  });
  child.stdout.on('data', chunk => { serverOutput += chunk; });
  child.stderr.on('data', chunk => { serverOutput += chunk; });
  let cookie = '';
  const api = async (url, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const turn = async (id, message, sessionId, onEvent) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-chat`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'compat:custom', submodel: 'fixture-chat', root: project,
        conversationId: id, sessionId, message, stream: true, persistTurn: true, permissionMode: 'read-only' }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const events = [], decoder = new TextDecoder(); let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line); events.push(event);
        if (onEvent) await onEvent(event);
      }
    }
    assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events));
    const done = events.find(event => event.type === 'done');
    assert.ok(done?.result?.sessionId, 'daemon session ID returned');
    assert.equal(done.result.response, 'Réponse locale.');
    assert.ok(events.some(event => event.type === 'rust_event' && event.event.type === 'text_delta'));
    return { ...done.result, events };
  };
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/auth/me`)).ok; } catch { return false; } }, Boolean, 'server startup');
    const registration = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'runtime-fixture@zaalis.local', password: 'fixture-password-123' }),
    });
    assert.equal(registration.status, 200);
    cookie = registration.headers.get('set-cookie').split(';')[0];
    await api('/api/compat/keys', 'PUT', { keys: { custom: 'local-fixture-key' }, baseUrls: { custom: `http://127.0.0.1:${fixturePort}/v1` } });
    const original = (await api('/api/conversations', 'POST', { title: 'Runtime original', projectPath: project, model: 'compat:custom', submodel: 'fixture-chat', source: 'cli' })).conversation;
    const first = await turn(original.id, 'Premier message unique');
    const savedFirst = (await api('/api/conversations/' + original.id)).conversation;
    assert.equal(savedFirst.sessionId, first.sessionId);
    assert.equal(savedFirst.apiHistory.length, 2);
    const second = await turn(original.id, 'Deuxième message unique', first.sessionId);
    assert.equal(second.sessionId, first.sessionId, 'continuation keeps runtime identity');
    const secondProviderCall = calls.at(-1);
    assert.ok(JSON.stringify(secondProviderCall.messages).includes('Premier message unique'));
    assert.ok(JSON.stringify(secondProviderCall.messages).includes('Deuxième message unique'));
    const branch = (await api(`/api/conversations/${original.id}/fork`, 'POST', { title: 'Runtime branch' })).conversation;
    assert.equal(branch.sessionId, undefined);
    assert.equal(branch.apiHistory.length, 4);
    const forked = await turn(branch.id, 'Branche indépendante');
    assert.notEqual(forked.sessionId, first.sessionId);
    assert.ok(JSON.stringify(calls.at(-1).messages).includes('Premier message unique'), 'fork retains copied context');
    assert.equal((await api('/api/conversations/' + original.id)).conversation.apiHistory.length, 4, 'fork leaves parent history intact');
    await api('/api/conversations/' + branch.id, 'PATCH', { title: 'Renamed searchable branch', archived: true });
    assert.equal((await api('/api/conversations?q=searchable')).conversations.length, 0);
    assert.equal((await api('/api/conversations?q=searchable&archived=all')).conversations[0].id, branch.id);
    const events = await api(`/api/conversations/${original.id}/events`);
    assert.ok(Array.isArray(events.events) && events.events.length > 0, 'durable event timeline exists');
    t.diagnostic('Real canonical create/continue/fork/history/archive/search/event replay passed using ' + path.basename(executable));

    const memory = (await api('/api/knowledge', 'POST', { root: project, title: 'Constellation fixture', content: 'Constellation utilise la valeur test-only-742.', tags: ['integration'] })).record;
    assert.ok((await api('/api/knowledge?q=Constellation&root=' + encodeURIComponent(project))).records.some(record => record.id === memory.id));
    await turn(original.id, 'Rappelle Constellation', first.sessionId);
    assert.ok(JSON.stringify(calls.at(-1).messages).includes('test-only-742'), 'saved memory is recalled into real provider request');
    await api('/api/knowledge/' + memory.id, 'DELETE');

    const discovered = await api('/api/tools?root=' + encodeURIComponent(project) + '&q=request_user_input');
    assert.ok(discovered.tools.some(tool => tool.name === 'request_user_input'), 'actual runtime exposes clarification tool');
    let clarificationAnswered = false;
    await turn(original.id, 'Clarification fixture demand', first.sessionId, async event => {
      if (event.type !== 'clarification_required') return;
      assert.equal(event.questions[0].id, 'format');
      await api('/api/rust-core/decision', 'POST', { sessionId: event.sessionId, requestId: event.requestId,
        kind: 'clarification', answers: { format: 'Court' } });
      clarificationAnswered = true;
    });
    assert.equal(clarificationAnswered, true, 'structured question awaited a real user decision');
    assert.ok(calls.at(-1).messages.some(message => message.role === 'tool' && String(message.content).includes('Court')), 'clarification answer returned to provider');
    t.diagnostic('Real runtime tool discovery and structured clarification decision passed.');

    const taskBody = { title: 'Local manual task', prompt: 'Une tâche manuelle isolée', root: project, model: 'compat:custom', submodel: 'fixture-chat', permissionMode: 'read-only', enabled: false };
    const manual = (await api('/api/tasks', 'POST', taskBody)).task;
    await api('/api/tasks/' + manual.id + '/run', 'POST', {});
    const finished = await until(() => api('/api/tasks'), result => result.tasks.some(task => task.id === manual.id && ['completed', 'failed'].includes(task.status)), 'manual real daemon task');
    const completed = finished.tasks.find(task => task.id === manual.id);
    assert.equal(completed.status, 'completed', completed.lastError);
    assert.equal(completed.lastResult, 'Réponse locale.');
    assert.ok(completed.sessionId);
    const scheduled = (await api('/api/tasks', 'POST', { ...taskBody, title: 'Local scheduled task', prompt: 'Une tâche planifiée isolée', enabled: true, runAt: new Date(Date.now() + 200).toISOString() })).task;
    const scheduledResult = await until(() => api('/api/tasks'), result => result.tasks.some(task => task.id === scheduled.id && ['completed', 'failed'].includes(task.status)), 'scheduled real daemon task', 25000);
    assert.equal(scheduledResult.tasks.find(task => task.id === scheduled.id).status, 'completed');
    await api('/api/tasks/' + manual.id, 'DELETE'); await api('/api/tasks/' + scheduled.id, 'DELETE');
    await api('/api/conversations/' + branch.id, 'DELETE');
    const deleted = await fetch(`http://127.0.0.1:${port}/api/conversations/${branch.id}`, { headers: { Cookie: cookie } });
    assert.equal(deleted.status, 404);
    t.diagnostic('General memory recall + manual and scheduled real daemon tasks passed.');
  } catch (error) {
    t.diagnostic(serverOutput.slice(-6000)); throw error;
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => fixture.close(resolve));
    for (let attempt = 0; attempt < 40; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await pause(100); }
    }
  }
});
