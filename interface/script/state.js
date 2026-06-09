//  STATE
// ==========================================================
const state = {
    agentMode: false,
    permissionMode: 'supervised', // supervised | semi | auto
    projectRoot: null,
    openFiles: {}, // { [filePath]: { name, content, unsaved } }
    activeFile: null, // filePath or null
    reasoningLevel: 0, // 0 = MIN, 1 = MED, 2 = MAX
    config: {
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'qwen3:8b',
        ollamaModels: ['qwen3:8b', 'llama3.2', 'gemma3:4b', 'deepseek-r1:8b', 'qwen2.5-coder:7b'],
        keys: { openai: '', anthropic: '', google: '', grok: '', mistral: '' }
    },
    profile: { pseudo: 'Utilisateur', photo: '' },
    conversations: [],        // single-chat history
    currentConvId: null,
    chatHistory: [],          // API memory for the current chat [{role, content}]
    contextTokens: 0,         // estimated tokens currently in context
    agentConversations: [],   // agents-mode history (separate)
    currentAgentConvId: null,
    attachments: [], // [{ name, ext, isImage, url?, content? }]
    language: 'fr' // 'fr' | 'en'
};

// Sub-model options per provider (current official API models)
const SUBMODELS = {
    codex:  ['gpt-5.1', 'gpt-5.1-codex', 'gpt-5', 'o4-mini', 'o3', 'o3-mini', 'o1', 'gpt-4.5', 'gpt-4o', 'gpt-4o-mini'],
    claude: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-4.8-opus', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'],
    gemini: ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-pro', 'gemini-2.0-flash'],
    grok:   ['grok-4.3', 'grok-4.20-multi-agent-0309', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1', 'grok-4', 'grok-3', 'grok-3-mini', 'grok-3-fast'],
    mistral:['mistral-large-latest', 'mistral-medium-latest', 'magistral-medium-latest', 'codestral-latest', 'pixtral-large-latest'],
    local:  ['qwen3:8b', 'llama3.2', 'gemma3:4b', 'deepseek-r1:8b', 'qwen2.5-coder:7b']
};

