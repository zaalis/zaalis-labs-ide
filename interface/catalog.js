/* =====================================================================
   Catalogue curé de modèles Ollama installables en 1 clic.
   Tags: light | code | vision | reasoning | general | embed | heavy
   'name' = nom exact pour `ollama pull`. Tailles approximatives.
   ===================================================================== */
window.OLLAMA_CATALOG = [
  // --- Ultra légers ---
  { name: 'tinyllama',           label: 'TinyLlama 1.1B',      size: '0.6 Go', tags: ['light', 'general'], desc: 'Minuscule, pour très petits PC.' },
  { name: 'gemma3:1b',           label: 'Gemma 3 1B',          size: '0.8 Go', tags: ['light', 'general'], desc: 'Google Gemma 3, ultra léger.' },
  { name: 'llama3.2:1b',         label: 'Llama 3.2 1B',        size: '1.3 Go', tags: ['light', 'general'], desc: 'Le plus petit Llama 3.2.' },
  { name: 'qwen3:1.7b',          label: 'Qwen 3 1.7B',         size: '1.4 Go', tags: ['light', 'reasoning'], desc: 'Qwen 3 minuscule avec réflexion.' },
  { name: 'deepseek-r1:1.5b',    label: 'DeepSeek R1 1.5B',    size: '1.1 Go', tags: ['light', 'reasoning'], desc: 'Raisonnement ultra léger.' },
  { name: 'smollm2:1.7b',        label: 'SmolLM2 1.7B',        size: '1.8 Go', tags: ['light', 'general'], desc: 'Petit modèle efficace.' },
  { name: 'moondream',           label: 'Moondream 1.8B',      size: '1.7 Go', tags: ['light', 'vision'], desc: 'Vision minuscule.' },

  // --- Légers / rapides ---
  { name: 'llama3.2:3b',         label: 'Llama 3.2 3B',        size: '2.0 Go', tags: ['light', 'general'], desc: 'Meta rapide, idéal PC modeste.' },
  { name: 'qwen3:4b',            label: 'Qwen 3 4B',           size: '2.6 Go', tags: ['light', 'reasoning'], desc: 'Qwen 3 compact avec raisonnement.' },
  { name: 'qwen2.5:3b',          label: 'Qwen 2.5 3B',         size: '1.9 Go', tags: ['light', 'general'], desc: 'Généraliste compact.' },
  { name: 'gemma3:4b',           label: 'Gemma 3 4B',          size: '3.3 Go', tags: ['light', 'vision'], desc: 'Léger et multimodal.' },
  { name: 'phi3.5',              label: 'Phi 3.5 Mini',        size: '2.2 Go', tags: ['light'], desc: 'Microsoft, petit et efficace.' },

  // --- Code ---
  { name: 'qwen2.5-coder:3b',    label: 'Qwen2.5 Coder 3B',    size: '1.9 Go', tags: ['light', 'code'], desc: 'Modèle de code compact.' },
  { name: 'starcoder2:3b',       label: 'StarCoder2 3B',       size: '1.7 Go', tags: ['light', 'code'], desc: 'Complétion de code légère.' },
  { name: 'qwen2.5-coder:7b',    label: 'Qwen2.5 Coder 7B',    size: '4.7 Go', tags: ['code'], desc: 'Excellent pour coder, équilibré.' },
  { name: 'codellama:7b',        label: 'Code Llama 7B',       size: '3.8 Go', tags: ['code'], desc: 'Modèle de code de Meta.' },
  { name: 'codegemma:7b',        label: 'CodeGemma 7B',        size: '5.0 Go', tags: ['code'], desc: 'Google, spécialisé code.' },
  { name: 'starcoder2:7b',       label: 'StarCoder2 7B',       size: '4.0 Go', tags: ['code'], desc: 'Complétion de code.' },
  { name: 'qwen2.5-coder:14b',   label: 'Qwen2.5 Coder 14B',   size: '9.0 Go', tags: ['code'], desc: 'Plus puissant (GPU conseillé).' },
  { name: 'codellama:13b',       label: 'Code Llama 13B',      size: '7.4 Go', tags: ['code'], desc: 'Code Llama plus large.' },
  { name: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', size: '8.9 Go', tags: ['code'], desc: 'Très bon en code.' },
  { name: 'qwen2.5-coder:32b',   label: 'Qwen2.5 Coder 32B',   size: '20 Go',  tags: ['code', 'heavy'], desc: 'Top code, GPU costaud requis.' },

  // --- Polyvalents ---
  { name: 'qwen3:8b',            label: 'Qwen 3 8B',           size: '5.2 Go', tags: ['general', 'reasoning'], desc: 'Très bon généraliste avec réflexion.' },
  { name: 'llama3.1:8b',         label: 'Llama 3.1 8B',        size: '4.9 Go', tags: ['general'], desc: 'Généraliste Meta très populaire.' },
  { name: 'qwen2.5:7b',          label: 'Qwen 2.5 7B',         size: '4.7 Go', tags: ['general'], desc: 'Généraliste solide.' },
  { name: 'mistral:7b',          label: 'Mistral 7B',          size: '4.1 Go', tags: ['general'], desc: 'Rapide et solide.' },
  { name: 'mistral-nemo:12b',    label: 'Mistral Nemo 12B',    size: '7.1 Go', tags: ['general'], desc: 'Mistral + NVIDIA, gros contexte.' },
  { name: 'granite3.1-dense:8b', label: 'Granite 3.1 8B',      size: '4.9 Go', tags: ['general', 'code'], desc: 'IBM, bon en code/entreprise.' },
  { name: 'gemma3:12b',          label: 'Gemma 3 12B',         size: '8.1 Go', tags: ['general', 'vision'], desc: 'Gemma 3 puissant, multimodal.' },
  { name: 'qwen3:14b',           label: 'Qwen 3 14B',          size: '9.3 Go', tags: ['general', 'reasoning'], desc: 'Qwen 3 plus puissant.' },
  { name: 'phi4',                label: 'Phi 4 14B',           size: '9.1 Go', tags: ['general', 'reasoning'], desc: 'Microsoft, fort en raisonnement.' },
  { name: 'gemma3:27b',          label: 'Gemma 3 27B',         size: '17 Go',  tags: ['general', 'vision', 'heavy'], desc: 'Gemma 3 large (GPU costaud).' },
  { name: 'mixtral:8x7b',        label: 'Mixtral 8x7B',        size: '26 Go',  tags: ['general', 'heavy'], desc: 'Mixture-of-experts puissant.' },
  { name: 'llama3.3:70b',        label: 'Llama 3.3 70B',       size: '43 Go',  tags: ['general', 'heavy'], desc: 'Très puissant, GPU haut de gamme.' },

  // --- Raisonnement ---
  { name: 'deepseek-r1:7b',      label: 'DeepSeek R1 7B',      size: '4.7 Go', tags: ['reasoning'], desc: 'Raisonnement visible (<think>).' },
  { name: 'deepseek-r1:8b',      label: 'DeepSeek R1 8B',      size: '5.2 Go', tags: ['reasoning'], desc: 'Raisonnement, équilibré.' },
  { name: 'deepseek-r1:14b',     label: 'DeepSeek R1 14B',     size: '9.0 Go', tags: ['reasoning'], desc: 'Raisonnement plus poussé.' },
  { name: 'qwq:32b',             label: 'QwQ 32B',             size: '20 Go',  tags: ['reasoning', 'heavy'], desc: 'Raisonnement avancé (GPU costaud).' },

  // --- Vision ---
  { name: 'llava:7b',            label: 'LLaVA 7B',            size: '4.7 Go', tags: ['vision'], desc: 'Analyse d’images.' },
  { name: 'llava:13b',           label: 'LLaVA 13B',           size: '8.0 Go', tags: ['vision'], desc: 'Vision plus précise.' },
  { name: 'llama3.2-vision:11b', label: 'Llama 3.2 Vision 11B',size: '7.9 Go', tags: ['vision'], desc: 'Vision de Meta.' },
  { name: 'minicpm-v',           label: 'MiniCPM-V 8B',        size: '5.5 Go', tags: ['vision'], desc: 'Bonne vision compacte.' },

  // --- Embeddings (recherche / RAG) ---
  { name: 'nomic-embed-text',    label: 'Nomic Embed Text',    size: '0.3 Go', tags: ['embed', 'light'], desc: 'Embeddings de texte (RAG).' },
  { name: 'mxbai-embed-large',   label: 'MxBai Embed Large',   size: '0.7 Go', tags: ['embed'], desc: 'Embeddings de qualité.' }
];
