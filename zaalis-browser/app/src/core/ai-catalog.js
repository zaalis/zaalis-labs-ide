'use strict';
// Catalogue des fournisseurs et modèles IA (miroir de zaalis labs ide) et applications du lanceur.
// (extrait de main.js — aucune dépendance sur l'état du navigateur)

// Providers + sous-modeles disponibles pour la recherche/chat IA.
// Miroir fidèle du catalogue de zaalis labs ide : interface/script/state.js
// (API officielles) et compat-providers.js (abonnement ChatGPT et passerelles
// compatibles OpenAI). Le navigateur envoie { model: provider, submodel } au
// serveur IDE local, qui garde les clés et le compte ChatGPT : aucun secret
// ne transite par le navigateur.
// Groupes affichés dans le panneau : abonnement, API officielles, passerelles
// compatibles OpenAI, local. « local » (Ollama) et « gguf » (llama.cpp) sont des
// listes ouvertes : leur contenu réel est récupéré en direct auprès du serveur
// IDE (refreshLocalModels + aiProvidersSnapshot).
const AI_PROVIDER_GROUPS = {
  subscription: 'Abonnements',
  api:          'API officielles',
  compat:       'Passerelles compatibles OpenAI',
  local:        'Local',
};

const AI_PROVIDERS = {
  // ----- Abonnements (connexion par compte dans zaalis labs ide) -----
  'compat:chatgpt': { group: 'subscription', label: 'ChatGPT (abonnement)', hint: 'Plus / Pro — compte connecté dans l\'IDE',
    submodels: ['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-sol','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.4','gpt-5.4-mini'] },
  'compat:xai-sub': { group: 'subscription', label: 'Grok / xAI (abonnement)', hint: 'SuperGrok / X Premium+ — compte connecté dans l\'IDE',
    submodels: ['grok-4.7','grok-4.6'] },
  'compat:minimax-sub': { group: 'subscription', label: 'MiniMax (abonnement)', hint: 'Compte MiniMax international',
    submodels: ['MiniMax-M3','MiniMax-M2.7','MiniMax-M2.7-highspeed'] },
  // ----- API officielles (clé dans zaalis labs ide) -----
  codex:  { group: 'api', label: 'OpenAI (API)',        submodels: ['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-sol','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano','gpt-5.2','gpt-5.1','o3-mini','o1','gpt-4o-mini','gpt-3.5-turbo','gpt-4'] },
  claude: { group: 'api', label: 'Claude (Anthropic)',  submodels: ['claude-fable-5-2','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5','claude-fable-5','claude-opus-4-8','claude-sonnet-5','claude-haiku-4-5'] },
  gemini: { group: 'api', label: 'Gemini (Google)',     submodels: ['gemini-3.5-flash','gemini-3.1-pro-preview','gemini-3.1-flash-lite','gemini-3-flash-preview','gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite'] },
  grok:   { group: 'api', label: 'Grok (xAI)',          submodels: ['grok-4.7','grok-4.6','grok-4.5','grok-4.3','grok-4.20-multi-agent-0309','grok-4.20-0309-reasoning','grok-4.20-0309-non-reasoning','grok-build-0.1','grok-imagine-image-quality','grok-imagine-image'] },
  mistral:{ group: 'api', label: 'Mistral',             submodels: ['mistral-medium-3-5','mistral-small-latest','mistral-large-latest','ministral-14b-2512','ministral-8b-2512','ministral-3b-2512','codestral-latest'] },
  kimi:   { group: 'api', label: 'Kimi (Moonshot AI)',  submodels: ['kimi-k3.1-pro','kimi-k3.1-pro-highspeed','kimi-k3','kimi-k2.7-code','kimi-k2.7-code-highspeed','kimi-k2.6'] },
  // ----- Passerelles compatibles OpenAI (clé dans zaalis labs ide) -----
  // Les passerelles sans liste de départ (OpenRouter, Fireworks…) ne sont
  // remplies qu'en direct par l'IDE : elles ne figurent donc pas ici.
  'compat:deepseek':   { group: 'compat', label: 'DeepSeek', submodels: ['deepseek-v4-pro','deepseek-flash'] },
  'compat:zai':        { group: 'compat', label: 'Z.AI (GLM)', submodels: ['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-5v-turbo','glm-5-turbo','glm-4.7','glm-4.5','glm-4.5-flash'] },
  'compat:alibaba':    { group: 'compat', label: 'Qwen Cloud (Alibaba)', submodels: ['qwen3.8-max','qwen3.7-max','qwen3.7-plus','qwen3.6-plus','qwen3.6-flash','qwen3.5-plus','qwen3-coder-plus','qwen3-coder-next','kimi-k2.5','glm-5.2','deepseek-v4-pro'] },
  'compat:alibaba-cn': { group: 'compat', label: 'Alibaba DashScope (Chine)', submodels: ['qwen3.8-max','qwen3.7-max','qwen3.7-plus','qwen3.6-plus','qwen3.6-flash','qwen3.5-plus','qwen3-coder-plus','qwen3-coder-next'] },
  'compat:alibaba-coding-plan':    { group: 'compat', label: 'Alibaba Coding Plan', submodels: ['qwen3.7-plus','qwen3.6-plus','qwen3.5-plus','qwen3-coder-plus','qwen3-coder-next','kimi-k2.5','glm-5','MiniMax-M2.5'] },
  'compat:alibaba-coding-plan-cn': { group: 'compat', label: 'Alibaba Coding Plan (Chine)', submodels: ['qwen3.7-plus','qwen3.6-plus','qwen3.5-plus','qwen3-coder-plus','qwen3-coder-next','kimi-k2.5','glm-5','MiniMax-M2.5'] },
  'compat:alibaba-token-plan':     { group: 'compat', label: 'Alibaba Token Plan', submodels: ['qwen3.8-max-0902','qwen3.7-max','qwen3.7-plus','qwen3.6-plus','deepseek-v4-pro','kimi-k2.7-code','glm-5.2'] },
  'compat:alibaba-token-plan-cn':  { group: 'compat', label: 'Alibaba Token Plan (Chine)', submodels: ['qwen3.8-max-0902','qwen3.7-max','qwen3.7-plus','qwen3.6-plus','deepseek-v4-pro','kimi-k2.7-code','glm-5.2'] },
  'compat:minimax':    { group: 'compat', label: 'MiniMax', submodels: ['MiniMax-M3','MiniMax-M2.7','MiniMax-M2.5','MiniMax-M2.1','MiniMax-M2'] },
  'compat:minimax-cn': { group: 'compat', label: 'MiniMax (Chine)', submodels: ['MiniMax-M3','MiniMax-M2.7','MiniMax-M2.5','MiniMax-M2.1','MiniMax-M2'] },
  'compat:novita':     { group: 'compat', label: 'NovitaAI', submodels: ['moonshotai/kimi-k2.5','minimax/minimax-m2.7','zai-org/glm-5','deepseek/deepseek-r1-0528','qwen/qwen3-235b-a22b-fp8'] },
  'compat:nvidia':     { group: 'compat', label: 'NVIDIA NIM', submodels: ['nvidia/nemotron-3-ultra-550b-a55b','nvidia/nemotron-3-super-120b-a12b','nvidia/nemotron-3.5-lightning-30b-a3b','z-ai/glm-5.3','moonshotai/kimi-k2.6','minimaxai/minimax-m3'] },
  'compat:huggingface':{ group: 'compat', label: 'Hugging Face', submodels: ['moonshotai/Kimi-K2.6','moonshotai/Kimi-K2.5','Qwen/Qwen3.5-397B-A17B','Qwen/Qwen3.5-35B-A3B','deepseek-ai/DeepSeek-V3.2','MiniMaxAI/MiniMax-M2.5','zai-org/GLM-5'] },
  'compat:xiaomi':     { group: 'compat', label: 'Xiaomi MiMo', submodels: ['mimo-v2.6-pro','mimo-v2.6-flash','mimo-v2.6-pro-ultraspeed','mimo-v2.5-pro','mimo-v2.5','mimo-v2-omni','mimo-v2-flash'] },
  'compat:stepfun':    { group: 'compat', label: 'StepFun', submodels: ['step-3.5-flash','step-3.5-flash-2603'] },
  'compat:tencent-tokenhub': { group: 'compat', label: 'Tencent TokenHub', submodels: ['hy4-preview','hy3','hy3-preview'] },
  'compat:arcee':      { group: 'compat', label: 'Arcee AI', submodels: ['trinity-large-thinking','trinity-large-preview','trinity-mini'] },
  'compat:gmi':        { group: 'compat', label: 'GMI Cloud', submodels: ['zai-org/GLM-5.1-FP8','deepseek-ai/DeepSeek-V3.2','moonshotai/Kimi-K2.5'] },
  'compat:ai-gateway': { group: 'compat', label: 'Vercel AI Gateway', submodels: ['moonshotai/kimi-k2.6','alibaba/qwen3.6-plus','zai/glm-5.1','minimax/minimax-m2.7','anthropic/claude-sonnet-4.6','openai/gpt-5.4','google/gemini-3.1-pro-preview'] },
  // ----- Local -----
  local:  { group: 'local', label: 'Ollama',            submodels: ['qwen3:8b','llama3.2','gemma3:4b','deepseek-r1:8b','qwen2.5-coder:7b'] },
  gguf:   { group: 'local', label: 'GGUF (llama.cpp)',  submodels: [] },
};