// Context window (tokens) per model — sized for coding use. Some models reach 1M.
const CONTEXT_WINDOWS = {
    codex:  { _default: 272000, 'gpt-4o': 128000, 'gpt-4.5': 128000, 'o1': 200000, 'o3': 200000, 'o4-mini': 200000, 'gpt-5': 400000 },
    claude: { _default: 200000, 'sonnet-4': 1000000, 'sonnet-4-6': 1000000, '3-7-sonnet': 200000, '3-5-sonnet': 200000 },
    gemini: { _default: 1000000 },
    grok:   { _default: 256000 },
    mistral:{ _default: 128000 },
    local:  { _default: 32000 }
};
function contextWindow(model, submodel) {
    const m = CONTEXT_WINDOWS[model] || {};
    const s = (submodel || '').toLowerCase();
    for (const k of Object.keys(m)) { if (k !== '_default' && s.includes(k)) return m[k]; }
    return m._default || 128000;
}
function estimateTokens(text) { return Math.ceil(((text || '') + '').length / 4); }
function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n); }
function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Translations Dictionary
const TRANSLATIONS = {
    fr: {
        'agent-mode-label': 'Mode Agents',
        'settings-title': 'Configuration',
        'no-project': 'Aucun projet',
        'open-folder': 'Ouvrir un dossier',
        'recent-projects': 'Projets recents',
        'no-recent-projects': 'Aucun projet recent',
        'files-header': 'FICHIERS',
        'profile-header': 'Profil',
        'username': 'Pseudo',
        'photo-url': 'Photo (URL)',
        'save-profile-btn': 'Sauvegarder',
        'welcome-sub': 'Ouvrez un projet pour commencer',
        'welcome-tab': 'Bienvenue',
        'incompatible-tooltip': 'Modele incompatible',
        'clear-title': 'Effacer',
        'tab-chat': 'Chat',
        'tab-agents': 'Agents',
        'chat-default-msg': 'Selectionnez un modele et posez votre question.',
        'perm-label': 'Mode :',
        'perm-supervised': 'Supervise',
        'perm-supervised-title': 'Chaque modification demande votre accord',
        'perm-semi': 'Semi-auto',
        'perm-semi-title': 'Code auto, commandes validees',
        'perm-auto': 'Autonome',
        'perm-auto-title': 'Controle total, aucune validation',
        'chat-input-placeholder': 'Ecrivez votre message...',
        'history-header': 'Historique',
        'history-empty': 'Aucune conversation',
        'new-chat-btn': 'Nouveau',
        'attach-image': 'Image',
        'attach-file': 'Fichier',
        'agents-desc': 'Configurez et lancez vos agents IA. Minimum 2 actifs pour le mode collaboratif.',
        'agents-log-default': 'Activez le Mode Agents et envoyez une tache.',
        'agents-input-placeholder': 'Donnez une tache aux agents...',
        'settings-header': 'Configuration',
        'api-keys-section': 'Cles API',
        'api-keys-hint': 'Chaque modele cloud necessite sa propre cle API. Ollama fonctionne sans cle.',
        'ollama-url-label': 'URL du serveur',
        'ollama-model-label': 'Modele',
        'cancel-btn': 'Annuler',
        'save-btn': 'Enregistrer',
        'open-project-header': 'Ouvrir un projet',
        'open-project-hint': 'Entrez le chemin absolu vers le dossier de votre projet.',
        'folder-path-label': 'Chemin du dossier',
        'cancel-project-btn': 'Annuler',
        'confirm-project-btn': 'Ouvrir',
        'approval-header': 'Validation requise',
        'approval-hint': "L'IA souhaite effectuer l'action suivante :",
        'deny-btn': 'Refuser',
        'approve-btn': 'Autoriser',
        
        // Roles
        'role-developer': 'Developpeur',
        'role-lead': 'Chef de projet',
        'role-architect': 'Architecte',
        'role-reviewer': 'Reviewer',
        'role-optimizer': 'Optimiseur',
        'role-tester': 'Testeur',
        
        // Statuses
        'status-idle': 'Inactif',
        'status-working': 'En cours',
        'status-done': 'Termine',

        // Editor state
        'unsaved-indicator': '(non enregistre)',
        'saved-indicator': 'Enregistre',
        'error-indicator': 'Erreur',

        // Miscellaneous
        'no-project-selected': 'Aucun projet selectionne.',
        'min-agents-required': 'Minimum 2 agents requis. Cochez au moins 2 agents.',
        'mode-agents-active': 'Mode Agents active.',
        'mode-agents-inactive': 'Mode Agents desactive.',
        'active-agents': 'agents prets.',
        'terminal-cleared': 'Terminal efface.',
        'history-cleared': 'Historique efface.',
        'team-thinking-title': "Reflexion de l'equipe",
        'lead-thinking-done': "terminee",
        'lead-thinking-progress': "termines",
        'lead-thinking-synthesis': "Le Chef de projet prepare la synthese...",
        'modification-refused': "Modification refusee.",
        'file-modified': "modifie.",
        'err-conn': "Erreur de connexion au serveur.",
        'err-conn-lead': "Erreur de connexion.",
        'recent-project-empty': "Aucun projet recent",
        'default-username': 'Utilisateur'
    },
    en: {
        'agent-mode-label': 'Agent Mode',
        'settings-title': 'Settings',
        'no-project': 'No Project',
        'open-folder': 'Open Folder',
        'recent-projects': 'Recent Projects',
        'no-recent-projects': 'No recent projects',
        'files-header': 'FILES',
        'profile-header': 'Profile',
        'username': 'Username',
        'photo-url': 'Photo (URL)',
        'save-profile-btn': 'Save',
        'welcome-sub': 'Open a project to begin',
        'welcome-tab': 'Welcome',
        'incompatible-tooltip': 'Incompatible model',
        'clear-title': 'Clear',
        'tab-chat': 'Chat',
        'tab-agents': 'Agents',
        'chat-default-msg': 'Select a model and ask your question.',
        'perm-label': 'Mode:',
        'perm-supervised': 'Supervised',
        'perm-supervised-title': 'Every modification requires your approval',
        'perm-semi': 'Semi-auto',
        'perm-semi-title': 'Auto code, approved commands',
        'perm-auto': 'Autonomous',
        'perm-auto-title': 'Full control, no approval',
        'chat-input-placeholder': 'Type a message...',
        'history-header': 'History',
        'history-empty': 'No conversation',
        'new-chat-btn': 'New',
        'attach-image': 'Image',
        'attach-file': 'File',
        'agents-desc': 'Configure and launch your AI agents. Minimum 2 active for collaborative mode.',
        'agents-log-default': 'Activate Agent Mode and send a task.',
        'agents-input-placeholder': 'Give a task to the agents...',
        'settings-header': 'Settings',
        'api-keys-section': 'API Keys',
        'api-keys-hint': 'Each cloud model requires its own API key. Ollama works without key.',
        'ollama-url-label': 'Server URL',
        'ollama-model-label': 'Model',
        'cancel-btn': 'Cancel',
        'save-btn': 'Save',
        'open-project-header': 'Open a Project',
        'open-project-hint': 'Enter the absolute path to your project folder.',
        'folder-path-label': 'Folder Path',
        'cancel-project-btn': 'Cancel',
        'confirm-project-btn': 'Open',
        'approval-header': 'Approval Required',
        'approval-hint': 'The AI wants to perform the following action:',
        'deny-btn': 'Deny',
        'approve-btn': 'Approve',
        
        // Roles
        'role-developer': 'Developer',
        'role-lead': 'Project Lead',
        'role-architect': 'Architect',
        'role-reviewer': 'Reviewer',
        'role-optimizer': 'Optimizer',
        'role-tester': 'Tester',
        
        // Statuses
        'status-idle': 'Inactive',
        'status-working': 'Running',
        'status-done': 'Done',

        // Editor state
        'unsaved-indicator': '(unsaved)',
        'saved-indicator': 'Saved',
        'error-indicator': 'Error',

        // Miscellaneous
        'no-project-selected': 'No project selected.',
        'min-agents-required': 'Minimum 2 agents required. Check at least 2 agents.',
        'mode-agents-active': 'Agent Mode active.',
        'mode-agents-inactive': 'Agent Mode inactive.',
        'active-agents': 'agents ready.',
        'terminal-cleared': 'Terminal cleared.',
        'history-cleared': 'History cleared.',
        'team-thinking-title': 'Team thinking',
        'lead-thinking-done': 'done',
        'lead-thinking-progress': 'completed',
        'lead-thinking-synthesis': 'The Project Lead is preparing the synthesis...',
        'modification-refused': 'Modification denied.',
        'file-modified': 'modified.',
        'err-conn': 'Error connecting to server.',
        'err-conn-lead': 'Connection error.',
        'recent-project-empty': 'No recent projects',
        'default-username': 'User'
    }
};

