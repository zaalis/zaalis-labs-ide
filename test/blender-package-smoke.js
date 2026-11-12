'use strict';
// Run explicitly after pkg builds the disposable package-check binary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

(async () => {
  const exe = path.resolve(process.argv[2] || '.tmp/blender-package-check/zaalis-server.exe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-blender-package-'));
  const assets = path.join(path.dirname(exe), 'blender'); fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(path.resolve('native/blender/zaalis-bridge-1.0.1.zip'), path.join(assets, 'zaalis-bridge-1.0.1.zip'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true,
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: path.join(root, 'data'), ZAALIS_RUST_CORE: 'off',
      BLENDER_USER_RESOURCES: path.join(root, 'blender'), BLENDER_USER_CONFIG: path.join(root, 'blender/config'),
      BLENDER_USER_EXTENSIONS: path.join(root, 'blender/extensions') } });
  let output = '';
  child.stdout.on('data', (part) => { output += part; });
  child.stderr.on('data', (part) => { output += part; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i=0; i<200; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { await fetch(base + '/api/blender/status'); ready=true; break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const registered = await fetch(base+'/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'blender-package@example.test', password: 'fixture-password123' }) });
    assert.equal(registered.status, 200, await registered.text());
    const response = await fetch(base+'/api/blender/status', { headers: { cookie: registered.headers.get('set-cookie').split(';')[0] } });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.addonVersion, '1.0.1');
    assert.equal(status.port, 9877);
    assert.equal(status.bundled, true);
    assert.equal(status.state, 'install');
    assert.ok(!JSON.stringify(status).includes('token'));
    console.log('Packaged Windows server: Zaalis bridge loaded; archive discovered; isolated profile status and authentication passed.');
  } finally {
    child.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode=1; });
