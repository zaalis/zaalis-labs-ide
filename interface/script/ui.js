//  DOM REFS (must be before INIT)
// ==========================================================
const modelSelect = $('#ai-model');
const submodelSelect = $('#ai-submodel');

// Solid colour for the closed model selector (gradients can't render there).
const MODEL_COLORS = { codex: '#3b82f6', claude: '#f97316', gemini: '#7c6cf0', grok: '#9ca3af', mistral: '#f59e0b', kimi: '#38bdf8', local: '#fafafa', gguf: '#34d399' };
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
// Submodel list per provider. Ollama + GGUF use the user's installed models.
function submodelsFor(model) {
    if (model === 'local') return (state.config.ollamaModels && state.config.ollamaModels.length) ? state.config.ollamaModels : SUBMODELS.local;
    if (model === 'gguf') return state.config.ggufModels || [];
    return SUBMODELS[model] || [];
}
function submodelLabelFor(model, s) {
    if (model === 'gguf') return s.replace(/\.gguf$/i, '');
    if (model === 'local') return /^hf\.co\//i.test(s) ? prettyModelLabel(s) : s;
    return modelLabel(s);
}
function updateSubmodelDropdown() {
    const model = modelSelect.value;
    const subs = submodelsFor(model);
    submodelSelect.innerHTML = '';
    subs.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = submodelLabelFor(model, s);
        opt.title = s;
        submodelSelect.appendChild(opt);
    });
}

