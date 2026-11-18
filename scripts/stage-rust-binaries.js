'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
if (process.platform !== 'win32') {
  execFileSync('sh', [path.join(__dirname, 'stage-rust-binaries.sh'), ...process.argv.slice(2)], { stdio: 'inherit' });
} else {
  const release = process.env.ZAALIS_RUST_RELEASE_DIR || path.join(root, 'rust', 'target', 'release');
  const target = path.join(root, 'native', 'dist');
  fs.mkdirSync(target, { recursive: true });
  for (const [source, destination] of [['zaalis.exe', 'zaalis-cli.exe'], ['zaalis-agentd.exe', 'zaalis-agentd.exe']]) {
    fs.copyFileSync(path.join(release, source), path.join(target, destination));
  }
  console.log(`Rust binaries staged in ${target}`);
}