function updateLanguage() {
    const lang = state.language || 'fr';
    
    // Translate text elements
    $$('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) {
            el.textContent = TRANSLATIONS[lang][key];
        }
    });

    // Translate placeholders
    $$('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        if (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) {
            el.placeholder = TRANSLATIONS[lang][key];
        }
    });

    // Translate titles
    $$('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        if (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) {
            el.title = TRANSLATIONS[lang][key];
        }
    });

    // Translate agent roles dropdown options
    $$('.agent-role-select option').forEach(opt => {
        const key = 'role-' + opt.value;
        if (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) {
            opt.textContent = TRANSLATIONS[lang][key];
        }
    });

    // Update default project name if no project open
    if (!state.projectRoot) {
        const nameEl = $('#project-name');
        if (nameEl) nameEl.textContent = TRANSLATIONS[lang]['no-project'];
    }

    // Update default profile name if default Utilisateur/User pseudo
    const pseudoInput = $('#profile-pseudo');
    if (pseudoInput && (pseudoInput.value === 'Utilisateur' || pseudoInput.value === 'User')) {
        pseudoInput.value = TRANSLATIONS[lang]['default-username'];
        state.profile.pseudo = TRANSLATIONS[lang]['default-username'];
        updateProfileUI();
    }
}

function initAgentModelDropdowns() {
    $$('.agent-model-select').forEach(sel => {
        const agent = sel.dataset.agent;
        const subs = agent === 'local'
            ? (state.config.ollamaModels && state.config.ollamaModels.length ? state.config.ollamaModels : SUBMODELS.local)
            : (SUBMODELS[agent] || []);
        sel.innerHTML = '';
        subs.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            sel.appendChild(opt);
        });
    });
}

