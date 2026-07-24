const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAction, needsApproval, isSensitive } = require('../automation-manager');

test('computer action validation only permits bounded actions', () => {
  assert.deepEqual(normalizeAction({ action: 'click', x: 14, y: 22 }), { action: 'click', x: 14, y: 22, button: 'left' });
  assert.deepEqual(normalizeAction({ action: 'menus' }), { action: 'menus' });
  assert.equal(normalizeAction({ action: 'click', x: -1, y: 2 }), null);
  assert.equal(normalizeAction({ action: 'shell', command: 'rm -rf /' }), null);
});

test('computer approvals preserve the permission modes and hard safety boundary', () => {
  assert.equal(needsApproval({ action: 'click' }, 'supervised'), true);
  assert.equal(needsApproval({ action: 'move' }, 'supervised'), false);
  assert.equal(needsApproval({ action: 'menus' }, 'supervised'), false);
  assert.equal(needsApproval({ action: 'open_terminal' }, 'semi'), true);
  const sensitive = { action: 'type', text: 'mot de passe secret' };
  assert.equal(isSensitive(sensitive), true);
  assert.equal(needsApproval(sensitive, 'auto'), true);
});
