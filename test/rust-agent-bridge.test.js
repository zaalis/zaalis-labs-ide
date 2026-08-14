'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentdClient, findAgentd } = require('../rust-agent-bridge');

test('findAgentd selects an existing native or Cargo binary only', () => {
  const found = findAgentd(path.resolve(__dirname, '..'));
  assert.ok(found);
  assert.equal(fs.existsSync(found), true);
  assert.match(path.basename(found), /^zaalis-agentd(?:\.exe)?$/);
});

test('findAgentd supports the installed side-by-side layout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-agentd-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'zaalis-agentd.exe' : 'zaalis-agentd';
  const candidate = path.join(root, name);
  fs.writeFileSync(candidate, 'fixture');
  assert.equal(findAgentd(root), candidate);
});

test('Node bridge speaks real JSON-RPC stdio to agentd', async (t) => {
  const root = path.resolve(__dirname, '..');
  const executable = findAgentd(root);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-agentd-node-'));
  const client = new AgentdClient({ executable, dataDir, keys: {} });
  t.after(async () => {
    await client.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const health = await client.request('health', {});
  assert.equal(health.sessions, 0);
  assert.match(health.version, /protocol=1/);
});
