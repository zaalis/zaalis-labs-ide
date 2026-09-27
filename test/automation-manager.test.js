'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAction } = require('../automation-manager');

function onPlatform(platform, check) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { check(); }
  finally { Object.defineProperty(process, 'platform', original); }
}

test('activate_app conserve les applications Windows admises', () => {
  onPlatform('win32', () => {
    for (const path of ['notepad', 'C:\\Windows\\System32\\notepad.exe']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['C:\\temp\\..\\bad.exe', 'C:\\temp\\bad.sh', '/bin/sh']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});

test('activate_app limite les lanceurs Linux', () => {
  onPlatform('linux', () => {
    for (const path of ['chrome', 'gedit.desktop', '/usr/share/applications/firefox.desktop', '/usr/local/share/applications/code.desktop', '~/.local/share/applications/local.desktop', '/var/lib/flatpak/exports/share/applications/org.example.App.desktop']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['/bin/sh', '/tmp/x.sh', '/tmp/x.desktop', '/usr/share/applications/../x.desktop', 'notepad', 'explorer', 'edge', 'msedge']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});

test('activate_app limite les applications macOS', () => {
  onPlatform('darwin', () => {
    for (const path of ['Safari', 'Google Chrome', 'Visual Studio Code', '/Applications/Safari.app', '/System/Applications/Notes.app', '~/Applications/Calculator.app']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['/tmp/Evil.app', '/Applications/../Evil.app', '/bin/sh', 'Other App', 'Safari.app']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});
