'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const connector = require('../blender-connector');

test('versions are read and compared as numbers', () => {
  assert.deepEqual(connector.parseVersion('Blender 5.2.2 LTS'), [5, 2, 2]);
  assert.deepEqual(connector.parseVersion('Blender 5.10'), [5, 10]);
  assert.equal(connector.parseVersion('Blender'), null);
  assert.ok(connector.compareVersions([5, 10], [5, 2, 9]) > 0);
  assert.ok(connector.compareVersions([5, 0, 1], connector.MIN_VERSION) < 0);
  assert.equal(connector.compareVersions([5, 1], [5, 1, 0]), 0);
});

test('the MCP add-on is found in whichever extension repository holds it', (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-blender-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  assert.equal(connector.addonOnDisk(profile), null);
  const write = (repo, manifest) => {
    fs.mkdirSync(path.join(profile, 'extensions', repo, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'extensions', repo, 'mcp', 'blender_manifest.toml'), manifest);
  };
  // Someone else's extension that happens to be called "mcp" is not ours.
  write('blender_org', 'id = "mcp"\nversion = "9.9.9"\nmaintainer = "Somebody"\n');
  assert.equal(connector.addonOnDisk(profile), null);
  write('lab_blender_org', 'schema_version = "1.0.0"\n\nid = "mcp"\nversion = "1.0.3"\nname = "MCP"\nmaintainer = "Blender Lab"\n');
  assert.deepEqual(connector.addonOnDisk(profile), { repo: 'lab_blender_org', version: '1.0.3' });
  assert.equal(connector.profileDir([5, 2, 2], { BLENDER_USER_RESOURCES: profile }), profile);
});

test('the add-on shipped with the IDE is the one its checksum describes', () => {
  const archive = path.resolve(__dirname, '..', 'native', 'blender', connector.ADDON.file);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), connector.ADDON.sha256);
  assert.equal(connector.create({ addonDirs: [path.join(__dirname, 'missing'), path.dirname(archive)] }).addonArchive(), archive);
  assert.equal(connector.create({ addonDirs: [] }).addonArchive(), '');
});

test('the socket client speaks the add-on protocol: one NUL-ended JSON each way', async (t) => {
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0);
      if (end < 0) return;
      requests.push(JSON.parse(buffer.subarray(0, end).toString('utf8')));
      const reply = Buffer.from(JSON.stringify({ status: 'ok', result: { echoed: requests.at(-1).code.length }, stdout: 'été\n' }) + '\0');
      socket.write(reply.subarray(0, 10));                // a reply may arrive in pieces
      setTimeout(() => socket.end(reply.subarray(10)), 20);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  assert.deepEqual(await connector.send('print("é")', { host: 'localhost', port }), { status: 'ok', result: { echoed: 10 }, stdout: 'été\n' });
  assert.deepEqual(requests, [{ type: 'execute', code: 'print("é")', strict_json: false }]);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(connector.send('1', { host: '127.0.0.1', port }), (error) => error.code === 'blender-closed' && /ouvrez Blender/.test(error.message));
});

test('the MCP server lists its tools and turns a call into Python for Blender', async () => {
  const sent = [];
  const replies = [{ status: 'ok', result: { scene: 'Scene' } }, { status: 'ok', result: { matched: 0 }, stdout: 'x'.repeat(30_000), stderr: 'attention' }, { status: 'error', message: 'Traceback…\nRuntimeError: boom' }];
  const blender = connector.create({ send: async (code, target) => { sent.push({ code, target }); return replies[sent.length - 1]; } });
  const rpc = (method, params, id = 7) => blender.handleRpc({ jsonrpc: '2.0', id, method, params });

  const init = await rpc('initialize', {});
  assert.equal(init.id, 7);
  assert.equal(init.result.serverInfo.name, 'zaalis-blender');
  assert.match(init.result.instructions, /Regarde avant d’agir/);
  assert.equal(await blender.handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await rpc('ping')).result, {});
  const tools = (await rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['scene_summary', 'list_objects', 'object_details', 'screenshot', 'render', 'file_info', 'missing_files',
    'linked_libraries', 'datablocks', 'node_tree', 'api_search', 'api_docs', 'focus_object', 'switch_workspace', 'show_properties', 'undo', 'execute_python', 'inspect_blend_file']);
  assert.ok(tools.every((tool) => Object.keys(tool).sort().join() === 'description,inputSchema,name'));
  assert.ok(tools.every((tool) => tool.description && tool.inputSchema.type === 'object' && !('code' in tool)));
  assert.equal((await rpc('resources/list')).error.code, -32601);
  assert.equal((await blender.handleRpc('nonsense')).error.code, -32600);

  const summary = (await rpc('tools/call', { name: 'scene_summary', arguments: {} })).result;
  assert.deepEqual(JSON.parse(summary.content[0].text), { result: { scene: 'Scene' } });
  assert.equal(summary.isError, false);
  assert.deepEqual(sent[0].target, { host: 'localhost', port: 9876 });
  assert.match(sent[0].code, /^import json\nparams = json\.loads\("\{\}"\)\n+import bpy\n/);

  // Arguments travel as data: quotes and newlines of theirs cannot become code.
  const hostile = { name_contains: '"); import os; os.remove("x")\n#', type: "MESH'" };
  const listed = (await rpc('tools/call', { name: 'list_objects', arguments: hostile })).result;
  const literal = /params = json\.loads\((".*")\)\n/.exec(sent[1].code)[1];
  assert.deepEqual(JSON.parse(JSON.parse(literal)), hostile);
  assert.equal(sent[1].code.split('\n')[1].includes('\n'), false);
  const payload = JSON.parse(listed.content[0].text);
  assert.equal(payload.stdout.length, 20_000);
  assert.equal(payload.stderr, 'attention');

  const failed = (await rpc('tools/call', { name: 'execute_python', arguments: { code: 'raise RuntimeError("boom")' } })).result;
  // The agent's own code runs as written, followed by one undo step for it.
  assert.ok(sent[2].code.startsWith('raise RuntimeError("boom")\n'));
  assert.match(sent[2].code, /undo_push\(message="IA zaalis : execute_python"\)/);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /RuntimeError: boom/);

  assert.equal((await rpc('tools/call', { name: 'execute_python', arguments: { code: '   ' } })).result.isError, true);
  assert.equal((await rpc('tools/call', { name: 'delete_everything', arguments: {} })).result.isError, true);
  assert.equal(sent.length, 3);
});

