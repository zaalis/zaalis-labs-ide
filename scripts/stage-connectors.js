'use strict';
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'native', 'dist');
const runtime = path.join(dist, 'messenger-runtime');
if (!runtime.startsWith(dist + path.sep)) throw Error('Invalid staging directory');
const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (fs.existsSync(runtime)) {
  if (!fs.realpathSync(runtime).startsWith(fs.realpathSync(dist) + path.sep)) throw Error('Runtime staging path leaves the distribution');
  fs.rmSync(runtime, { recursive: true, force: true });
}
fs.mkdirSync(runtime, { recursive: true });
const upstream = path.join(root, 'connectors', 'whatsapp-bridge');
for (const file of fs.readdirSync(upstream)) if (fs.statSync(path.join(upstream, file)).isFile()) fs.copyFileSync(path.join(upstream, file), path.join(runtime, file));
fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
fs.copyFileSync(path.join(root, 'docs', 'third-party', 'node-license.txt'), path.join(runtime, 'NODE-LICENSE'));
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!fs.existsSync(npm)) throw Error('npm runtime unavailable');
execFileSync(process.execPath, [npm, 'ci', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-fund'], { windowsHide: true, stdio: 'inherit' });
const ghDir = path.join(dist, 'github'); fs.mkdirSync(ghDir, { recursive: true });
const gh = [path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe'), path.join(ghDir, 'gh.exe')].find(p => fs.existsSync(p));
if (!gh) throw Error('Install the official GitHub CLI before building the Windows connector');
if (gh !== path.join(ghDir, 'gh.exe')) fs.copyFileSync(gh, path.join(ghDir, 'gh.exe'));
fs.copyFileSync(path.join(root, 'docs', 'third-party', 'github-cli-license.txt'), path.join(ghDir, 'LICENSE'));
console.log('GitHub client and Zaalis WhatsApp bridge staged.');