// --- Lightweight toast notification (non-blocking, auto-dismiss) ---
function showToast(title, msg, opts = {}) {
    let stack = $('#toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toast-stack';
        document.body.appendChild(stack);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <span class="toast-icon">${opts.icon || '⚠️'}</span>
        <div class="toast-body">
            <div class="toast-title"></div>
            <div class="toast-msg"></div>
        </div>
        <button class="toast-close" aria-label="close">&times;</button>`;
    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-msg').textContent = msg;
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    let killed = false;
    const dismiss = () => {
        if (killed) return; killed = true;
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    };
    toast.querySelector('.toast-close').addEventListener('click', dismiss);
    setTimeout(dismiss, opts.duration || 8000);
}

// Parse the parameter count (in billions) from an Ollama model tag.
// "qwen3:8b" -> 8, "llama3.1:70b" -> 70, "gemma3:4b" -> 4, "llama3.2" -> null.
// Version numbers like the "3.2" in "llama3.2" are ignored (no trailing 'b').
function localModelSizeB(name) {
    if (!name) return null;
    const m = String(name).toLowerCase().match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/);
    return m ? parseFloat(m[1]) : null;
}

// Warn (once per model per session) that a small Ollama model may misbehave —
// e.g. fail to emit read/file blocks, hallucinate, or ignore instructions.
const warnedSmallModels = new Set();
function maybeWarnSmallLocalModel() {
    if (modelSelect.value !== 'local' && modelSelect.value !== 'gguf') return;
    const sub = submodelSelect.value;
    if (!sub || warnedSmallModels.has(sub)) return;
    const size = localModelSizeB(sub);
    const SMALL = 14; // below ~14B these local models become unreliable here
    if (size !== null && size >= SMALL) return; // big enough -> no warning
    warnedSmallModels.add(sub);
    const lang = state.language || 'fr';
    const pretty = (typeof prettyModelLabel === 'function' && /^hf\.co\//i.test(sub)) ? prettyModelLabel(sub) : sub;
    const title = TRANSLATIONS[lang]['ollama-small-title'] || 'Modèle local léger';
    const tmpl = TRANSLATIONS[lang]['ollama-small-msg'] ||
        'Le modèle « {model} » est petit. Il peut halluciner, ignorer des consignes (lecture/écriture de fichiers) ou bugger. Pour des résultats fiables, préférez un modèle ≥ 14B.';
    showToast(title, tmpl.replace('{model}', pretty), { icon: '⚠️', duration: 9000 });
}

modelSelect.addEventListener('change', () => {
    state.config.aiModel = modelSelect.value;
    updateSubmodelDropdown();
    
    // Auto-select the newest submodel for the newly chosen provider
    const model = modelSelect.value;
    const subs = submodelsFor(model);
    if (subs.length) {
        submodelSelect.value = subs[0]; // Newest model is first in the list
    }
    
    state.config.aiSubmodel = submodelSelect.value;
    saveState();
    
    createCustomSelect('ai-submodel');
    
    checkReasoningCompatibility();
    updateAttachAvailability();
    applyModelColor();
    updateTokenMeter();
    maybeWarnSmallLocalModel();
});
submodelSelect.addEventListener('change', () => {
    state.config.aiSubmodel = submodelSelect.value;
    saveState();

    checkReasoningCompatibility();
    updateAttachAvailability();
    updateTokenMeter();
    maybeWarnSmallLocalModel();
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
//  PROJECT MANAGEMENT
// ==========================================================
const projectDropdown = $('#project-dropdown');

$('#project-btn').addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = !projectDropdown.classList.contains('open');
    // Always re-render the recent list from localStorage when opening, so the
    // history shows up even when no project was auto-reopened at startup.
    if (willOpen) initRecentProjects();
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

const noProjBtn = $('#no-project-btn');
if (noProjBtn) {
    noProjBtn.addEventListener('click', e => {
        e.stopPropagation();
        projectDropdown.classList.remove('open');
        clearProject();
    });
}

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

function removeRecentProject(path) {
    let recent = getRecentProjects().filter(p => p !== path);
    localStorage.setItem('zaalis-recent', JSON.stringify(recent));
    syncRecentProjects(recent);
    initRecentProjects();
    if (state.projectRoot === path) {
        clearProject();
    }
}

function normalizeProjectPath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function conversationsForProject(projectPath, folderName, kind) {
    const storeKey = kind === 'agents' ? 'agentConversations' : 'conversations';
    const normalizedPath = normalizeProjectPath(projectPath);
    return (state[storeKey] || [])
        .filter(c => {
            if (c.projectPath && normalizeProjectPath(c.projectPath) === normalizedPath) return true;
            return !c.projectPath && c.project === folderName;
        })
        .sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0));
}

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
        const folderName = p.split(/[\\/]/).pop();
        
        // Row container
        const projectRow = document.createElement('div');
        projectRow.className = 'project-dropdown-row';
        projectRow.title = p;
        if (state.projectRoot === p) projectRow.classList.add('active');
        
        // Chevron button
        const chev = document.createElement('button');
        chev.className = 'proj-dropdown-chev-btn';
        chev.type = 'button';
        chev.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="proj-dropdown-chev"><polyline points="9 18 15 12 9 6"/></svg>`;
        
        // Project name button (opens project)
        const nameBtn = document.createElement('button');
        nameBtn.className = 'proj-dropdown-name-btn';
        nameBtn.type = 'button';
        nameBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <span></span>
        `;
        nameBtn.querySelector('span').textContent = folderName;
        projectRow.addEventListener('click', e => {
            if (chev.contains(e.target) || pencilBtn.contains(e.target) || trashBtn.contains(e.target)) {
                return;
            }
            projectDropdown.classList.remove('open');
            openProject(p, true);
        });

        // Pencil button (Nouveau chat)
        const pencilBtn = document.createElement('button');
        pencilBtn.className = 'proj-dropdown-action-btn pencil';
        pencilBtn.type = 'button';
        pencilBtn.title = lang === 'en' ? 'New chat here' : 'Nouveau chat ici';
        pencilBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
        pencilBtn.addEventListener('click', async e => {
            e.stopPropagation();
            projectDropdown.classList.remove('open');
            await openProject(p, true);
            const kind = (typeof activeKind === 'function') ? activeKind() : 'chat';
            if (typeof newConversation === 'function') {
                newConversation(kind);
            }
        });

        // Trash button (Supprimer)
        const trashBtn = document.createElement('button');
        trashBtn.className = 'proj-dropdown-action-btn trash';
        trashBtn.type = 'button';
        trashBtn.title = lang === 'en' ? 'Delete project' : 'Supprimer le projet';
        trashBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
        trashBtn.addEventListener('click', async e => {
            e.stopPropagation();
            const ok = await customConfirm(`"${folderName}"`, {
                title: lang === 'en' ? 'Remove this project?' : 'Supprimer ce projet ?',
                okText: lang === 'en' ? 'Delete' : 'Supprimer',
                danger: true
            });
            if (ok) {
                removeRecentProject(p);
            }
        });

        projectRow.appendChild(chev);
        projectRow.appendChild(nameBtn);
        projectRow.appendChild(pencilBtn);
        projectRow.appendChild(trashBtn);
        container.appendChild(projectRow);

        // Nested chats list container
        const chatsContainer = document.createElement('div');
        chatsContainer.className = 'project-dropdown-chats';
        
        chatsContainer.style.display = 'block';
        chev.querySelector('.proj-dropdown-chev').classList.toggle('expanded', true);
        
        // Toggle chats list expand
        chev.addEventListener('click', e => {
            e.stopPropagation();
            const isCollapsed = chatsContainer.style.display === 'none';
            chatsContainer.style.display = isCollapsed ? 'block' : 'none';
            chev.querySelector('.proj-dropdown-chev').classList.toggle('expanded', isCollapsed);
        });

        // Load nested chats
        const kind = (typeof activeKind === 'function') ? activeKind() : 'chat';
        const projectConvs = conversationsForProject(p, folderName, kind);

        if (projectConvs.length === 0) {
            chatsContainer.innerHTML = `<div class="dropdown-chat-empty">${lang === 'fr' ? 'Aucune conversation' : 'No conversations'}</div>`;
        } else {
            projectConvs.forEach(conv => {
                const chatRow = document.createElement('button');
                chatRow.className = 'dropdown-chat-item';
                chatRow.type = 'button';
                const currentStoreKey = kind === 'agents' ? 'currentAgentConvId' : 'currentConvId';
                if (state[currentStoreKey] === conv.id) {
                    chatRow.classList.add('active');
                }
                chatRow.innerHTML = `
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    <span></span>
                `;
                chatRow.querySelector('span').textContent = conv.title;
                chatRow.addEventListener('click', e => {
                    e.stopPropagation();
                    projectDropdown.classList.remove('open');
                    openProject(p, false);
                    if (typeof loadConversation === 'function') {
                        loadConversation(kind, conv.id);
                    }
                });
                chatsContainer.appendChild(chatRow);
            });
        }
        container.appendChild(chatsContainer);
    });
}

async function openProject(rootPath, isNew) {
    const switchingProject = state.projectRoot && state.projectRoot !== rootPath;

    state.projectRoot = rootPath;
    if (isNew) addRecentProject(rootPath);

    // Switching to a DIFFERENT project must drop the previous project's open
    // tabs/editor and force the AI context (project tree) to be re-injected on
    // the next message — otherwise the assistant keeps reasoning about the old
    // project. We mark the context dirty via lastContextRoot (read in sendChat).
    if (switchingProject) {
        state.openFiles = {};
        state.activeFile = null;
        if (typeof textarea !== 'undefined' && textarea) textarea.value = '';
        if (typeof renderTabs === 'function') renderTabs();
    }
    state.lastContextRoot = null; // re-inject project context for this root

    saveState();
    const nameEl = $('#project-name');
    // Retire le data-i18n : sinon updateLanguage() (changement de langue) réécrit
    // l'étiquette à « Aucun projet » alors qu'un projet est bien ouvert.
    nameEl.removeAttribute('data-i18n');
    nameEl.textContent = rootPath.split(/[\\/]/).pop();
    await loadFileTree();
    initRecentProjects();
}

// Drop the open project and return to a clean "no project" state — used by the
// classic "Aucun projet" chat group so the AI answers with no project context.
function clearProject() {
    if (!state.projectRoot) return;
    const lang = state.language || 'fr';
    state.projectRoot = null;
    state.openFiles = {};
    state.activeFile = null;
    state.lastContextRoot = null;
    if (typeof textarea !== 'undefined' && textarea) textarea.value = '';
    if (typeof renderTabs === 'function') renderTabs();
    const nameEl = $('#project-name');
    if (nameEl) {
        nameEl.setAttribute('data-i18n', 'no-project');
        nameEl.textContent = TRANSLATIONS[lang]['no-project'] || 'Aucun projet';
    }
    saveState();
    loadFileTree();        // empties the explorer (handles null root)
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
    const fileTree = $('#file-tree');
    if (!fileTree) return;
    const titleEl = document.querySelector('.sidebar-title span');
    const stack = $('#sidebar-stack');
    const lang = state.language || 'fr';

    if (!state.projectRoot) {
        document.body.classList.remove('project-open');
        if (stack) {
            stack.classList.add('no-project');
            stack.classList.remove('project-open');
        }
        if (titleEl) {
            titleEl.textContent = TRANSLATIONS[lang]['conversations-header'] || 'CONVERSATIONS';
            titleEl.removeAttribute('data-i18n');
        }
        fileTree.innerHTML = '';
        renderNoProjectConversations($('#sidebar-conversations-list'));
        return;
    }

    document.body.classList.add('project-open');
    if (stack) {
        stack.classList.remove('no-project');
        stack.classList.add('project-open');
    }
    if (titleEl) {
        titleEl.textContent = TRANSLATIONS[lang]['files-header'] || 'FICHIERS';
        titleEl.setAttribute('data-i18n', 'files-header');
    }
    fileTree.innerHTML = '';
    const files = await fetchFiles('');
    renderTree(files, fileTree, 0);
    renderSidebarConversations();
}

function renderNoProjectConversations(container) {
    if (!container) return;
    const lang = state.language || 'fr';
    const kind = (typeof activeKind === 'function') ? activeKind() : 'chat';
    const storeKey = kind === 'agents' ? 'agentConversations' : 'conversations';
    const curIdKey = kind === 'agents' ? 'currentAgentConvId' : 'currentConvId';
    const curId = state[curIdKey];
    
    const convs = (state[storeKey] || [])
        .filter(c => !c.project)
        .sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0));

    container.innerHTML = '';

    // "+ Nouveau chat" button at the top of the conversations list
    const newChatBtn = document.createElement('button');
    newChatBtn.className = 'sidebar-no-project-new-chat-btn';
    newChatBtn.type = 'button';
    newChatBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>${lang === 'fr' ? 'Nouveau chat' : 'New chat'}</span>
    `;
    newChatBtn.addEventListener('click', () => {
        if (typeof newConversation === 'function') {
            newConversation(kind);
        }
    });
    container.appendChild(newChatBtn);

    if (convs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'convo-empty';
        empty.textContent = TRANSLATIONS[lang]['history-empty'] || 'Aucune conversation';
        container.appendChild(empty);
        return;
    }

    convs.forEach(conv => {
        const row = document.createElement('div');
        row.className = 'convo-item' + (conv.id === curId ? ' active' : '');
        row.title = conv.date || '';
        
        const titleEl = document.createElement('span');
        titleEl.className = 'convo-title';
        titleEl.textContent = conv.title;
        titleEl.addEventListener('click', () => {
            if (typeof loadConversation === 'function') {
                loadConversation(kind, conv.id);
            }
        });
        
        const delBtn = document.createElement('button');
        delBtn.className = 'convo-del';
        delBtn.type = 'button';
        delBtn.title = lang === 'en' ? 'Delete' : 'Supprimer';
        delBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        `;
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (typeof deleteConversation === 'function') {
                deleteConversation(kind, conv.id);
            }
        });
        
        row.appendChild(titleEl);
        row.appendChild(delBtn);
        container.appendChild(row);
    });
}

function renderSidebarConversations() {
    const container = $('#sidebar-conversations-list');
    if (!container) return;

    const lang = state.language || 'fr';
    const kind = (typeof activeKind === 'function') ? activeKind() : 'chat';
    const curIdKey = kind === 'agents' ? 'currentAgentConvId' : 'currentConvId';
    const curId = state[curIdKey];
    const projectPath = state.projectRoot;
    const folderName = projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : '';
    if (!projectPath) {
        renderNoProjectConversations(container);
        return;
    }
    const convs = projectPath ? conversationsForProject(projectPath, folderName, kind) : [];

    container.innerHTML = '';

    const newChatBtn = document.createElement('button');
    newChatBtn.className = 'sidebar-no-project-new-chat-btn';
    newChatBtn.type = 'button';
    newChatBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>${lang === 'fr' ? 'Nouveau chat' : 'New chat'}</span>
    `;
    newChatBtn.addEventListener('click', () => {
        if (typeof newConversation === 'function') newConversation(kind);
    });
    container.appendChild(newChatBtn);

    if (!projectPath || convs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'convo-empty';
        empty.textContent = TRANSLATIONS[lang]['history-empty'] || 'Aucune conversation';
        container.appendChild(empty);
        return;
    }

    convs.forEach(conv => {
        const row = document.createElement('div');
        row.className = 'convo-item' + (conv.id === curId ? ' active' : '');
        row.title = conv.date || '';

        const titleEl = document.createElement('span');
        titleEl.className = 'convo-title';
        titleEl.textContent = conv.title;
        titleEl.addEventListener('click', () => {
            if (typeof loadConversation === 'function') loadConversation(kind, conv.id);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'convo-del';
        delBtn.type = 'button';
        delBtn.title = lang === 'en' ? 'Delete' : 'Supprimer';
        delBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        `;
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (typeof deleteConversation === 'function') deleteConversation(kind, conv.id);
        });

        row.appendChild(titleEl);
        row.appendChild(delBtn);
        container.appendChild(row);
    });
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

// ==========================================================
//  SYNTAX HIGHLIGHTING (lightweight, local, VS Code-like colors)
// ==========================================================
const escHL = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HL_KEYWORDS = '(?:const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|new|class|extends|super|this|self|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield|static|get|set|public|private|protected|def|lambda|pass|with|as|global|nonlocal|raise|except|and|or|not|is|None|True|False|print|fn|pub|use|mut|struct|enum|impl|trait|match|where|package|func|type|interface|map|range|defer|go|select|chan|namespace|using|include|sizeof|template|virtual|override|final|abstract|implements|module|require|then|begin|echo|local|nil|undefined|true|false|null)';
const HL_MASTER = new RegExp(
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*|<!--[\\s\\S]*?-->)' +        // 1 comment
    '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)' +   // 2 string
    '|(\\b0x[\\da-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)' +          // 3 number
    '|(\\b' + HL_KEYWORDS + '\\b)' +                                             // 4 keyword
    '|([A-Za-z_$][\\w$]*)(?=\\s*\\()' +                                          // 5 function call
    '|(\\b[A-Z][A-Za-z0-9_]*\\b)',                                              // 6 Type / Class
    'g'
);
function highlightCode(code) {
    let out = '', last = 0, m;
    HL_MASTER.lastIndex = 0;
    while ((m = HL_MASTER.exec(code)) !== null) {
        if (m.index > last) out += escHL(code.slice(last, m.index));
        const t = m[0];
        const cls = m[1] ? 'tok-comment' : m[2] ? 'tok-string' : m[3] ? 'tok-number'
            : m[4] ? 'tok-keyword' : (m[5] !== undefined ? 'tok-func' : 'tok-type');
        out += '<span class="' + cls + '">' + escHL(t) + '</span>';
        last = m.index + t.length;
        if (t.length === 0) HL_MASTER.lastIndex++;
    }
    out += escHL(code.slice(last));
    return out;
}
function syncEditorScroll() {
    const pre = $('#code-highlight');
    if (pre) { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; }
    const g = $('#line-gutter');
    if (g) g.scrollTop = textarea.scrollTop;
}
let _hlRaf = 0;
function renderHighlight() {
    const pre = $('#code-highlight');
    const code = pre && pre.querySelector('code');
    if (!code) return;
    const val = textarea.value;
    // Skip highlighting very large files so typing never lags.
    code.innerHTML = val.length > 200000 ? escHL(val) + '\n' : highlightCode(val) + '\n';
    syncEditorScroll();
}
function scheduleHighlight() {
    if (_hlRaf) cancelAnimationFrame(_hlRaf);
    _hlRaf = requestAnimationFrame(renderHighlight);
}

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
    renderHighlight();
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
        renderHighlight();

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
    scheduleHighlight();
    if (!fileData.unsaved) {
        fileData.unsaved = true;
        renderTabs();
    }
});

textarea.addEventListener('scroll', syncEditorScroll);

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
//  EDITOR RIGHT-CLICK MENU — ask the selected AI about the code
// ==========================================================
const editorCtxMenu = document.createElement('div');
editorCtxMenu.className = 'ctx-menu';
editorCtxMenu.id = 'editor-ctx-menu';
document.body.appendChild(editorCtxMenu);

function closeEditorCtx() { editorCtxMenu.classList.remove('open'); }

function editorCurrentLine() {
    const v = textarea.value, pos = textarea.selectionStart;
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos);
    if (end === -1) end = v.length;
    return { text: v.slice(start, end), lineNo: v.slice(0, start).split('\n').length };
}
const editorHasSelection = () => textarea.selectionStart !== textarea.selectionEnd;

function switchToChatView() {
    $$('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'chat'));
    $$('.ai-view').forEach(v => v.classList.toggle('active', v.id === 'view-chat'));
}

function editorCtxAction(scope) {
    const lang = state.language || 'fr';
    const file = state.activeFile || '';
    const ext = (file.split('.').pop() || '').toLowerCase();
    const v = textarea.value;
    let snippet, label;
    if (scope === 'selection') {
        snippet = v.slice(textarea.selectionStart, textarea.selectionEnd);
        label = `${file} (${lang === 'en' ? 'selection' : 'sélection'})`;
    } else if (scope === 'line') {
        const li = editorCurrentLine();
        snippet = li.text;
        label = `${file} (${lang === 'en' ? 'line' : 'ligne'} ${li.lineNo})`;
    } else {
        snippet = v;
        label = file;
    }
    switchToChatView();

    if (scope === 'add') {
        const input = $('#chat-input');
        input.value = (lang === 'en'
            ? `Here is \`${file}\` for context:\n\`\`\`${ext}\n${v}\n\`\`\`\n`
            : `Voici \`${file}\` pour le contexte :\n\`\`\`${ext}\n${v}\n\`\`\`\n`);
        input.dispatchEvent(new Event('input'));
        input.focus();
        return;
    }

    if (scope === 'explain') {
        // Explain the selection if there is one, otherwise the current line.
        let snip, lbl;
        if (editorHasSelection()) {
            snip = v.slice(textarea.selectionStart, textarea.selectionEnd);
            lbl = `${file} (${lang === 'en' ? 'selection' : 'sélection'})`;
        } else {
            const li = editorCurrentLine();
            snip = li.text;
            lbl = `${file} (${lang === 'en' ? 'line' : 'ligne'} ${li.lineNo})`;
        }
        sendChat(lang === 'en'
            ? `Explain clearly and simply what this code does and what it is for (from \`${lbl}\`). Do not modify anything, just explain.\n\n\`\`\`${ext}\n${snip}\n\`\`\``
            : `Explique clairement et simplement à quoi sert ce code et ce qu'il fait (extrait de \`${lbl}\`). Ne modifie rien, explique seulement.\n\n\`\`\`${ext}\n${snip}\n\`\`\``);
        return;
    }

    const prompt = lang === 'en'
        ? `Review the following code from \`${label}\`. Find errors, bugs and possible improvements. For now DO NOT modify anything: list the issues you find, then ask me whether you should fix them. After I confirm and you apply a fix, give me a short report of what you changed.\n\n\`\`\`${ext}\n${snippet}\n\`\`\``
        : `Analyse le code suivant de \`${label}\`. Repère les erreurs, bugs et améliorations possibles. Pour l'instant NE modifie rien : liste les problèmes trouvés, puis demande-moi si tu dois les corriger. Une fois que je confirme et que tu appliques une correction, fais-moi un court rapport de ce que tu as changé.\n\n\`\`\`${ext}\n${snippet}\n\`\`\``;
    sendChat(prompt);
}

function openEditorCtx(x, y) {
    const lang = state.language || 'fr';
    const sel = editorHasSelection();
    const spark = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l1.9 4.8L19 9.6l-4.8 1.9L12 16l-1.9-4.5L5 9.6l5.1-1.8z"/></svg>';
    let html = `<div class="ctx-label">${lang === 'en' ? 'Ask the AI' : 'Demander à l’IA'}</div>`;
    html += `<div class="ctx-item" data-scope="file">${spark}<span>${lang === 'en' ? 'Review the whole file' : 'Analyser le fichier'}</span></div>`;
    if (sel) html += `<div class="ctx-item" data-scope="selection">${spark}<span>${lang === 'en' ? 'Review the selection' : 'Analyser la sélection'}</span></div>`;
    else html += `<div class="ctx-item" data-scope="line">${spark}<span>${lang === 'en' ? 'Review this line' : 'Analyser la ligne'}</span></div>`;
    html += `<div class="ctx-sep"></div>`;
    html += `<div class="ctx-item" data-scope="add">${spark}<span>${lang === 'en' ? 'Add file to chat' : 'Ajouter le fichier au chat'}</span></div>`;
    html += `<div class="ctx-item" data-scope="explain">${spark}<span>${lang === 'en' ? 'Explain' : 'Explication'}</span></div>`;
    editorCtxMenu.innerHTML = html;
    editorCtxMenu.querySelectorAll('.ctx-item').forEach(it => {
        it.addEventListener('click', () => { const s = it.dataset.scope; closeEditorCtx(); editorCtxAction(s); });
    });
    editorCtxMenu.style.left = Math.min(x, window.innerWidth - 230) + 'px';
    editorCtxMenu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
    editorCtxMenu.classList.add('open');
}

textarea.addEventListener('contextmenu', e => {
    if (!state.activeFile) return;
    e.preventDefault();
    openEditorCtx(e.clientX, e.clientY);
});
document.addEventListener('click', e => { if (!editorCtxMenu.contains(e.target)) closeEditorCtx(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditorCtx(); });
window.addEventListener('blur', closeEditorCtx);

// ==========================================================
//  PROFILE
// ==========================================================
function initProfile() {
    $('#profile-pseudo').value = state.profile.pseudo;
    updateProfileUI();
}

// Persist the profile on the user's ACCOUNT (server-side), so the pseudo and
// photo are tied to the email and survive restarts / other machines.
function saveProfileToServer() {
    fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pseudo: state.profile.pseudo, photo: state.profile.photo || '' })
    }).catch(() => {});
}

// Apply the profile returned by the server (login / register / session check).
function applyServerProfile(profile) {
    if (profile && typeof profile === 'object') {
        if (profile.pseudo) state.profile.pseudo = profile.pseudo;
        state.profile.photo = profile.photo || '';
        saveState();
    }
    const pseudoInput = $('#profile-pseudo');
    if (pseudoInput) pseudoInput.value = state.profile.pseudo || '';
    updateProfileUI();
}

function updateProfileUI() {
    const lang = state.language || 'fr';
    const name = state.profile.pseudo || TRANSLATIONS[lang]['default-username'];
    const letter = name ? name.charAt(0).toUpperCase() : 'U';
    $('#profile-name').textContent = name;
    const removePhoto = $('#remove-profile-photo');

    if (state.profile.photo) {
        $('#profile-avatar').innerHTML = `<img src="${state.profile.photo}" alt="">`;
        $('#profile-avatar-large').innerHTML = `<img src="${state.profile.photo}" alt="">`;
    } else {
        $('#profile-avatar').textContent = letter;
        $('#profile-avatar-large').textContent = letter;
    }
    if (removePhoto) removePhoto.classList.toggle('hidden', !state.profile.photo);
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
        saveProfileToServer();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});

const removeProfilePhoto = $('#remove-profile-photo');
if (removeProfilePhoto) removeProfilePhoto.addEventListener('click', () => {
    state.profile.photo = '';
    const photoInput = $('#profile-photo-input');
    if (photoInput) photoInput.value = '';
    saveState();
    updateProfileUI();
    saveProfileToServer();
});

$('#save-profile').addEventListener('click', () => {
    state.profile.pseudo = $('#profile-pseudo').value.trim() || 'Utilisateur';
    saveState();
    updateProfileUI();
    $('#profile-popup').classList.remove('open');
    saveProfileToServer();
});

// MODEL SUB-SELECTOR — moved to top (before INIT)

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
            applyServerProfile(data.profile);
            await loadUserChats();
            openSavedProject();
            syncOllamaModels(); setTimeout(syncOllamaModels, 3000);
            if (typeof loadGgufModels === 'function') loadGgufModels();
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
            applyServerProfile(data.profile);
            await loadUserChats();
            openSavedProject();
            syncOllamaModels(); setTimeout(syncOllamaModels, 3000);
            if (typeof loadGgufModels === 'function') loadGgufModels();
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
            applyServerProfile(data.profile);
            await loadUserChats();
            openSavedProject();
            syncOllamaModels(); setTimeout(syncOllamaModels, 3000);
            if (typeof loadGgufModels === 'function') loadGgufModels();
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
    const sidebar = $('#sidebar');
    const app = $('#app');
    const collapsed = sidebar.classList.toggle('collapsed');
    app.classList.toggle('sidebar-collapsed', collapsed);

    if (collapsed) {
        const currentWidth = Math.round(sidebar.getBoundingClientRect().width);
        if (currentWidth > 80) sidebar.dataset.expandedWidth = currentWidth + 'px';
        sidebar.style.width = '46px';
        sidebar.style.minWidth = '46px';
    } else {
        const expandedWidth = sidebar.dataset.expandedWidth || '240px';
        sidebar.style.width = expandedWidth;
        sidebar.style.minWidth = '180px';
    }

    const projectBtn = $('#project-btn');
    const stack = $('#sidebar-stack');
    const profile = $('#sidebar-profile');
    const profileName = $('#profile-name');
    if (projectBtn) {
        projectBtn.style.maxWidth = collapsed ? '0' : '';
        projectBtn.style.paddingLeft = collapsed ? '0' : '';
        projectBtn.style.paddingRight = collapsed ? '0' : '';
        projectBtn.style.opacity = collapsed ? '0' : '';
        projectBtn.style.transform = collapsed ? 'translateX(-14px)' : '';
        projectBtn.style.pointerEvents = collapsed ? 'none' : '';
    }
    if (stack) {
        stack.style.opacity = collapsed ? '0' : '';
        stack.style.transform = collapsed ? 'translateX(-18px)' : '';
        stack.style.pointerEvents = collapsed ? 'none' : '';
    }
    if (profile) {
        profile.style.justifyContent = collapsed ? 'center' : '';
        profile.style.gap = collapsed ? '0' : '';
        profile.style.padding = collapsed ? '8px 0' : '';
    }
    if (profileName) {
        profileName.style.maxWidth = collapsed ? '0' : '';
        profileName.style.opacity = collapsed ? '0' : '';
        profileName.style.transform = collapsed ? 'translateX(-12px)' : '';
        profileName.style.pointerEvents = collapsed ? 'none' : '';
    }
});

