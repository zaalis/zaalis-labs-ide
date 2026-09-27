'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCapabilities, bindingCapabilities } = require('../model-capabilities');

test('Mistral exposes native thinking without a misleading effort selector', () => {
  const caps = modelCapabilities('mistral', 'mistral-small-latest', { ready: true });
  assert.equal(caps.reasoning.mode, 'native');
  assert.equal(caps.reasoning.supported, false);
  assert.deepEqual(caps.reasoning.levels, []);
  assert.equal(bindingCapabilities(caps).reasoning, 'native');
});

test('local capabilities come from runtime metadata, not a model filename', () => {
  const unknown = modelCapabilities('local', 'custom:latest', { ready: false });
  assert.equal(unknown.tools, false);
  assert.equal(unknown.vision, false);
  assert.equal(unknown.ready, false);
  const confirmed = modelCapabilities('local', 'custom:latest', {
    ready: true, localCapabilities: ['tools', 'vision', 'thinking'], contextWindow: 8192,
  });
  assert.equal(confirmed.tools, true);
  assert.equal(confirmed.vision, true);
  assert.equal(confirmed.reasoning.mode, 'native');
  assert.equal(bindingCapabilities(confirmed).max_context, 8192);
});

test('a GGUF file stays on the text fallback unless the runtime proves more', () => {
  const caps = modelCapabilities('gguf', 'SmolLM2-135M-Instruct-Q4_K_M.gguf', { ready: true, contextWindow: 4096 });
  assert.equal(caps.tools, false);
  assert.equal(caps.vision, false);
  assert.equal(caps.reasoning.supported, false);
});
