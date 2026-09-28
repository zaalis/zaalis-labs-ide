'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 31957;
const base = `http://localhost:${PORT}`;

async function start(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZAALIS_PORT: String(PORT), ZAALIS_DATA_DIR: dataDir, ZAALIS_RUST_CORE: 'off' },
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try { if ((await fetch(base)).ok) return child; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error('server did not start');
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('working mode is validated and restored after logout and server restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-preferences-'));
  let child;
  try {
    child = await start(dataDir);
    assert.equal((await fetch(`${base}/api/preferences`)).status, 401);
    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'preferences@zaalis.local', password: 'password123' }),
    });
    assert.equal(register.status, 200);
    let cookie = register.headers.get('set-cookie');
    const headers = { cookie, 'content-type': 'application/json' };
    assert.deepEqual(await (await fetch(`${base}/api/preferences`, { headers })).json(), { permissionMode: 'supervised' });
    assert.equal((await fetch(`${base}/api/preferences`, { method: 'PUT', headers,
      body: JSON.stringify({ permissionMode: 'bypass' }) })).status, 400);
    const saved = await fetch(`${base}/api/preferences`, { method: 'PUT', headers,
      body: JSON.stringify({ permissionMode: 'auto' }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { permissionMode: 'auto' });
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })).status, 200);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'preferences@zaalis.local', password: 'password123' }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie');
    assert.deepEqual(await (await fetch(`${base}/api/preferences`, { headers: { cookie } })).json(), { permissionMode: 'auto' });
    await stop(child);
    child = await start(dataDir);
    assert.deepEqual(await (await fetch(`${base}/api/preferences`, { headers: { cookie } })).json(), { permissionMode: 'auto' });
  } finally {
    await stop(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
