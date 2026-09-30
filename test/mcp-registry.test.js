'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const mcpRegistry = require('../mcp-registry');
const { runtimeMcpEntry } = require('../rust-agent-bridge');

const windows = process.platform === 'win32';

// A minimal stdio MCP server. It prints a banner and a request of its own
// before answering, as real servers do, and reports the environment it sees.
const STDIO_SERVER = `
const readline = require('readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    process.stdout.write('starting up\\n');
    send({ jsonrpc: '2.0', id: message.id, method: 'roots/list' });
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1.2.3' }, instructions: 'Inspect before you modify.' } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'get_scene', description: 'Read   the scene.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, depth: { type: 'number' } }, required: ['name'] } },
      { name: 'run_code', description: 'Run code.', inputSchema: { type: 'object', properties: {} } },
    ] } });
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ tool: message.params.name, args: process.argv.slice(2), mark: process.env.FIXTURE_MARK || '', leak: process.env.ZAALIS_FIXTURE_SECRET || '' }) }] } });
  } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
});
`;

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'server.js'), STDIO_SERVER);
  return dir;
}
const stdioServer = (dir, extra = {}) => ({ id: 'fixture', name: 'Fixture', transport: 'stdio', command: process.execPath, args: [path.join(dir, 'server.js')], env: {}, allow: [], deny: [], ...extra });

test('normaliseServer accepts an URL or a local command, and nothing else', () => {
  assert.deepEqual(mcpRegistry.normaliseServer({ name: 'Notes', endpoint: 'http://127.0.0.1:8000/mcp', allow: ['read', 'bad name'] }),
    { id: 'notes', name: 'Notes', enabled: true, allow: ['read'], deny: [], transport: 'http', endpoint: 'http://127.0.0.1:8000/mcp' });
  assert.equal(mcpRegistry.normaliseServer({ name: 'remote', endpoint: 'http://example.com/mcp' }), null);
  assert.equal(mcpRegistry.normaliseServer({ name: 'creds', endpoint: 'https://user:pass@example.com/mcp' }), null);

  // The shape of a Claude Desktop / Codex entry: a command, no transport field.
  assert.deepEqual(mcpRegistry.normaliseServer({ name: 'Blender MCP', command: 'uvx', args: ['blender-mcp', 3], env: { BLENDER_MCP_PORT: 9876 }, enabled: false }),
    { id: 'blender-mcp', name: 'Blender MCP', enabled: false, allow: [], deny: [], transport: 'stdio', command: 'uvx', args: ['blender-mcp', '3'], env: { BLENDER_MCP_PORT: '9876' } });
  assert.equal(mcpRegistry.normaliseServer({ name: 'x', transport: 'stdio', command: '' }), null);
  assert.equal(mcpRegistry.normaliseServer({ name: 'x', command: 'a\nb' }), null);
  assert.equal(mcpRegistry.normaliseServer({ name: 'x', command: 'a', args: 'not-a-list' }), null);
  assert.equal(mcpRegistry.normaliseServer({ name: 'x', command: 'a', args: new Array(65).fill('a') }), null);
  assert.equal(mcpRegistry.normaliseServer({ name: 'x', command: 'a', env: { 'BAD NAME': '1' } }), null);
  assert.equal(mcpRegistry.normaliseServer({ name: 'x', command: 'a', env: { OK: 'line\nbreak' } }), null);
  assert.equal(mcpRegistry.normaliseServer({ command: 'a' }), null);
});

test('the entries of the former Blender preset are recognised, and nothing else', () => {
  // Blender is built into the IDE: what the old preset button created is dropped.
  assert.equal(mcpRegistry.isBlenderPreset({ id: 'blender', name: 'Blender MCP', endpoint: 'http://127.0.0.1:9876/mcp', enabled: true }), true);
  assert.equal(mcpRegistry.isBlenderPreset({ id: 'blender', transport: 'stdio', command: 'blender-mcp', args: [] }), true);
  assert.equal(mcpRegistry.isBlenderPreset({ id: 'blender', transport: 'stdio', command: 'C:\\tools\\Blender-MCP.exe' }), process.platform === 'win32');
  // Anything the user pointed elsewhere is theirs and stays as it is.
  assert.equal(mcpRegistry.isBlenderPreset({ id: 'blender', endpoint: 'http://127.0.0.1:8000/' }), false);
  assert.equal(mcpRegistry.isBlenderPreset({ id: 'blender', transport: 'stdio', command: 'uvx', args: ['blender-mcp'] }), false);
  assert.equal(mcpRegistry.isBlenderPreset({ id: 'notes', endpoint: 'http://127.0.0.1:9876/mcp' }), false);
  assert.equal(mcpRegistry.isBlenderPreset(null), false);
});

