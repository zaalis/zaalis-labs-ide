'use strict';

const { contextWindow } = require('./model-catalog');

const REASONING_LEVELS = Object.freeze([
  { id: 'off', label: 'Désactivé', value: 0 },
  { id: 'low', label: 'Faible', value: 1 },
  { id: 'medium', label: 'Moyen', value: 2 },
  { id: 'high', label: 'Élevé', value: 3 },
  { id: 'max', label: 'Maximum', value: 4 },
]);

function modelCapabilities(provider, model, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const name = String(model || '').trim();
  const lower = name.toLowerCase();
  const localFacts = Array.isArray(options.localCapabilities) ? options.localCapabilities : [];
  const hasLocalFact = (fact) => localFacts.includes(fact);
  const result = {
    provider: id,
    model: name,
    reasoning: { mode: 'none', supported: false, levels: [] },
    contextWindow: Number(options.contextWindow) || contextWindow(id, name),
    tools: true,
    vision: false,
    ready: options.ready === undefined ? true : !!options.ready,
  };

  if (id === 'codex') {
    result.vision = !/^(o1|o3-mini|o4-mini)/.test(lower);
    if (/^(gpt-5|o1|o3|o4)/.test(lower)) result.reasoning.mode = 'effort';
  } else if (id === 'claude') {
    result.vision = true;
    if (/opus|sonnet|fable/.test(lower)) result.reasoning.mode = 'effort';
  } else if (id === 'gemini') {
    result.vision = true;
    if (/2\.5|^gemini-3|thinking/.test(lower)) result.reasoning.mode = 'effort';
  } else if (id === 'mistral') {
    // The current Mistral adapter receives native thinking but does not send
    // an adjustable reasoning_effort. The interface must not imply otherwise.
    if (/medium-3-5|small-latest/.test(lower)) result.reasoning.mode = 'native';
    result.vision = /pixtral|vision/.test(lower);
  } else if (id === 'grok' || id === 'kimi') {
    result.reasoning.mode = 'native';
    result.vision = id === 'grok';
  } else if (id === 'local') {
    result.tools = hasLocalFact('tools');
    result.vision = hasLocalFact('vision');
    result.reasoning.mode = hasLocalFact('thinking') ? 'native' : 'none';
  } else if (id === 'gguf') {
    // llama.cpp's OpenAI-compatible endpoint is used with the text tool
    // fallback. A GGUF filename alone cannot prove vision or thinking support.
    result.tools = false;
    result.reasoning.mode = 'effort';
    result.reasoning.supported = true;
    result.reasoning.levels = [
      { id: 'none', label: 'Désactivé', value: 0 },
      { id: 'minimal', label: 'Minimal', value: 1 },
      { id: 'low', label: 'Faible', value: 2 },
      { id: 'medium', label: 'Moyen', value: 3 },
      { id: 'high', label: 'Élevé', value: 4 },
      { id: 'xhigh', label: 'Très élevé', value: 5 },
      { id: 'max', label: 'Maximum', value: 6 },
      { id: 'ultra', label: 'Ultra', value: 7 },
    ];
  }

  if (result.reasoning.mode === 'effort') {
    result.reasoning.supported = true;
    if (!result.reasoning.levels.length) result.reasoning.levels = REASONING_LEVELS;
  }
  return result;
}

function bindingCapabilities(description) {
  const mode = description.reasoning.mode;
  return {
    native_tools: description.tools,
    vision: description.vision,
    max_context: description.contextWindow,
    reasoning: mode,
  };
}

module.exports = { REASONING_LEVELS, modelCapabilities, bindingCapabilities };
