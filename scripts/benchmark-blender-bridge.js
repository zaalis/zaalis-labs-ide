'use strict';
// Compare original bridge round trips using actual Blender UI timers, in two
// fresh processes with isolated preferences. No user scene is ever opened.
// PowerShell: $env:BLENDER_TEST_EXE='...blender.exe'; node scripts/benchmark-blender-bridge.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { send } = require('../src/integrations/blender-connector');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (samples, fraction) => [...samples].sort((a,b) => a-b)[Math.ceil(samples.length*fraction)-1];

async function run(kind, root) {
  const dir = path.join(root, kind); fs.mkdirSync(dir);
  const ready = path.join(dir, 'ready'), stop = path.join(dir, 'stop');
  const token = crypto.randomBytes(32).toString('hex');
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const script = path.join(dir, 'host.py');
  fs.writeFileSync(script, String.raw`
import bpy, os, sys, zipfile, time
root=os.environ['ZAALIS_BENCH_ROOT']
kind=os.environ['ZAALIS_BENCH_KIND']
if kind=='official':
    module=os.path.join(root,'official_bridge')
    os.makedirs(module)
    with zipfile.ZipFile(os.environ['ZAALIS_OFFICIAL_ZIP']) as archive: archive.extractall(module)
    sys.path.insert(0, root)
    import addon_utils
    addon_utils.enable('official_bridge', default_set=True)
    prefs=bpy.context.preferences.addons['official_bridge'].preferences
    prefs.port=int(os.environ['ZAALIS_BENCH_PORT'])
    bpy.ops.blmcp.server_start()
else:
    sys.path.insert(0, os.environ['ZAALIS_BRIDGE_SOURCE'])
    import addon_utils
    addon_utils.enable('zaalis_bridge', default_set=True)
    import zaalis_bridge
    prefs=bpy.context.preferences.addons['zaalis_bridge'].preferences
    prefs.port=int(os.environ['ZAALIS_BENCH_PORT'])
    prefs.token=os.environ['ZAALIS_BENCH_TOKEN']
    zaalis_bridge.start_server()
deadline=time.monotonic()+60
def shutdown():
    if os.path.exists(os.path.join(root,'stop')) or time.monotonic()>deadline:
        bpy.ops.wm.quit_blender()
        return None
    return 0.05
bpy.app.timers.register(shutdown, first_interval=0.05)
with open(os.path.join(root,'ready'),'w') as handle: handle.write(bpy.app.version_string)
`);
  const child = spawn(process.env.BLENDER_TEST_EXE, ['--factory-startup', '--online-mode', '--python-exit-code', '1', '--python', script], {
    windowsHide: true, env: { ...process.env, BLENDER_USER_RESOURCES: path.join(dir, 'resources'),
      BLENDER_USER_CONFIG: path.join(dir, 'config'), BLENDER_USER_EXTENSIONS: path.join(dir, 'extensions'),
      ZAALIS_BENCH_ROOT: dir, ZAALIS_BENCH_KIND: kind, ZAALIS_BENCH_PORT: String(port), ZAALIS_BENCH_TOKEN: token,
      ZAALIS_OFFICIAL_ZIP: process.env.BLENDER_OFFICIAL_ZIP || path.resolve(__dirname, '../native/blender/mcp-1.0.3.zip'),
      ZAALIS_BRIDGE_SOURCE: path.resolve(__dirname, '../native/blender') },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let exited = false;
  const finished = new Promise((resolve) => child.once('exit', (code) => { exited = true; resolve(code); }));
  try {
    for (let i=0; !fs.existsSync(ready); i++) {
      if (exited || i > 600) throw new Error(`${kind} failed to start: ${output}`);
      await pause(50);
    }
    const samples = [];
    for (let i=0; i<16; i++) {
      const started = performance.now();
      const reply = await send('import bpy\nresult = {"objects": len(bpy.context.scene.objects), "frame": bpy.context.scene.frame_current}', {
        host: '127.0.0.1', port, ...(kind === 'zaalis' ? { token } : {}), timeoutMs: 10000,
      });
      if (reply.status !== 'ok' || reply.result.objects !== 3) throw new Error('Invalid benchmark reply: ' + JSON.stringify(reply));
      if (i >= 4) samples.push(performance.now()-started); // discard warmup
    }
    return { kind, blender: fs.readFileSync(ready, 'utf8'), samples: samples.length,
      median_ms: +percentile(samples, 0.5).toFixed(3), p95_ms: +percentile(samples, 0.95).toFixed(3),
      timer: kind === 'official' ? 'official v1.0.3 default active 250 ms' : 'Zaalis v1.0.0 active 10 ms',
      measurements_ms: samples.map((v) => +v.toFixed(3)) };
  } finally {
    fs.writeFileSync(stop, 'stop');
    const timer = setTimeout(() => child.kill(), 5000);
    await finished;
    clearTimeout(timer);
  }
}

(async () => {
  if (!process.env.BLENDER_TEST_EXE) throw new Error('Set BLENDER_TEST_EXE to the Blender executable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-blender-bench-'));
  try {
    const official = await run('official', root);
    const zaalis = await run('zaalis', root);
    const report = { scenario: 'Sequential read-only requests over loopback, default UI polling, fresh factory scene. Same Blender executable. Not a render or modeling speed benchmark.',
      official, zaalis, median_latency_ratio: +(official.median_ms/zaalis.median_ms).toFixed(2),
      limitation: 'Official polling is configurable. Faster polling wakes the main thread more often; this does not accelerate bpy calculations or improve model reasoning.' };
    if (process.env.BLENDER_BENCH_REPORT) fs.writeFileSync(process.env.BLENDER_BENCH_REPORT, JSON.stringify(report, null, 2)+'\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode=1; });