const AI_MODEL_LABELS = {
  'gpt-6-astra': 'GPT-6 Astra', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6-sol': 'GPT-6 Sol', 'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4', 'gpt-5.4-mini': 'GPT-5.4 mini', 'gpt-5.4-nano': 'GPT-5.4 nano',
  'gpt-5.2': 'GPT-5.2', 'gpt-5.1': 'GPT-5.1', 'o3-mini': 'o3-mini', 'o1': 'o1', 'gpt-4o-mini': 'GPT-4o mini',
  'gpt-3.5-turbo': 'GPT-3.5 Turbo', 'gpt-4': 'GPT-4',
  'claude-fable-5-2': 'Claude Fable 5.2', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-fable-5': 'Claude Fable 5', 'claude-opus-4-8': 'Claude Opus 4.8', 'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite', 'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'gemini-2.5-pro': 'Gemini 2.5 Pro', 'gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'grok-4.7': 'Grok 4.7', 'grok-4.6': 'Grok 4.6', 'grok-4.5': 'Grok 4.5', 'grok-4.3': 'Grok 4.3', 'grok-4.20-multi-agent-0309': 'Grok 4.20 Multi-Agent',
  'grok-4.20-0309-reasoning': 'Grok 4.20 Reasoning', 'grok-4.20-0309-non-reasoning': 'Grok 4.20 Non-Reasoning',
  'grok-build-0.1': 'Grok Build 0.1', 'grok-imagine-image-quality': 'Grok Imagine Image Quality', 'grok-imagine-image': 'Grok Imagine Image',
  'mistral-medium-3-5': 'Mistral Medium 3.5', 'mistral-small-latest': 'Mistral Small 4',
  'mistral-large-latest': 'Mistral Large 3', 'ministral-14b-2512': 'Ministral 3 14B',
  'ministral-8b-2512': 'Ministral 3 8B', 'ministral-3b-2512': 'Ministral 3 3B', 'codestral-latest': 'Codestral 25.08',
  'kimi-k3.1-pro': 'Kimi K3.1 Pro', 'kimi-k3.1-pro-highspeed': 'Kimi K3.1 Pro HighSpeed', 'kimi-k3': 'Kimi K3', 'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7-code-highspeed': 'Kimi K2.7 Code HighSpeed', 'kimi-k2.6': 'Kimi K2.6',
};

