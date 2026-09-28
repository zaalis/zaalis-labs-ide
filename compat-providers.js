'use strict';

// ---------------------------------------------------------------------------
// OpenAI-COMPATIBLE PROVIDERS — called directly by the zaalis Rust core.
// ---------------------------------------------------------------------------
// Every entry speaks the OpenAI chat-completions dialect, so one adapter serves
// them all (rust/crates/zaalis-providers/src/compat.rs). Keys are encrypted in
// users.json like the built-in providers and only ever sent to `baseUrl`.
// No external agent, CLI or account session is involved.
//
// `models` is a starting list; when a key is saved the live `/models` endpoint
// of the provider completes it. `editableUrl` lets the user point the entry at
// their own server; `keyless` entries work without a key (local servers).

const PROVIDERS = Object.freeze([
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro', 'deepseek-flash'] },
  { id: 'zai', label: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5v-turbo', 'glm-5-turbo', 'glm-4.7', 'glm-4.5', 'glm-4.5-flash'] },
  { id: 'alibaba', label: 'Qwen Cloud (Alibaba)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next', 'kimi-k2.5', 'glm-5.2', 'deepseek-v4-pro'] },
  { id: 'alibaba-cn', label: 'Alibaba DashScope (Chine)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next'] },
  { id: 'alibaba-coding-plan', label: 'Alibaba Coding Plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    models: ['qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5'] },
  { id: 'alibaba-coding-plan-cn', label: 'Alibaba Coding Plan (Chine)', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    models: ['qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5'] },
  { id: 'alibaba-token-plan', label: 'Alibaba Token Plan', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max-0902', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'deepseek-v4-pro', 'kimi-k2.7-code', 'glm-5.2'] },
  { id: 'alibaba-token-plan-cn', label: 'Alibaba Token Plan (Chine)', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max-0902', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'deepseek-v4-pro', 'kimi-k2.7-code', 'glm-5.2'] },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'] },
  { id: 'minimax-cn', label: 'MiniMax (Chine)', baseUrl: 'https://api.minimaxi.com/v1', models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'] },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', models: [] },
  { id: 'novita', label: 'NovitaAI', baseUrl: 'https://api.novita.ai/openai/v1',
    models: ['moonshotai/kimi-k2.5', 'minimax/minimax-m2.7', 'zai-org/glm-5', 'deepseek/deepseek-r1-0528', 'qwen/qwen3-235b-a22b-fp8'] },
  { id: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'z-ai/glm-5.3', 'moonshotai/kimi-k2.6', 'minimaxai/minimax-m3'] },
  { id: 'huggingface', label: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1',
    models: ['moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.5', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.5-35B-A3B', 'deepseek-ai/DeepSeek-V3.2', 'MiniMaxAI/MiniMax-M2.5', 'zai-org/GLM-5'] },
  { id: 'xiaomi', label: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'] },
  { id: 'stepfun', label: 'StepFun', baseUrl: 'https://api.stepfun.ai/step_plan/v1', models: ['step-3.5-flash', 'step-3.5-flash-2603'] },
  { id: 'tencent-tokenhub', label: 'Tencent TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1', models: ['hy4-preview', 'hy3', 'hy3-preview'] },
  { id: 'arcee', label: 'Arcee AI', baseUrl: 'https://api.arcee.ai/api/v1', models: ['trinity-large-thinking', 'trinity-large-preview', 'trinity-mini'] },
  { id: 'gmi', label: 'GMI Cloud', baseUrl: 'https://api.gmi-serving.com/v1',
    models: ['zai-org/GLM-5.1-FP8', 'deepseek-ai/DeepSeek-V3.2', 'moonshotai/Kimi-K2.5'] },
  { id: 'kilocode', label: 'Kilo Code', baseUrl: 'https://api.kilo.ai/api/gateway', models: [] },
  { id: 'ai-gateway', label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1',
    models: ['moonshotai/kimi-k2.6', 'alibaba/qwen3.6-plus', 'zai/glm-5.1', 'minimax/minimax-m2.7', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.4', 'google/gemini-3.1-pro-preview'] },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', models: [] },
  { id: 'nebius', label: 'Nebius Token Factory', baseUrl: 'https://api.tokenfactory.nebius.com/v1', models: [] },
  { id: 'upstage', label: 'Upstage Solar', baseUrl: 'https://api.upstage.ai/v1', models: [] },
  { id: 'ollama-cloud', label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', models: [] },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', models: [], keyless: true, editableUrl: true, local: true },
  { id: 'custom', label: 'Personnalisé (URL libre)', baseUrl: '', models: [], keyless: true, editableUrl: true },
]);

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));
const PREFIX = 'compat:';

function get(id) {
  return BY_ID.get(String(id || '').replace(/^compat:/, '')) || null;
}

function isCompat(value) {
  return String(value || '').startsWith(PREFIX);
}

function vaultName(id) {
  return `${PREFIX}${id}`;
}

// Only http(s) URLs, without credentials or fragments, reach the Rust core.
function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

// The binding the Rust core understands: provider `compat`, model `<id>::<model>`.
function binding(provider, model) {
  const entry = get(provider);
  if (!isCompat(provider) || !entry) return null;
  const name = String(model || '').trim();
  if (!name) throw Object.assign(new Error(`Choisissez un modèle ${entry.label}.`), { status: 400 });
  return { provider: 'compat', model: `${entry.id}::${name}` };
}

function capabilities(provider, model, ready) {
  const entry = get(provider);
  const lower = String(model || '').toLowerCase();
  return {
    provider: `${PREFIX}${entry.id}`,
    model: String(model || ''),
    // Reasoning streamed back by the model is displayed; nothing is requested,
    // because the knob differs from one gateway to the next.
    reasoning: { mode: 'native', supported: false, levels: [] },
    contextWindow: 128000,
    tools: true,
    vision: /(^|[-/_.])(vl|vision|omni)([-/_.]|$)|glm-5v|gemini|claude|gpt-5/.test(lower),
    ready: !!ready,
  };
}

module.exports = { PROVIDERS, PREFIX, get, isCompat, vaultName, normalizeBaseUrl, binding, capabilities };
