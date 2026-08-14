'use strict';

const fs = require('fs');
const path = require('path');
const { downloadArtifact } = require('@electron/get');

async function main() {
  const [arch, outArg] = process.argv.slice(2);
  if (!arch || !outArg) {
    console.error('Usage: node native/download_electron_macos.js <x64|arm64> <out.zip>');
    process.exit(1);
  }

  const root = path.resolve(__dirname, '..');
  const electronPkg = require('electron/package.json');
  const outPath = path.resolve(root, outArg);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const zipPath = await downloadArtifact({
    version: electronPkg.version,
    artifactName: 'electron',
    platform: 'darwin',
    arch,
  });

  fs.copyFileSync(zipPath, outPath);
  console.log(`Electron darwin-${arch} runtime written to ${outPath}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
