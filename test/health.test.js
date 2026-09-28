'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 31958;

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('health endpoint did not become ready');
}

test('le contrôle de disponibilité Electron reste public et minimal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-health-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZAALIS_PORT: String(PORT), ZAALIS_DATA_DIR: dataDir, ZAALIS_RUST_CORE: 'off' },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const response = await waitForHealth(child);
    assert.deepEqual(await response.json(), { ok: true, apiRevision: 'desktop-launcher-v2' });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
