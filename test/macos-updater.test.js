'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildMacosUpdateScript,
  resolveMacosAppBundle,
  shellQuote,
} = require('../macos-updater');

test('shellQuote protege les chemins transmis au script detache', () => {
  assert.equal(shellQuote('/Applications/zaalis IDE.app'), "'/Applications/zaalis IDE.app'");
  assert.equal(shellQuote("/tmp/l'app.dmg"), "'/tmp/l'\"'\"'app.dmg'");
  assert.throws(() => shellQuote('bad\0path'), /NUL byte/);
});

test('resolveMacosAppBundle accepte uniquement une structure .app existante', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-updater-test-'));
  try {
    const appBundle = path.join(root, 'zaalis IDE.app');
    fs.mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(appBundle, 'Contents', 'Info.plist'), '<plist/>');

    assert.equal(resolveMacosAppBundle(appBundle, ''), fs.realpathSync(appBundle));
    assert.equal(resolveMacosAppBundle(path.join(root, 'missing.app'), ''), null);
    assert.equal(resolveMacosAppBundle(root, ''), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('le runner macOS verifie, remplace, restaure et relance sans commande Windows', () => {
  const script = buildMacosUpdateScript({
    installerPath: '/tmp/zaalis update.dmg',
    appBundlePath: '/Applications/zaalis IDE.app',
    logPath: '/tmp/zaalis update.log',
    lastTagFile: '/tmp/last-update-tag',
    expectedVersion: '1.2.3',
    expectedArch: 'arm64',
    serverPid: 123,
    shellPid: 456,
  });

  assert.match(script, /hdiutil verify/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /application signing identity does not match/);
  assert.match(script, /DMG version \$SOURCE_VERSION does not match release \$EXPECTED_VERSION/);
  assert.match(script, /ditto "\$SOURCE_APP" "\$STAGE_APP"/);
  assert.match(script, /mv "\$DEST_APP" "\$BACKUP_APP"/);
  assert.match(script, /restore_previous_app/);
  assert.match(script, /open "\$DEST_APP"/);
  assert.doesNotMatch(script, /\.exe|taskkill|powershell|wscript/i);

  const syntax = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('le runner refuse les charges et destinations non macOS', () => {
  const base = {
    logPath: '/tmp/update.log',
    lastTagFile: '/tmp/tag',
    expectedArch: 'x64',
  };
  assert.throws(() => buildMacosUpdateScript({ ...base, installerPath: '/tmp/update.exe', appBundlePath: '/Applications/zaalis IDE.app' }), /DMG/);
  assert.throws(() => buildMacosUpdateScript({ ...base, installerPath: '/tmp/update.dmg', appBundlePath: '/Applications/zaalis' }), /app bundle/);
});