// Drag the edges to resize the sidebar and the AI panel.
function makeResizer(id, target, side) {
    const handle = $('#' + id), el = $(target);
    if (!handle || !el) return;
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        handle.classList.add('dragging');
        el.classList.add('resizing-panel');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        let raf = 0;
        let nextWidth = el.getBoundingClientRect().width;
        const applyWidth = () => {
            el.style.width = nextWidth + 'px';
            raf = 0;
        };
        const move = ev => {
            let w = side === 'left' ? ev.clientX : (window.innerWidth - ev.clientX);
            nextWidth = Math.max(180, Math.min(w, Math.round(window.innerWidth * 0.6)));
            if (!raf) raf = requestAnimationFrame(applyWidth);
        };
        const up = () => {
            if (raf) { cancelAnimationFrame(raf); applyWidth(); }
            handle.classList.remove('dragging');
            el.classList.remove('resizing-panel');
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

const sidebarConvToggle = $('#sidebar-conversations-toggle');
if (sidebarConvToggle) sidebarConvToggle.addEventListener('click', () => {
    const section = $('#sidebar-conversations-section');
    if (!section) return;
    const collapsed = section.classList.toggle('collapsed');
    sidebarConvToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
});

const sidebarSplitter = $('#sidebar-splitter');
if (sidebarSplitter) sidebarSplitter.addEventListener('mousedown', e => {
    const stack = $('#sidebar-stack');
    const files = $('#sidebar-files-section');
    const conversations = $('#sidebar-conversations-section');
    if (!stack || !files || !conversations || conversations.classList.contains('collapsed')) return;
    e.preventDefault();
    sidebarSplitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const move = ev => {
        const rect = stack.getBoundingClientRect();
        const splitterH = sidebarSplitter.getBoundingClientRect().height || 9;
        const total = rect.height - splitterH;
        const minConvs = 112;
        const minFiles = 118;
        const next = Math.max(minConvs, Math.min(ev.clientY - rect.top, total - minFiles));
        conversations.style.flex = `0 0 ${Math.round(next)}px`;
        files.style.flex = '1 1 auto';
    };
    const up = () => {
        sidebarSplitter.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
});

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
    // The "jump to bottom" pill has its own translate-based bounce; the generic
    // scale bounce would override its translateY centering and make it jump.
    if (b.classList.contains('scroll-bottom-btn')) return;
    b.classList.remove('bounce');
    void b.offsetWidth; // restart the animation
    b.classList.add('bounce');
}, true);

// ==========================================================
//  SMART AUTO-SCROLL ("stick to bottom" + jump-to-bottom pill)
// ==========================================================
// While the AI streams, the message list should follow the text — but ONLY if
// the user is already at the bottom. The moment they scroll up to re-read, the
// view stops auto-following and a little down-arrow pill appears; clicking it
// gives a tiny bounce, smooth-scrolls to the bottom and re-engages following.
// Works identically for the Chat view and the Agents view.
const _scrollCtrls = new Map();
const PIN_THRESHOLD = 64; // px from the bottom that still counts as "at bottom"

function _pinCtrl(container) { return _scrollCtrls.get(container); }

function updatePinButton(container) {
    const c = _scrollCtrls.get(container);
    if (!c) return;
    const overflow = container.scrollHeight - container.clientHeight;
    // Show only when the user has scrolled up AND there is something to go down to.
    c.btn.classList.toggle('show', !c.pinned && overflow > 40);
}

function onContainerScroll(container) {
    const c = _scrollCtrls.get(container);
    if (!c || c.autoScrolling) return; // ignore our own programmatic scrolling
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    c.pinned = dist <= PIN_THRESHOLD;
    updatePinButton(container);
}

// Follow the bottom only if currently pinned (used by every streaming/append site).
function followScroll(container) {
    const c = _scrollCtrls.get(container);
    if (!c) { if (container) container.scrollTop = container.scrollHeight; return; }
    if (c.pinned) container.scrollTop = container.scrollHeight;
    updatePinButton(container);
}

// Force the view back to the bottom and re-pin (user sent a message / clicked the pill).
function forceScrollBottom(container, smooth) {
    const c = _scrollCtrls.get(container);
    if (!c) { if (container) container.scrollTop = container.scrollHeight; return; }
    c.pinned = true;
    c.autoScrolling = true;
    clearTimeout(c.autoTimer);
    const settle = () => {
        container.scrollTop = container.scrollHeight;
        updatePinButton(container);
    };
    if (smooth) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        requestAnimationFrame(settle);
        setTimeout(settle, 80);
        setTimeout(settle, 220);
        // Guard against the smooth-scroll's intermediate scroll events un-pinning us.
        c.autoTimer = setTimeout(() => { settle(); c.autoScrolling = false; c.pinned = true; updatePinButton(container); }, 460);
    } else {
        settle();
        c.autoScrolling = false;
        updatePinButton(container);
    }
}

