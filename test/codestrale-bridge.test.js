'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 31956;
const HEADER = 'x-zaalis-codestrale';

async function waitForServer(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://localhost:${PORT}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

async function waitForBridgeFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge descriptor was never published');
}

test('codestrale bridge answers on its secret and stays confined to agent turns', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-codestrale-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZAALIS_PORT: String(PORT), ZAALIS_DATA_DIR: dataDir, ZAALIS_RUST_CORE: 'off' },
    stdio: 'ignore',
    windowsHide: true,
  });
  const bridgeFile = path.join(dataDir, 'codestrale-bridge.json');
  try {
    await waitForServer(child);

    // The descriptor must advertise the port we actually bound, so codestrale
    // never dials a port the server failed to take.
    const bridge = await waitForBridgeFile(bridgeFile);
    assert.equal(bridge.port, PORT);
    assert.match(bridge.secret, /^[0-9a-f]{64}$/);
    assert.ok(bridge.pid > 0);
    assert.ok(Date.parse(bridge.updatedAt) > 0);
    const secretHeaders = { [HEADER]: bridge.secret };

    // No account yet: the bridge exists but has nobody to act as. codestrale
    // reads this refusal as "log into the IDE once", not "IDE is closed".
    const beforeAccount = await fetch(`http://localhost:${PORT}/api/codestrale/ping`, { headers: secretHeaders });
    assert.equal(beforeAccount.status, 401);

    const register = await fetch(`http://localhost:${PORT}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'codestrale@zaalis.local', password: 'password123' }),
    });
    assert.equal(register.status, 200);

    // A wrong or missing secret never authenticates.
    for (const headers of [{}, { [HEADER]: 'a'.repeat(64) }]) {
      const refused = await fetch(`http://localhost:${PORT}/api/codestrale/ping`, { headers });
      assert.equal(refused.status, 401);
    }

    const ping = await fetch(`http://localhost:${PORT}/api/codestrale/ping`, { headers: secretHeaders });
    assert.equal(ping.status, 200);
    const status = await ping.json();
    assert.equal(status.account, 'codestrale@zaalis.local');
    assert.ok(status.version);
    // ZAALIS_RUST_CORE=off: codestrale must be told models cannot answer.
    assert.equal(status.rustCore.enabled, false);
    assert.equal(typeof status.rustCore.available, 'boolean');

    const catalogResponse = await fetch(`http://localhost:${PORT}/api/codestrale/models`, { headers: secretHeaders });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    const claude = catalog.providers.find((provider) => provider.id === 'claude');
    assert.equal(claude.keyName, 'anthropic');
    assert.equal(claude.family, 'cloud');
    // No key configured for this fresh account, so nothing pretends to be usable.
    assert.equal(claude.ready, false);
    assert.ok(claude.models.length > 0);
    for (const model of claude.models) {
      assert.equal(typeof model.id, 'string');
      assert.equal(typeof model.label, 'string');
      assert.ok(model.context > 0);
    }

    // The secret buys agent turns and nothing else: never the key vault, the
    // filesystem, the terminal or the tunnel.
    const forbidden = [
      ['PUT', '/api/keys', { keys: { mistral: 'stolen' } }],
      ['POST', '/api/terminal/sessions', {}],
      ['POST', '/api/tunnel/start', {}],
      ['GET', '/api/chats', null],
    ];
    for (const [method, route, body] of forbidden) {
      const response = await fetch(`http://localhost:${PORT}${route}`, {
        method,
        headers: { ...secretHeaders, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 403, `${method} ${route} must stay out of reach`);
    }

    // The cancel route is matched on shape, so any session id gets through the
    // guard — and is then refused by the bridge itself, not by the guard.
    const cancel = await fetch(`http://localhost:${PORT}/api/agent-runs/whatever/cancel`, {
      method: 'POST', headers: { ...secretHeaders, 'content-type': 'application/json' }, body: '{}',
    });
    assert.notEqual(cancel.status, 403);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
