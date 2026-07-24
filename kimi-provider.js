'use strict';

// Current, non-deprecated models from the official Kimi API model list.
const KIMI_MODELS = Object.freeze([
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
]);

function boundedLevel(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function buildKimiPayload({ model = KIMI_MODELS[0], messages = [], reasoningLevel = 0, tools, requireTool = false, maxTokens = 16000 } = {}) {
  const payload = { model, messages, max_tokens: maxTokens };
  const level = boundedLevel(reasoningLevel);

  if (model === 'kimi-k3') {
    payload.reasoning_effort = ['low', 'high', 'max'][Math.min(level, 2)];
  } else if (model === 'kimi-k2.6') {
    payload.thinking = { type: level > 0 ? 'enabled' : 'disabled' };
  }
  // K2.7 Code always reasons. The official API recommends omitting `thinking`.

  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
    // Only K3 accepts required; K2.6/K2.7 accept auto/none.
    payload.tool_choice = model === 'kimi-k3' && requireTool ? 'required' : 'auto';
  }
  return payload;
}

function parseKimiResponse(data) {
  const choice = data && data.choices && data.choices[0] || {};
  const message = choice.message || {};
  const usage = data && data.usage;
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    thinking: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
    usage: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens } : null,
  };
}

module.exports = { KIMI_MODELS, buildKimiPayload, parseKimiResponse };
