'use strict';
// Run explicitly: $env:BLENDER_TEST_EXE='.../blender.exe'; node --test test/blender-live.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const connector = require('../src/integrations/blender-connector');

test('real Blender: authenticated bridge and advanced tools, including export roundtrips and restoration', { skip: !process.env.BLENDER_TEST_EXE, timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-blender-live-'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const token = crypto.randomBytes(32).toString('hex');
  const stop = path.join(root, 'stop');
  const child = spawn(process.env.BLENDER_TEST_EXE, ['--factory-startup', '--background', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(__dirname, 'fixtures', 'blender-bridge-host.py')], {
    windowsHide: true, env: { ...process.env, BLENDER_USER_CONFIG: path.join(root, 'config'),
      ZAALIS_BLENDER_CHECKPOINT_DIR: path.join(root, 'checkpoints'), ZAALIS_BRIDGE_SOURCE: path.resolve(__dirname, '../native/blender'),
      ZAALIS_TEST_TOKEN: token, ZAALIS_TEST_PORT: String(port), ZAALIS_TEST_STOP: stop },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(async () => {
    fs.writeFileSync(stop, 'stop');
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error('Blender startup timed out: ' + output)); }, 30000);
    const poll = setInterval(() => { if (output.includes('ZAALIS_TEST_READY')) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 25);
    child.once('error', (error) => { clearInterval(poll); clearTimeout(timer); reject(error); });
    exited.then((code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`Blender exited ${code}: ${output}`)); });
  });
  const send = (code, auth = token) => connector.send(code, { host: '127.0.0.1', port, token: auth });
  assert.equal((await send('result = 1', 'wrong')).status, 'error');
  const api = connector.create({ send: (code) => send(code) });
  const call = async (name, args = {}) => {
    const reply = await api.callTool(name, args);
    assert.equal(reply.isError, false, name + ': ' + reply.content[0].text);
    return JSON.parse(reply.content[0].text).result;
  };
  const python = (code) => call('execute_python', { code });
  const fail = async (name, args) => assert.equal((await api.callTool(name, args)).isError, true, name);
  await python("bpy.data.objects['Cube'].name = 'Box'\nbpy.ops.mesh.primitive_cube_add(size=2, location=(0.8,0.2,0.3))\nbpy.context.object.name='Other'\nbpy.ops.mesh.primitive_plane_add(size=100, location=(0,0,-3))\nbpy.context.object.name='Ground'\nresult = True");
  await t.test('diagnostic uses evaluated topology and classifies open surfaces', async () => {
    const audit = await call('scene_audit', { profile: 'print' });
    assert.ok(audit.issues.some((i) => i.object === 'Ground' && i.code === 'non_manifold' && i.severity === 'error'));
    assert.equal(audit.evaluated_meshes.find((m) => m.object === 'Box').triangles, 12);
    assert.equal(audit.modified, false);
    const perf = await call('performance_report');
    assert.equal(perf.total_triangles, 26);
    assert.ok((await call('inspect_batch', { sections: ['scene_summary', 'scene_audit', 'performance_report'] })).scene_audit.ok);
  });
  await t.test('snapshots detect coordinate-only edits and check numeric expectations', async () => {
    await call('scene_snapshot', { name: 'before' });
    await python("bpy.data.objects['Box'].data.vertices[0].co.x += 0.1\nresult=True");
    const diff = await call('verify_changes', { snapshot: 'before', expectations: [{ name: 'Box', dimensions: [2.1,2,2], max_triangles: 12 }] });
    assert.ok(diff.changed.find((i) => i.object === 'Box').fields.geometry_hash);
    assert.equal(diff.passed, true, JSON.stringify(diff.checks));
    assert.equal((await call('verify_changes', { snapshot: 'before', expectations: [{ name: 'absent' }] })).passed, false);
    await fail('scene_snapshot', { name: 'before' });
  });
  await t.test('placement previews, real distribution, surface drop, intersections', async () => {
    assert.ok((await call('detect_intersections', { objects: ['Box', 'Other'] })).pairs[0].surface_intersection);
    const preview = await call('place_objects', { objects: ['Box', 'Other'], action: 'distribute', axis: 'X', gap: 1, value: 0 });
    assert.equal(preview.applied, false);
    assert.ok((await call('detect_intersections', { objects: ['Box', 'Other'] })).pairs[0].surface_intersection);
    await call('place_objects', { objects: ['Box', 'Other'], action: 'distribute', axis: 'X', gap: 1, value: 0, apply: true });
    assert.equal((await call('detect_intersections', { objects: ['Box', 'Other'] })).pairs.length, 0);
    await call('place_objects', { objects: ['Box'], action: 'drop', surface: 'Ground', apply: true });
    assert.equal((await call('object_details', { name: 'Box' })).location[2], -2);
    await call('place_objects', { objects: ['Box'], action: 'align', axis: 'Y', value: 4, apply: true });
    assert.equal((await call('object_details', { name: 'Box' })).location[1], 4);
  });
  await t.test('PBR material isolates linked meshes, Geometry Nodes produces real evaluated geometry', async () => {
    await python("obj=bpy.data.objects['Box'].copy()\nobj.data=bpy.data.objects['Box'].data\nobj.name='Linked'\nbpy.context.scene.collection.objects.link(obj)\nresult=True");
    await call('create_pbr_material', { objects: ['Box'], name: 'TestMetal', color: [0.2,0.4,0.6,1], metallic: 0.8, roughness: 0.25 });
    assert.deepEqual((await call('object_details', { name: 'Linked' })).materials, ['Material']);
    assert.ok((await call('object_details', { name: 'Box' })).materials.includes('TestMetal'));
    await call('create_geometry_repeat', { objects: ['Other'], name: 'TestRepeat', count: 3, spacing: [3,0,0] });
    assert.equal((await call('object_details', { name: 'Other' })).evaluated_mesh.vertices, 24);
    const nodes = await call('node_tree', { node_group: 'TestRepeat' });
    assert.ok(nodes.nodes.length >= 5);
    await call('scene_snapshot', { name: 'shaders-and-nodes', objects: ['Box', 'Other'] });
    assert.deepEqual((await call('verify_changes', { snapshot: 'shaders-and-nodes' })).changed, []);
    await python("mat=bpy.data.materials['TestMetal']\nnext(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED').inputs['Roughness'].default_value=0.9\nresult=True");
    await call('update_geometry_repeat', { objects: ['Other'], modifier: 'TestRepeat', count: 4, spacing: [4,0,0] });
    const differences = await call('verify_changes', { snapshot: 'shaders-and-nodes' });
    assert.ok(differences.changed.find((i) => i.object === 'Box').fields.material_hashes);
    assert.ok(differences.changed.find((i) => i.object === 'Other').fields.modifiers);
    assert.equal((await call('object_details', { name: 'Other' })).evaluated_mesh.vertices, 32);
    await fail('create_geometry_repeat', { objects: ['Other'], name: 'TestRepeat' });
    await fail('create_pbr_material', { objects: ['Box'], name: 'Invalid', roughness: 2 });
  });
  await t.test('GLB and FBX files export and import in Blender; selection restored; overwrite blocked', async () => {
    for (const profile of ['gltf', 'roblox', 'unreal']) {
      const selectedBefore = await python('result=sorted(o.name for o in bpy.context.selected_objects)');
      const file = path.join(root, profile + (profile === 'gltf' ? '.glb' : '.fbx'));
      assert.equal((await call('export_asset', { objects: ['Box'], profile })).exported, false);
      const exported = await call('export_asset', { objects: ['Box'], profile, export: true, path: file });
      assert.ok(exported.size_bytes > 100);
      assert.deepEqual(await python('result=sorted(o.name for o in bpy.context.selected_objects)'), selectedBefore, profile);
      await fail('export_asset', { objects: ['Box'], profile, export: true, path: file });
      const operator = profile === 'gltf' ? 'gltf' : 'fbx';
      const imported = await python(`before=set(bpy.data.objects)\nbpy.ops.import_scene.${operator}(filepath=${JSON.stringify(file)})\nadded=set(bpy.data.objects)-before\nresult={'count':len(added),'meshes':sum(o.type=='MESH' for o in added),'dimensions':[list(o.dimensions) for o in added if o.type=='MESH']}\nfor obj in added: bpy.data.objects.remove(obj, do_unlink=True)`);
      assert.ok(imported.meshes >= 1);
      assert.ok(imported.dimensions.some((v) => Math.abs(v[0]-2.1)<0.001 && Math.abs(v[1]-2)<0.001 && Math.abs(v[2]-2)<0.001), JSON.stringify(imported));
    }
  });
  await t.test('persistent checkpoint survives mutation and restores actual file contents', async () => {
    const before = await call('scene_summary');
    const copy = await call('checkpoint', { action: 'create', name: 'Restore test' });
    assert.equal(copy.active_file, before.file || '');
    assert.ok(fs.existsSync(copy.path));
    assert.ok((await call('checkpoint')).checkpoints.some((p) => p.id === copy.id));
    await python("bpy.data.objects.remove(bpy.data.objects['Box'], do_unlink=True)\nresult=True");
    await fail('checkpoint', { action: 'restore', id: copy.id });
    await call('checkpoint', { action: 'restore', id: copy.id, restore: true, discard_changes: true });
    assert.equal((await call('object_details', { name: 'Box' })).name, 'Box');
    assert.equal((await call('scene_summary')).file, copy.path);
    // Authenticated network bridge must remain usable after opening a file.
    assert.equal((await send('result=42')).result, 42);
  });
  await fail('place_objects', { objects: ['Box'], action: 'align', apply: 'true' });
  await fail('scene_audit', { profile: 'made-up' });
  await fail('checkpoint', { action: 'restore', id: '../escape', restore: true });
  const invalid = await api.callTool('place_objects', { objects: ['Box'], action: 'align', value: NaN, apply: true });
  assert.equal(invalid.isError, true);
  t.diagnostic(`Blender ${process.env.BLENDER_TEST_EXE}; real socket, 12 added tools, exports reimported in Blender (no target-engine import)`);
});

test('real Blender: packaged extension installs and enables with isolated preferences, no online access change or token leak', { skip: !process.env.BLENDER_TEST_EXE, timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-blender-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, BLENDER_USER_RESOURCES: root, BLENDER_USER_CONFIG: path.join(root, 'config'),
    BLENDER_USER_EXTENSIONS: path.join(root, 'extensions'), BLENDER_USER_SCRIPTS: path.join(root, 'scripts') };
  const api = connector.create({ env, addonDirs: [path.resolve(__dirname, '../native/blender')],
    // This profile is not used by any open Blender. The production guard
    // otherwise checks every Blender process, including unrelated profiles.
    isRunning: async () => false });
  const status = await api.install();
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.addon.version, connector.ADDON.version);
  assert.equal(status.onlineAccess, false);
  assert.ok(!JSON.stringify(status).includes('token'));
  assert.ok(connector.addonOnDisk(root));
  const second = await api.install();
  assert.equal(second.state, 'ready');
});