function initScrollPins() {
    ['#chat-messages', '#agents-log'].forEach(sel => {
        const container = document.querySelector(sel);
        if (!container || _scrollCtrls.has(container)) return;

        // Wrap the scroller so the pill can be absolutely positioned over its bottom.
        const wrap = document.createElement('div');
        wrap.className = 'scroll-pin-wrap';
        container.parentNode.insertBefore(wrap, container);
        wrap.appendChild(container);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scroll-bottom-btn';
        btn.setAttribute('aria-label', 'Aller en bas');
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        wrap.appendChild(btn);

        const c = { container, btn, pinned: true, autoScrolling: false, autoTimer: 0 };
        _scrollCtrls.set(container, c);

        container.addEventListener('scroll', () => onContainerScroll(container), { passive: true });
        // Scrolling up with the wheel un-pins immediately, even mid-stream.
        container.addEventListener('wheel', e => {
            if (e.deltaY < 0 && !c.autoScrolling) { c.pinned = false; updatePinButton(container); }
        }, { passive: true });

        btn.addEventListener('pointerdown', e => {
            e.preventDefault();
            e.stopPropagation();
            forceScrollBottom(container, false);
        });
        btn.addEventListener('click', e => {
            e.stopPropagation();
            btn.classList.remove('pin-bounce');
            void btn.offsetWidth; // restart the bounce animation
            btn.classList.add('pin-bounce');
            forceScrollBottom(container, true);
        });
    });
}

