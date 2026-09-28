'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 31955;

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

test('tunnel and mobile identities cannot acquire desktop capabilities', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-mobile-security-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZAALIS_PORT: String(PORT), ZAALIS_DATA_DIR: dataDir, ZAALIS_RUST_CORE: 'off' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let probeHits = 0;
  const probe = http.createServer((_request, response) => {
    probeHits++;
    response.setHeader('content-type', 'application/json');
    response.end('{"models":[]}');
  });
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  try {
    await waitForServer(child);
    const blockedRegister = await fetch(`http://localhost:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zaalis-tunnel-origin': 'attacker-controlled' },
      body: JSON.stringify({ email: 'blocked@zaalis.local', password: 'password123' }),
    });
    assert.equal(blockedRegister.status, 403);

    const register = await fetch(`http://localhost:${PORT}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mobile@zaalis.local', password: 'password123' }),
    });
    assert.equal(register.status, 200);
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    const secret = fs.readFileSync(path.join(dataDir, 'secret'), 'utf8');
    const payload = `${users[0].id}|1`;
    const signature = crypto.createHmac('sha256', secret).update(`mobile:${payload}`).digest('hex');
    const mobileToken = `${Buffer.from(payload).toString('base64url')}.${signature}`;
    const mobileHeaders = { cookie: `zaalis_mobile=${mobileToken}` };

    const keys = await fetch(`http://localhost:${PORT}/api/keys`, {
      method: 'PUT', headers: { ...mobileHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ keys: { mistral: 'replacement' } }),
    });
    assert.equal(keys.status, 403);

    const address = probe.address();
    const models = await fetch(`http://localhost:${PORT}/api/ollama-models?url=${encodeURIComponent(`http://127.0.0.1:${address.port}`)}`, { headers: mobileHeaders });
    assert.equal(models.status, 500);
    assert.equal(probeHits, 0, 'mobile-supplied Ollama URL must be ignored');
  } finally {
    await new Promise((resolve) => probe.close(resolve));
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
