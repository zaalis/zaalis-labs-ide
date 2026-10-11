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
const ghDir = path.join(dist, 'github'); fs.mkdirSync(ghDir, { recursive: true });
const ghName = windows ? 'gh.exe' : 'gh', ghTarget = path.join(ghDir, ghName);
if (windows) {
  const gh = [path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe'), ghTarget].find(p => fs.existsSync(p));
  if (!gh) throw Error('Install the official GitHub CLI before building the Windows connector');
  if (gh !== ghTarget) fs.copyFileSync(gh, ghTarget);
} else stageLinuxGh(ghTarget);
fs.copyFileSync(path.join(root, 'docs', 'third-party', 'github-cli-license.txt'), path.join(ghDir, 'LICENSE'));
console.log('GitHub client and Zaalis WhatsApp bridge staged in ' + path.relative(root, dist) + '.');

// Linux: the official release archive, verified against the release checksums.
function stageLinuxGh(target) {
  const cache = path.join(root, 'native', 'linux-gh');
  fs.mkdirSync(cache, { recursive: true });
  const curl = (args, options = {}) => execFileSync('curl', ['-fsSL', '--retry', '3', ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  const release = JSON.parse(curl(['-H', 'Accept: application/vnd.github+json', 'https://api.github.com/repos/cli/cli/releases/latest']).toString());
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Unexpected GitHub CLI release tag');
  const name = `gh_${version}_linux_amd64.tar.gz`, archive = path.join(cache, name);
  const asset = file => (release.assets || []).find(a => a.name === file)?.browser_download_url;
  const sums = asset(`gh_${version}_checksums.txt`);
  if (!asset(name) || !sums) throw Error('GitHub CLI Linux release assets not found');
  const expected = curl([sums]).toString().split('\n').map(line => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  if (!/^[0-9a-f]{64}$/.test(expected || '')) throw Error('GitHub CLI checksum missing');
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(archive) || digest(archive) !== expected) curl(['-o', archive, asset(name)]);
  if (digest(archive) !== expected) throw Error('GitHub CLI checksum mismatch');
  const extract = path.join(cache, `gh_${version}`);
  fs.rmSync(extract, { recursive: true, force: true }); fs.mkdirSync(extract);
  execFileSync('tar', ['-xzf', archive, '-C', extract]);
  fs.copyFileSync(path.join(extract, `gh_${version}_linux_amd64`, 'bin', 'gh'), target);
  fs.chmodSync(target, 0o755);
}
