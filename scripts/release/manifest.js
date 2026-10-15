'use strict';

// Run after staging the Windows build. Records exact artifacts and source
// inputs without including accounts, credentials or application data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'native/dist');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : entry.isFile() ? [full] : [];
  });
}
async function main() {
  const names = ['zaalis.exe', 'zaalis-server.exe', 'zaalis-agentd.exe', 'zaalis-cli.exe', 'zaalis-terminal.exe'];
  const artifacts = [];
  for (const name of names) {
    const file = path.join(dist, name), stat = fs.statSync(file);
    artifacts.push({ path: name, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: await digest(file) });
  }
  let stagedAssets = 0;
  for (const file of files(path.join(root, 'interface'))) {
    const relative = path.relative(path.join(root, 'interface'), file);
    const staged = path.join(dist, 'interface', relative);
    if (!fs.existsSync(staged) || await digest(file) !== await digest(staged)) throw new Error(`Staged UI differs: ${relative}`);
    stagedAssets++;
  }
  for (const [sourceName, artifactName] of [['zaalis.exe', 'zaalis-cli.exe'], ['zaalis-agentd.exe', 'zaalis-agentd.exe']]) {
    if (await digest(path.join(root, 'rust/target/release', sourceName)) !== await digest(path.join(dist, artifactName))) throw new Error(`Staged Rust binary differs: ${artifactName}`);
  }
  const nodeLog = fs.readFileSync(path.join(root, '.tmp/parity-final-node-tests.log'), 'utf8');
  const rustLog = fs.readFileSync(path.join(root, '.tmp/parity-final-rust-tests.log'), 'utf8');
  const manifest = { generatedAt: new Date().toISOString(), version: require('../../package.json').version,
    baseCommit: git(['rev-parse', 'HEAD']), upstreamCommit: git(['rev-parse', 'origin/main']),
    hasLocalChanges: Boolean(git(['status', '--porcelain'])), platform: process.platform, arch: process.arch,
    sourceTests: { nodePassed: Number(nodeLog.match(/tests (\d+)/)?.[1] || 0),
      rustPassed: [...rustLog.matchAll(/test result: ok\. (\d+) passed/g)].reduce((total, match) => total + Number(match[1]), 0) },
    verifiedStagedInterfaceFiles: stagedAssets, artifacts };
  fs.writeFileSync(path.join(dist, 'validation-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Manifest: ${names.length} artifacts; ${stagedAssets} interface files match source; Rust staging matches release.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
