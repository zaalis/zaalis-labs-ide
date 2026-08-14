'use strict';

const fs = require('fs');
const path = require('path');
const png2icons = require('png2icons');

const root = path.resolve(__dirname, '..');
const pngPath = path.join(root, 'native', 'image', 'logo-zaalis.png');
const icnsPath = path.join(root, 'native', 'image', 'logo-zaalis.icns');

if (!fs.existsSync(pngPath)) {
  throw new Error(`Missing PNG icon: ${pngPath}`);
}

const input = fs.readFileSync(pngPath);
const output = png2icons.createICNS(input, png2icons.BICUBIC, 0);
if (!output) {
  throw new Error('Unable to create ICNS icon.');
}

fs.writeFileSync(icnsPath, output);
console.log(`Electron macOS icon written to ${icnsPath}`);
