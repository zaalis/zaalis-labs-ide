'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KIMI_MODELS, buildKimiPayload, parseKimiResponse } = require('../kimi-provider');

test('Kimi model catalog contains the current official non-deprecated models', () => {
  assert.deepEqual(KIMI_MODELS, [
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.7-code-highspeed',
    'kimi-k2.6',
  ]);
});

test('Kimi K3 maps the IDE reasoning levels and required tool choice', () => {
  const tools = [{ type: 'function', function: { name: 'computer' } }];
  assert.deepEqual(buildKimiPayload({
    model: 'kimi-k3', messages: [{ role: 'user', content: 'test' }], reasoningLevel: 2, tools, requireTool: true,
  }), {
    model: 'kimi-k3',
    messages: [{ role: 'user', content: 'test' }],
    max_tokens: 16000,
    reasoning_effort: 'max',
    tools,
    tool_choice: 'required',
  });
});

test('Kimi always carries an explicit output ceiling', () => {
  // Without it the provider default silently truncates long answers, and a cut
  // report is indistinguishable from a finished one.
  assert.equal(buildKimiPayload({ model: 'kimi-k3' }).max_tokens, 16000);
  assert.equal(buildKimiPayload({ model: 'kimi-k3', maxTokens: 4096 }).max_tokens, 4096);
});

test('Kimi K2.6 uses thinking on/off and K2.7 never sends unsupported controls', () => {
  assert.deepEqual(buildKimiPayload({ model: 'kimi-k2.6', reasoningLevel: 0 }), {
    model: 'kimi-k2.6', messages: [], max_tokens: 16000, thinking: { type: 'disabled' },
  });
  assert.deepEqual(buildKimiPayload({ model: 'kimi-k2.6', reasoningLevel: 1 }), {
    model: 'kimi-k2.6', messages: [], max_tokens: 16000, thinking: { type: 'enabled' },
  });
  assert.deepEqual(buildKimiPayload({
    model: 'kimi-k2.7-code', tools: [{ type: 'function' }], requireTool: true,
  }), {
    model: 'kimi-k2.7-code', messages: [], max_tokens: 16000, tools: [{ type: 'function' }], tool_choice: 'auto',
  });
});

test('Kimi response parser preserves answer, reasoning, native tools, and usage', () => {
  const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'computer', arguments: '{}' } }];
  assert.deepEqual(parseKimiResponse({
    choices: [{ message: { content: 'ok', reasoning_content: 'raisonnement', tool_calls: toolCalls } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  }), {
    content: 'ok', toolCalls, thinking: 'raisonnement', finishReason: '', usage: { input: 12, output: 7 },
  });
});

test('Kimi surfaces the finish reason so a truncated answer is detectable', () => {
  const parsed = parseKimiResponse({ choices: [{ finish_reason: 'length', message: { content: 'coupe' } }] });
  assert.equal(parsed.finishReason, 'length');
  assert.equal(require('../response-integrity').isTruncated(parsed.finishReason), true);
});