// Deux modes par profil : « travail » = grille preremplie d'apps Google (icones
// via favicon, non modifiable) ; « creatif » = raccourcis ajoutes/supprimes par
// l'utilisateur. Persiste par profil dans launcher.json.
// Icones officielles Google chargees EN DIRECT depuis gstatic (pas embarquees
// dans l'app -> usage nominatif comme une favicon, pas de redistribution).
// `icon` vide => repli favicon cote UI (les favicons de ces domaines sont deja
// correctes : YouTube, Gemini, Maps, Actualites...).
const GST = 'https://www.gstatic.com/images/branding/product/2x/';

const WORK_APPS = [
  { url: 'https://myaccount.google.com', title: 'Compte',     icon: GST + 'googleg_48dp.png' },
  { url: 'https://drive.google.com',     title: 'Drive',      icon: GST + 'drive_2020q4_48dp.png' },
  { url: 'https://mail.google.com',      title: 'Gmail',      icon: GST + 'gmail_2020q4_48dp.png' },
  { url: 'https://www.youtube.com',      title: 'YouTube',    icon: GST + 'youtube_48dp.png' },
  { url: 'https://gemini.google.com',    title: 'Gemini',     icon: '' },
  { url: 'https://maps.google.com',      title: 'Maps',       icon: '' },
  { url: 'https://www.google.com',       title: 'Recherche',  icon: GST + 'googleg_48dp.png' },
  { url: 'https://calendar.google.com',  title: 'Agenda',     icon: GST + 'calendar_2020q4_48dp.png' },
  { url: 'https://news.google.com',      title: 'Actualités', icon: '' },
  { url: 'https://photos.google.com',    title: 'Photos',     icon: GST + 'photos_48dp.png' },
  { url: 'https://meet.google.com',      title: 'Meet',       icon: GST + 'meet_2020q4_48dp.png' },
  { url: 'https://translate.google.com', title: 'Traduction', icon: 'https://ssl.gstatic.com/images/branding/product/2x/translate_24dp.png' },
  { url: 'https://docs.google.com',      title: 'Docs',       icon: GST + 'docs_2020q4_48dp.png' },
];

module.exports = { AI_PROVIDER_GROUPS, AI_PROVIDERS, AI_MODEL_LABELS, GST, WORK_APPS };