test('images Blender writes for a tool reach the agent as MCP image content, and only those', async () => {
  const dir = os.tmpdir();
  const name = (hex) => path.join(dir, `zaalis_blender_${hex.repeat(32 / hex.length)}.jpg`);
  const shot = name('ab');
  const tooBig = name('cd');
  fs.writeFileSync(shot, Buffer.from('fake-jpeg-bytes'));
  fs.writeFileSync(tooBig, Buffer.alloc(8 * 1024 * 1024 + 1));
  const outside = path.join(dir, `zaalis-not-a-capture-${process.pid}.jpg`);
  fs.writeFileSync(outside, 'secret');
  const sent = [];
  const blender = connector.create({ send: async (code) => { sent.push(code); return { status: 'ok', result: { target: 'viewport', _images: [shot, outside, tooBig] } }; } });
  try {
    const result = await blender.callTool('screenshot', { target: 'viewport' });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), { result: { target: 'viewport', images_attached: 1 } });
    assert.deepEqual(result.content.slice(1), [{ type: 'image', mimeType: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes').toString('base64') }]);
    // Read captures are removed; a file that is not one is never touched.
    assert.equal(fs.existsSync(shot), false);
    assert.equal(fs.existsSync(tooBig), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
    // Tools that need Blender's interface carry the shared helpers.
    assert.match(sent[0], /def _zaalis_window\(\):/);
    assert.match(sent[0], /screenshot_area/);

    // A tool that does not produce images keeps `_images` as plain data.
    const plain = await blender.callTool('scene_summary', {});
    assert.equal(plain.content.length, 1);
    assert.doesNotMatch(sent[1], /_zaalis_window/);
  } finally {
    for (const file of [shot, tooBig, outside]) { try { fs.unlinkSync(file); } catch {} }
  }
});

test('inspect_blend_file only reads an existing .blend given by absolute path', async (t) => {
  const blender = connector.create({ send: async () => { throw new Error('the open Blender must not be used'); } });
  for (const path_ of ['relative.blend', path.join(os.tmpdir(), 'missing-zaalis.blend'), __filename]) {
    const result = await blender.callTool('inspect_blend_file', { path: path_ });
    assert.equal(result.isError, true, path_);
    assert.match(result.content[0].text, /\.blend existant requis/);
  }
});

test('a closed Blender is reported to the agent as something the user can fix', async () => {
  const blender = connector.create({ send: async () => { throw Object.assign(new Error('Blender n’est pas joignable : ouvrez Blender (l’add-on MCP démarre avec lui), puis réessayez.'), { code: 'blender-closed' }); } });
  const result = await blender.callTool('scene_summary', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ouvrez Blender/);
});

test('the Skill names every tool and says whether Blender is open', () => {
  const open = connector.skill({ version: '5.2.2', reachable: true });
  assert.equal(open.name, 'blender');
  assert.ok(open.description.length <= 236);
  assert.match(open.description, /server="blender"/);
  assert.ok(open.instructions.startsWith('---\nname: blender\ndescription: '));
  for (const tool of connector.TOOLS) assert.ok(open.instructions.includes('`' + tool.name + '`'), tool.name);
  assert.match(open.instructions, /- `object_details` \(name\)/);
  assert.match(open.instructions, /- `list_objects` \(type\?, name_contains\?, limit\?\)/);
  assert.match(open.instructions, /Blender est ouvert et répond/);
  assert.match(connector.skill({ version: '5.2.2', reachable: false }).instructions, /Blender est fermé pour le moment/);
});
