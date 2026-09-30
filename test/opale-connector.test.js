'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Opale is a separate project: these tests need its folder (the "opale" folder
// on the Desktop, or OPALE_DIR) and are skipped on a machine without it.
const opaleDir = process.env.OPALE_DIR || [path.join(os.homedir(), 'Desktop', 'opale'), process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop', 'opale'), process.env.OneDrive && path.join(process.env.OneDrive, 'Bureau', 'opale')]
  .filter(Boolean).find((dir) => fs.existsSync(path.join(dir, 'server.js')));
if (!opaleDir) {
  test('Opale link', { skip: 'the Opale project is not present on this machine' }, () => {});
  return;
}

// Everything below runs against a throwaway Opale home and vault.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-opale-test-'));
process.env.OPALE_HOME = path.join(temp, 'opale-home');
const vaultRoot = path.join(temp, 'Coffre test');
fs.mkdirSync(vaultRoot, { recursive: true });
fs.writeFileSync(path.join(vaultRoot, 'Accueil.md'), '# Accueil\nVoir [[Brouillon]].\n');
fs.writeFileSync(path.join(vaultRoot, 'Brouillon.md'), 'Un brouillon.\n');

const connector = require('../opale-connector');
const mcpRegistry = require('../mcp-registry');
const { syncManagedSkills, findAgentd } = require('../rust-agent-bridge');
const { createOpale } = require(path.join(opaleDir, 'server.js'));

let opale;
test.before(async () => {
  opale = createOpale({ port: 0, vaultPath: vaultRoot, watch: false });
  await opale.listen();
});
test.after(async () => {
  await opale.close();
  assert.ok(path.basename(temp).startsWith('zaalis-opale-test-'));
  for (let attempt = 0; attempt < 40; attempt++) {
    try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
});

test('a running Opale is detected from its instance file', async () => {
  const inst = connector.instance();
  assert.equal(inst.port, opale.port);
  assert.equal(inst.endpoint, `http://127.0.0.1:${opale.port}/mcp`);
  assert.deepEqual(inst.vault, { name: 'Coffre test', path: fs.realpathSync(vaultRoot) });
  assert.equal((await connector.running()).pid, process.pid);
  const status = await connector.status(path.join(temp, 'nowhere'));
  assert.equal(status.running, true);
  assert.equal(status.detected, true);
  assert.equal(status.vault.name, 'Coffre test');
});

test('the instance file cannot redirect the token to another host', () => {
  const file = path.join(process.env.OPALE_HOME, 'instance.json');
  const original = fs.readFileSync(file, 'utf8');
  const info = JSON.parse(original);
  try {
    fs.writeFileSync(file, JSON.stringify({ ...info, url: 'https://evil.example', mcp: 'https://evil.example/mcp' }));
    assert.equal(connector.instance().endpoint, `http://127.0.0.1:${opale.port}/mcp`);
    fs.writeFileSync(file, JSON.stringify({ ...info, port: 'evil.example:443' }));
    assert.equal(connector.instance(), null);
    fs.writeFileSync(file, JSON.stringify({ ...info, token: 'short' }));
    assert.equal(connector.instance(), null);
    fs.writeFileSync(file, JSON.stringify({ ...info, pid: 0 }));
    assert.equal(connector.instance(), null, 'a stale file from a dead process is ignored');
  } finally { fs.writeFileSync(file, original); }
});

test('only Opale itself can be launched from install.json', () => {
  const dir = path.join(temp, 'launch');
  fs.mkdirSync(path.join(dir, 'opale'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
  const write = (file, content = '') => { fs.writeFileSync(file, content); return file; };
  const shell = write(path.join(dir, 'Opale.exe'));
  const evil = write(path.join(dir, 'evil.exe'));
  const server = write(path.join(dir, 'opale', 'server.js'));
  write(path.join(dir, 'opale', 'package.json'), '{"name":"opale"}');
  const otherServer = write(path.join(dir, 'other', 'server.js'));
  write(path.join(dir, 'other', 'package.json'), '{"name":"something-else"}');

  assert.deepEqual(connector.validLaunch({ file: shell, args: [] }), { file: shell, args: [], cwd: dir });
  assert.equal(connector.validLaunch({ file: shell, args: ['--anything'] }), null);
  assert.equal(connector.validLaunch({ file: evil, args: [] }), null);
  assert.equal(connector.validLaunch({ file: 'Opale.exe', args: [] }), null, 'relative paths are refused');
  assert.equal(connector.validLaunch({ file: path.join(dir, 'missing', 'Opale.exe'), args: [] }), null);
  assert.deepEqual(connector.validLaunch({ file: process.execPath, args: [server, '--window', '-e', 'evil'] }), { file: process.execPath, args: [server, '--window'], cwd: path.join(dir, 'opale') });
  assert.equal(connector.validLaunch({ file: process.execPath, args: [otherServer] }), null, 'Node may only run Opale’s own server.js');
  assert.equal(connector.validLaunch({ file: process.execPath, args: ['-e', 'process.exit()'] }), null);
});

test('connecting exposes the vault tools and a Skill describing them', async () => {
  const inst = await connector.running();
  const greeting = await connector.hello(inst);
  assert.equal(greeting.vault.name, 'Coffre test');
  const entry = await connector.mcpServer();
  assert.equal(entry.id, 'opale');
  assert.equal(entry.endpoint, inst.endpoint);
  assert.ok(entry.skill.description.length <= 240, 'the core keeps 240 characters of description');
  assert.match(entry.skill.description, /server="opale"/);
  assert.match(entry.skill.instructions, /^---\nname: opale\ndescription: Coffre de notes Opale « Coffre test » connecté\./);
  for (const tool of ['vault_info', 'read_note', 'write_note', 'move_many', 'search', 'delete']) assert.match(entry.skill.instructions, new RegExp(`- \`${tool}\` \\(`));
  assert.match(entry.skill.instructions, /`move` \(from, to\)/);

  // The same registry the IDE uses for personal MCP servers can drive it.
  const result = await mcpRegistry.call(entry, 'move', { from: 'Brouillon', to: 'Archives/Texte final' });
  assert.match(result.content[0].text, /Brouillon\.md → Archives\/Texte final\.md \(1 lien\(s\) mis à jour dans 1 note\(s\)\)/);
  assert.equal(fs.readFileSync(path.join(vaultRoot, 'Accueil.md'), 'utf8'), '# Accueil\nVoir [[Texte final]].\n');
  await assert.rejects(mcpRegistry.call({ ...entry, token: 'f'.repeat(64) }, 'vault_info', {}), /Jeton Opale invalide|MCP HTTP 401/);
});

test('managed Skills are written, replaced and removed without touching the user’s own', () => {
  const config = path.join(temp, 'extensions');
  const own = path.join(config, 'skills', 'mine');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'mine');
  syncManagedSkills(config, [{ name: 'opale', instructions: '---\r\nname: opale\r\n---\r\nun' }, { name: 'mine', instructions: 'overwrite attempt' }, { name: '../evil', instructions: 'x' }]);
  assert.equal(fs.readFileSync(path.join(config, 'skills', 'opale', 'SKILL.md'), 'utf8'), '---\nname: opale\n---\nun');
  assert.equal(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(path.join(config, 'skills')).sort(), ['mine', 'opale']);
  assert.ok(!fs.existsSync(path.join(config, 'evil')));
  syncManagedSkills(config, [{ name: 'opale', instructions: 'deux' }]);
  assert.equal(fs.readFileSync(path.join(config, 'skills', 'opale', 'SKILL.md'), 'utf8'), 'deux');
  syncManagedSkills(config, []);
  assert.deepEqual(fs.readdirSync(path.join(config, 'skills')), ['mine']);
});

test('a present Opale is linked by default: the real agent gets the vault, until the link is cut', { timeout: 90000, skip: findAgentd(path.resolve(__dirname, '..')) ? false : 'zaalis-agentd is not built' }, async () => {
  const seen = [];
  // A scripted OpenAI-compatible model: write a note through Opale, then stop.
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); }
    seen.push(body);
    const messages = body.messages || [];
    const userIndex = messages.findLastIndex((item) => item.role === 'user');
    const done = messages.slice(userIndex + 1).filter((item) => item.role === 'tool').length;
    const wantsNote = String(messages[userIndex]?.content).includes('Opale');
    const tool = wantsNote && done === 0
      ? { name: 'mcp', arguments: JSON.stringify({ server: 'opale', tool: 'write_note', arguments: { path: 'Boîte/Depuis l’IDE', content: '# Depuis l’IDE\n\nÉcrit par l’agent. Voir [[Accueil]].\n' } }) }
      : null;
    res.setHeader('content-type', 'text/event-stream');
    const delta = tool ? { tool_calls: [{ index: 0, id: `call_${seen.length}`, type: 'function', function: tool }] } : { content: 'Terminé.' };
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = 35500 + Math.floor(Math.random() * 400);
  // The agent's own project: separate from its data folder and from the vault.
  const project = path.join(temp, 'projet');
  fs.mkdirSync(project);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: path.join(temp, 'ide-data'), ZAALIS_RUST_CORE: 'on' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await fetch(`${base}/api/opale/status`)).status, 401, 'the Opale routes require a session');
    const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'opale@zaalis.local', password: 'password123' }) });
    assert.equal(registration.status, 200);
    const headers = { cookie: registration.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/compat/keys`, { method: 'PUT', headers, body: JSON.stringify({ keys: { custom: 'sk-fixture-opale-0123456789' }, baseUrls: { custom: `http://127.0.0.1:${provider.address().port}/v1` } }) })).status, 200);
    const run = async (message) => {
      const response = await fetch(`${base}/api/agent-chat`, { method: 'POST', headers, body: JSON.stringify({ model: 'compat:custom', submodel: 'fixture', permissionMode: 'auto', root: project, message }) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const systemPrompt = () => String((seen[seen.length - 1].messages.find((item) => item.role === 'system') || {}).content || '');

    const before = await (await fetch(`${base}/api/opale/status`, { headers })).json();
    // Nothing was configured for this brand-new account: the link is already on.
    assert.deepEqual([before.detected, before.running, before.connected, before.vault.name], [true, true, true, 'Coffre test']);
    assert.equal(opale.vault.files.has('Boîte/Depuis l’IDE.md'), false);

    const result = await run('Écris une note dans Opale');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.match(systemPrompt(), /SKILLS DISPONIBLES[^]*- opale: Coffre de notes Opale « Coffre test » connecté/);
    assert.ok(result.toolResults.some((item) => item.tool === 'mcp' && /Note créée : Boîte\/Depuis l’IDE\.md/.test(item.text)), JSON.stringify(result.toolResults));
    assert.equal(fs.readFileSync(path.join(vaultRoot, 'Boîte', 'Depuis l’IDE.md'), 'utf8'), '# Depuis l’IDE\n\nÉcrit par l’agent. Voir [[Accueil]].\n');
    assert.deepEqual(opale.vault.backlinks('Accueil.md').linked.map((group) => group.path), ['Boîte/Depuis l’IDE.md']);

    const after = await (await fetch(`${base}/api/opale/connect`, { method: 'DELETE', headers })).json();
    assert.equal(after.connected, false);
    await run('Bonjour encore');
    assert.doesNotMatch(systemPrompt(), /Coffre de notes Opale|SKILLS DISPONIBLES/, 'cutting the link withdraws the vault from the next run');
    assert.equal((await (await fetch(`${base}/api/opale/status`, { headers })).json()).connected, false, 'the choice is remembered');

    const relinked = await (await fetch(`${base}/api/opale/connect`, { method: 'POST', headers })).json();
    assert.equal(relinked.connected, true);
    assert.ok(relinked.tools.includes('write_note'));
    await run('Bonjour à nouveau');
    assert.match(systemPrompt(), /- opale: Coffre de notes Opale/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});
