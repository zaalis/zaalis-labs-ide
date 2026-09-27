'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalManager, TERMINAL_PROFILE_IDS, DEFAULT_TERMINAL_PROFILE } = require('../terminal-manager');

// Le terminal intégré s'appuie sur node-pty, un module natif que le paquet
// installe à côté du binaire plutôt que dans l'instantané pkg. Une machine sans
// ce module doit voir le test ignoré, pas échouer : c'est exactement la
// dégradation que TerminalManager applique au produit.
function ptyAvailable() {
  try { new TerminalManager().create({ userId: 'probe', cwd: process.cwd() }).proc.kill(); return true; }
  catch { return false; }
}

test('les profils annoncés correspondent à la plateforme', () => {
  const expected = process.platform === 'win32'
    ? ['cmd', 'powershell', 'pwsh', 'git-bash']
    : process.platform === 'darwin'
      ? ['zsh', 'bash', 'fish', 'sh', 'login-shell']
      : ['bash', 'zsh', 'fish', 'sh', 'login-shell'];
  assert.deepEqual(TERMINAL_PROFILE_IDS, expected);
  assert.equal(DEFAULT_TERMINAL_PROFILE, expected[0]);
  assert.deepEqual(new TerminalManager().profiles().map((p) => p.id), expected);
});

test('un profil inconnu retombe sur un shell réellement disponible', () => {
  const profile = new TerminalManager().profile('profil-inexistant');
  assert.ok(profile, 'un profil de repli doit toujours être renvoyé');
  assert.ok(TERMINAL_PROFILE_IDS.includes(profile.id));
  assert.equal(typeof profile.shell, 'string');
});

test('le PTY persistant exécute une commande et rend son code de sortie', { skip: !ptyAvailable() && 'node-pty indisponible' }, async () => {
  const manager = new TerminalManager();
  const command = process.platform === 'win32' ? 'echo terminal-ok' : 'printf terminal-ok';
  const result = await manager.runCommand({ userId: 'test-user', cwd: process.cwd(), command, waitMs: 15000 });
  try {
    assert.match(result.output, /terminal-ok/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.session.profile.id, DEFAULT_TERMINAL_PROFILE);
    assert.equal(result.session.origin, 'agent');
  } finally { manager.close(result.session); }
});
