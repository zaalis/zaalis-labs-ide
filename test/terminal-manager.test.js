const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalManager } = require('../terminal-manager');

test('persistent PTY executes a command and returns its exit code', async () => {
  const manager = new TerminalManager();
  const command = process.platform === 'win32' ? 'echo terminal-ok' : 'printf terminal-ok';
  const result = await manager.runCommand({ userId: 'test-user', cwd: process.cwd(), command, waitMs: 5000 });
  try {
    assert.match(result.output, /terminal-ok/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.session.profile.id, process.platform === 'win32' ? 'cmd' : 'system');
    assert.equal(result.session.origin, 'agent');
  } finally { manager.close(result.session); }
});