// System prompts per role for agent mode
const ROLE_PROMPTS = {
  lead: `
Tu es le Chef de Projet.
Ton rôle est de coordonner les agents, trancher les décisions et produire la synthèse finale.
Tu ne réécris pas tout le travail des agents.
Tu identifies les conflits, choisis la meilleure solution, refuses les changements risqués et proposes un plan clair.
Format obligatoire:
- Décision finale
- Actions à faire
- Risques
- Fichiers concernés
- Validation recommandée
`,

  developer: `
Tu es le Développeur principal.
Ton rôle est de proposer une implémentation concrète, minimale et maintenable.
Ne modifie jamais l'auth, les secrets, les sessions, les clés, le consensus blockchain ou les fichiers .env sans demande explicite.
Format obligatoire:
- Solution proposée
- Fichiers à modifier
- Patch ou pseudo-patch
- Risques techniques
- Tests à lancer
`,

  architect: `
Tu es l'Architecte.
Ton rôle est d'analyser la structure, les dépendances, la scalabilité et la maintenabilité.
Tu ne proposes pas de refactor massif sauf nécessité claire.
Format obligatoire:
- Diagnostic architecture
- Problèmes structurels
- Solution recommandée
- Impact sur le projet
- Priorité
`,

  reviewer: `
Tu es le Reviewer.
Ton rôle est de chercher les bugs, failles de sécurité, régressions et incohérences.
Ne valide jamais une modification sans preuve logique.
Format obligatoire:
- Bugs confirmés
- Risques possibles
- Fichiers concernés
- Corrections recommandées
- Niveau de gravité
`,

  optimizer: `
Tu es l'Optimiseur.
Ton rôle est d'améliorer performance, rendu, chargement, mémoire et requêtes inutiles.
Tu dois privilégier les optimisations mesurables et éviter les changements risqués.
Format obligatoire:
- Goulots d'étranglement
- Optimisations proposées
- Impact attendu
- Risques
- Tests de performance à faire
`,

  tester: `
Tu es le Testeur.
Ton rôle est d'identifier les cas limites, scénarios de test, régressions possibles et validations nécessaires.
Format obligatoire:
- Cas de test critiques
- Cas limites
- Tests automatisables
- Tests manuels
- Critères de validation
`
};

const AGENT_COLLABORATION_PROMPT = `Tu fais partie d'une equipe multi-IA. Les autres agents ont peut-etre deja contribue (voir contexte). Reponds de maniere concise et technique. Si tu vois le travail d'un autre agent, construis dessus au lieu de tout refaire. Signale clairement si quelque chose doit etre corrige.`;

// Status phrases cycled under the spinner while a model is thinking.
const THINKING_PHRASES = {
    fr: ['En cours de reflexion...', 'Analyse de la demande...', 'Preparation de la reponse...', 'Finalisation de la reponse...'],
    en: ['Thinking...', 'Analyzing the request...', 'Preparing the answer...', 'Finalizing the response...']
};

// Turn an element into a "thinking" indicator (spinner + cycling text).
function startThinking(el) {
    if (!el) return;
    el.classList.add('thinking');
    el.classList.remove('typing');
    el.innerHTML = '<span class="thinking-spinner"></span><span class="thinking-text"></span>';
    const lang = state.language || 'fr';
    const phrases = THINKING_PHRASES[lang] || THINKING_PHRASES.fr;
    const textEl = el.querySelector('.thinking-text');
    let i = 0;
    textEl.textContent = phrases[0];
    el._thinkingInterval = setInterval(() => {
        i = (i + 1) % phrases.length;
        textEl.textContent = phrases[i];
    }, 1800);
}

// Stop the thinking indicator (the wheel disappears once the AI writes).
function stopThinking(el) {
    if (!el) return;
    if (el._thinkingInterval) { clearInterval(el._thinkingInterval); el._thinkingInterval = null; }
    el.classList.remove('thinking');
    el.innerHTML = '';
}