// Scripts are deferred, so the DOM is parsed by now.
initScrollPins();

// ==========================================================
//  CUSTOM SELECT DROPDOWNS
// ==========================================================
function createCustomSelect(selectId, opts) {
    opts = opts || {};
    const select = document.getElementById(selectId);
    if (!select) return;

    select.style.display = 'none';

    // Remove existing wrapper if present (to avoid duplicates on reload)
    const existing = document.getElementById(`custom-select-${selectId}`);
    if (existing) existing.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select-container' + (opts.dropDown ? ' drop-down' : '');
    wrapper.id = `custom-select-${selectId}`;

    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    
    const triggerText = document.createElement('span');
    triggerText.className = 'custom-select-trigger-text';
    trigger.appendChild(triggerText);

    const arrow = document.createElement('div');
    arrow.className = 'custom-select-arrow';
    arrow.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 1L5 5L9 1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    trigger.appendChild(arrow);

    wrapper.appendChild(trigger);

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'custom-select-options';
    wrapper.appendChild(optionsContainer);

    select.parentNode.insertBefore(wrapper, select.nextSibling);

    function updateOptions() {
        optionsContainer.innerHTML = '';
        
        const selectedOption = select.options[select.selectedIndex];
        triggerText.textContent = selectedOption ? selectedOption.textContent : '';

        // Update color for model select trigger
        if (selectId === 'ai-model') {
            const colors = { codex: '#3b82f6', claude: '#f97316', gemini: '#7c6cf0', grok: '#9ca3af', mistral: '#f59e0b', local: '#fafafa', gguf: '#34d399' };
            triggerText.style.color = colors[select.value] || 'var(--text-0)';
        }
        trigger.title = selectedOption ? (selectedOption.title || selectedOption.textContent || '') : '';

        Array.from(select.options).forEach(opt => {
            const div = document.createElement('div');
            div.className = 'custom-select-option';
            if (opt.value === select.value) {
                div.classList.add('selected');
            }
            div.textContent = opt.textContent;
            div.dataset.value = opt.value;
            div.title = opt.title || opt.textContent;

            if (selectId === 'ai-model') {
                const colors = { codex: '#3b82f6', claude: '#f97316', gemini: '#7c6cf0', grok: '#9ca3af', mistral: '#f59e0b', local: '#fafafa', gguf: '#34d399' };
                div.style.color = colors[opt.value] || 'inherit';
                div.style.fontWeight = '600';
            }

            div.addEventListener('click', (e) => {
                e.stopPropagation();
                select.value = opt.value;
                select.dispatchEvent(new Event('change'));
                closeAllCustomSelects();
            });

            optionsContainer.appendChild(div);
        });
    }

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = wrapper.classList.contains('open');
        closeAllCustomSelects();
        if (!isOpen) {
            wrapper.classList.add('open');
        }
    });

    const observer = new MutationObserver(() => {
        updateOptions();
    });
    observer.observe(select, { childList: true, characterData: true, subtree: true });

    select.addEventListener('change', () => {
        updateOptions();
    });

    updateOptions();
}

function closeAllCustomSelects() {
    document.querySelectorAll('.custom-select-container').forEach(c => {
        c.classList.remove('open');
    });
}

document.addEventListener('click', () => {
    closeAllCustomSelects();
});

// Initialize on DOM load or immediately if ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        createCustomSelect('ai-model');
        createCustomSelect('ai-submodel');
    });
} else {
    createCustomSelect('ai-model');
    createCustomSelect('ai-submodel');
}
