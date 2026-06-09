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