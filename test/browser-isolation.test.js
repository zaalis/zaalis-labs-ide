'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserHost } = require('../zaalis-browser/host');

test('standalone browser data is copied once into the integrated browser store', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-browser-isolated-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-browser-profile-'));
  const previousAppData = process.env.APPDATA;
  const standaloneDir = path.join(appData, 'zaalis browser');
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.writeFileSync(path.join(standaloneDir, 'settings.txt'), 'standalone settings');
  process.env.APPDATA = appData;
  t.after(() => {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  });
  const host = new BrowserHost({ dataDir, log: () => {} });
  host.importStandaloneData();
  const destination = path.join(dataDir, 'settings.txt');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'standalone settings');
  fs.writeFileSync(destination, 'integrated settings');
  host.importStandaloneData();
  assert.equal(fs.readFileSync(destination, 'utf8'), 'integrated settings');
});