test('resolveCommand finds programs on PATH and refuses relative paths', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-mcp-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const program = path.join(dir, windows ? 'mytool.cmd' : 'mytool');
  fs.writeFileSync(program, '');
  // An extension-less file of the same name (npm ships one beside npx.cmd) is not runnable on Windows.
  if (windows) fs.writeFileSync(path.join(dir, 'mytool'), '');
  const env = { PATH: dir, USERPROFILE: dir, HOME: dir, APPDATA: dir };
  assert.equal(mcpRegistry.resolveCommand('mytool', { env }), program);
  assert.equal(mcpRegistry.resolveCommand(program, { env }), program);
  assert.equal(mcpRegistry.resolveCommand('missing-tool', { env }), '');
  assert.equal(mcpRegistry.resolveCommand(`.${path.sep}mytool`, { env }), '');
  assert.equal(mcpRegistry.resolveCommand('', { env }), '');

  // blender-mcp is looked up where other assistants install it when PATH has none.
  const bin = path.join(dir, '.codex', 'mcp-servers', 'blender-mcp', windows ? 'Scripts' : 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const bridge = path.join(bin, windows ? 'blender-mcp.exe' : 'blender-mcp');
  fs.writeFileSync(bridge, '');
  assert.equal(mcpRegistry.resolveCommand('blender-mcp', { env }), bridge);
});

test('a stdio server is described, called and given a scoped environment', async (t) => {
  const dir = fixtureDir(t);
  process.env.ZAALIS_FIXTURE_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.ZAALIS_FIXTURE_SECRET; });
  const server = stdioServer(dir, { args: [path.join(dir, 'server.js'), 'two words'], env: { FIXTURE_MARK: 'from-config' } });

  const info = await mcpRegistry.describe(server);
  assert.deepEqual(info.tools.map((tool) => tool.name), ['get_scene', 'run_code']);
  assert.equal(info.instructions, 'Inspect before you modify.');
  assert.deepEqual(info.serverInfo, { name: 'fixture', version: '1.2.3' });
  assert.equal(info.executable, process.execPath);
  assert.deepEqual((await mcpRegistry.tools(server)).length, 2);

  const result = await mcpRegistry.call(server, 'get_scene', { name: 'Cube' });
  assert.deepEqual(JSON.parse(result.content[0].text), { tool: 'get_scene', args: ['two words'], mark: 'from-config', leak: '' });

  await assert.rejects(mcpRegistry.call({ ...server, deny: ['run_code'] }, 'run_code', {}), /refusé/);
  await assert.rejects(mcpRegistry.describe({ ...server, command: 'zaalis-no-such-program' }), /introuvable/);
  // A program that is not an MCP server: the connection fails instead of hanging.
  await assert.rejects(mcpRegistry.describe({ ...server, args: ['-e', 'process.exit(0)'] }), /arrêté|répond pas/);
  await assert.rejects(mcpRegistry.describe({ ...server, args: ['-e', 'setTimeout(() => {}, 60000)'] }, { timeoutMs: 300 }), /répond pas/);
});

test('a .cmd launcher runs through the command interpreter', { skip: !windows }, async (t) => {
  const dir = fixtureDir(t);
  const spaced = path.join(dir, 'my tools');
  fs.mkdirSync(spaced);
  fs.copyFileSync(path.join(dir, 'server.js'), path.join(spaced, 'server.js'));
  fs.writeFileSync(path.join(spaced, 'launch.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0server.js" %*\r\n`);
  const server = { id: 'wrapped', transport: 'stdio', command: path.join(spaced, 'launch.cmd'), args: ['two words', 'plain'], env: {}, allow: [], deny: [] };
  const result = await mcpRegistry.call(server, 'get_scene', {});
  assert.deepEqual(JSON.parse(result.content[0].text).args, ['two words', 'plain']);
  assert.throws(() => mcpRegistry.spawnPlan(server.command, ['a & calc'], true), /non pris en charge/);
  assert.deepEqual(mcpRegistry.spawnPlan('C:\\tools\\server.exe', ['a & b'], true), { file: 'C:\\tools\\server.exe', args: ['a & b'], options: {} });
});

test('an HTTP server gets the initialized notification before its first request', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      seen.push([message.method, req.headers['mcp-session-id'] || '', req.headers.authorization || '']);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, instructions: 'hello' }
        : message.method === 'tools/list' ? { tools: [{ name: 'read' }] } : { content: [{ type: 'text', text: 'done' }] };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const entry = { id: 'web', endpoint: `http://127.0.0.1:${server.address().port}/mcp`, token: 'secret', allow: [], deny: [] };
  const info = await mcpRegistry.describe(entry);
  assert.deepEqual(info.tools, [{ name: 'read' }]);
  assert.equal(info.instructions, 'hello');
  assert.deepEqual(seen, [['initialize', '', 'Bearer secret'], ['notifications/initialized', 'session-1', 'Bearer secret'], ['tools/list', 'session-1', 'Bearer secret']]);
});

