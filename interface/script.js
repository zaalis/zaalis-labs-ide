document.addEventListener('DOMContentLoaded', () => {

    // ==========================================================
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
    //  DOM REFS (must be before INIT)
    // ==========================================================
    const modelSelect = $('#ai-model');
    const submodelSelect = $('#ai-submodel');

    // Solid colour for the closed model selector (gradients can't render there).
    const MODEL_COLORS = { codex: '#3b82f6', claude: '#f97316', gemini: '#7c6cf0', grok: '#9ca3af', mistral: '#f59e0b', local: '#fafafa' };
    function applyModelColor() {
        modelSelect.style.color = MODEL_COLORS[modelSelect.value] || 'var(--text-0)';
    }

    // Pretty short name for the dropdown (full tag stays in the option's value).
    // ex: "hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M" -> "Qwen2.5-Coder-7B (Q4_K_M)"
    function prettyModelLabel(full) {
        if (!full) return '';
        let s = String(full);
        // Strip the hf.co/ prefix and the owner part.
        s = s.replace(/^hf\.co\//i, '');
        const colon = s.lastIndexOf(':');
        let quant = '';
        if (colon > -1) {
            const tag = s.slice(colon + 1);
            if (/^(Q\d|IQ\d|BF16|F16|F32)/i.test(tag)) { quant = tag; s = s.slice(0, colon); }
        }
        // Drop the owner ("Qwen/..." -> "..."), then strip noisy suffixes.
        if (s.includes('/')) s = s.split('/').slice(1).join('/');
        s = s.replace(/-?GGUF$/i, '').replace(/-?Instruct$/i, '');
        return quant ? `${s} (${quant})` : s;
    }
    function updateSubmodelDropdown() {
        const model = modelSelect.value;
        // For Ollama, use the user's managed model list (Settings).
        const subs = model === 'local'
            ? (state.config.ollamaModels && state.config.ollamaModels.length ? state.config.ollamaModels : SUBMODELS.local)
            : (SUBMODELS[model] || []);
        submodelSelect.innerHTML = '';
        subs.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = model === 'local' && /^hf\.co\//i.test(s) ? prettyModelLabel(s) : s;
            opt.title = s;
            submodelSelect.appendChild(opt);
        });
    }

    modelSelect.addEventListener('change', () => {
        updateSubmodelDropdown();
        checkReasoningCompatibility();
        updateAttachAvailability();
        applyModelColor();
        updateTokenMeter();
    });
    submodelSelect.addEventListener('change', () => {
        checkReasoningCompatibility();
        updateAttachAvailability();
        updateTokenMeter();
    });

    // In agents mode the reasoning slider tracks the lead agent, so re-check it
    // whenever the selection, roles, or sub-models of agents change.
    $$('.agent-check, .agent-role-select, .agent-model-select').forEach(el => {
        el.addEventListener('change', () => {
            checkReasoningCompatibility();
            updateAttachAvailability();
        });
    });

    // ==========================================================
    //  SETTINGS MODAL
    // ==========================================================
    $('#settings-btn').addEventListener('click', () => $('#settings-modal').classList.add('active'));
    $('#close-modal').addEventListener('click', () => $('#settings-modal').classList.remove('active'));
    $('#cancel-btn').addEventListener('click', () => $('#settings-modal').classList.remove('active'));
    $('#settings-modal').addEventListener('click', e => { if (e.target.id === 'settings-modal') $('#settings-modal').classList.remove('active'); });

    $('#save-btn').addEventListener('click', () => {
        state.config.keys.openai = $('#key-openai').value.trim();
        state.config.keys.anthropic = $('#key-anthropic').value.trim();
        state.config.keys.google = $('#key-google').value.trim();
        state.config.keys.grok = $('#key-grok').value.trim();
        state.config.keys.mistral = $('#key-mistral').value.trim();
        state.config.ollamaUrl = $('#ollama-url').value.trim();
        // Default Ollama model = first of the managed list.
        state.config.ollamaModel = (state.config.ollamaModels && state.config.ollamaModels[0]) || 'qwen3:8b';
        saveState();
        const btn = $('#save-btn');
        btn.textContent = 'OK';
        setTimeout(() => { btn.textContent = 'Enregistrer'; $('#settings-modal').classList.remove('active'); }, 500);
    });

    // ----- Ollama models manager (Settings) -----
    function renderOllamaModels() {
        const box = $('#ollama-models-list');
        if (!box) return;
        const list = state.config.ollamaModels || [];
        box.innerHTML = '';
        if (!list.length) {
            box.innerHTML = `<span class="ollama-empty">${state.language === 'en' ? 'No model added yet.' : 'Aucun modèle ajouté.'}</span>`;
            return;
        }
        list.forEach(name => {
            const chip = document.createElement('div');
            chip.className = 'ollama-chip';
            const span = document.createElement('span');
            span.textContent = name;
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.title = state.language === 'en' ? 'Remove' : 'Retirer';
            rm.addEventListener('click', () => removeOllamaModel(name));
            chip.appendChild(span);
            chip.appendChild(rm);
            box.appendChild(chip);
        });
    }
    function addOllamaModel(name) {
        name = (name || '').trim();
        if (!name) return;
        if (!state.config.ollamaModels) state.config.ollamaModels = [];
        if (state.config.ollamaModels.includes(name)) return;
        state.config.ollamaModels.push(name);
        saveState();
        renderOllamaModels();
        if (modelSelect.value === 'local') updateSubmodelDropdown();
        refreshOllamaAgentSelect();
    }
    function removeOllamaModel(name) {
        state.config.ollamaModels = (state.config.ollamaModels || []).filter(m => m !== name);
        saveState();
        renderOllamaModels();
        if (modelSelect.value === 'local') updateSubmodelDropdown();
        refreshOllamaAgentSelect();
    }
    // Keep the Ollama agent's model dropdown in sync with the managed list.
    function refreshOllamaAgentSelect() {
        const sel = $('.agent-model-select[data-agent="local"]');
        if (!sel) return;
        const prev = sel.value;
        const list = (state.config.ollamaModels && state.config.ollamaModels.length) ? state.config.ollamaModels : SUBMODELS.local;
        sel.innerHTML = '';
        list.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = /^hf\.co\//i.test(s) ? prettyModelLabel(s) : s; o.title = s; sel.appendChild(o); });
        if (list.includes(prev)) sel.value = prev;
    }
    const olAdd = $('#ollama-model-add'), olInput = $('#ollama-model-input');
    if (olAdd) olAdd.addEventListener('click', () => { addOllamaModel(olInput.value); olInput.value = ''; olInput.focus(); });
    if (olInput) olInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addOllamaModel(olInput.value); olInput.value = ''; } });
    const olDetect = $('#ollama-detect');
    if (olDetect) olDetect.addEventListener('click', async () => {
        const lang = state.language || 'fr';
        const original = olDetect.innerHTML;
        olDetect.textContent = lang === 'en' ? 'Detecting…' : 'Détection…';
        try {
            const url = encodeURIComponent($('#ollama-url').value.trim() || 'http://localhost:11434');
            const res = await fetch('/api/ollama-models?url=' + url);
            const data = await res.json();
            const found = (data.models || []);
            if (found.length) { found.forEach(addOllamaModel); olDetect.textContent = (lang === 'en' ? 'Found ' : 'Trouvés : ') + found.length; }
            else olDetect.textContent = lang === 'en' ? 'No model found' : 'Aucun modèle trouvé';
        } catch {
            olDetect.textContent = lang === 'en' ? 'Ollama unreachable' : 'Ollama injoignable';
        }
        setTimeout(() => { olDetect.innerHTML = original; }, 2200);
    });

    // ----- Ollama model catalog (install / uninstall + Hugging Face search) -----
    let _installedModels = new Set();           // normalized names actually present in Ollama
    const normName = n => (n && n.includes(':')) ? n : (n + ':latest');
    function isInstalled(name) {
        if (_installedModels.has(normName(name))) return true;
        // HF models: match by prefix (quant suffix may differ).
        for (const m of _installedModels) { if (m.startsWith(name + ':') || m === name) return true; }
        return false;
    }
    async function refreshInstalled() {
        try {
            const url = encodeURIComponent(state.config.ollamaUrl || 'http://localhost:11434');
            const res = await fetch('/api/ollama-models?url=' + url);
            const data = await res.json();
            _installedModels = new Set((data.models || []).map(normName));
        } catch { _installedModels = new Set((state.config.ollamaModels || []).map(normName)); }
    }

    // Build the action button(s) inside a catalog card based on install state.
    function setCardActions(card, name) {
        const lang = state.language || 'fr';
        const actions = card.querySelector('.cat-actions');
        actions.innerHTML = '';
        if (isInstalled(name)) {
            const un = document.createElement('button');
            un.className = 'cat-uninstall'; un.type = 'button';
            un.textContent = lang === 'en' ? 'Uninstall' : 'Désinstaller';
            un.addEventListener('click', () => uninstallModel(name, card));
            actions.appendChild(un);
        } else {
            const ins = document.createElement('button');
            ins.className = 'cat-install'; ins.type = 'button';
            ins.textContent = lang === 'en' ? 'Install' : 'Installer';
            // HF models -> let the user pick a quantization first (like LM Studio).
            ins.addEventListener('click', () => card.dataset.hf === '1' ? expandQuants(card) : installModel(name, card));
            actions.appendChild(ins);
        }
    }

    function buildCard(name, label, size, tags, desc, extra, isHf) {
        const card = document.createElement('div');
        card.className = 'cat-card';
        card.dataset.name = name;
        if (isHf) card.dataset.hf = '1';
        card.innerHTML = `
            <div class="cat-top"><span class="cat-name">${label}</span><span class="cat-size">${size || ''}</span></div>
            ${(tags && tags.length) ? `<div class="cat-tags">${tags.map(t => `<span class="cat-tag ${t}">${t}</span>`).join('')}</div>` : ''}
            <div class="cat-desc">${desc || ''}</div>
            ${extra || ''}
            <div class="cat-actions"></div>
            <div class="cat-progress" style="display:none"><div class="pbar"><div class="pfill"></div></div><div class="ptext"></div></div>`;
        setCardActions(card, name);
        return card;
    }

    // Open a clean modal to pick a quantization (Q4_K_M, Q6_K, Q8_0...).
    async function expandQuants(card) {
        const lang = state.language || 'fr';
        const repo = (card.dataset.name || '').replace(/^hf\.co\//, '');
        const grid = $('#quant-grid');
        $('#quant-title').textContent = (lang === 'en' ? 'Choose a version — ' : 'Choisir une version — ') + repo.split('/').pop();
        grid.innerHTML = `<div class="catalog-empty">${lang === 'en' ? 'Loading options…' : 'Chargement…'}</div>`;
        $('#quant-modal').classList.add('active');
        let quants = [];
        try {
            const res = await fetch('/api/hf-files?id=' + encodeURIComponent(repo));
            const data = await res.json();
            quants = data.quants || [];
        } catch {}
        if (!quants.length) {
            $('#quant-modal').classList.remove('active');
            installModel('hf.co/' + repo, card); // no quant detected -> install repo default
            return;
        }
        grid.innerHTML = '';
        quants.forEach(qd => {
            const go = qd.size >= 1e9 ? (qd.size / 1e9).toFixed(1) + ' Go' : Math.round(qd.size / 1e6) + ' Mo';
            const opt = document.createElement('button');
            opt.className = 'quant-opt'; opt.type = 'button';
            opt.innerHTML = `<span class="quant-q">${qd.quant}</span><span class="quant-size">${go}</span>`;
            opt.addEventListener('click', () => {
                $('#quant-modal').classList.remove('active');
                installModel('hf.co/' + repo + ':' + qd.quant, card);
            });
            grid.appendChild(opt);
        });
    }

    // Detect actually-installed Ollama models and use them as the model list.
    async function syncOllamaModels() {
        try {
            const url = encodeURIComponent(state.config.ollamaUrl || 'http://localhost:11434');
            const res = await fetch('/api/ollama-models?url=' + url);
            if (!res.ok) return;
            const data = await res.json();
            const list = data.models || [];
            if (list.length) {
                state.config.ollamaModels = list;
                saveState();
                if (modelSelect.value === 'local') updateSubmodelDropdown();
                refreshOllamaAgentSelect();
            }
        } catch {}
    }

    // Curated catalog (filtered by the unified search bar).
    function renderCatalog() {
        const grid = $('#catalog-grid');
        if (!grid) return;
        const q = ($('#catalog-search-input') ? $('#catalog-search-input').value.trim().toLowerCase() : '');
        const list = (window.OLLAMA_CATALOG || []).filter(m => {
            if (!q) return true;
            return (m.name + ' ' + m.label + ' ' + (m.desc || '') + ' ' + (m.tags || []).join(' ')).toLowerCase().includes(q);
        });
        grid.innerHTML = '';
        if (!list.length) { grid.innerHTML = `<div class="catalog-empty">${state.language === 'en' ? 'No model.' : 'Aucun modèle.'}</div>`; return; }
        list.forEach(m => grid.appendChild(buildCard(m.name, m.label, m.size, m.tags, m.desc)));
    }

    // --- Hugging Face helpers ---
    async function fetchHf(q, sort, limit) {
        const res = await fetch(`/api/hf-search?q=${encodeURIComponent(q || '')}&sort=${sort}&limit=${limit}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.models || [];
    }
    // Estimate the GGUF (Q4) download size from the parameter count in the name.
    function estimateGgufSize(id) {
        const s = (id || '').toLowerCase();
        let params = 0;
        let m = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b/); // e.g. 8x7b
        if (m) params = parseFloat(m[1]) * parseFloat(m[2]);
        else { m = s.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/); if (m) params = parseFloat(m[1]); }
        if (!params || params > 2000) return '';
        const go = params * 0.62; // ~Q4_K_M
        return '~' + (go >= 10 ? Math.round(go) : go.toFixed(1)) + ' Go';
    }
    function renderHfCards(grid, models) {
        grid.innerHTML = '';
        if (!models.length) { grid.innerHTML = `<div class="catalog-empty">${state.language === 'en' ? 'No model found.' : 'Aucun modèle trouvé.'}</div>`; return; }
        models.forEach(m => {
            const name = 'hf.co/' + m.id;
            const owner = m.id.split('/')[0];
            const repo = m.id.split('/').slice(1).join('/') || m.id;
            const desc = (m.pipeline ? m.pipeline + ' · ' : '') + (state.language === 'en' ? 'by ' : 'par ') + owner;
            const extra = `<div class="cat-dl">⬇ ${(m.downloads || 0).toLocaleString()} · ♥ ${m.likes || 0}</div>`;
            grid.appendChild(buildCard(name, repo, estimateGgufSize(m.id), (m.tags || []).slice(0, 4), desc, extra, true));
        });
    }

    // Default HF view (empty search): trending + most downloaded sections.
    async function showHfDefault() {
        $('#hf-default').classList.remove('hidden');
        $('#hf-grid').classList.add('hidden');
        const pop = $('#hf-popular'), dl = $('#hf-downloads');
        const ld = `<div class="catalog-empty">${state.language === 'en' ? 'Loading…' : 'Chargement…'}</div>`;
        if (!pop.querySelector('.cat-card')) pop.innerHTML = ld;
        if (!dl.querySelector('.cat-card')) dl.innerHTML = ld;
        try {
            const [trending, downloads] = await Promise.all([fetchHf('', 'trendingScore', 12), fetchHf('', 'downloads', 12)]);
            renderHfCards(pop, trending);
            renderHfCards(dl, downloads);
        } catch (e) {
            pop.innerHTML = `<div class="catalog-empty">${(state.language === 'en' ? 'Error: ' : 'Erreur : ') + e.message}</div>`;
            dl.innerHTML = '';
        }
    }

    let _hfSeq = 0;
    async function hfSearch(q) {
        const grid = $('#hf-grid');
        if (!grid) return;
        $('#hf-default').classList.add('hidden');
        grid.classList.remove('hidden');
        const seq = ++_hfSeq;
        if (!grid.querySelector('.cat-card')) {
            grid.innerHTML = `<div class="catalog-empty">${state.language === 'en' ? 'Searching…' : 'Recherche…'}</div>`;
        }
        try {
            const models = await fetchHf(q, 'downloads', 40);
            if (seq !== _hfSeq) return;
            renderHfCards(grid, models);
        } catch (e) {
            if (seq !== _hfSeq) return;
            grid.innerHTML = `<div class="catalog-empty">${(state.language === 'en' ? 'Error: ' : 'Erreur : ') + e.message}</div>`;
        }
    }

    // Apply the unified search bar to whichever tab is active.
    function applyCatalogSearch() {
        const q = $('#catalog-search-input').value.trim();
        const hfActive = !$('#catalog-pane-hf').classList.contains('hidden');
        if (hfActive) { q ? hfSearch(q) : showHfDefault(); }
        else { renderCatalog(); }
    }

    async function installModel(name, card) {
        const lang = state.language || 'fr';
        const actions = card.querySelector('.cat-actions');
        const prog = card.querySelector('.cat-progress');
        const pfill = card.querySelector('.pfill');
        const ptext = card.querySelector('.ptext');
        actions.innerHTML = ''; // hide Install while downloading
        prog.style.display = 'block';
        pfill.style.width = '0%';
        ptext.textContent = lang === 'en' ? 'Starting…' : 'Démarrage…';

        // Red Cancel button under the bar.
        const controller = new AbortController();
        prog.querySelectorAll('.cat-cancel').forEach(b => b.remove());
        const cancel = document.createElement('button');
        cancel.className = 'cat-cancel'; cancel.type = 'button';
        cancel.textContent = lang === 'en' ? 'Cancel' : 'Annuler';
        cancel.addEventListener('click', () => controller.abort());
        prog.appendChild(cancel);

        try {
            const url = encodeURIComponent(state.config.ollamaUrl || 'http://localhost:11434');
            const res = await fetch(`/api/ollama-pull?name=${encodeURIComponent(name)}&url=${url}`, { signal: controller.signal });
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let o; try { o = JSON.parse(line); } catch { continue; }
                    if (o.error) throw new Error(o.error);
                    if (o.total) {
                        const pct = Math.round((o.completed || 0) / o.total * 100);
                        pfill.style.width = pct + '%';
                        ptext.textContent = `${o.status || ''} ${pct}%`;
                    } else if (o.status) {
                        ptext.textContent = o.status;
                    }
                }
            }
            addOllamaModel(name);
            _installedModels.add(normName(name));
            cancel.remove();
            prog.style.display = 'none';
            setCardActions(card, name);
        } catch (e) {
            cancel.remove();
            prog.style.display = 'none';
            pfill.style.width = '0%';
            if (!(e && e.name === 'AbortError')) {
                ptext.textContent = (lang === 'en' ? 'Error: ' : 'Erreur : ') + e.message;
            }
            setCardActions(card, name); // back to Install
        }
    }

    async function uninstallModel(name, card) {
        const lang = state.language || 'fr';
        const ok = await customConfirm(name, {
            title: lang === 'en' ? 'Uninstall this model?' : 'Désinstaller ce modèle ?',
            okText: lang === 'en' ? 'Uninstall' : 'Désinstaller',
            danger: true
        });
        if (!ok) return;
        const un = card.querySelector('.cat-uninstall');
        if (un) { un.disabled = true; un.textContent = lang === 'en' ? 'Removing…' : 'Suppression…'; }
        try {
            // Find the exact installed name (case + quant tag) so /api/delete matches.
            await refreshInstalled();
            const targets = new Set();
            const wanted = name.toLowerCase();
            for (const m of _installedModels) {
                const ml = m.toLowerCase();
                if (ml === wanted || ml === normName(name).toLowerCase()) targets.add(m);
                // HF model: same repo, any quant tag.
                else if (wanted.startsWith('hf.co/') && ml.startsWith(wanted.split(':')[0].toLowerCase() + ':')) targets.add(m);
            }
            if (!targets.size) targets.add(name); // fallback
            let lastErr = null;
            for (const t of targets) {
                const res = await fetch('/api/ollama-delete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: t, url: state.config.ollamaUrl || 'http://localhost:11434' })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.error) lastErr = data.error || ('HTTP ' + res.status);
                else _installedModels.delete(t);
            }
            if (lastErr && !targets.size) throw new Error(lastErr);
            removeOllamaModel(name);
            // Also drop any HF variant we may have kept in the managed list.
            (state.config.ollamaModels || []).slice().forEach(m => {
                if (m.toLowerCase().startsWith(name.toLowerCase().split(':')[0] + ':') || m.toLowerCase() === name.toLowerCase()) removeOllamaModel(m);
            });
            setCardActions(card, name);
        } catch (e) {
            if (un) { un.disabled = false; un.textContent = (lang === 'en' ? 'Error' : 'Erreur'); setTimeout(() => setCardActions(card, name), 1800); }
        }
    }

    // Catalog modal open/close + tabs + unified search.
    const catalogBtn = $('#catalog-btn');
    if (catalogBtn) catalogBtn.addEventListener('click', async () => {
        $('#catalog-modal').classList.add('active');
        await refreshInstalled();
        renderCatalog();
    });
    const closeCatalog = $('#close-catalog');
    if (closeCatalog) closeCatalog.addEventListener('click', () => $('#catalog-modal').classList.remove('active'));
    // Help / docs modal.
    function renderHelp() {
        const list = $('#help-list'); if (!list) return;
        list.innerHTML = '';
        (window.HELP_TOPICS || []).forEach(t => {
            const det = document.createElement('details');
            det.className = 'help-item';
            det.innerHTML = `<summary>${t.q}</summary><div class="help-answer">${t.a}</div>`;
            list.appendChild(det);
        });
    }
    const helpBtn = $('#help-btn');
    if (helpBtn) helpBtn.addEventListener('click', () => { renderHelp(); $('#help-modal').classList.add('active'); });
    const closeHelp = $('#close-help');
    if (closeHelp) closeHelp.addEventListener('click', () => $('#help-modal').classList.remove('active'));
    const helpModal = $('#help-modal');
    if (helpModal) helpModal.addEventListener('click', e => { if (e.target.id === 'help-modal') helpModal.classList.remove('active'); });

    const closeQuant = $('#close-quant');
    if (closeQuant) closeQuant.addEventListener('click', () => $('#quant-modal').classList.remove('active'));
    const quantModal = $('#quant-modal');
    if (quantModal) quantModal.addEventListener('click', e => { if (e.target.id === 'quant-modal') quantModal.classList.remove('active'); });
    const catalogModal = $('#catalog-modal');
    if (catalogModal) catalogModal.addEventListener('click', e => { if (e.target.id === 'catalog-modal') catalogModal.classList.remove('active'); });

    $$('.catalog-tab').forEach(tab => tab.addEventListener('click', () => {
        $$('.catalog-tab').forEach(t => t.classList.toggle('active', t === tab));
        const cat = tab.dataset.cat;
        $('#catalog-pane-curated').classList.toggle('hidden', cat !== 'curated');
        $('#catalog-pane-hf').classList.toggle('hidden', cat !== 'hf');
        applyCatalogSearch(); // apply current query to the newly active tab
    }));

    // One unified search bar drives both tabs (debounced).
    const catalogSearch = $('#catalog-search-input');
    let _searchTimer = null;
    if (catalogSearch) catalogSearch.addEventListener('input', () => {
        clearTimeout(_searchTimer);
        const q = catalogSearch.value.trim();
        if (q.length === 1) return; // wait for 2+ chars (or empty)
        _searchTimer = setTimeout(applyCatalogSearch, 200);
    });
    if (catalogSearch) catalogSearch.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_searchTimer); applyCatalogSearch(); }
    });

    // ==========================================================
    //  PROJECT MANAGEMENT
    // ==========================================================
    const projectDropdown = $('#project-dropdown');

    $('#project-btn').addEventListener('click', e => {
        e.stopPropagation();
        projectDropdown.classList.toggle('open');
    });

    document.addEventListener('click', () => {
        projectDropdown.classList.remove('open');
        $('#profile-popup').classList.remove('open');
    });

    $('#open-project-btn').addEventListener('click', async e => {
        e.stopPropagation();
        projectDropdown.classList.remove('open');
        // Open the native OS folder picker via the local server.
        try {
            const res = await fetch('/api/pick-folder', { method: 'POST' });
            const data = await res.json();
            if (data && data.path) {
                openProject(data.path, true);
                return;
            }
            if (data && data.cancelled) return; // user closed the dialog
            throw new Error(data && data.error ? data.error : 'picker unavailable');
        } catch {
            // Fallback: manual path input modal.
            $('#project-modal').classList.add('active');
            $('#project-path-input').focus();
        }
    });

    // Project modal
    $('#close-project-modal').addEventListener('click', () => $('#project-modal').classList.remove('active'));
    $('#cancel-project-btn').addEventListener('click', () => $('#project-modal').classList.remove('active'));
    $('#project-modal').addEventListener('click', e => { if (e.target.id === 'project-modal') $('#project-modal').classList.remove('active'); });

    $('#confirm-project-btn').addEventListener('click', () => {
        const p = $('#project-path-input').value.trim();
        if (p) {
            openProject(p, true);
            $('#project-modal').classList.remove('active');
        }
    });

    $('#project-path-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') $('#confirm-project-btn').click();
    });

    function initRecentProjects() {
        const recent = getRecentProjects();
        const container = $('#recent-projects');
        const lang = state.language || 'fr';
        if (recent.length === 0) {
            container.innerHTML = `<div class="dropdown-empty" data-i18n="no-recent-projects">${TRANSLATIONS[lang]['no-recent-projects']}</div>`;
            return;
        }
        container.innerHTML = '';
        recent.forEach(p => {
            const item = document.createElement('button');
            item.className = 'dropdown-item';
            item.textContent = p.split(/[\\/]/).pop();   // folder name only (no full path)
            item.title = p;                               // full path on hover only
            item.addEventListener('click', e => {
                e.stopPropagation();
                projectDropdown.classList.remove('open');
                openProject(p, true);
            });
            container.appendChild(item);
        });
    }

    async function openProject(rootPath, isNew) {
        state.projectRoot = rootPath;
        if (isNew) addRecentProject(rootPath);
        saveState();
        $('#project-name').textContent = rootPath.split(/[\\/]/).pop();
        await loadFileTree();
        initRecentProjects();
    }

    // ==========================================================
    //  FILE TREE
    // ==========================================================
    const ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6d8086" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 16h5" stroke-linecap="round"/></svg>';
    // Centered confirmation bubble (replaces the ugly browser window.confirm).
    function customConfirm(message, opts) {
        opts = opts || {};
        return new Promise(resolve => {
            const modal = $('#confirm-modal');
            const lang = state.language || 'fr';
            $('#confirm-title').textContent = opts.title || (lang === 'en' ? 'Confirm' : 'Confirmation');
            $('#confirm-msg').textContent = message;
            const yes = $('#confirm-yes'), no = $('#confirm-no');
            yes.textContent = opts.okText || (lang === 'en' ? 'Confirm' : 'Confirmer');
            no.textContent  = opts.cancelText || (lang === 'en' ? 'Cancel' : 'Annuler');
            yes.classList.toggle('btn-danger', !!opts.danger);
            const close = (ok) => {
                modal.classList.remove('active');
                yes.removeEventListener('click', onYes);
                no.removeEventListener('click', onNo);
                modal.removeEventListener('click', onBg);
                resolve(ok);
            };
            const onYes = () => close(true);
            const onNo  = () => close(false);
            const onBg  = (e) => { if (e.target.id === 'confirm-modal') close(false); };
            yes.addEventListener('click', onYes);
            no.addEventListener('click', onNo);
            modal.addEventListener('click', onBg);
            modal.classList.add('active');
        });
    }

    // Mapping filename -> known icon (extension or special-name). icon-fichier/<key>.svg
    const FILE_ICON_MAP = {
        js:'js', mjs:'mjs', cjs:'cjs', ts:'ts', jsx:'jsx', tsx:'tsx',
        html:'html', htm:'htm', css:'css', scss:'scss', sass:'sass',
        json:'json', md:'md', markdown:'markdown',
        py:'py', pyc:'py', pyw:'py', java:'java', kt:'kt', c:'c', h:'h', cpp:'cpp', cc:'cc', hpp:'hpp',
        cs:'cs', go:'go', rs:'rs', rb:'rb', php:'php', swift:'swift', sql:'sql',
        sh:'sh', bat:'bat', ps1:'ps1', yml:'yml', yaml:'yaml', toml:'toml',
        xml:'xml', vue:'vue', svelte:'svelte', txt:'txt', log:'log', env:'env',
        svg:'svg', png:'png', jpg:'jpg', jpeg:'jpeg', gif:'gif', webp:'webp', ico:'ico', icns:'ico',
        pdf:'pdf', zip:'zip', lock:'lock', rar:'zip', '7z':'zip', tar:'zip', gz:'zip'
    };
    // Special full-name matching for dotfiles and config files
    const FILE_NAME_MAP = {
        '.gitignore':'default', '.gitattributes':'default',
        'dockerfile':'bat', 'makefile':'bat', 'cmakelists.txt':'toml',
        'readme.md':'md', 'license':'txt', 'changelog.md':'md'
    };
    function fileIconHtml(name) {
        const lower = (name || '').toLowerCase();
        let key = 'default';
        // Check full filename first
        if (FILE_NAME_MAP[lower]) key = FILE_NAME_MAP[lower];
        else if (lower === '.env' || lower.endsWith('.env')) key = 'env';
        else if (lower.endsWith('.lock') || lower === 'package-lock.json') key = 'lock';
        else {
            const m = lower.match(/\.([a-z0-9]+)$/);
            if (m && FILE_ICON_MAP[m[1]]) key = FILE_ICON_MAP[m[1]];
        }
        return `<img class="file-icon" src="icon-fichier/${key}.svg" alt="" width="16" height="16">`;
    }
    const ICON_FOLDER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1a1a1e" stroke="#888" stroke-width="2.5" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    const ICON_FOLDER_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#252528" stroke="#aaa" stroke-width="2.5" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    const ICON_CHEVRON_R = '<svg width="10" height="10" viewBox="0 0 24 24"><polygon points="8 4 20 12 8 20" fill="#888"/></svg>';
    const ICON_CHEVRON_D = '<svg width="10" height="10" viewBox="0 0 24 24"><polygon points="4 8 20 8 12 20" fill="#aaa"/></svg>';

    async function loadFileTree() {
        if (!state.projectRoot) return;
        const fileTree = $('#file-tree');
        fileTree.innerHTML = '';
        const files = await fetchFiles('');
        renderTree(files, fileTree, 0);
    }

    async function fetchFiles(subPath) {
        try {
            let url = `/api/files?root=${encodeURIComponent(state.projectRoot)}`;
            if (subPath) url += `&path=${encodeURIComponent(subPath)}`;
            const res = await fetch(url);
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        } catch { return []; }
    }

    function renderTree(files, container, depth) {
        files.forEach(f => {
            const item = document.createElement('div');
            item.className = 'tree-item';
            item.style.paddingLeft = (12 + depth * 16) + 'px';

            if (f.isDirectory) {
                item.innerHTML = `${ICON_CHEVRON_R} ${ICON_FOLDER} <span class="tree-label">${f.name}</span>`;
                let expanded = false;
                item.addEventListener('click', async e => {
                    e.stopPropagation();
                    const childContainer = item.nextElementSibling;
                    if (expanded && childContainer && childContainer.classList.contains('tree-children')) {
                        childContainer.remove();
                        expanded = false;
                        item.innerHTML = `${ICON_CHEVRON_R} ${ICON_FOLDER} <span class="tree-label">${f.name}</span>`;
                        return;
                    }
                    const sub = await fetchFiles(f.path);
                    const wrap = document.createElement('div');
                    wrap.className = 'tree-children';
                    renderTree(sub, wrap, depth + 1);
                    item.after(wrap);
                    expanded = true;
                    item.innerHTML = `${ICON_CHEVRON_D} ${ICON_FOLDER_OPEN} <span class="tree-label">${f.name}</span>`;
                });
            } else {
                item.innerHTML = `${fileIconHtml(f.name)} <span class="tree-label">${f.name}</span>`;
                item.addEventListener('click', e => {
                    e.stopPropagation();
                    $$('.tree-item').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    openFile(f.path, f.name);
                });
            }
            container.appendChild(item);
        });
    }

    // ==========================================================
    //  FILE EDITOR
    // ==========================================================
    // ==========================================================
    //  FILE TABS & EDITOR
    // ==========================================================
    function updateGutter(content) {
        const g = $('#line-gutter');
        const n = (content || '').split('\n').length;
        g.innerHTML = Array.from({ length: n }, (_, i) => `<div>${i + 1}</div>`).join('');
    }

    const textarea = $('#code-textarea');

    function renderTabs() {
        const tabBar = $('#tab-bar');
        tabBar.innerHTML = '';

        const filePaths = Object.keys(state.openFiles);
        if (filePaths.length === 0) {
            const lang = state.language || 'fr';
            tabBar.innerHTML = `<div class="tab active" data-file="welcome"><span class="tab-name" data-i18n="welcome-tab">${TRANSLATIONS[lang]['welcome-tab']}</span></div>`;
            $('#welcome-screen').classList.remove('hidden');
            $('#code-editor').classList.add('hidden');
            $('#status-file').textContent = '--';
            $('#status-saved').textContent = '';
            state.activeFile = null;
            return;
        }

        filePaths.forEach(filePath => {
            const fileData = state.openFiles[filePath];
            const isActive = filePath === state.activeFile;

            const tab = document.createElement('div');
            tab.className = `tab ${isActive ? 'active' : ''}`;
            tab.dataset.file = filePath;

            // File-type icon (HTML, JS, CSS...) before the name.
            const ico = document.createElement('span');
            ico.className = 'tab-icon';
            ico.innerHTML = fileIconHtml(fileData.name);
            tab.appendChild(ico);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'tab-name';
            nameSpan.textContent = fileData.name;
            tab.appendChild(nameSpan);

            if (fileData.unsaved) {
                const dot = document.createElement('span');
                dot.className = 'tab-unsaved-dot';
                tab.appendChild(dot);
            }

            const closeBtn = document.createElement('button');
            closeBtn.className = 'tab-close';
            closeBtn.innerHTML = '&times;';
            closeBtn.addEventListener('click', e => {
                e.stopPropagation();
                closeFile(filePath);
            });
            tab.appendChild(closeBtn);

            tab.addEventListener('click', () => {
                switchToFile(filePath);
            });

            tabBar.appendChild(tab);
        });

        if (state.activeFile && state.openFiles[state.activeFile]) {
            $('#welcome-screen').classList.add('hidden');
            $('#code-editor').classList.remove('hidden');
            const fileData = state.openFiles[state.activeFile];
            const lang = state.language || 'fr';
            $('#status-file').textContent = state.activeFile;
            $('#status-saved').textContent = fileData.unsaved ? (TRANSLATIONS[lang]['unsaved-indicator'] || '(non enregistre)') : '';
            $('#status-saved').style.color = fileData.unsaved ? 'var(--yellow)' : 'var(--green)';
        } else {
            switchToFile(filePaths[0]);
        }
    }

    function switchToFile(filePath) {
        if (!state.openFiles[filePath]) return;
        state.activeFile = filePath;
        
        const fileData = state.openFiles[filePath];
        if (textarea.value !== fileData.content) {
            textarea.value = fileData.content;
            updateGutter(fileData.content);
        }
        renderTabs();
    }

    function closeFile(filePath) {
        if (!state.openFiles[filePath]) return;
        
        if (state.openFiles[filePath].unsaved) {
            const lang = state.language || 'fr';
            const msgConfirm = lang === 'en'
                ? `The file ${state.openFiles[filePath].name} has unsaved changes. Do you really want to close it?`
                : `Le fichier ${state.openFiles[filePath].name} a des modifications non enregistrees. Voulez-vous vraiment le fermer ?`;
            if (!confirm(msgConfirm)) {
                return;
            }
        }

        delete state.openFiles[filePath];

        if (state.activeFile === filePath) {
            const keys = Object.keys(state.openFiles);
            if (keys.length > 0) {
                state.activeFile = keys[keys.length - 1];
            } else {
                state.activeFile = null;
            }
        }

        renderTabs();
    }

    async function openFile(filePath, fileName) {
        try {
            if (state.openFiles[filePath]) {
                switchToFile(filePath);
                return;
            }

            const res = await fetch(`/api/file?root=${encodeURIComponent(state.projectRoot)}&path=${encodeURIComponent(filePath)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            state.openFiles[filePath] = {
                name: fileName,
                content: data.content,
                unsaved: false
            };
            state.activeFile = filePath;

            $('#welcome-screen').classList.add('hidden');
            $('#code-editor').classList.remove('hidden');
            textarea.value = data.content;
            updateGutter(data.content);

            renderTabs();
        } catch (err) {
            const lang = state.language || 'fr';
            const prefix = lang === 'en' ? 'Error: ' : 'Erreur: ';
            addMsg($('#chat-messages'), 'system', null, prefix + err.message);
        }
    }

    textarea.addEventListener('input', () => {
        if (!state.activeFile || !state.openFiles[state.activeFile]) return;
        const fileData = state.openFiles[state.activeFile];
        fileData.content = textarea.value;
        updateGutter(textarea.value);
        if (!fileData.unsaved) {
            fileData.unsaved = true;
            renderTabs();
        }
    });

    textarea.addEventListener('scroll', () => {
        $('#line-gutter').scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener('keydown', e => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            textarea.dispatchEvent(new Event('input'));
        }
    });

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveCurrentFile();
        }
    });

    async function saveCurrentFile() {
        if (!state.activeFile || !state.openFiles[state.activeFile] || !state.projectRoot) return;
        const filePath = state.activeFile;
        const fileData = state.openFiles[filePath];
        try {
            const res = await fetch('/api/file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    root: state.projectRoot,
                    path: filePath,
                    content: fileData.content
                })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            
            const lang = state.language || 'fr';
            fileData.unsaved = false;
            $('#status-saved').textContent = TRANSLATIONS[lang]['saved-indicator'] || 'Enregistre';
            $('#status-saved').style.color = 'var(--green)';
            renderTabs();
            setTimeout(() => { 
                if (state.activeFile === filePath && !fileData.unsaved) {
                    $('#status-saved').textContent = ''; 
                }
            }, 2000);
        } catch (err) {
            const lang = state.language || 'fr';
            $('#status-saved').textContent = TRANSLATIONS[lang]['error-indicator'] || 'Erreur';
            $('#status-saved').style.color = 'var(--red)';
        }
    }

    // ==========================================================
    //  PROFILE
    // ==========================================================
    function initProfile() {
        $('#profile-pseudo').value = state.profile.pseudo;
        updateProfileUI();
    }

    function updateProfileUI() {
        const lang = state.language || 'fr';
        const name = state.profile.pseudo || TRANSLATIONS[lang]['default-username'];
        const letter = name ? name.charAt(0).toUpperCase() : 'U';
        $('#profile-name').textContent = name;

        if (state.profile.photo) {
            $('#profile-avatar').innerHTML = `<img src="${state.profile.photo}" alt="">`;
            $('#profile-avatar-large').innerHTML = `<img src="${state.profile.photo}" alt="">`;
        } else {
            $('#profile-avatar').textContent = letter;
            $('#profile-avatar-large').textContent = letter;
        }
    }

    $('#sidebar-profile').addEventListener('click', e => {
        e.stopPropagation();
        $('#profile-popup').classList.toggle('open');
    });

    // Clicks inside the popup must not bubble to the document handler (which closes it).
    $('#profile-popup').addEventListener('click', e => e.stopPropagation());

    // Click the avatar circle -> open the file explorer to pick a photo.
    $('#profile-avatar-large').addEventListener('click', () => $('#profile-photo-input').click());
    $('#profile-photo-input').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            state.profile.photo = String(reader.result || '');
            saveState();
            updateProfileUI();
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    $('#save-profile').addEventListener('click', () => {
        state.profile.pseudo = $('#profile-pseudo').value.trim() || 'Utilisateur';
        saveState();
        updateProfileUI();
        $('#profile-popup').classList.remove('open');
    });

    // MODEL SUB-SELECTOR — moved to top (before INIT)

    // ==========================================================
    //  PERMISSION MODE
    // ==========================================================
    $$('.perm-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.permissionMode = btn.dataset.perm;
            // Keep both permission bars (chat + agents) in sync.
            $$('.perm-btn').forEach(b => b.classList.toggle('active', b.dataset.perm === btn.dataset.perm));
        });
    });

    // Approval modal
    let pendingApproval = null;

    function requestApproval(description, content) {
        return new Promise((resolve) => {
            $('#approval-desc').textContent = description;
            $('#approval-content').textContent = content;
            $('#approval-modal').classList.add('active');
            pendingApproval = resolve;
        });
    }

    $('#approve-action').addEventListener('click', () => {
        $('#approval-modal').classList.remove('active');
        if (pendingApproval) { pendingApproval(true); pendingApproval = null; }
    });
    $('#deny-action').addEventListener('click', () => {
        $('#approval-modal').classList.remove('active');
        if (pendingApproval) { pendingApproval(false); pendingApproval = null; }
    });
    $('#close-approval').addEventListener('click', () => {
        $('#approval-modal').classList.remove('active');
        if (pendingApproval) { pendingApproval(false); pendingApproval = null; }
    });

    // ==========================================================
    //  AI PANEL TABS
    // ==========================================================
    // ==========================================================
    //  AI PANEL TABS
    // ==========================================================
    $$('.ai-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const isAgentsTab = tab.dataset.tab === 'agents';
            
            $$('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab.dataset.tab));
            $$('.ai-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab.dataset.tab));

            // Re-evaluate the reasoning slider for the active context (chat model or lead agent)
            checkReasoningCompatibility();
            updateAttachAvailability();

            const lang = state.language || 'fr';
            if (isAgentsTab && !state.agentMode) {
                state.agentMode = true;
                $('#agent-toggle').classList.add('active');
                $('#agent-status').textContent = 'ON';
                
                const checked = $$('.agent-check:checked');
                if (checked.length < 2) {
                    addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['min-agents-required']);
                    state.agentMode = false;
                    $('#agent-toggle').classList.remove('active');
                    $('#agent-status').textContent = 'OFF';
                } else {
                    addMsg($('#agents-log'), 'system', null, (TRANSLATIONS[lang]['mode-agents-active'] || 'Mode Agents active.') + ' ' + checked.length + ' ' + (TRANSLATIONS[lang]['active-agents'] || 'agents prets.'));
                }
            } else if (!isAgentsTab && state.agentMode) {
                state.agentMode = false;
                $('#agent-toggle').classList.remove('active');
                $('#agent-status').textContent = 'OFF';
                addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['mode-agents-inactive'] || 'Mode Agents desactive.');
                $$('.agent-card').forEach(c => {
                    c.classList.remove('working');
                    const badge = c.querySelector('.agent-badge');
                    badge.textContent = TRANSLATIONS[lang]['status-idle'] || 'Inactif';
                    badge.className = 'agent-badge idle';
                });
            }
        });
    });

    // ==========================================================
    //  AGENT MODE TOGGLE
    // ==========================================================
    $('#agent-toggle').addEventListener('click', () => {
        state.agentMode = !state.agentMode;
        $('#agent-toggle').classList.toggle('active', state.agentMode);
        $('#agent-status').textContent = state.agentMode ? 'ON' : 'OFF';

        const lang = state.language || 'fr';
        if (state.agentMode) {
            const checked = $$('.agent-check:checked');
            if (checked.length < 2) {
                addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['min-agents-required']);
                state.agentMode = false;
                $('#agent-toggle').classList.remove('active');
                $('#agent-status').textContent = 'OFF';
                return;
            }
            addMsg($('#agents-log'), 'system', null, (TRANSLATIONS[lang]['mode-agents-active'] || 'Mode Agents active.') + ' ' + checked.length + ' ' + (TRANSLATIONS[lang]['active-agents'] || 'agents prets.'));
            $$('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'agents'));
            $$('.ai-view').forEach(v => v.classList.toggle('active', v.id === 'view-agents'));
        } else {
            addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['mode-agents-inactive'] || 'Mode Agents desactive.');
            $$('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'chat'));
            $$('.ai-view').forEach(v => v.classList.toggle('active', v.id === 'view-chat'));
            $$('.agent-card').forEach(c => {
                c.classList.remove('working');
                const badge = c.querySelector('.agent-badge');
                badge.textContent = TRANSLATIONS[lang]['status-idle'] || 'Inactif';
                badge.className = 'agent-badge idle';
            });
        }
    });

    // ==========================================================
    //  CLEAR TERMINAL
    // ==========================================================
    $('#clear-terminal').addEventListener('click', () => {
        const lang = state.language || 'fr';
        $('#chat-messages').innerHTML = '';
        $('#agents-log').innerHTML = '';
        // Start fresh conversations so we don't overwrite saved ones.
        state.currentConvId = null;
        state.currentAgentConvId = null;
        state.chatHistory = [];
        state.contextTokens = 0;
        if (typeof updateTokenMeter === 'function') updateTokenMeter();
        addMsg($('#chat-messages'), 'system', null, TRANSLATIONS[lang]['terminal-cleared']);
        addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['history-cleared']);
        renderHistory();
    });

    // ==========================================================
    //  MESSAGE HELPERS
    // ==========================================================
    function escapeHTML(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Minimal, safe Markdown -> HTML renderer (no dependency).
    // Everything is HTML-escaped before any transform, so AI output cannot
    // inject markup; only a known set of formatting tags is produced.
    function renderMarkdown(src) {
        if (!src) return '';
        const NUL = '';

        // 1) Extract fenced code blocks so their content is left untouched.
        const codeBlocks = [];
        src = src.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (m, lang, code) => {
            codeBlocks.push(code.replace(/\n$/, ''));
            return `${NUL}CODE${codeBlocks.length - 1}${NUL}`;
        });

        // 2) Escape the rest.
        let html = escapeHTML(src);

        // 3) Extract inline code (content already escaped).
        const inlineCode = [];
        html = html.replace(/`([^`\n]+)`/g, (m, c) => {
            inlineCode.push(c);
            return `${NUL}IC${inlineCode.length - 1}${NUL}`;
        });

        function inline(s) {
            s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
            s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
            s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
            return s;
        }

        // 4) Block-level parsing, line by line.
        const lines = html.split('\n');
        const out = [];
        let listType = null;
        const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

        for (const line of lines) {
            if (new RegExp(`^${NUL}CODE\\d+${NUL}$`).test(line.trim())) { closeList(); out.push(line.trim()); continue; }
            let h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) { closeList(); const lvl = Math.min(h[1].length, 4); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
            if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
            let bq = line.match(/^>\s?(.*)$/);
            if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
            let ul = line.match(/^\s*[-*+]\s+(.*)$/);
            if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
            let ol = line.match(/^\s*\d+\.\s+(.*)$/);
            if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
            if (/^\s*$/.test(line)) { closeList(); continue; }
            closeList();
            out.push(`<p>${inline(line)}</p>`);
        }
        closeList();
        html = out.join('\n');

        // 5) Restore code.
        html = html.replace(new RegExp(`${NUL}IC(\\d+)${NUL}`, 'g'), (m, i) => `<code>${inlineCode[+i]}</code>`);
        html = html.replace(new RegExp(`${NUL}CODE(\\d+)${NUL}`, 'g'), (m, i) => `<pre class="code-block"><code>${escapeHTML(codeBlocks[+i])}</code></pre>`);

        return html;
    }

    function formatAIResponse(text) {
        const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
        const match = text.match(thinkRegex);
        if (match) {
            const thinkContent = match[1].trim();
            const mainContent = text.replace(thinkRegex, '').trim();
            return `
                <details class="thinking-details">
                    <summary>Processus de reflexion</summary>
                    <div class="thinking-content md">${renderMarkdown(thinkContent)}</div>
                </details>
                <div class="response-text md">${renderMarkdown(mainContent)}</div>
            `;
        }
        return `<div class="md">${renderMarkdown(text)}</div>`;
    }

    function isMaxReasoning() {
        const model = reasoningContext().model;
        const modes = REASONING_MODES[model] || REASONING_MODES.local;
        return state.reasoningLevel === (modes.length - 1);
    }

    function addMsg(container, type, label, text, isHTML = false) {
        const div = document.createElement('div');
        div.className = 'msg msg-' + type;
        let html = '';
        if (label) html += `<span class="msg-label ${label.toLowerCase()}">${label}</span>`;
        html += '<div class="msg-body"></div>';
        div.innerHTML = html;
        const body = div.querySelector('.msg-body');
        if (type === 'ai' && isMaxReasoning()) {
            body.classList.add('max-reasoning-text');
        }
        if (isHTML) {
            body.innerHTML = text;
        } else {
            body.textContent = text;
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return body;
    }

    function addTypingMsg(container, label) {
        const div = document.createElement('div');
        div.className = 'msg msg-ai';
        let html = '';
        if (label) html += `<span class="msg-label ${label.toLowerCase()}">${label}</span>`;
        html += '<div class="msg-body"></div>';
        div.innerHTML = html;
        const body = div.querySelector('.msg-body');
        startThinking(body);
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return body;
    }

    // ==========================================================
    //  CHAT - SINGLE AI
    // ==========================================================
    async function callAI(model, submodel, message, systemPrompt, images = [], signal = undefined, history = []) {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model, submodel, message, systemPrompt,
                config: state.config,
                reasoningLevel: state.reasoningLevel,
                images, history
            }),
            signal
        });
        try {
            return await res.json();
        } catch {
            return { error: `Reponse invalide du serveur (HTTP ${res.status} ${res.statusText})` };
        }
    }

    // Token / context meter.
    function updateTokenMeter() {
        const fill = $('#token-fill'), txt = $('#token-text');
        if (!fill || !txt) return;
        const win = contextWindow(modelSelect.value, submodelSelect.value);
        const used = state.contextTokens || 0;
        const pct = Math.min(100, Math.round((used / win) * 100));
        fill.style.width = pct + '%';
        fill.classList.toggle('warn', pct >= 70 && pct < 90);
        fill.classList.toggle('full', pct >= 90);
        txt.textContent = `${fmtTokens(used)} / ${fmtTokens(win)} (${pct}%)`;
    }

    // Auto-compact the context when it nears the model's window (summarize old turns).
    async function maybeCompact(model, submodel) {
        const win = contextWindow(model, submodel);
        if (state.contextTokens < win * 0.75) return;
        if (state.chatHistory.length <= 4) return;
        const lang = state.language || 'fr';
        const keep = 4;
        const older = state.chatHistory.slice(0, state.chatHistory.length - keep);
        const recent = state.chatHistory.slice(state.chatHistory.length - keep);
        const text = older.map(h => `${h.role}: ${h.content}`).join('\n');
        addMsg($('#chat-messages'), 'system', null, lang === 'en' ? 'Compacting context…' : 'Compactage du contexte…');
        try {
            const prompt = (lang === 'en'
                ? 'Summarize the conversation below concisely, keeping every important fact, decision, file and context. Under 250 words:\n\n'
                : 'Resume la conversation ci-dessous de maniere concise, en gardant chaque fait, decision, fichier et contexte important. En moins de 250 mots :\n\n') + text;
            const data = await callAI(model, submodel, prompt, null, [], undefined, []);
            const summary = (data && data.response) || '';
            state.chatHistory = [{ role: 'user', content: (lang === 'en' ? '[Earlier context summary]: ' : '[Résumé du contexte précédent] : ') + summary }, ...recent];
            state.contextTokens = state.chatHistory.reduce((n, h) => n + estimateTokens(h.content), 0);
            updateTokenMeter();
            addMsg($('#chat-messages'), 'system', null, lang === 'en' ? 'Context compacted.' : 'Contexte compacté.');
        } catch {}
    }

    // Collapsible reasoning block (like Codex): "Réflexion durant Xs".
    function reasoningBlock(thinking, durationMs) {
        const lang = state.language || 'fr';
        const label = (lang === 'en' ? 'Reasoned for ' : 'Réflexion durant ') + fmtDuration(durationMs);
        const chevron = '<svg class="reasoning-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
        return `<details class="reasoning"><summary><span class="reasoning-spark"></span><span class="reasoning-label">${label}</span>${chevron}</summary><div class="reasoning-body md">${renderMarkdown(thinking)}</div></details>`;
    }

    // --- Send / Stop button state ---
    let chatAbort = null;
    const SEND_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    const STOP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    function setChatBusy(on) {
        const btn = $('#send-btn');
        if (!btn) return;
        btn.classList.toggle('stop', on);
        btn.innerHTML = on ? STOP_ICON : SEND_ICON;
    }

    async function sendChat(message) {
        const model = modelSelect.value;
        const submodel = submodelSelect.value;
        const modelLabel = modelSelect.options[modelSelect.selectedIndex].text.split(' ')[0];

        const lang = state.language || 'fr';
        const { aiText, names, images } = consumeAttachments();

        // Compact the running context first if it's getting close to the limit.
        await maybeCompact(model, submodel);

        // Project tree goes into the SYSTEM prompt (background), only on the first
        // message — so weak models don't echo it and later questions aren't drowned.
        const ctx = state.chatHistory.length === 0 ? await projectContext() : '';
        const sys = codeAgentPrompt() + ctx;
        const aiMessage = message + aiText;            // user message stays clean
        const displayMsg = message + (names.length ? `\n📎 ${names.join(', ')}` : '');
        addMsg($('#chat-messages'), 'user', lang === 'en' ? 'You' : 'Vous', displayMsg);
        const body = addTypingMsg($('#chat-messages'), modelLabel);

        const history = state.chatHistory.slice(); // prior turns (memory)
        const t0 = Date.now();
        const controller = new AbortController();
        chatAbort = controller;
        setChatBusy(true);
        try {
            const data = await callAI(model, submodel, aiMessage, sys, images, controller.signal, history);
            stopThinking(body);
            if (data.error) {
                body.textContent = data.error;
                body.classList.add('error');
            } else {
                const duration = Date.now() - t0;
                if (isMaxReasoning()) body.classList.add('max-reasoning-text');
                const reasoning = data.thinking ? reasoningBlock(data.thinking, duration) : '';
                body.innerHTML = reasoning + formatAIResponse(data.response);

                // Update conversation memory + token meter.
                state.chatHistory.push({ role: 'user', content: message }, { role: 'assistant', content: data.response });
                if (data.usage && data.usage.input != null) {
                    state.contextTokens = (data.usage.input || 0) + (data.usage.output || 0);
                } else {
                    state.contextTokens = state.chatHistory.reduce((n, h) => n + estimateTokens(h.content), 0) + estimateTokens(codeAgentPrompt());
                }
                updateTokenMeter();

                // Check if AI wants to modify a file / run a command.
                await handleAIResponse(data.response, modelLabel);
            }
        } catch (err) {
            stopThinking(body);
            if (err && err.name === 'AbortError') {
                body.textContent = lang === 'en' ? 'Stopped.' : 'Interrompu.';
            } else {
                body.textContent = TRANSLATIONS[lang]['err-conn'] || 'Erreur de connexion au serveur.';
                body.classList.add('error');
            }
        } finally {
            chatAbort = null;
            setChatBusy(false);
        }

        saveConversation();
    }

    // Handle AI file modifications based on permission mode.
    // Writes EVERY file block the model emits (creating files/folders as needed),
    // not just the currently-open file — this is what makes it behave like a CLI/IDE.
    async function handleAIResponse(response, agentName) {
        const lang = state.language || 'fr';

        if (!state.projectRoot) {
            addMsg($('#chat-messages'), 'system', null,
                lang === 'en' ? 'Open a project folder first so changes can be written to disk.'
                              : 'Ouvrez d\'abord un dossier de projet pour pouvoir ecrire les modifications sur le disque.');
            return;
        }

        let blocks = extractFileBlocks(response);
        const commands = extractRunBlocks(response);

        // Fallback (legacy): prose names a file + a code block exists + a file is open.
        if (blocks.length === 0) {
            const fileMatch = response.match(/(?:fichier|file|ecrire dans|modifier|sauvegarder)\s+[`"]?([^\s`"]+\.\w+)[`"]?/i);
            const codeMatch = response.match(/```[^\n]*\n([\s\S]*?)```/);
            if (fileMatch && codeMatch && state.activeFile) {
                blocks = [{ path: state.activeFile, content: codeMatch[1].replace(/\n$/, '') }];
            }
        }

        if (blocks.length === 0 && commands.length === 0) return;

        let wroteAny = false;
        for (const { path: targetFile, content: codeContent } of blocks) {
            if (state.permissionMode === 'supervised') {
                const desc = lang === 'en'
                    ? `${agentName} wants to write ${targetFile}`
                    : `${agentName} veut ecrire ${targetFile}`;
                const approved = await requestApproval(
                    desc,
                    codeContent.substring(0, 500) + (codeContent.length > 500 ? '\n...' : '')
                );
                if (!approved) {
                    addMsg($('#chat-messages'), 'system', null, TRANSLATIONS[lang]['modification-refused'] || 'Modification refusee.');
                    continue;
                }
            }

            try {
                const res = await fetch('/api/file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        root: state.projectRoot,
                        path: targetFile,
                        content: codeContent
                    })
                });
                const result = await res.json();
                if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));

                if (state.openFiles[targetFile]) {
                    state.openFiles[targetFile].content = codeContent;
                    state.openFiles[targetFile].unsaved = false;
                }
                if (state.activeFile === targetFile) {
                    textarea.value = codeContent;
                    updateGutter(codeContent);
                    renderTabs();
                }

                addMsg($('#chat-messages'), 'system', null, `${lang === 'en' ? 'File' : 'Fichier'} ${targetFile} ${TRANSLATIONS[lang]['file-modified'] || 'modifie.'}`);
                wroteAny = true;
            } catch (err) {
                addMsg($('#chat-messages'), 'system', null,
                    `${lang === 'en' ? 'Write error' : 'Erreur ecriture'} ${targetFile}: ${err.message}`);
            }
        }

        // Refresh the file tree so newly-created files appear in the explorer.
        if (wroteAny) await loadFileTree();

        // Run terminal commands the AI requested (```run blocks).
        // Permission: supervised + semi ask first; auto runs without asking.
        for (const cmd of commands) {
            if (state.permissionMode !== 'auto') {
                const desc = lang === 'en'
                    ? `${agentName} wants to run a command`
                    : `${agentName} veut exécuter une commande`;
                const approved = await requestApproval(desc, cmd);
                if (!approved) {
                    addMsg($('#chat-messages'), 'system', null,
                        lang === 'en' ? 'Command refused.' : 'Commande refusée.');
                    continue;
                }
            }
            addMsg($('#chat-messages'), 'system', null, '$ ' + cmd);
            try {
                const res = await fetch('/api/exec', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd, cwd: state.projectRoot })
                });
                const out = await res.json();
                if (!res.ok || out.error) {
                    addMsg($('#chat-messages'), 'system', null,
                        `${lang === 'en' ? 'Command error' : 'Erreur commande'}: ${out.error || ('HTTP ' + res.status)}`);
                } else {
                    const text = ((out.stdout || '') + (out.stderr ? '\n' + out.stderr : '')).trim();
                    addMsg($('#chat-messages'), 'ai', 'Terminal', text || (lang === 'en' ? '(no output)' : '(aucune sortie)'));
                }
            } catch (err) {
                addMsg($('#chat-messages'), 'system', null,
                    `${lang === 'en' ? 'Command error' : 'Erreur commande'}: ${err.message}`);
            }
        }
    }

    // Auto-grow a textarea downward as the user types (up to its CSS max-height).
    function autoGrow(el) {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }
    function resetInput(el) { if (el) { el.value = ''; el.style.height = 'auto'; } }
    ['#chat-input', '#agents-input'].forEach(sel => {
        const t = $(sel);
        if (t) t.addEventListener('input', () => autoGrow(t));
    });

    // Chat input — Enter sends, Shift+Enter inserts a new line.
    $('#chat-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!chatAbort && $('#chat-input').value.trim()) {
                sendChat($('#chat-input').value.trim());
                resetInput($('#chat-input'));
            }
        }
    });
    $('#send-btn').addEventListener('click', () => {
        // While the AI is generating, the button is a "stop" circle -> cancel.
        if (chatAbort) { chatAbort.abort(); return; }
        if ($('#chat-input').value.trim()) {
            sendChat($('#chat-input').value.trim());
            resetInput($('#chat-input'));
        }
    });

    // ==========================================================
    //  AGENTS MODE - MULTI AI
    // ==========================================================
    async function sendAgentTask(task) {
        const lang = state.language || 'fr';
        if (!state.agentMode) {
            addMsg($('#agents-log'), 'system', null, lang === 'en' ? "Activate Agent Mode first." : "Activez le Mode Agents d'abord.");
            return;
        }

        const activeAgents = [];
        $$('.agent-check:checked').forEach(cb => {
            const agent = cb.dataset.agent;
            const card = $(`.agent-card[data-agent="${agent}"]`);
            const role = card.querySelector('.agent-role-select').value;
            const modelSel = card.querySelector('.agent-model-select');
            const submodel = modelSel ? modelSel.value : state.config.ollamaModel;
            activeAgents.push({ agent, role, submodel });
        });

        if (activeAgents.length < 2) {
            addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['min-agents-required'] || 'Minimum 2 agents requis.');
            return;
        }

        const labels = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', mistral: 'Mistral', local: 'Ollama' };

        // Identify lead agent
        const leadIdx = activeAgents.findIndex(a => a.role === 'lead');
        let leadAgent;
        let workers = [];

        if (leadIdx !== -1) {
            leadAgent = activeAgents[leadIdx];
            workers = activeAgents.filter((_, idx) => idx !== leadIdx);
        } else {
            leadAgent = activeAgents[0];
            workers = activeAgents.slice(1);
            const noLeadMsg = lang === 'en'
                ? `No Project Lead selected. ${labels[leadAgent.agent]} will coordinate the response.`
                : `Aucun Chef de projet selectionne. ${labels[leadAgent.agent]} coordonnera la reponse.`;
            addMsg($('#agents-log'), 'system', null, noLeadMsg);
        }

        // Attach any selected files/images to the task given to the agents.
        const { aiText, names, images: taskImages } = consumeAttachments();
        const displayTask = task + (names.length ? `\n📎 ${names.join(', ')}` : '');
        task = task + aiText;
        const projCtx = await projectContext(); // appended to each agent's SYSTEM prompt
        addMsg($('#agents-log'), 'user', lang === 'en' ? 'You' : 'Vous', displayTask);

        // Pre-create the unified chat bubble for the final response
        const leadBody = addMsg($('#agents-log'), 'ai', labels[leadAgent.agent], '', true);
        
        // Initialize the thinking box — the dot wave fills the whole box, behind the text.
        leadBody.innerHTML = `
            <details class="thinking-details" open>
                <canvas class="wave-canvas"></canvas>
                <summary>${TRANSLATIONS[lang]['team-thinking-title']} (0/${workers.length} ${TRANSLATIONS[lang]['lead-thinking-progress']})</summary>
                <div class="thinking-content"></div>
            </details>
            <div class="lead-response"></div>
        `;

        const thinkingContent = leadBody.querySelector('.thinking-content');
        const summary = leadBody.querySelector('summary');
        const leadResponseDiv = leadBody.querySelector('.lead-response');
        const waveCanvas = leadBody.querySelector('.wave-canvas');
        startWave(waveCanvas);

        let context = '';
        let completedCount = 0;

        // Run worker agents sequentially
        for (const { agent, role, submodel } of workers) {
            const card = $(`.agent-card[data-agent="${agent}"]`);
            card.classList.add('working');
            const badge = card.querySelector('.agent-badge');
            badge.textContent = TRANSLATIONS[lang]['status-working'];
            badge.className = 'agent-badge working';

            // Add worker item in details
            const item = document.createElement('div');
            item.className = 'agent-thinking-item';
            item.innerHTML = `<strong>${labels[agent]} (${TRANSLATIONS[lang]['role-' + role] || role})</strong>: <span class="agent-status-text">${lang === 'en' ? 'analyzing...' : 'analyse en cours...'}</span>`;
            thinkingContent.appendChild(item);
            $('#agents-log').scrollTop = $('#agents-log').scrollHeight;

            const statusText = item.querySelector('.agent-status-text');

            const systemPrompt = `${ROLE_PROMPTS[role]}\n${AGENT_COLLABORATION_PROMPT}\n${codeAgentPrompt()}${projCtx}`;
            const fullMessage = context
                ? (lang === 'en' 
                    ? `[Previous agents context]:\n${context}\n\n[User task]: ${task}` 
                    : `[Contexte des agents precedents]:\n${context}\n\n[Tache utilisateur]: ${task}`)
                : task;

            try {
                const data = await callAI(agent, submodel, fullMessage, systemPrompt, taskImages);
                if (data.error) {
                    statusText.textContent = (lang === 'en' ? 'error: ' : 'erreur : ') + data.error;
                    statusText.style.color = 'var(--red)';
                } else {
                    statusText.textContent = TRANSLATIONS[lang]['lead-thinking-done'];
                    statusText.style.color = 'var(--green)';
                    
                    const outDiv = document.createElement('pre');
                    outDiv.style.whiteSpace = 'pre-wrap';
                    outDiv.style.fontFamily = 'var(--font-mono)';
                    outDiv.style.fontSize = '11px';
                    outDiv.style.marginTop = '4px';
                    outDiv.style.color = 'var(--text-1)';
                    outDiv.textContent = data.response;
                    item.appendChild(outDiv);

                    context += `\n[${labels[agent]} (${TRANSLATIONS[lang]['role-' + role] || role})]: ${data.response}\n`;
                    await handleAIResponse(data.response, labels[agent]);
                }
            } catch (err) {
                statusText.textContent = lang === 'en' ? 'connection error' : 'erreur de connexion';
                statusText.style.color = 'var(--red)';
            }

            card.classList.remove('working');
            badge.textContent = TRANSLATIONS[lang]['status-done'];
            badge.className = 'agent-badge done';

            completedCount++;
            summary.textContent = `${TRANSLATIONS[lang]['team-thinking-title']} (${completedCount}/${workers.length} ${TRANSLATIONS[lang]['lead-thinking-progress']})`;
            $('#agents-log').scrollTop = $('#agents-log').scrollHeight;
        }

        // Now run the Chef de projet (Lead agent)
        summary.textContent = `${TRANSLATIONS[lang]['team-thinking-title']} (${TRANSLATIONS[lang]['lead-thinking-done']})`;

        const leadCard = $(`.agent-card[data-agent="${leadAgent.agent}"]`);
        leadCard.classList.add('working');
        const leadBadge = leadCard.querySelector('.agent-badge');
        leadBadge.textContent = TRANSLATIONS[lang]['status-working'];
        leadBadge.className = 'agent-badge working';

        const leadSystemPrompt = `${ROLE_PROMPTS[leadAgent.role]}\n${AGENT_COLLABORATION_PROMPT}\n${codeAgentPrompt()}${projCtx}`;
        const leadMessage = lang === 'fr'
            ? `[Tache utilisateur]: ${task}

Voici les contributions et analyses des autres membres de l'equipe :
${context}

En tant que Chef de Projet, synthetise leur travail, prends les decisions finales et formule une reponse unique, structuree, coherente et complete pour l'utilisateur.`
            : `[User task]: ${task}

Here are the contributions and analyses from the other team members:
${context}

As the Project Lead, synthesize their work, make final decisions, and formulate a single, structured, coherent, and complete response for the user.`;

        startThinking(leadResponseDiv);
        try {
            const data = await callAI(leadAgent.agent, leadAgent.submodel, leadMessage, leadSystemPrompt, taskImages);
            stopThinking(leadResponseDiv);
            stopWave(waveCanvas); if (waveCanvas) waveCanvas.remove();
            if (data.error) {
                leadResponseDiv.textContent = data.error;
                leadResponseDiv.classList.add('error');
            } else {
                const formatted = formatAIResponse(data.response);
                leadResponseDiv.innerHTML = formatted;
                await handleAIResponse(data.response, labels[leadAgent.agent]);
            }
        } catch (err) {
            stopThinking(leadResponseDiv);
            stopWave(waveCanvas); if (waveCanvas) waveCanvas.remove();
            leadResponseDiv.textContent = TRANSLATIONS[lang]['err-conn-lead'] || 'Erreur de connexion.';
            leadResponseDiv.classList.add('error');
        }

        leadCard.classList.remove('working');
        leadBadge.textContent = TRANSLATIONS[lang]['status-done'];
        leadBadge.className = 'agent-badge done';
        $('#agents-log').scrollTop = $('#agents-log').scrollHeight;

        // Save this agents session to the (separate) agents history.
        saveConversation('agents');
    }

    $('#agents-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if ($('#agents-input').value.trim()) {
                sendAgentTask($('#agents-input').value.trim());
                resetInput($('#agents-input'));
            }
        }
    });
    $('#agents-send-btn').addEventListener('click', () => {
        if ($('#agents-input').value.trim()) {
            sendAgentTask($('#agents-input').value.trim());
            resetInput($('#agents-input'));
        }
    });

    // ==========================================================
    //  CONVERSATION HISTORY
    // ==========================================================
    // History config per kind: 'chat' (single) vs 'agents' (multi-agent).
    const HIST = {
        chat: {
            store: 'conversations', current: 'currentConvId',
            container: '#chat-messages', list: '#history-list', tab: 'chat',
            defaultKey: 'chat-default-msg', defaultMsg: 'Selectionnez un modele et posez votre question.'
        },
        agents: {
            store: 'agentConversations', current: 'currentAgentConvId',
            container: '#agents-log', list: '#history-list-agents', tab: 'agents',
            defaultKey: 'agents-log-default', defaultMsg: 'Activez le Mode Agents et envoyez une tache.'
        }
    };

    function saveConversation(kind = 'chat') {
        const cfg = HIST[kind];
        const data = [];
        $(cfg.container).querySelectorAll('.msg').forEach(m => {
            const label = m.querySelector('.msg-label');
            const body = m.querySelector('.msg-body');
            data.push({
                label: label ? label.textContent : null,
                text: body ? body.textContent : '',
                type: m.classList.contains('msg-system') ? 'system' : m.classList.contains('msg-user') ? 'user' : 'ai'
            });
        });

        if (data.length <= 1) return; // only the default system message

        const title = data.find(d => d.type === 'user')?.text?.substring(0, 40) || 'Conversation';
        const listArr = state[cfg.store];
        let curId = state[cfg.current];

        if (!curId) {
            curId = Date.now().toString();
            state[cfg.current] = curId;
            listArr.push({ id: curId, title, date: new Date().toLocaleDateString(), messages: data });
        } else {
            const conv = listArr.find(c => c.id === curId);
            if (conv) { conv.messages = data; if (!conv.title || conv.title === 'Conversation') conv.title = title; }
            else listArr.push({ id: curId, title, date: new Date().toLocaleDateString(), messages: data });
        }

        persistChats(kind);
        renderHistory();
    }

    // Save a kind's conversations to the server (debounced, per kind).
    const _persistTimers = {};
    function persistChats(kind = 'chat') {
        const cfg = HIST[kind];
        clearTimeout(_persistTimers[kind]);
        _persistTimers[kind] = setTimeout(() => {
            fetch('/api/chats', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, conversations: state[cfg.store] })
            }).catch(() => {});
        }, 400);
    }

    // Load both histories (chat + agents) from the server.
    async function loadUserChats() {
        for (const kind of ['chat', 'agents']) {
            try {
                const res = await fetch('/api/chats?kind=' + kind);
                if (res.ok) state[HIST[kind].store] = await res.json();
            } catch {}
        }
        renderHistory();
    }

    // Restore a saved conversation into its view (chat or agents).
    function loadConversation(kind, id) {
        const cfg = HIST[kind];
        const conv = state[cfg.store].find(c => c.id === id);
        if (!conv) return;
        state[cfg.current] = id;

        const container = $(cfg.container);
        container.innerHTML = '';
        (conv.messages || []).forEach(m => addMsg(container, m.type, m.label, m.text || ''));
        container.scrollTop = container.scrollHeight;

        // Rebuild the API memory for the chat from its messages.
        if (kind === 'chat') {
            state.chatHistory = (conv.messages || [])
                .filter(m => m.type === 'user' || m.type === 'ai')
                .map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.text || '' }));
            state.contextTokens = state.chatHistory.reduce((n, h) => n + estimateTokens(h.content), 0);
            updateTokenMeter();
        }

        $$('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === cfg.tab));
        $$('.ai-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + cfg.tab));

        renderHistory();
    }

    function renderHistory() {
        const lang = state.language || 'fr';
        ['chat', 'agents'].forEach(kind => {
            const cfg = HIST[kind];
            const list = $(cfg.list);
            if (!list) return;
            const convs = state[cfg.store] || [];
            const curId = state[cfg.current];
            if (convs.length === 0) {
                list.innerHTML = `<div class="history-empty">${TRANSLATIONS[lang]['history-empty'] || 'Aucune conversation'}</div>`;
                return;
            }
            list.innerHTML = '';
            convs.slice().reverse().forEach(conv => {
                const item = document.createElement('div');
                item.className = 'history-item' + (conv.id === curId ? ' active' : '');
                item.title = conv.date || '';

                const titleEl = document.createElement('span');
                titleEl.className = 'history-title';
                titleEl.textContent = conv.title;
                titleEl.addEventListener('click', () => loadConversation(kind, conv.id));

                const delBtn = document.createElement('button');
                delBtn.className = 'history-del';
                delBtn.title = lang === 'en' ? 'Delete' : 'Supprimer';
                delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
                delBtn.addEventListener('click', e => { e.stopPropagation(); deleteConversation(kind, conv.id); });

                item.appendChild(titleEl);
                item.appendChild(delBtn);
                list.appendChild(item);
            });
        });
    }

    // Start a brand-new conversation for the given kind.
    function newConversation(kind = 'chat') {
        const cfg = HIST[kind];
        const lang = state.language || 'fr';
        state[cfg.current] = null;
        $(cfg.container).innerHTML = '';
        addMsg($(cfg.container), 'system', null, TRANSLATIONS[lang][cfg.defaultKey] || cfg.defaultMsg);
        if (kind === 'chat') { state.chatHistory = []; state.contextTokens = 0; updateTokenMeter(); }
        renderHistory();
    }

    // Delete a saved conversation (after confirmation).
    async function deleteConversation(kind, id) {
        const cfg = HIST[kind];
        const lang = state.language || 'fr';
        const conv = state[cfg.store].find(c => c.id === id);
        const title = conv ? conv.title : '';
        const ok = await customConfirm(`"${title}"`, {
            title: lang === 'en' ? 'Delete this conversation?' : 'Supprimer cette conversation ?',
            okText: lang === 'en' ? 'Delete' : 'Supprimer',
            danger: true
        });
        if (!ok) return;

        state[cfg.store] = state[cfg.store].filter(c => c.id !== id);
        if (state[cfg.current] === id) {
            state[cfg.current] = null;
            $(cfg.container).innerHTML = '';
            addMsg($(cfg.container), 'system', null, TRANSLATIONS[lang][cfg.defaultKey] || cfg.defaultMsg);
        }
        persistChats(kind);
        renderHistory();
    }

    const newChatBtn = $('#new-chat-btn');
    if (newChatBtn) newChatBtn.addEventListener('click', () => newConversation('chat'));
    const newChatBtnAgents = $('#new-chat-btn-agents');
    if (newChatBtnAgents) newChatBtnAgents.addEventListener('click', () => newConversation('agents'));

    // ==========================================================
    //  ATTACHMENTS (images / files) — chat + agents
    // ==========================================================
    function fileExtLabel(name) {
        const parts = (name || '').split('.');
        return parts.length > 1 ? parts.pop().toUpperCase().slice(0, 4) : 'TXT';
    }

    function renderAttachments() {
        ['#chat-attachments', '#agents-attachments'].forEach(sel => {
            const bar = $(sel);
            if (!bar) return;
            bar.innerHTML = '';
            bar.classList.toggle('has-items', state.attachments.length > 0);
            state.attachments.forEach((att, idx) => {
                const chip = document.createElement('div');
                chip.className = 'attach-chip';
                if (att.isImage) {
                    chip.innerHTML = `<div class="attach-thumb"><img src="${att.dataUrl}" alt=""></div>`;
                } else {
                    chip.innerHTML = `<div class="attach-thumb file"><span class="file-ext">${att.ext}</span></div>`;
                }
                const name = document.createElement('span');
                name.className = 'attach-name';
                name.textContent = att.name;
                chip.appendChild(name);

                const rm = document.createElement('button');
                rm.className = 'attach-remove';
                rm.textContent = '×';
                rm.title = (state.language === 'en') ? 'Remove' : 'Retirer';
                rm.addEventListener('click', () => {
                    state.attachments.splice(idx, 1);
                    renderAttachments();
                });
                chip.appendChild(rm);
                bar.appendChild(chip);
            });
        });
    }

    function addAttachment(file) {
        if (!file) return;
        const ext = fileExtLabel(file.name);
        if (file.type && file.type.startsWith('image/')) {
            // Read as a data URL so we have base64 for both the preview and the API.
            const reader = new FileReader();
            reader.onload = () => {
                state.attachments.push({ name: file.name, ext, isImage: true, mime: file.type, dataUrl: String(reader.result || '') });
                renderAttachments();
            };
            reader.readAsDataURL(file);
        } else {
            const reader = new FileReader();
            reader.onload = () => {
                state.attachments.push({ name: file.name, ext, isImage: false, content: String(reader.result || '') });
                renderAttachments();
            };
            reader.readAsText(file);
        }
    }

    // Build the AI payload from attachments (text injected into the message,
    // images returned as base64 for the vision APIs), then clear them.
    function consumeAttachments() {
        if (!state.attachments.length) return { aiText: '', names: [], images: [] };
        let aiText = '';
        const names = [];
        const images = [];
        state.attachments.forEach(att => {
            names.push(att.name);
            if (att.isImage) {
                const base64 = (att.dataUrl || '').split(',')[1] || '';
                if (base64) images.push({ mime: att.mime || 'image/png', data: base64 });
            } else {
                aiText += `\n[Fichier joint: ${att.name}]\n\`\`\`${att.ext.toLowerCase()}\n${att.content || ''}\n\`\`\`\n`;
            }
        });
        state.attachments = [];
        renderAttachments();
        return { aiText, names, images };
    }

    // Build a compact project context (file tree + open file) so the AI can
    // analyse the project directly, without having to run shell commands.
    async function projectContext() {
        if (!state.projectRoot) return '';
        try {
            const res = await fetch(`/api/tree?root=${encodeURIComponent(state.projectRoot)}`);
            if (!res.ok) return '';
            const data = await res.json();
            const files = data.files || [];
            if (!files.length) return '';
            let ctx = `\n\n[CONTEXTE DU PROJET — racine: ${state.projectRoot}]\nArborescence des fichiers:\n${files.join('\n')}`;
            if (data.truncated) ctx += '\n(liste tronquée)';
            if (state.activeFile && state.openFiles[state.activeFile]) {
                const c = state.openFiles[state.activeFile].content || '';
                ctx += `\n\n[Fichier actuellement ouvert: ${state.activeFile}]\n\`\`\`\n${c.slice(0, 8000)}\n\`\`\``;
            }
            return ctx;
        } catch { return ''; }
    }

    function setupAttachMenu(btnId, menuId) {
        const btn = $('#' + btnId), menu = $('#' + menuId);
        if (!btn || !menu) return;
        btn.addEventListener('click', e => {
            e.stopPropagation();
            $$('.attach-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
            menu.classList.toggle('open');
        });
        menu.querySelectorAll('button[data-attach]').forEach(item => {
            item.addEventListener('click', () => {
                if (item.dataset.attach === 'image' && item.classList.contains('disabled')) {
                    const lang = state.language || 'fr';
                    addMsg($(menuId === 'agents-attach-menu' ? '#agents-log' : '#chat-messages'), 'system', null,
                        lang === 'en' ? 'The selected model does not support images.'
                                      : "Le modèle sélectionné ne supporte pas les images.");
                    menu.classList.remove('open');
                    return;
                }
                const input = $('#attach-input');
                input.accept = item.dataset.attach === 'image' ? 'image/*' : '';
                input.click();
                menu.classList.remove('open');
            });
        });
    }
    setupAttachMenu('chat-attach-btn', 'chat-attach-menu');
    setupAttachMenu('agents-attach-btn', 'agents-attach-menu');
    document.addEventListener('click', () => $$('.attach-menu.open').forEach(m => m.classList.remove('open')));

    const attachInput = $('#attach-input');
    if (attachInput) attachInput.addEventListener('change', e => {
        [...e.target.files].forEach(addAttachment);
        e.target.value = '';
    });

    // --- Vision (image) compatibility per model (from official provider docs) ---
    function isVisionCompatible(model, submodel) {
        const s = (submodel || '').toLowerCase();
        switch (model) {
            case 'gemini': return true;                 // Gemini: fully multimodal
            case 'claude': return true;                 // Claude 3/3.5/3.7/4.x: vision
            case 'codex':                               // OpenAI: vision except the *-mini reasoning models
                return !(s.includes('o3-mini') || s.includes('o1-mini'));
            case 'grok':  return s.includes('grok-4');  // xAI: Grok 4 has vision, Grok 3 does not
            case 'mistral': return s.includes('pixtral'); // Mistral: only Pixtral models have vision
            case 'local': return /llava|vision|bakllava/.test(s); // Ollama: only vision models
            default: return false;
        }
    }
    function chatImagesAllowed() {
        return isVisionCompatible(modelSelect.value, submodelSelect.value);
    }
    function agentsImagesAllowed() {
        const checked = [...$$('.agent-check:checked')];
        if (!checked.length) return false;
        return checked.every(cb => {
            const agent = cb.dataset.agent;
            const card = $(`.agent-card[data-agent="${agent}"]`);
            const ms = card.querySelector('.agent-model-select');
            return isVisionCompatible(agent, ms ? ms.value : state.config.ollamaModel);
        });
    }
    function updateAttachAvailability() {
        const setMenu = (menuId, allowed) => {
            const menu = $('#' + menuId);
            if (!menu) return;
            const imgBtn = menu.querySelector('button[data-attach="image"]');
            if (imgBtn) {
                imgBtn.classList.toggle('disabled', !allowed);
                imgBtn.title = allowed ? '' : ((state.language === 'en')
                    ? 'Model not compatible with images' : 'Modèle non compatible avec les images');
            }
        };
        const chatAllowed = chatImagesAllowed();
        const agentsAllowed = agentsImagesAllowed();
        setMenu('chat-attach-menu', chatAllowed);
        setMenu('agents-attach-menu', agentsAllowed);

        // If the active view's model can't take images, drop any staged image.
        const agentsActive = $('#view-agents') && $('#view-agents').classList.contains('active');
        const allowedHere = agentsActive ? agentsAllowed : chatAllowed;
        if (!allowedHere && state.attachments.some(a => a.isImage)) {
            state.attachments = state.attachments.filter(a => !a.isImage);
            renderAttachments();
        }
    }

    const REASONING_MODES = {
        codex: [
            { label: 'HIGH', effort: 'high' },
            { label: 'MED', effort: 'medium' },
            { label: 'LOW', effort: 'low' },
            { label: 'OFF', effort: 'none' }
        ],
        claude: [
            { label: 'MAX', budget: 8192 },
            { label: 'HIGH', budget: 4096 },
            { label: 'MED', budget: 2048 },
            { label: 'LOW', budget: 1024 },
            { label: 'OFF', budget: 0 }
        ],
        gemini: [
            { label: 'MAX', budget: 4096 },
            { label: 'MED', budget: 2048 },
            { label: 'LOW', budget: 1024 },
            { label: 'OFF', budget: 0 }
        ],
        grok: [
            { label: 'MAX', budget: 4096 },
            { label: 'MED', budget: 2048 },
            { label: 'OFF', budget: 0 }
        ],
        mistral: [
            { label: 'ON', budget: 1 },
            { label: 'OFF', budget: 0 }
        ],
        local: [
            { label: 'MAX', budget: 2048 },
            { label: 'MED', budget: 1024 },
            { label: 'OFF', budget: 0 }
        ]
    };

    // Determine which agent acts as the lead (chef de projet) right now.
    function currentLeadAgent() {
        const checked = [...$$('.agent-check:checked')];
        if (checked.length === 0) return null;
        const agents = checked.map(cb => {
            const agent = cb.dataset.agent;
            const card = $(`.agent-card[data-agent="${agent}"]`);
            const roleSel = card.querySelector('.agent-role-select');
            const modelSel = card.querySelector('.agent-model-select');
            return {
                model: agent,
                submodel: modelSel ? modelSel.value : state.config.ollamaModel,
                role: roleSel ? roleSel.value : 'developer'
            };
        });
        const lead = agents.find(a => a.role === 'lead') || agents[0];
        return { model: lead.model, submodel: lead.submodel };
    }

    // The reasoning slider follows the chat model, or the LEAD agent in agents mode.
    function reasoningContext() {
        const agentsActive = $('#view-agents') && $('#view-agents').classList.contains('active');
        if (agentsActive) {
            const lead = currentLeadAgent();
            if (lead) return lead;
        }
        return { model: modelSelect.value, submodel: submodelSelect.value };
    }

    function isReasoningCompatible(model, submodel) {
        if (model === 'codex' && (submodel.startsWith('o1') || submodel.startsWith('o3') || submodel.startsWith('o4') || submodel.startsWith('gpt-5'))) return true;
        if (model === 'claude' && (submodel.includes('3-7') || submodel.includes('4.8') || submodel.includes('opus-4') || submodel.includes('sonnet-4'))) return true;
        if (model === 'gemini') return true;
        if (model === 'local' && submodel.includes('r1')) return true;
        if (model === 'grok' && (submodel.includes('reasoning') || submodel.includes('4.20-0309-reasoning'))) return true;
        if (model === 'mistral' && submodel.includes('magistral')) return true; // Magistral = reasoning model
        return false;
    }

    function updateSliderVisuals() {
        const sliderBar = $('#reasoning-slider-bar');
        if (!sliderBar) return;
        const handle = sliderBar.querySelector('.slider-handle');
        const notches = sliderBar.querySelectorAll('.slider-notch');
        const model = reasoningContext().model;
        const modes = REASONING_MODES[model] || REASONING_MODES.local;

        const totalLevels = modes.length;
        const currentLevel = state.reasoningLevel;
        
        let percentage = 100;
        if (totalLevels > 1) {
            percentage = (1 - (currentLevel / (totalLevels - 1))) * 100;
        }
        
        if (handle) handle.style.top = percentage + '%';

        notches.forEach(n => {
            const l = parseInt(n.dataset.level);
            n.classList.toggle('active', l === currentLevel);
        });
        sliderBar.querySelectorAll('.slider-dot').forEach(d => {
            d.classList.toggle('active', parseInt(d.dataset.level) === currentLevel);
        });
    }

    function checkReasoningCompatibility() {
        const { model, submodel } = reasoningContext();
        const sliderBar = $('#reasoning-slider-bar');
        if (!sliderBar) return;
        
        const compatible = isReasoningCompatible(model, submodel);
        const modes = REASONING_MODES[model] || REASONING_MODES.local;
        const track = sliderBar.querySelector('.slider-track');
        const handle = sliderBar.querySelector('.slider-handle');

        sliderBar.querySelectorAll('.slider-notch').forEach(n => n.remove());
        track.querySelectorAll('.slider-dot').forEach(d => d.remove());

        modes.forEach((m, idx) => {
            const levelFromBottom = modes.length - 1 - idx;
            const pct = modes.length > 1 ? (levelFromBottom / (modes.length - 1)) : 1;

            const notch = document.createElement('div');
            notch.className = 'slider-notch';
            if (levelFromBottom === modes.length - 1) notch.classList.add('notch-max');
            notch.dataset.level = levelFromBottom;
            notch.textContent = m.label;
            // Set dynamic top positioning to align perfectly with the track and handle
            notch.style.top = `calc(28px + ${(1 - pct) * 124}px)`;
            sliderBar.insertBefore(notch, track);

            // Small dot on the track marking this tier (palier).
            const dot = document.createElement('div');
            dot.className = 'slider-dot';
            dot.dataset.level = levelFromBottom;
            dot.style.top = ((1 - pct) * 100) + '%';
            track.insertBefore(dot, handle); // keep handle on top
        });
        
        if (compatible) {
            sliderBar.classList.remove('locked');
            if (state.reasoningLevel >= modes.length) {
                state.reasoningLevel = modes.length - 1;
            }
        } else {
            sliderBar.classList.add('locked');
            state.reasoningLevel = 0;
        }
        
        updateSliderVisuals();
    }

    function initReasoningSlider() {
        const sliderBar = $('#reasoning-slider-bar');
        if (!sliderBar) return;
        const handle = sliderBar.querySelector('.slider-handle');
        const track = sliderBar.querySelector('.slider-track');
        
        let tooltipTimeout = null;
        function showIncompatibleTooltip() {
            sliderBar.classList.add('show-tooltip');
            if (tooltipTimeout) clearTimeout(tooltipTimeout);
            tooltipTimeout = setTimeout(() => {
                sliderBar.classList.remove('show-tooltip');
            }, 2000);
        }

        sliderBar.addEventListener('click', e => {
            const notch = e.target.closest('.slider-notch');
            if (!notch) return;
            if (sliderBar.classList.contains('locked')) {
                showIncompatibleTooltip();
                return;
            }
            const level = parseInt(notch.dataset.level);
            state.reasoningLevel = level;
            updateSliderVisuals();
        });

        track.addEventListener('click', e => {
            if (sliderBar.classList.contains('locked')) {
                showIncompatibleTooltip();
                return;
            }
            const model = reasoningContext().model;
            const modes = REASONING_MODES[model] || REASONING_MODES.local;
            const totalLevels = modes.length;

            const trackRect = track.getBoundingClientRect();
            let yPercent = (e.clientY - trackRect.top) / trackRect.height;
            yPercent = Math.max(0, Math.min(1, yPercent));
            const percentage = yPercent * 100;
            
            let closestLevel = 0;
            let minDiff = Infinity;
            
            for (let i = 0; i < totalLevels; i++) {
                const targetPercentage = (1 - (i / (totalLevels - 1))) * 100;
                const diff = Math.abs(percentage - targetPercentage);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestLevel = i;
                }
            }
            
            state.reasoningLevel = closestLevel;
            updateSliderVisuals();
        });

        let isDragging = false;

        handle.addEventListener('mousedown', e => {
            if (sliderBar.classList.contains('locked')) {
                showIncompatibleTooltip();
                return;
            }
            isDragging = true;
            handle.classList.add('dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            const trackRect = track.getBoundingClientRect();
            let yPercent = (e.clientY - trackRect.top) / trackRect.height;
            yPercent = Math.max(0, Math.min(1, yPercent));
            const percentage = yPercent * 100;
            handle.style.top = percentage + '%';

            const model = reasoningContext().model;
            const modes = REASONING_MODES[model] || REASONING_MODES.local;
            const totalLevels = modes.length;
            
            let snapLevel = 0;
            let minDiff = Infinity;
            
            for (let i = 0; i < totalLevels; i++) {
                const targetPercentage = (1 - (i / (totalLevels - 1))) * 100;
                const diff = Math.abs(percentage - targetPercentage);
                if (diff < minDiff) {
                    minDiff = diff;
                    snapLevel = i;
                }
            }

            sliderBar.querySelectorAll('.slider-notch').forEach(n => {
                const l = parseInt(n.dataset.level);
                n.classList.toggle('active', l === snapLevel);
            });
            sliderBar.querySelectorAll('.slider-dot').forEach(d => {
                d.classList.toggle('active', parseInt(d.dataset.level) === snapLevel);
            });
        }

        function onMouseUp(e) {
            if (!isDragging) return;
            isDragging = false;
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            const trackRect = track.getBoundingClientRect();
            let yPercent = (e.clientY - trackRect.top) / trackRect.height;
            yPercent = Math.max(0, Math.min(1, yPercent));
            const percentage = yPercent * 100;

            const model = reasoningContext().model;
            const modes = REASONING_MODES[model] || REASONING_MODES.local;
            const totalLevels = modes.length;

            let level = 0;
            let minDiff = Infinity;
            
            for (let i = 0; i < totalLevels; i++) {
                const targetPercentage = (1 - (i / (totalLevels - 1))) * 100;
                const diff = Math.abs(percentage - targetPercentage);
                if (diff < minDiff) {
                    minDiff = diff;
                    level = i;
                }
            }

            state.reasoningLevel = level;
            updateSliderVisuals();
        }
    }

    // ==========================================================
    //  AUTHENTICATION (mandatory login at startup)
    // ==========================================================
    function showAuthError(msg) {
        const el = $('#auth-error');
        el.textContent = msg;
        el.classList.add('show');
    }
    function hideAuthError() { $('#auth-error').classList.remove('show'); }

    function showApp(email) {
        $('#auth-overlay').classList.add('hidden');
        $('#app').style.display = '';
        if (email) {
            const emailEl = $('#profile-email');
            if (emailEl) emailEl.textContent = email;
        }
    }
    function showAuthOverlay() {
        $('#auth-overlay').classList.remove('hidden');
        $('#app').style.display = 'none';
        // Wipe any in-memory chats so they can't be seen before re-login.
        state.conversations = [];
        state.currentConvId = null;
        state.chatHistory = [];
        state.contextTokens = 0;
        state.agentConversations = [];
        state.currentAgentConvId = null;
        $('#chat-messages').innerHTML = '';
        renderHistory();
        updateTokenMeter();
    }

    // Reopen the last project once the user is authenticated.
    function openSavedProject() {
        if (state.projectRoot) openProject(state.projectRoot, false);
    }

    function setupAuth() {
        // Toggle between login and register forms.
        $('#show-register').addEventListener('click', e => {
            e.preventDefault();
            hideAuthError();
            $('#login-form').classList.add('hidden');
            $('#register-form').classList.remove('hidden');
        });
        $('#show-login').addEventListener('click', e => {
            e.preventDefault();
            hideAuthError();
            $('#register-form').classList.add('hidden');
            $('#login-form').classList.remove('hidden');
        });

        // Login
        $('#login-form').addEventListener('submit', async e => {
            e.preventDefault();
            hideAuthError();
            const email = $('#login-email').value.trim();
            const password = $('#login-password').value;
            $('#login-password').value = ''; // avoid Chrome's "save password?" prompt
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (!res.ok) return showAuthError(data.error || 'Connexion impossible.');
                showApp(data.email);
                await loadUserChats();
                openSavedProject();
                syncOllamaModels(); setTimeout(syncOllamaModels, 3000);
            } catch { showAuthError('Erreur de connexion au serveur.'); }
        });

        // Register (password must be confirmed twice)
        $('#register-form').addEventListener('submit', async e => {
            e.preventDefault();
            hideAuthError();
            const email = $('#reg-email').value.trim();
            const password = $('#reg-password').value;
            const password2 = $('#reg-password2').value;
            if (password.length < 6) return showAuthError('Mot de passe trop court (6 caractères minimum).');
            if (password !== password2) return showAuthError('Les deux mots de passe ne correspondent pas.');
            // Clear the password fields so Chrome doesn't offer to save them.
            $('#reg-password').value = '';
            $('#reg-password2').value = '';
            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (!res.ok) return showAuthError(data.error || 'Création de compte impossible.');
                showApp(data.email);
                await loadUserChats();
                openSavedProject();
                syncOllamaModels(); setTimeout(syncOllamaModels, 3000);
            } catch { showAuthError('Erreur de connexion au serveur.'); }
        });

        // Logout
        const logoutBtn = $('#logout-btn');
        if (logoutBtn) logoutBtn.addEventListener('click', async () => {
            try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
            showAuthOverlay();
        });
    }

    async function checkAuthAndInit() {
        try {
            const res = await fetch('/api/auth/me');
            const data = await res.json();
            if (data && data.authenticated) {
                showApp(data.email);
                await loadUserChats();
                openSavedProject();
                syncOllamaModels(); setTimeout(syncOllamaModels, 3000);
            } else {
                showAuthOverlay();
            }
        } catch {
            showAuthOverlay();
        }
    }

    // ==========================================================
    //  UI: collapse sidebar / resize panels / collapse agent models / bounce
    // ==========================================================
    // One toggle (same icon, same place) collapses the sidebar to a thin rail.
    const sbToggle = $('#sidebar-toggle');
    if (sbToggle) sbToggle.addEventListener('click', () => {
        const collapsed = $('#sidebar').classList.toggle('collapsed');
        $('#app').classList.toggle('sidebar-collapsed', collapsed);
    });

    // Drag the edges to resize the sidebar and the AI panel.
    function makeResizer(id, target, side) {
        const handle = $('#' + id), el = $(target);
        if (!handle || !el) return;
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            const move = ev => {
                let w = side === 'left' ? ev.clientX : (window.innerWidth - ev.clientX);
                w = Math.max(180, Math.min(w, Math.round(window.innerWidth * 0.6)));
                el.style.width = w + 'px';
            };
            const up = () => {
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    }
    makeResizer('resizer-left', '#sidebar', 'left');
    makeResizer('resizer-right', '#ai-panel', 'right');

    // Collapse / expand the agent model cards (chevron = house roof).
    const agCollapse = $('#agents-collapse');
    if (agCollapse) agCollapse.addEventListener('click', () => {
        const collapsed = $('#agents-list').classList.toggle('collapsed');
        agCollapse.classList.toggle('collapsed', collapsed);
    });

    // Discreet bounce on any button click. Capture phase so it still fires for
    // buttons that call stopPropagation (e.g. the attach "+" button).
    document.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        b.classList.remove('bounce');
        void b.offsetWidth; // restart the animation
        b.classList.add('bounce');
    }, true);

    // ==========================================================
    //  INIT
    // ==========================================================
    loadState();
    initProfile();
    initRecentProjects();
    // The project is opened only after authentication (see openSavedProject),
    // because /api/files requires a valid session.
    updateSubmodelDropdown();
    applyModelColor();
    updateTokenMeter();
    initAgentModelDropdowns();
    initReasoningSlider();
    checkReasoningCompatibility();
    updateAttachAvailability();

    // Restore config inputs
    if (state.config.keys.openai) $('#key-openai').value = state.config.keys.openai;
    if (state.config.keys.anthropic) $('#key-anthropic').value = state.config.keys.anthropic;
    if (state.config.keys.google) $('#key-google').value = state.config.keys.google;
    if (state.config.keys.grok) $('#key-grok').value = state.config.keys.grok;
    if (state.config.keys.mistral) $('#key-mistral').value = state.config.keys.mistral;
    if (state.config.ollamaUrl) $('#ollama-url').value = state.config.ollamaUrl;
    renderOllamaModels();

    // Restore language settings and select binding
    const langSelect = $('#lang-select');
    if (langSelect) {
        langSelect.value = state.language || 'fr';
        langSelect.addEventListener('change', () => {
            state.language = langSelect.value;
            saveState();
            updateLanguage();
        });
    }
    updateLanguage();

    renderHistory();

    // Gate the app behind authentication.
    setupAuth();
    checkAuthAndInit();
});
