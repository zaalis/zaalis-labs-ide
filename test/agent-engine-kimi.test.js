'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runAgentTurn, TOOL_CATALOG } = require('../agent-engine');

test('Kimi uses the shared agent loop and can execute the standard read-only tools', async () => {
  let calls = 0;
  const result = await runAgentTurn({
    root: path.resolve(__dirname, '..'),
    model: 'kimi',
    submodel: 'kimi-k3',
    message: 'Lis package.json puis réponds.',
    permissionMode: 'read-only',
    callModel: async (payload) => {
      assert.equal(payload.model, 'kimi');
      assert.equal(payload.submodel, 'kimi-k3');
      calls++;
      return calls === 1
        ? { response: '```tool\n{"name":"read","input":{"paths":["package.json"]}}\n```' }
        : { response: 'package.json a été lu.' };
    },
  });

  assert.ok(TOOL_CATALOG.read.readOnly);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].tool, 'read');
  assert.match(result.toolResults[0].text, /package\.json/);
  assert.equal(result.response, 'package.json a été lu.');
});

test('structured Git reads run through the execution broker and page full diffs', async () => {
  const calls = [];
  let turns = 0;
  const result = await runAgentTurn({
    root: path.resolve(__dirname, '..'),
    model: 'local',
    message: 'Montre le diff.',
    permissionMode: 'read-only',
    executionBroker: { run: async (input) => { calls.push(input); return { exitCode: 0, stdout: 'a'.repeat(1500), stderr: '', sandbox: 'seatbelt' }; } },
    callModel: async () => {
      turns++;
      return turns === 1
        ? { response: '```tool\n{"name":"git","input":{"action":"diff","scope":"all","limit":2}}\n```' }
        : { response: 'Diff consulté.' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].write, false);
  assert.equal(calls[0].network, false);
  assert.match(result.toolResults[0].text, /offset=1000/);
  assert.equal(result.response, 'Diff consulté.');
});
