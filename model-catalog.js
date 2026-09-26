'use strict';

// ---------------------------------------------------------------------------
// MODEL CATALOGUE — provider -> exact models, shared by the server-side APIs.
// ---------------------------------------------------------------------------
// The desktop interface keeps its own copy in interface/script/state.js because
// it needs the lists before any request is made. This module is the version the
// server hands to external consumers (the codestrale bridge), so a companion
// app never has to hard-code a model list that would drift on every release.
// Keep the two in sync when adding a provider or a model.

// Sub-model options per provider — real/current API models only, NEWEST FIRST.
// The first entry of each list is the default selection for that provider.
const SUBMODELS = {
  codex:  ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.1', 'o3-mini', 'o1', 'gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-4'],
  claude: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  grok:   ['grok-4.5', 'grok-4.3', 'grok-4.20-multi-agent-0309', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1', 'grok-imagine-image-quality', 'grok-imagine-image'],
  mistral:['mistral-medium-3-5', 'mistral-small-latest', 'mistral-large-latest', 'ministral-14b-2512', 'ministral-8b-2512', 'ministral-3b-2512', 'codestral-latest'],
  kimi:   ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
  local:  ['qwen3:8b', 'llama3.2', 'gemma3:4b', 'deepseek-r1:8b', 'qwen2.5-coder:7b'],
  gguf:   []   // populated from the installed *.gguf files
};

// Human-friendly display names (dots, not dashes). Falls back to the raw id.
const MODEL_LABELS = {
  'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4', 'gpt-5.4-mini': 'GPT-5.4 mini', 'gpt-5.4-nano': 'GPT-5.4 nano',
  'gpt-5.2': 'GPT-5.2', 'gpt-5.1': 'GPT-5.1', 'o3-mini': 'o3-mini', 'o1': 'o1', 'gpt-4o-mini': 'GPT-4o mini',
  'gpt-3.5-turbo': 'GPT-3.5 Turbo', 'gpt-4': 'GPT-4',
  'claude-fable-5': 'Claude Fable 5', 'claude-opus-4-8': 'Claude Opus 4.8', 'claude-sonnet-5': 'Claude Sonnet 5', 'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite', 'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'gemini-2.5-pro': 'Gemini 2.5 Pro', 'gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'grok-4.5': 'Grok 4.5', 'grok-4.3': 'Grok 4.3', 'grok-4.20-multi-agent-0309': 'Grok 4.20 Multi-Agent',
  'grok-4.20-0309-reasoning': 'Grok 4.20 Reasoning', 'grok-4.20-0309-non-reasoning': 'Grok 4.20 Non-Reasoning',
  'grok-build-0.1': 'Grok Build 0.1', 'grok-imagine-image-quality': 'Grok Imagine Image Quality', 'grok-imagine-image': 'Grok Imagine Image',
  'mistral-medium-3-5': 'Mistral Medium 3.5', 'mistral-small-latest': 'Mistral Small 4',
  'mistral-large-latest': 'Mistral Large 3', 'ministral-14b-2512': 'Ministral 3 14B',
  'ministral-8b-2512': 'Ministral 3 8B', 'ministral-3b-2512': 'Ministral 3 3B', 'codestral-latest': 'Codestral 25.08',
  'kimi-k3': 'Kimi K3', 'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7-code-highspeed': 'Kimi K2.7 Code HighSpeed', 'kimi-k2.6': 'Kimi K2.6'
};

// Context window (tokens) per model — aligned with official API key limits.
const CONTEXT_WINDOWS = {
  codex: {
    'gpt-5.6-sol': 1050000, 'gpt-5.6-terra': 1050000, 'gpt-5.6-luna': 1050000,
    'gpt-5.5': 1050000, 'gpt-5.4': 1050000, 'gpt-5.4-mini': 400000, 'gpt-5.4-nano': 400000,
    'gpt-5.2': 400000, 'gpt-5.1': 400000, 'gpt-4.5': 128000, 'o3-mini': 200000, 'o1': 200000,
    'gpt-4o-mini': 128000, 'gpt-3.5-turbo': 16385, 'gpt-4': 8192, _default: 128000
  },
  claude: {
    'claude-fable-5': 1000000, 'claude-opus-4-8': 1000000, 'claude-sonnet-5': 1000000,
    'claude-haiku-4-5': 200000, _default: 200000
  },
  gemini: {
    'gemini-3.5-flash': 1048576, 'gemini-3.1-pro-preview': 1048576, 'gemini-3.1-flash-lite': 1048576,
    'gemini-3-flash-preview': 1048576, 'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576,
    'gemini-2.5-flash-lite': 1048576, _default: 1048576
  },
  grok: {
    'grok-4.5': 500000, 'grok-4.3': 1000000, 'grok-4.20-multi-agent-0309': 1000000,
    'grok-4.20-0309-reasoning': 1000000, 'grok-4.20-0309-non-reasoning': 1000000,
    'grok-build-0.1': 256000, 'grok-imagine-image-quality': 1024, 'grok-imagine-image': 1024,
    _default: 1000000
  },
  mistral: {
    'mistral-medium-3-5': 256000, 'mistral-small-latest': 256000, 'mistral-large-latest': 256000,
    'ministral-14b-2512': 256000, 'ministral-8b-2512': 256000, 'ministral-3b-2512': 256000,
    'codestral-latest': 128000, _default: 256000
  },
  kimi: {
    'kimi-k3': 1000000, 'kimi-k2.7-code': 256000, 'kimi-k2.7-code-highspeed': 256000,
    'kimi-k2.6': 256000, _default: 256000
  },
  local: { _default: 8000 },
  gguf:  { _default: 8192 }   // matches the engine's --ctx-size
};

// Provider identity + which stored API key unlocks it. `keyName` is empty for
// the two local runtimes: nothing to configure, they answer offline.
const PROVIDERS = [
  { id: 'codex',   label: 'Codex',   vendor: 'OpenAI',      family: 'cloud', keyName: 'openai' },
  { id: 'claude',  label: 'Claude',  vendor: 'Anthropic',   family: 'cloud', keyName: 'anthropic' },
  { id: 'gemini',  label: 'Gemini',  vendor: 'Google',      family: 'cloud', keyName: 'google' },
  { id: 'grok',    label: 'Grok',    vendor: 'xAI',         family: 'cloud', keyName: 'grok' },
  { id: 'mistral', label: 'Mistral', vendor: 'Mistral',     family: 'cloud', keyName: 'mistral' },
  { id: 'kimi',    label: 'Kimi',    vendor: 'Moonshot AI', family: 'cloud', keyName: 'moonshot' },
  { id: 'local',   label: 'Ollama',  vendor: 'Ollama',      family: 'local', keyName: '' },
  { id: 'gguf',    label: 'GGUF',    vendor: 'llama.cpp',   family: 'local', keyName: '' },
];

function modelLabel(id) { return MODEL_LABELS[id] || id; }

function contextWindow(provider, submodel) {
  const table = CONTEXT_WINDOWS[provider] || {};
  const wanted = String(submodel || '').toLowerCase().trim();
  if (table[wanted]) return table[wanted];
  // Longest key first so `gpt-5.5` wins over `gpt-5`.
  const keys = Object.keys(table).filter((k) => k !== '_default').sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (wanted.includes(key) || key.includes(wanted)) return table[key];
  }
  return table._default || 128000;
}

