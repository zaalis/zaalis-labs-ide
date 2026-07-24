const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalManager } = require('../terminal-manager');

test('persistent PTY executes a command and returns its exit code', async () => {
  const manager = new TerminalManager();
  const result = await manager.runCommand({ userId: 'test-user', cwd: process.cwd(), command: 'printf terminal-ok', waitMs: 5000 });
  try {
    assert.match(result.output, /terminal-ok/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally { manager.close(result.session); }
});
