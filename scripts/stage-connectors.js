'use strict';
// Stages the WhatsApp bridge runtime and the official GitHub client next to the
// packaged server. Windows: native/dist. Linux: pass the server dist directory
// (native/dist-linux-server) and run this script with the Linux Node runtime
// that is shipped, since its binary is copied into the package.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), windows = process.platform === 'win32';
const dist = path.resolve(root, process.argv[2] || path.join('native', 'dist'));
if (!dist.startsWith(path.join(root, 'native') + path.sep)) throw Error('Invalid staging directory');
fs.mkdirSync(dist, { recursive: true });
const runtime = path.join(dist, 'messenger-runtime');
if (!runtime.startsWith(dist + path.sep)) throw Error('Invalid staging directory');
if (fs.existsSync(runtime)) {
  if (!fs.realpathSync(runtime).startsWith(fs.realpathSync(dist) + path.sep)) throw Error('Runtime staging path leaves the distribution');
  fs.rmSync(runtime, { recursive: true, force: true });
}
fs.mkdirSync(runtime, { recursive: true });
const upstream = path.join(root, 'connectors', 'whatsapp-bridge');
for (const file of fs.readdirSync(upstream)) if (fs.statSync(path.join(upstream, file)).isFile()) fs.copyFileSync(path.join(upstream, file), path.join(runtime, file));
const nodeName = windows ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(runtime, nodeName));
if (!windows) fs.chmodSync(path.join(runtime, nodeName), 0o755);
fs.copyFileSync(path.join(root, 'docs', 'third-party', 'node-license.txt'), path.join(runtime, 'NODE-LICENSE'));
const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  .find(p => p && /npm-cli\.js$/.test(p) && fs.existsSync(p));
if (!npm) throw Error('npm runtime unavailable');
execFileSync(process.execPath, [npm, 'ci', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], { windowsHide: true, stdio: 'inherit' });
// The bridge runs launcher.mjs directly. npm's .bin symlinks are unused and,
// when the Linux build runs from Windows through WSL, unreadable by Windows.
if (!windows) fs.rmSync(path.join(runtime, 'node_modules', '.bin'), { recursive: true, force: true });
const ghDir = path.join(dist, 'github'); fs.mkdirSync(ghDir, { recursive: true });
const ghName = windows ? 'gh.exe' : 'gh', ghTarget = path.join(ghDir, ghName);
if (windows) {
  const gh = [path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe'), ghTarget].find(p => fs.existsSync(p));
  if (!gh) throw Error('Install the official GitHub CLI before building the Windows connector');
  if (gh !== ghTarget) fs.copyFileSync(gh, ghTarget);
} else stageLinuxGh(ghTarget);
fs.copyFileSync(path.join(root, 'docs', 'third-party', 'github-cli-license.txt'), path.join(ghDir, 'LICENSE'));
console.log('GitHub client and Zaalis WhatsApp bridge staged in ' + path.relative(root, dist) + '.');

// Linux: pin the official archive and verify its published checksum.
function stageLinuxGh(target) {
  const version = '2.105.0';
  const expected = '79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f';
  const cache = path.join(root, 'native', 'linux-gh');
  const name = `gh_${version}_linux_amd64.tar.gz`;
  const archive = path.join(cache, name);
  const url = `https://github.com/cli/cli/releases/download/v${version}/${name}`;
  fs.mkdirSync(cache, { recursive: true });
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(archive) || digest(archive) !== expected) {
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', archive, url]);
  }
  if (digest(archive) !== expected) throw Error('GitHub CLI checksum mismatch');
  const extract = path.join(cache, `gh_${version}`);
  fs.rmSync(extract, { recursive: true, force: true }); fs.mkdirSync(extract);
  execFileSync('tar', ['-xzf', archive, '-C', extract]);
  fs.copyFileSync(path.join(extract, `gh_${version}_linux_amd64`, 'bin', 'gh'), target);
  fs.chmodSync(target, 0o755);
}