// Animated dot grid: a white wave travels diagonally from one corner to the other.
function startWave(canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const DPR = window.devicePixelRatio || 1;
    const GAP = 13;
    const t0 = performance.now();
    let lastW = 0, lastH = 0;
    function frame(now) {
        const w = canvas.clientWidth || 300, h = canvas.clientHeight || 72;
        // Keep the drawing buffer in sync with the box (it grows as agents are added).
        if (w !== lastW || h !== lastH) {
            canvas.width = w * DPR; canvas.height = h * DPR;
            ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
            lastW = w; lastH = h;
        }
        ctx.clearRect(0, 0, w, h);
        const cols = Math.ceil(w / GAP), rows = Math.ceil(h / GAP);
        const t = (now - t0) / 1000;
        const waveWidth = 3.2;
        const maxDiag = cols + rows;
        const front = ((t * 9) % (maxDiag + waveWidth * 2)) - waveWidth; // travels TL -> BR
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                const dist = Math.abs((i + j) - front);
                const k = Math.max(0, 1 - dist / waveWidth);
                const alpha = 0.10 + k * 0.85;
                ctx.beginPath();
                ctx.arc(i * GAP + GAP / 2, j * GAP + GAP / 2, 1.4 + k * 1.6, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255,255,255,${alpha})`;
                ctx.fill();
            }
        }
        canvas._raf = requestAnimationFrame(frame);
    }
    canvas._raf = requestAnimationFrame(frame);
}
function stopWave(canvas) {
    if (canvas && canvas._raf) { cancelAnimationFrame(canvas._raf); canvas._raf = null; }
}

// Instructions given to every model so it can actually write files to disk,
// like a real CLI/IDE agent. The client parses any code fence whose info
// line carries a `path=` and writes the full content via /api/file.
function codeAgentPrompt() {
    const lang = state.language || 'fr';
    if (lang === 'en') {
        return `You are a coding agent embedded in an IDE with full read/write access to the user's project folder. To create or modify a file on disk, output its COMPLETE final content inside a fenced code block whose info line includes the file path in this EXACT format:

\`\`\`js path=src/app.js
<full file content here>
\`\`\`

Rules:
- ALWAYS put path=<relative/path> on the opening code fence for every file you want saved.
- Output the ENTIRE file content, never a diff or a partial snippet.
- You may emit several file blocks to create/modify multiple files at once.
- Use forward slashes, paths are relative to the project root.
- Only use this format for files you actually want written; normal explanation text stays outside code blocks.

To RUN a terminal command in the project folder, output a fenced block whose info line contains the word "run" (one command per line):

\`\`\`run
npm install
\`\`\`

- Use "run" blocks ONLY for commands you actually want executed.
- The machine runs WINDOWS (shell: cmd.exe). Use Windows commands (dir, type, cd), NOT Unix ones (ls, cat). The project file tree is already provided in the context, so you do not need to list files.
- The project files are only background context. ALWAYS answer the user's actual question first. If they ask who you are, which model/version you are, or anything unrelated to the project, answer that directly and honestly (if you don't know your exact version, just say so) — do not describe the project instead.
- NEVER repeat, echo, paste or list the project context / file tree in your answer. Use it silently as background knowledge only.`;
    }
    return `Tu es un agent de code integre dans un IDE avec un acces complet en lecture/ecriture au dossier du projet de l'utilisateur. Pour creer ou modifier un fichier sur le disque, ecris son contenu COMPLET final dans un bloc de code dont la ligne d'info contient le chemin du fichier avec ce format EXACT :

\`\`\`js path=src/app.js
<contenu complet du fichier ici>
\`\`\`

Regles :
- Mets TOUJOURS path=<chemin/relatif> sur la ligne d'ouverture du bloc de code pour chaque fichier a enregistrer.
- Donne le contenu ENTIER du fichier, jamais un diff ni un extrait partiel.
- Tu peux produire plusieurs blocs de fichiers pour creer/modifier plusieurs fichiers a la fois.
- Utilise des slash avant (/), les chemins sont relatifs a la racine du projet.
- N'utilise ce format que pour les fichiers que tu veux reellement ecrire ; le texte d'explication normal reste hors des blocs de code.

Pour EXECUTER une commande dans le dossier du projet, ecris un bloc de code dont la ligne d'info contient le mot "run" (une commande par ligne) :

\`\`\`run
npm install
\`\`\`

- N'utilise les blocs "run" que pour les commandes que tu veux reellement executer.
- La machine est sous WINDOWS (shell : cmd.exe). Utilise des commandes Windows (dir, type, cd), PAS Unix (ls, cat). L'arborescence du projet est deja fournie dans le contexte, tu n'as pas besoin de lister les fichiers.
- Les fichiers du projet ne sont qu'un contexte d'arriere-plan. Reponds TOUJOURS d'abord a la vraie question de l'utilisateur. S'il demande qui tu es, quel modele/version tu es, ou autre chose sans rapport avec le projet, reponds-y directement et honnetement (si tu ne connais pas ta version exacte, dis-le simplement) — ne decris pas le projet a la place.
- Ne repete JAMAIS, ne recopie pas, ne liste pas le contexte du projet / l'arborescence dans ta reponse. Utilise-le silencieusement comme simple connaissance d'arriere-plan.`;
}

