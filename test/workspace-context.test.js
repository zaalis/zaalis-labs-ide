'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { agentRoot, knownProjects, selectProject } = require('../workspace-context');

test('project context survives missing UI root; no-project chat uses a separate workspace', () => {
  assert.equal(agentRoot({}, {}, __dirname), __dirname);
  assert.equal(agentRoot({}, {}, __dirname, { projectPath: __dirname }), __dirname);
  assert.equal(agentRoot({ root: os.homedir() }, {}, __dirname, { projectPath: __dirname }), os.homedir());
});

test('project lookup rejects unknown and ambiguous names, and keeps full paths', () => {
  const projects = [{ name: 'app', path: 'C:/a/app', available: true }, { name: 'app', path: 'C:/b/app', available: true }];
  assert.throws(() => selectProject(projects, 'app'), /Plusieurs/);
  assert.throws(() => selectProject(projects, 'absent'), /inconnu/);
  assert.equal(selectProject(projects, 'C:/b/app'), 'C:/b/app');
  assert.equal(knownProjects({ recentProjects: [__dirname, __dirname] }, __dirname).length, 1);
});

test('real agent opens a known project and terminal, then resumes in the correct sandbox', { timeout: 60000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-workspace-test-'));
  const project = path.join(temp, 'connexion ide');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'marker.txt'), 'correct-project');
  const seen = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    seen.push(body);
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); }
    const messages = body.messages || [];
    const userIndex = messages.findLastIndex(item => item.role === 'user');
    const current = messages.slice(userIndex + 1);
    const toolResults = current.filter(item => item.role === 'tool');
    const opening = String(messages[userIndex]?.content).includes('Ouvre');
    const tool = opening
      ? toolResults.length === 0 ? { name: 'workspace', arguments: '{"action":"list"}' }
        : toolResults.length === 1 ? { name: 'workspace', arguments: '{"action":"open","project":"connexion ide","terminal":true}' } : null
      : toolResults.length === 0 ? { name: 'read', arguments: '{"path":"marker.txt"}' } : null;
    res.setHeader('content-type', 'text/event-stream');
    const delta = tool ? { tool_calls: [{ index: 0, id: 'call_' + seen.length, type: 'function', function: tool }] } : { content: 'Terminé.' };
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const port = 34900 + Math.floor(Math.random() * 500);
  const executable = process.env.ZAALIS_TEST_PACKAGED ? path.resolve(__dirname, '..', 'native', 'dist', 'zaalis-server.exe') : process.execPath;
  const child = spawn(executable, process.env.ZAALIS_TEST_PACKAGED ? [] : ['server.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: path.join(temp, 'data'), ZAALIS_RUST_CORE: 'on' } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const registration = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'workspace@zaalis.local', password: 'password123' }) });
    assert.equal(registration.status, 200);
    const headers = { cookie: registration.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
    const put = (url, value) => fetch(base + url, { method: 'PUT', headers, body: JSON.stringify(value) });
    assert.equal((await put('/api/recent-projects', { projects: [project] })).status, 200);
    assert.equal((await put('/api/compat/keys', { keys: { custom: 'sk-fixture-workspace-0123456789' }, baseUrls: { custom: `http://127.0.0.1:${provider.address().port}/v1` } })).status, 200);
    const run = async value => {
      const response = await fetch(base + '/api/agent-chat', { method: 'POST', headers, body: JSON.stringify({ model: 'compat:custom', submodel: 'fixture', permissionMode: 'auto', ...value }) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.error, undefined, JSON.stringify(result));
      return result;
    };
    const first = await run({ message: 'Ouvre le projet connexion ide dans le terminal' });
    assert.equal(first.workspaceSelection?.root, project);
    assert.ok(first.toolResults.some(item => item.tool === 'workspace' && item.text.includes(project.replaceAll('\\', '\\\\'))));
    const terminal = await (await fetch(base + '/api/terminal/sessions/' + first.workspaceSelection.terminalId, { headers })).json();
    assert.equal(terminal.cwd, project);
    assert.ok(!terminal.closed);
    await put('/api/chats', { kind: 'chat', conversations: [{ id: 'restored', projectPath: project, project: 'connexion ide', messages: [] }] });
    const second = await run({ message: 'Lis marker.txt', conversationId: 'restored', sessionId: first.sessionId });
    assert.notEqual(second.sessionId, first.sessionId, 'a stale sandbox is replaced after switching project');
    assert.ok(second.toolResults.some(item => item.tool === 'read' && item.text.includes('correct-project')));
    const third = await run({ message: 'Lis marker.txt', root: project, sessionId: second.sessionId });
    assert.equal(third.sessionId, second.sessionId, 'same project resumes durable session');
    assert.ok(third.toolResults.some(item => item.tool === 'read' && item.text.includes('correct-project')));
    assert.equal((await fetch(base + '/api/internal/rust-workspace', { method: 'POST', headers, body: '{"action":"list"}' })).status, 401);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => provider.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(temp).startsWith('zaalis-workspace-test-'));
    for (let attempt = 0; attempt < 40; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
});