// A GGUF file name doubles as its id; the label just drops the extension.
function ggufLabel(name) { return String(name).replace(/\.gguf$/i, ''); }

/**
 * Build the catalogue as consumed by the codestrale bridge.
 *
 * @param {object} sources
 * @param {object} sources.keys        decrypted API keys, keyed by `keyName`
 * @param {string[]} sources.ollama    Ollama model names installed locally
 * @param {string[]} sources.gguf      installed *.gguf file names
 * @param {number} [sources.ggufCtx]   context size the local engine is set to
 * @returns {{providers: Array}}
 */
function buildCatalog(sources) {
  const keys = (sources && sources.keys) || {};
  const ollama = (sources && Array.isArray(sources.ollama) ? sources.ollama : []).filter(Boolean);
  const gguf = (sources && Array.isArray(sources.gguf) ? sources.gguf : []).filter(Boolean);
  const ggufCtx = Number(sources && sources.ggufCtx) || CONTEXT_WINDOWS.gguf._default;

  const providers = PROVIDERS.map((provider) => {
    let models;
    let ready;
    if (provider.id === 'local') {
      // Installed models first; the curated defaults stay visible so the menu is
      // never empty, and pulling one of them is a single Ollama command away.
      const seen = new Set(ollama);
      const ids = ollama.concat(SUBMODELS.local.filter((id) => !seen.has(id)));
      models = ids.map((id) => ({ id, label: id, context: contextWindow('local', id) }));
      ready = ollama.length > 0;
    } else if (provider.id === 'gguf') {
      models = gguf.map((name) => ({ id: name, label: ggufLabel(name), context: ggufCtx }));
      ready = gguf.length > 0;
    } else {
      models = (SUBMODELS[provider.id] || []).map((id) => ({
        id, label: modelLabel(id), context: contextWindow(provider.id, id),
      }));
      ready = !!(provider.keyName && keys[provider.keyName]);
    }
    return { ...provider, models, ready };
  });

  return { providers };
}

module.exports = {
  SUBMODELS, MODEL_LABELS, CONTEXT_WINDOWS, PROVIDERS,
  modelLabel, contextWindow, buildCatalog,
};
