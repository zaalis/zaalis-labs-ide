'use strict';

// The engine narrator must always describe the REAL tool batch/results, never
// invent actions, and stay silent when there is nothing meaningful to say.
const test = require('node:test');
const assert = require('node:assert');
const { describeToolBatchNote, describeToolOutcomeNote } = require('../agent-engine');

test('batch note derives from actual tool inputs', () => {
  const note = describeToolBatchNote([
    { name: 'read', input: { paths: ['auth-system/auth.go', '.env'] } },
    { name: 'grep', input: { pattern: 'password' } },
  ], 'fr');
  assert.match(note, /auth\.go/);
  assert.match(note, /\.env/);
  assert.match(note, /password/);
  assert.match(note, /^Je lis /);
});

test('batch note is empty for an empty batch', () => {
  assert.strictEqual(describeToolBatchNote([], 'fr'), '');
  assert.strictEqual(describeToolBatchNote(null, 'fr'), '');
});

test('batch note supports english and run commands', () => {
  const note = describeToolBatchNote([{ name: 'run', input: { command: 'npm test' } }], 'en');
  assert.match(note, /I run: npm test/);
});

test('outcome note counts real results and failures', () => {
  const note = describeToolOutcomeNote([
    { name: 'read' }, { name: 'read' }, { name: 'grep' }, { name: 'run', error: true },
  ], 'fr');
  assert.match(note, /2 fichiers lus/);
  assert.match(note, /1 recherche/);
  assert.match(note, /1 étape en erreur/);
});

test('outcome note stays silent for a single successful step', () => {
  assert.strictEqual(describeToolOutcomeNote([{ name: 'read' }], 'fr'), '');
});