// Parse an AI response into a list of shell commands to run (```run blocks).
function extractRunBlocks(response) {
    const cmds = [];
    const re = /```([^\n]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(response)) !== null) {
        const info = (m[1] || '').trim().toLowerCase();
        if (/(^|\s)run(\s|$)/.test(info)) {
            m[2].split('\n').map(l => l.trim())
                .filter(l => l && !l.startsWith('#'))
                .forEach(c => cmds.push(c));
        }
    }
    return cmds;
}

// Parse an AI response into a list of { path, content } file operations.
function extractFileBlocks(response) {
    const blocks = [];
    const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
    let m;
    let lastIndex = 0;
    while ((m = fenceRe.exec(response)) !== null) {
        const info = (m[1] || '').trim();
        let content = m[2].replace(/\n$/, '');
        let filePath = null;

        // 1) explicit path= / file= / filename= on the info line
        const pm = info.match(/(?:path|file|filename)\s*[:=]\s*["'`]?([^\s"'`]+)["'`]?/i);
        if (pm) filePath = pm[1];

        // 2) a token on the info line that looks like a path ("js src/app.js", "src/app.js")
        if (!filePath && info) {
            for (const tok of info.split(/[\s:]+/).filter(Boolean)) {
                if (/[\/\\]/.test(tok) || /\.[A-Za-z0-9]+$/.test(tok)) { filePath = tok; break; }
            }
        }

        // 3) the line just before the fence (e.g. **src/app.js** or `src/app.js`)
        if (!filePath) {
            const before = response.slice(lastIndex, m.index).split('\n').map(s => s.trim()).filter(Boolean);
            const prev = before[before.length - 1] || '';
            const fm = prev.length < 120 && prev.match(/([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)/);
            if (fm) filePath = fm[1];
        }

        // 4) a leading comment inside the block: // path: x  /  # file: x
        if (!filePath) {
            const first = content.split('\n')[0].trim();
            const cm = first.match(/^(?:\/\/|#|<!--)\s*(?:file|path|filename)\s*[:=]\s*([^\s>]+)/i);
            if (cm) { filePath = cm[1]; content = content.split('\n').slice(1).join('\n'); }
        }

        if (filePath) {
            filePath = filePath.replace(/^["'`]+|["'`]+$/g, '').replace(/^\.?\//, '');
            blocks.push({ path: filePath, content });
        }
        lastIndex = fenceRe.lastIndex;
    }
    return blocks;
}

// ==========================================================
//  HELPERS
// ==========================================================
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function loadState() {
    try {
        const saved = localStorage.getItem('zaalis-state');
        if (saved) {
            const s = JSON.parse(saved);
            if (s.config) Object.assign(state.config, s.config);
            if (s.profile) Object.assign(state.profile, s.profile);
            if (s.projectRoot) state.projectRoot = s.projectRoot;
            // Conversations are stored server-side per account (see /api/chats),
            // not in localStorage, to avoid leaking chats between accounts.
            if (s.language) state.language = s.language;
        }
    } catch {}
}

function saveState() {
    localStorage.setItem('zaalis-state', JSON.stringify({
        config: state.config,
        profile: state.profile,
        projectRoot: state.projectRoot,
        language: state.language
    }));
}

function getRecentProjects() {
    try {
        return JSON.parse(localStorage.getItem('zaalis-recent') || '[]');
    } catch { return []; }
}

function addRecentProject(path) {
    let recent = getRecentProjects().filter(p => p !== path);
    recent.unshift(path);
    if (recent.length > 8) recent = recent.slice(0, 8);
    localStorage.setItem('zaalis-recent', JSON.stringify(recent));
}

// ==========================================================