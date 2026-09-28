'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserHost } = require('../zaalis-browser/host');

test('isolated browser data never imports the normal browser profile', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-browser-isolated-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const host = new BrowserHost({ dataDir, legacyDataDir: '' });
  assert.equal(host.legacyDataDir, '');
  host.importStandaloneData();
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.txt')), false);
});