test('probe reports whether the application behind the Blender bridge is listening', async (t) => {
  const listener = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const blender = { transport: 'stdio', command: windows ? 'C:\\tools\\Blender-MCP.exe' : '/opt/blender-mcp', env: { BLENDER_MCP_HOST: '127.0.0.1', BLENDER_MCP_PORT: String(port) } };
  assert.deepEqual(await mcpRegistry.probe(blender), { label: 'Blender', host: '127.0.0.1', port, reachable: true });
  await new Promise((resolve) => listener.close(resolve));
  assert.equal((await mcpRegistry.probe(blender)).reachable, false);
  assert.equal(await mcpRegistry.probe({ transport: 'stdio', command: 'npx', env: {} }), null);
  assert.equal(await mcpRegistry.probe({ endpoint: 'http://127.0.0.1:1/mcp' }), null);
});

test('buildSkill lists only the tools the server policy allows', () => {
  const info = {
    instructions: 'Inspect before you modify.',
    tools: [
      { name: 'get_scene', description: 'Read   the scene.', inputSchema: { type: 'object', properties: { name: {}, depth: {} }, required: ['name'] } },
      { name: 'run_code', description: 'Run code.' },
      { name: 'bad name' },
    ],
  };
  const skill = mcpRegistry.buildSkill({ id: 'blender', name: 'Blender MCP', allow: [], deny: ['run_code'] }, info);
  assert.equal(skill.name, 'blender');
  assert.ok(skill.description.length <= 236);
  assert.match(skill.description, /Blender MCP/);
  assert.match(skill.description, /server="blender"/);
  assert.ok(skill.instructions.startsWith('---\nname: blender\ndescription: '));
  assert.match(skill.instructions, /- `get_scene` \(name, depth\?\) — Read the scene\./);
  assert.doesNotMatch(skill.instructions, /run_code|bad name/);
  assert.match(skill.instructions, /Inspect before you modify\./);
  assert.equal(mcpRegistry.buildSkill({ id: 'blender', allow: [], deny: [] }, { tools: [] }), null);
  assert.equal(mcpRegistry.buildSkill({ id: 'bad id', allow: [], deny: [] }, info), null);
});

test('the runtime entry of a stdio server names its secrets instead of carrying them', (t) => {
  const dir = fixtureDir(t);
  const env = {};
  const entry = runtimeMcpEntry(stdioServer(dir, { env: { API_TOKEN: 'secret-value', 'BAD NAME': 'x' }, deny: ['run_code'] }), 3, env);
  assert.deepEqual(entry, {
    transport: 'stdio', executable: fs.realpathSync.native(process.execPath), args: [path.join(dir, 'server.js')],
    env_from: { API_TOKEN: 'ZAALIS_MCP_ENV_3_0' }, timeout_ms: 120000, name: 'Fixture', allow: [], deny: ['run_code'],
  });
  assert.deepEqual(env, { ZAALIS_MCP_ENV_3_0: 'secret-value' });
  assert.doesNotMatch(JSON.stringify(entry), /secret-value/);

  // A program that cannot be found is left out: the runtime would otherwise
  // reject the whole configuration and no chat could start.
  assert.equal(runtimeMcpEntry({ id: 'gone', transport: 'stdio', command: 'zaalis-no-such-program', args: [] }, 0, {}), null);

  const httpEnv = {};
  assert.deepEqual(runtimeMcpEntry({ id: 'web', name: 'Web', endpoint: 'http://127.0.0.1:8000/mcp', token: 'abc', allow: ['read'], deny: [] }, 1, httpEnv),
    { transport: 'streamable_http', endpoint: 'http://127.0.0.1:8000/mcp', oauth_env: 'ZAALIS_MCP_TOKEN_1', name: 'Web', allow: ['read'], deny: [] });
  assert.deepEqual(httpEnv, { ZAALIS_MCP_TOKEN_1: 'abc' });
  // A server whose calls run long asks for more than the runtime's 15 s, up to its maximum.
  assert.equal(runtimeMcpEntry({ id: 'slow', endpoint: 'http://127.0.0.1:8000/mcp', timeoutMs: 90000 }, 0, {}).timeout_ms, 90000);
  assert.equal(runtimeMcpEntry({ id: 'slow', endpoint: 'http://127.0.0.1:8000/mcp', timeoutMs: 900000 }, 0, {}).timeout_ms, 120000);
  assert.equal(runtimeMcpEntry({ id: 'bad', endpoint: 'ftp://example.com' }, 2, {}), null);
});
