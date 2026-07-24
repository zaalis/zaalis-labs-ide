//  SETTINGS MODAL
// ==========================================================
const SETTINGS_SECTION_TITLES = {
    general: 'settings-general-title',
    api: 'settings-api-keys-title',
    mcp: 'MCP',
    appearance: 'settings-appearance-title',
    models: 'settings-models-title',
    hardware: 'settings-hardware-title',
    project: 'settings-project-title',
    privacy: 'settings-privacy-title',
    updates: 'settings-updates-title',
    backup: 'settings-backup-title'
};

function setSettingsSection(section) {
    const key = SETTINGS_SECTION_TITLES[section] ? section : 'general';
    $$('.settings-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.settingsSection === key);
    });
    $$('.settings-pane').forEach(pane => {
        pane.classList.toggle('active', pane.dataset.settingsPane === key);
    });
    const title = $('#settings-active-title');
    if (title) {
        const i18nKey = SETTINGS_SECTION_TITLES[key];
        title.dataset.i18n = i18nKey;
        title.textContent = (TRANSLATIONS[state.language || 'fr'] && TRANSLATIONS[state.language || 'fr'][i18nKey]) || title.textContent;
    }
}

$$('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => setSettingsSection(btn.dataset.settingsSection));
});

// Small toast helper (title-less) on top of showToast().
function toast(msg, opts) {
    if (typeof showToast === 'function') showToast('', msg, Object.assign({ icon: '✓', duration: 4000 }, opts || {}));
}

// ----- Appearance: apply theme / density / font size to the whole app -----
function applyAppearance() {
    const c = state.config;
    document.body.classList.toggle('theme-light', c.theme === 'light');
    document.body.classList.toggle('density-compact', c.density === 'compact');
    document.body.classList.remove('font-small', 'font-large');
    if (c.fontSize === 'small') document.body.classList.add('font-small');
    else if (c.fontSize === 'large') document.body.classList.add('font-large');
}

// IDs of the settings <select> elements that should render as rounded custom
// dropdowns (opening downward).
const SETTINGS_SELECT_IDS = [
    'settings-lang-select', 'settings-terminal-profile', 'gguf-variant-select', 'gguf-ngl-select',
    'settings-theme-select', 'settings-density-select', 'settings-fontsize-select',
    'settings-default-chat-select', 'settings-default-agent-select',
    'settings-default-reasoning-select', 'settings-channel-select'
];
let _settingsSelectsReady = false;
function initSettingsCustomSelects() {
    if (_settingsSelectsReady) return;
    if (typeof createCustomSelect !== 'function') return;
    SETTINGS_SELECT_IDS.forEach(id => { if ($('#' + id)) createCustomSelect(id, { dropDown: true }); });
    _settingsSelectsReady = true;
}

function sharedHardwareConfigPayload() {
    const c = state.config || {};
    return {
        ollamaUrl: (c.ollamaUrl || 'http://127.0.0.1:11434').trim(),
        ollamaModel: c.ollamaModel || 'qwen3:8b',
        ggufCtx: clampGgufCtx(c.ggufCtx || 8192),
        ggufVariant: c.ggufVariant || '',
        ggufGpuLayers: (c.ggufGpuLayers === undefined || c.ggufGpuLayers === null) ? '' : c.ggufGpuLayers,
        terminalProfile: c.terminalProfile || 'cmd'
    };
}

// The server reports which shells actually exist on this PC; the missing ones
// stay listed but disabled so the choice is explainable rather than silent.
function populateTerminalProfiles(profiles) {
    const select = $('#settings-terminal-profile');
    if (!select || !Array.isArray(profiles)) return;
    select.replaceChildren(...profiles.map((profile) => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.label + (profile.available ? '' : ' (non installé)');
        option.disabled = !profile.available;
        return option;
    }));
    const saved = state.config.terminalProfile || 'cmd';
    state.config.terminalProfile = select.querySelector(`option[value="${saved}"]:not(:disabled)`) ? saved : 'cmd';
    select.value = state.config.terminalProfile;
}

function applySharedHardwareConfig(config) {
    if (!config || typeof config !== 'object') return;
    const c = state.config || {};
    if ('ollamaUrl' in config) c.ollamaUrl = String(config.ollamaUrl || '').trim() || 'http://127.0.0.1:11434';
    if ('ollamaModel' in config) c.ollamaModel = String(config.ollamaModel || '').trim() || 'qwen3:8b';
    if ('ggufCtx' in config) c.ggufCtx = clampGgufCtx(config.ggufCtx || 8192);
    if ('ggufVariant' in config) c.ggufVariant = String(config.ggufVariant || '').trim().toLowerCase();
    if ('ggufGpuLayers' in config) {
        const raw = config.ggufGpuLayers;
        c.ggufGpuLayers = (raw === '' || raw === undefined || raw === null) ? '' : (parseInt(raw, 10) || 0);
    }
    if ('terminalProfile' in config) c.terminalProfile = String(config.terminalProfile || 'cmd');
}

async function syncSharedHardwareConfig() {
    try {
        await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: sharedHardwareConfigPayload() })
        });
    } catch {}
}

async function loadSharedHardwareConfig() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const data = await res.json();
        if (data) populateTerminalProfiles(data.terminalProfiles);
        if (data && data.configured && data.config) {
            applySharedHardwareConfig(data.config);
            populateTerminalProfiles(data.terminalProfiles);
            saveState();
        } else {
            await syncSharedHardwareConfig();
        }
    } catch {}
}

// Push the current config values into the settings controls, then refresh the
// custom dropdown displays.
function populateSettingsControls() {
    const c = state.config;
    const setVal = (id, val) => {
        const el = $('#' + id);
        if (!el) return;
        el.value = (val === undefined || val === null) ? '' : String(val);
        el.dispatchEvent(new Event('change')); // refresh custom-select display
    };
    setVal('settings-lang-select', state.language || 'fr');
    setVal('gguf-variant-select', c.ggufVariant || '');
    setVal('gguf-ctx-input', clampGgufCtx(c.ggufCtx || 8192));
    setVal('gguf-ngl-select', c.ggufGpuLayers === '' ? '' : c.ggufGpuLayers);
    setVal('settings-theme-select', c.theme || 'dark');
    setVal('settings-density-select', c.density || 'normal');
    setVal('settings-fontsize-select', c.fontSize || 'normal');
    setVal('settings-default-chat-select', c.aiModel || 'codex');
    setVal('settings-default-agent-select', c.defaultAgentModel || 'codex');
    setVal('settings-default-reasoning-select', c.defaultReasoning || 0);
    setVal('settings-channel-select', c.updateChannel || 'stable');
    const folder = $('#settings-default-folder'); if (folder) folder.value = c.defaultProjectFolder || '';
    const reopen = $('#settings-reopen-toggle'); if (reopen) reopen.checked = !!c.reopenLastProject;
    const autoUp = $('#settings-autoupdate-toggle'); if (autoUp) autoUp.checked = c.autoCheckUpdates !== false;
}

$('#settings-btn').addEventListener('click', () => {
    if (typeof loadGgufModels === 'function') loadGgufModels();
    initSettingsCustomSelects();
    populateSettingsControls();
    // Refresh the API-key "Enregistrée ····1234" badges from the server every
    // time the panel opens, so they persist across restarts (the keys are stored
    // server-side; the badge state isn't in localStorage).
    if (typeof refreshSecureSettings === 'function') refreshSecureSettings();
    loadMcpSettings();
    setSettingsSection('general');
    $('#settings-modal').classList.add('active');
});
$('#close-modal').addEventListener('click', () => $('#settings-modal').classList.remove('active'));
$('#cancel-btn').addEventListener('click', () => $('#settings-modal').classList.remove('active'));
$('#settings-modal').addEventListener('click', e => { if (e.target.id === 'settings-modal') $('#settings-modal').classList.remove('active'); });

const API_KEY_FIELDS = ['openai', 'anthropic', 'google', 'grok', 'mistral'];

function updateApiKeyInputs(status) {
    const savedLabel = (state.language === 'en') ? 'Saved' : 'Enregistrée';
    API_KEY_FIELDS.forEach(provider => {
        const input = $('#key-' + provider);
        if (!input) return;
        const info = status && status[provider];
        const set = !!(info && info.set);
        input.value = '';
        // When a key is already stored, hint that leaving the field empty keeps it.
        input.placeholder = set
            ? '••••••••••••'
            : input.dataset.defaultPlaceholder || input.placeholder;

        // Discreet green "saved" badge next to the label.
        const badge = $('#key-status-' + provider);
        if (badge) {
            badge.classList.toggle('set', set);
            badge.innerHTML = set
                ? `${savedLabel}${info.last4 ? ` <span class="key-last4">····${info.last4}</span>` : ''}`
                : '';
        }
    });
}

async function loadApiKeyStatus() {
    try {
        const res = await fetch('/api/keys');
        if (!res.ok) return;
        const data = await res.json();
        updateApiKeyInputs(data.keys || {});
    } catch {}
}

async function migrateLegacyApiKeys() {
    if (!legacyApiKeysForMigration || !Object.keys(legacyApiKeysForMigration).length) return;
    try {
        const res = await fetch('/api/keys', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: legacyApiKeysForMigration })
        });
        if (res.ok) {
            legacyApiKeysForMigration = null;
            state.config.keys = { openai: '', anthropic: '', google: '', grok: '', mistral: '' };
            saveState();
            const data = await res.json();
            updateApiKeyInputs(data.keys || {});
        }
    } catch {}
}

async function refreshSecureSettings() {
    await migrateLegacyApiKeys();
    await loadApiKeyStatus();
}

let personalMcpServers = [];
function mcpId(value) {
    return String(value || 'mcp').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'mcp';
}
function mcpEscape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function newPersonalMcp(seed = {}) {
    return {
        id: seed.id || mcpId(seed.name || 'mcp-' + (personalMcpServers.length + 1)),
        name: seed.name || 'Nouveau MCP',
        endpoint: seed.endpoint || seed.url || '',
        enabled: seed.enabled !== false,
        token: '',
        tokenConfigured: !!seed.tokenConfigured,
        allow: Array.isArray(seed.allow) ? seed.allow : [],
        deny: Array.isArray(seed.deny) ? seed.deny : []
    };
}
function renderPersonalMcpServers() {
    const list = $('#mcp-personal-list');
    if (!list) return;
    if (!personalMcpServers.length) {
        list.innerHTML = '<div class="settings-status-row"><span>Aucun serveur personnel</span><strong>Prêt à ajouter</strong></div>';
        return;
    }
    list.innerHTML = personalMcpServers.map((server, index) => `
        <article class="mcp-server-card" data-mcp-index="${index}">
            <div class="form-group settings-row-group">
                <div class="settings-row-copy"><label>${mcpEscape(server.name || 'MCP personnel')}</label><p>Serveur Streamable HTTP personnel</p></div>
                <label class="zs-switch"><input class="mcp-enabled" type="checkbox" ${server.enabled ? 'checked' : ''}><span class="zs-slider"></span></label>
            </div>
            <div class="mcp-server-grid">
                <div class="form-group"><label>Nom</label><input class="mcp-name" value="${mcpEscape(server.name)}" maxlength="120"></div>
                <div class="form-group"><label>URL MCP</label><input class="mcp-endpoint" type="url" value="${mcpEscape(server.endpoint)}" placeholder="https://mcp.exemple.com/mcp ou http://127.0.0.1:9876/mcp" spellcheck="false"></div>
            </div>
            <div class="form-group"><label>Jeton Bearer <span class="form-hint">(optionnel${server.tokenConfigured ? ', déjà enregistré' : ''})</span></label><input class="mcp-token" type="password" value="" placeholder="${server.tokenConfigured ? 'Laisser vide pour conserver le jeton' : 'Aucun jeton requis si le serveur n’en demande pas'}" autocomplete="new-password"></div>
            <details class="form-group"><summary>Règles avancées</summary><div class="mcp-server-grid"><div class="form-group"><label>Autoriser (noms d’outils, séparés par virgules)</label><input class="mcp-allow" value="${mcpEscape(server.allow.join(', '))}"></div><div class="form-group"><label>Refuser</label><input class="mcp-deny" value="${mcpEscape(server.deny.join(', '))}"></div></div></details>
            <button class="btn btn-ghost mcp-action-btn mcp-remove" type="button">Retirer ce serveur</button>
        </article>`).join('');
    list.querySelectorAll('.mcp-server-card').forEach(card => {
        const index = Number(card.dataset.mcpIndex);
        const server = personalMcpServers[index];
        const sync = () => {
            server.name = card.querySelector('.mcp-name').value.trim() || 'MCP personnel';
            server.endpoint = card.querySelector('.mcp-endpoint').value.trim();
            server.enabled = card.querySelector('.mcp-enabled').checked;
            server.token = card.querySelector('.mcp-token').value.trim();
            server.allow = card.querySelector('.mcp-allow').value.split(',').map(v => v.trim()).filter(Boolean);
            server.deny = card.querySelector('.mcp-deny').value.split(',').map(v => v.trim()).filter(Boolean);
            server.id = server.id || mcpId(server.name);
        };
        card.querySelectorAll('input').forEach(input => input.addEventListener('change', sync));
        card.querySelector('.mcp-remove').addEventListener('click', () => { personalMcpServers.splice(index, 1); renderPersonalMcpServers(); });
    });
}
function parseImportedMcpConfig(value) {
    const raw = value && typeof value === 'object' ? value : {};
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.servers)) return raw.servers;
    if (raw.mcpServers && typeof raw.mcpServers === 'object') return Object.entries(raw.mcpServers).map(([name, config]) => ({ name, ...(config || {}) }));
    return [];
}
async function loadMcpSettings() {
    try {
        const [brainRes, mcpRes] = await Promise.all([fetch('/api/brain-mcp'), fetch('/api/mcp')]);
        if (brainRes.ok) {
            const brain = await brainRes.json();
            const status = $('#brain-mcp-status');
            if (status) status.textContent = brain.enabled ? (brain.configured ? '● Configuré' : '● À compléter') : 'Non configuré';
            if ($('#brain-mcp-enabled')) $('#brain-mcp-enabled').checked = !!brain.enabled;
            if ($('#brain-mcp-endpoint')) $('#brain-mcp-endpoint').value = brain.endpoint || '';
            if ($('#brain-mcp-token')) { $('#brain-mcp-token').value = ''; $('#brain-mcp-token').placeholder = brain.configured ? 'Laisser vide pour conserver le jeton' : 'Coller le jeton à 64 caractères'; }
        }
        if (mcpRes.ok) {
            const data = await mcpRes.json();
            personalMcpServers = Array.isArray(data.servers) ? data.servers.map(newPersonalMcp) : [];
            renderPersonalMcpServers();
        }
    } catch {}
}

$('#mcp-add-personal').addEventListener('click', () => { personalMcpServers.push(newPersonalMcp()); renderPersonalMcpServers(); });
$('#mcp-add-blender').addEventListener('click', () => {
    personalMcpServers.push(newPersonalMcp({ id: 'blender', name: 'Blender MCP', endpoint: 'http://127.0.0.1:9876/mcp', enabled: false }));
    renderPersonalMcpServers();
});
$('#mcp-import-config').addEventListener('click', () => $('#mcp-config-file').click());
$('#mcp-config-file').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
        const imported = parseImportedMcpConfig(JSON.parse(await file.text()));
        const usable = imported.filter(item => item && (item.url || item.endpoint));
        if (!usable.length) throw new Error('Aucun serveur HTTP importable');
        personalMcpServers.push(...usable.map(newPersonalMcp));
        renderPersonalMcpServers();
        toast(`${usable.length} serveur MCP importé${usable.length > 1 ? 's' : ''}.`);
    } catch {
        toast('Ce fichier ne contient pas de serveurs MCP HTTP importables. Les configurations stdio (command/args) doivent être exposées via une URL MCP.', { icon: '!' });
    } finally { event.target.value = ''; }
});

API_KEY_FIELDS.forEach(provider => {
    const input = $('#key-' + provider);
    if (input) input.dataset.defaultPlaceholder = input.placeholder;
});

$('#save-btn').addEventListener('click', async () => {
    const keys = {};
    API_KEY_FIELDS.forEach(provider => {
        const value = ($('#key-' + provider)?.value || '').trim();
        if (value) keys[provider] = value;
    });
    const settingsLang = $('#settings-lang-select');
    if (settingsLang && settingsLang.value) setLanguage(settingsLang.value);
    const variantSelect = $('#gguf-variant-select');
    if (variantSelect) state.config.ggufVariant = variantSelect.value || '';
    const ollamaUrlInput = $('#ollama-url');
    state.config.ollamaUrl = (ollamaUrlInput?.value || state.config.ollamaUrl || 'http://127.0.0.1:11434').trim();
    // Default Ollama model = first of the managed list.
    state.config.ollamaModel = (state.config.ollamaModels && state.config.ollamaModels[0]) || 'qwen3:8b';

    // ----- Appearance -----
    const c = state.config;
    const getVal = id => $('#' + id)?.value;
    c.theme = getVal('settings-theme-select') || 'dark';
    c.density = getVal('settings-density-select') || 'normal';
    c.fontSize = getVal('settings-fontsize-select') || 'normal';
    applyAppearance();
    // ----- Default models -----
    const defChat = getVal('settings-default-chat-select');
    if (defChat) c.aiModel = defChat;
    c.defaultAgentModel = getVal('settings-default-agent-select') || 'codex';
    c.defaultReasoning = parseInt(getVal('settings-default-reasoning-select') || '0', 10) || 0;
    // ----- Hardware advanced -----
    c.ggufCtx = clampGgufCtx(getVal('gguf-ctx-input') || '8192');
    const nglVal = getVal('gguf-ngl-select');
    c.ggufGpuLayers = (nglVal === '' || nglVal === undefined) ? '' : (parseInt(nglVal, 10) || 0);
    // ----- Integrated terminal -----
    const previousTerminalProfile = c.terminalProfile || 'cmd';
    const terminalProfileSelect = $('#settings-terminal-profile');
    if (terminalProfileSelect && terminalProfileSelect.value) c.terminalProfile = terminalProfileSelect.value;
    if (c.terminalProfile !== previousTerminalProfile) document.dispatchEvent(new CustomEvent('terminal-profile-changed'));
    // ----- Project -----
    c.defaultProjectFolder = ($('#settings-default-folder')?.value || '').trim();
    c.reopenLastProject = !!$('#settings-reopen-toggle')?.checked;
    // ----- Updates -----
    c.autoCheckUpdates = !!$('#settings-autoupdate-toggle')?.checked;
    c.updateChannel = getVal('settings-channel-select') || 'stable';
    if (typeof updateTokenMeter === 'function') updateTokenMeter();
    saveState();
    const btn = $('#save-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    try {
        const mcpRes = await fetch('/api/mcp', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers: personalMcpServers }) });
        if (!mcpRes.ok) throw new Error('MCP');
        const brainRes = await fetch('/api/brain-mcp', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!$('#brain-mcp-enabled')?.checked, endpoint: ($('#brain-mcp-endpoint')?.value || '').trim(), token: ($('#brain-mcp-token')?.value || '').trim() }) });
        if (!brainRes.ok) throw new Error('MCP');
        await syncSharedHardwareConfig();
        if (Object.keys(keys).length) {
            const res = await fetch('/api/keys', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys })
            });
            if (!res.ok) throw new Error('keys');
            const data = await res.json();
            updateApiKeyInputs(data.keys || {});
        }
        btn.textContent = 'OK';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; $('#settings-modal').classList.remove('active'); }, 500);
    } catch {
        btn.textContent = state.language === 'en' ? 'Error' : 'Erreur';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1200);
    }
});

// ----- Live preview: theme/density/font apply instantly when changed -----
// Listeners are attached directly to each <select> (custom-select dispatches a
// non-bubbling 'change' event, so document-level delegation would miss it).
[
    ['settings-theme-select', 'theme'],
    ['settings-density-select', 'density'],
    ['settings-fontsize-select', 'fontSize']
].forEach(([id, key]) => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', () => { state.config[key] = el.value; applyAppearance(); });
});

// ----- Project: default folder picker -----
const pickFolderBtn = $('#settings-pick-folder-btn');
if (pickFolderBtn) pickFolderBtn.addEventListener('click', async () => {
    try {
        const res = await fetch('/api/pick-folder', { method: 'POST' });
        const data = await res.json();
        if (data && data.path) {
            const inp = $('#settings-default-folder');
            if (inp) inp.value = data.path;
        }
    } catch {}
});

// ----- Privacy: delete history / keys / full reset -----
async function clearLocalHistory() {
    try {
        await fetch('/api/chats', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'chat', conversations: [] }) });
        await fetch('/api/chats', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agents', conversations: [] }) });
    } catch {}
    state.conversations = []; state.currentConvId = null; state.chatHistory = [];
    state.agentConversations = []; state.currentAgentConvId = null; state.contextTokens = 0;
    const cm = $('#chat-messages'); if (cm) cm.innerHTML = '';
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof updateTokenMeter === 'function') updateTokenMeter();
}

const clearHistBtn = $('#settings-clear-history-btn');
if (clearHistBtn) clearHistBtn.addEventListener('click', async () => {
    const ok = await customConfirm(
        state.language === 'en' ? 'Delete ALL local conversations? This cannot be undone.' : 'Supprimer TOUTES les conversations locales ? Action irréversible.',
        { danger: true, okText: state.language === 'en' ? 'Delete' : 'Supprimer' });
    if (!ok) return;
    await clearLocalHistory();
    toast(state.language === 'en' ? 'History deleted.' : 'Historique supprimé.');
});

const clearKeysBtn = $('#settings-clear-keys-btn');
if (clearKeysBtn) clearKeysBtn.addEventListener('click', async () => {
    const ok = await customConfirm(
        state.language === 'en' ? 'Remove all saved API keys?' : 'Supprimer toutes les clés API enregistrées ?',
        { danger: true, okText: state.language === 'en' ? 'Delete' : 'Supprimer' });
    if (!ok) return;
    try {
        const nulls = {}; API_KEY_FIELDS.forEach(p => nulls[p] = null);
        const res = await fetch('/api/keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: nulls }) });
        if (res.ok) { const data = await res.json(); updateApiKeyInputs(data.keys || {}); }
        state.config.keys = { openai: '', anthropic: '', google: '', grok: '', mistral: '' };
        toast(state.language === 'en' ? 'API keys deleted.' : 'Clés API supprimées.');
    } catch {}
});

const resetBtn = $('#settings-reset-btn');
if (resetBtn) resetBtn.addEventListener('click', async () => {
    const ok = await customConfirm(
        state.language === 'en' ? 'Full reset: erase all local settings, history and preferences on this device?' : 'Réinitialisation complète : effacer tous les réglages locaux, l\'historique et les préférences sur cet appareil ?',
        { danger: true, okText: state.language === 'en' ? 'Reset' : 'Réinitialiser' });
    if (!ok) return;
    await clearLocalHistory();
    try {
        const nulls = {}; API_KEY_FIELDS.forEach(p => nulls[p] = null);
        await fetch('/api/keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: nulls }) });
    } catch {}
    try {
        localStorage.removeItem('zaalis-state');
        localStorage.removeItem('zaalis-recent');
    } catch {}
    location.reload();
});

// ----- Updates: check now -----
const checkNowBtn = $('#settings-check-now-btn');
if (checkNowBtn) checkNowBtn.addEventListener('click', async () => {
    const en = state.language === 'en';
    const orig = TRANSLATIONS[state.language || 'fr']['settings-check-now-btn'] || (en ? 'Check' : 'Vérifier');
    checkNowBtn.disabled = true;
    checkNowBtn.textContent = en ? 'Checking…' : 'Recherche…';
    let result = en ? 'Up to date ✓' : 'Système à jour ✓';
    try {
        const res = await fetch('/api/check-update');
        const data = res.ok ? await res.json() : {};
        if (data && data.updateAvailable && data.downloadUrl) {
            result = en ? 'Update available' : 'Mise à jour dispo';
        }
        // Also refresh the topbar update badge.
        try { await checkForUpdates(); } catch {}
    } catch {
        result = en ? 'Check failed' : 'Échec de la vérif';
    }
    // Show the result inside the button, then revert to "Vérifier".
    checkNowBtn.textContent = result;
    setTimeout(() => { checkNowBtn.textContent = orig; checkNowBtn.disabled = false; }, 2500);
});

// ----- Backup: export / import config (NEVER includes API keys) -----
const exportBtn = $('#settings-export-btn');
if (exportBtn) exportBtn.addEventListener('click', () => {
    const { keys, ...safeConfig } = state.config;
    const payload = {
        _type: 'zaalis-config', _version: 1,
        config: safeConfig,
        language: state.language,
        profile: { pseudo: state.profile?.pseudo || '' }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'zaalis-config.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(state.language === 'en' ? 'Configuration exported.' : 'Configuration exportée.');
});

const importBtn = $('#settings-import-btn');
const importFile = $('#settings-import-file');
if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
        const file = importFile.files && importFile.files[0];
        importFile.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || data._type !== 'zaalis-config' || !data.config) throw new Error('format');
            // Never import API keys; keep the current (secure) ones untouched.
            const { keys, ...incoming } = data.config;
            Object.assign(state.config, incoming);
            if (data.language) state.language = data.language;
            if (data.profile && data.profile.pseudo) state.profile.pseudo = data.profile.pseudo;
            saveState();
            applyAppearance();
            if (typeof setLanguage === 'function') setLanguage(state.language);
            populateSettingsControls();
            toast(state.language === 'en' ? 'Configuration imported.' : 'Configuration importée.');
        } catch {
            toast(state.language === 'en' ? 'Invalid configuration file.' : 'Fichier de configuration invalide.');
        }
    });
}

// ----- Ollama models manager (Settings) -----
function renderOllamaModels() {
    const box = $('#ollama-models-list');
    if (!box) return;
    const list = _installedModels.size ? Array.from(_installedModels).sort() : (state.config.ollamaModels || []);
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
function setAgentModelOptions(sel, list, labeler, emptyLabel) {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    if (!list.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = emptyLabel;
        o.disabled = true;
        o.selected = true;
        sel.appendChild(o);
        return;
    }
    list.forEach(s => {
        const o = document.createElement('option');
        o.value = s;
        o.textContent = labeler(s);
        o.title = s;
        sel.appendChild(o);
    });
    if (list.includes(prev)) sel.value = prev;
}
function refreshOllamaAgentSelect() {
    const list = (state.config.ollamaModels && state.config.ollamaModels.length) ? state.config.ollamaModels : SUBMODELS.local;
    setAgentModelOptions(
        $('.agent-model-select[data-agent="local"]'),
        list,
        s => /^hf\.co\//i.test(s) ? prettyModelLabel(s) : s,
        state.language === 'en' ? 'No Ollama model' : 'Aucun modele Ollama'
    );
}
function refreshGgufAgentSelect() {
    setAgentModelOptions(
        $('.agent-model-select[data-agent="gguf"]'),
        state.config.ggufModels || [],
        s => String(s || '').replace(/\.gguf$/i, ''),
        (TRANSLATIONS[state.language || 'fr'] && TRANSLATIONS[state.language || 'fr']['gguf-agent-empty']) || 'Aucun modele GGUF installe'
    );
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
        const url = encodeURIComponent($('#ollama-url').value.trim() || 'http://127.0.0.1:11434');
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
let _installedGgufModels = new Set();       // installed *.gguf file names
let catalogInstallTarget = 'gguf';          // 'gguf' by default; Ollama stays available
const normName = n => (n && n.includes(':')) ? n : (n + ':latest');
function isInstalled(name) {
    if (_installedModels.has(normName(name))) return true;
    // HF models: match by prefix (quant suffix may differ).
    for (const m of _installedModels) { if (m.startsWith(name + ':') || m === name) return true; }
    return false;
}
async function refreshInstalled() {
    try {
        const url = encodeURIComponent(state.config.ollamaUrl || 'http://127.0.0.1:11434');
        const res = await fetch('/api/ollama-models?url=' + url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        _installedModels = new Set((data.models || []).map(normName));
    } catch { _installedModels = new Set((state.config.ollamaModels || []).map(normName)); }
}
function ggufFileName(fileOrPath) {
    return String(fileOrPath || '').split(/[\\/]/).pop();
}
function isGgufInstalled(file) {
    const base = ggufFileName(file).toLowerCase();
    if (!base) return false;
    for (const m of _installedGgufModels) {
        if (m.toLowerCase() === base) return true;
    }
    return false;
}
async function refreshGgufInstalled() {
    await loadGgufModels();
    _installedGgufModels = new Set(state.config.ggufModels || []);
}
async function refreshCatalogInstalled() {
    if (catalogInstallTarget === 'gguf') await refreshGgufInstalled();
    else await refreshInstalled();
}
function cardTarget(card) {
    return card?.dataset?.target || catalogInstallTarget || 'gguf';
}

// Build the action button(s) inside a catalog card based on install state.
function setCardActions(card, name) {
    const lang = state.language || 'fr';
    const actions = card.querySelector('.cat-actions');
    const target = cardTarget(card);
    const ggufFile = card.dataset.ggufFile || '';
    const installed = target === 'gguf' ? (ggufFile && isGgufInstalled(ggufFile)) : isInstalled(name);
    actions.innerHTML = '';
    if (installed) {
        const un = document.createElement('button');
        un.className = 'cat-uninstall'; un.type = 'button';
        un.textContent = lang === 'en' ? 'Uninstall' : 'Désinstaller';
        un.addEventListener('click', () => target === 'gguf' ? uninstallGgufModel(ggufFile, card) : uninstallModel(name, card));
        actions.appendChild(un);
    } else {
        const ins = document.createElement('button');
        ins.className = 'cat-install'; ins.type = 'button';
        ins.textContent = lang === 'en' ? 'Install' : 'Installer';
        ins.addEventListener('click', () => {
            if (target === 'gguf') {
                card.dataset.ggufFile ? installGgufFromCatalog(card.dataset.ggufRepo, card.dataset.ggufFile, card) : expandQuants(card);
            } else {
                // HF models -> let the user pick a quantization first (like LM Studio).
                card.dataset.hf === '1' ? expandQuants(card) : installModel(name, card);
            }
        });
        actions.appendChild(ins);
    }
}

function buildCard(name, label, size, tags, desc, extra, isHf, opts = {}) {
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.dataset.name = name;
    if (isHf) card.dataset.hf = '1';
    card.dataset.target = opts.target || catalogInstallTarget;
    if (opts.ggufRepo) card.dataset.ggufRepo = opts.ggufRepo;
    if (opts.ggufFile) card.dataset.ggufFile = opts.ggufFile;
    card.innerHTML = `
        <div class="cat-top"><span class="cat-name">${label}</span><span class="cat-size">${size || ''}</span></div>
        ${(tags && tags.length) ? `<div class="cat-tags">${tags.map(t => `<span class="cat-tag ${t}">${t}</span>`).join('')}</div>` : ''}
        <div class="cat-desc">${desc || ''}</div>
        ${extra || ''}
        <div class="cat-actions"></div>
        <div class="cat-progress" style="display:none"><div class="pbar"><div class="pfill"></div></div><div class="ptext"></div></div>`;
    const nameEl = card.querySelector('.cat-name');
    if (nameEl) nameEl.title = label || name;
    setCardActions(card, name);
    return card;
}

// Open a clean modal to pick a quantization (Q4_K_M, Q6_K, Q8_0...).
async function expandQuants(card) {
    const lang = state.language || 'fr';
    const target = cardTarget(card);
    const repo = (card.dataset.ggufRepo || card.dataset.name || '').replace(/^hf\.co\//, '');
    const grid = $('#quant-grid');
    $('#quant-title').textContent = (lang === 'en' ? 'Choose a version — ' : 'Choisir une version — ') + repo.split('/').pop();
    grid.innerHTML = `<div class="catalog-empty">${lang === 'en' ? 'Loading options…' : 'Chargement…'}</div>`;
    $('#quant-modal').classList.add('active');
    let quants = [];
    try {
        const res = await fetch('/api/hf-files?id=' + encodeURIComponent(repo));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        quants = data.quants || [];
    } catch {}
    if (!quants.length) {
        $('#quant-modal').classList.remove('active');
        if (target === 'gguf') {
            showToast(lang === 'en' ? 'No GGUF file' : 'Aucun fichier GGUF',
                lang === 'en' ? 'No downloadable GGUF file was found for this model.' : 'Aucun fichier GGUF telechargeable trouve pour ce modele.',
                { icon: '!' });
        } else {
            installModel('hf.co/' + repo, card); // no quant detected -> install repo default
        }
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
            if (target === 'gguf') {
                if (!qd.file) {
                    showToast(lang === 'en' ? 'Missing file' : 'Fichier manquant',
                        lang === 'en' ? 'No GGUF file was returned for this quantization.' : 'Aucun fichier GGUF retourne pour cette quantization.',
                        { icon: '!' });
                    return;
                }
                installGgufFromCatalog(repo, qd.file, card);
            } else {
                installModel('hf.co/' + repo + ':' + qd.quant, card);
            }
        });
        grid.appendChild(opt);
    });
}

// Detect actually-installed Ollama models and use them as the model list.
async function syncOllamaModels() {
    try {
        const url = encodeURIComponent(state.config.ollamaUrl || 'http://127.0.0.1:11434');
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

// ----- GGUF models manager (local llama.cpp engine — no Ollama) -----
function renderGgufModels() {
    const box = $('#gguf-models-list');
    if (!box) return;
    const list = state.config.ggufModels || [];
    box.innerHTML = '';
    if (!list.length) {
        box.innerHTML = `<span class="ollama-empty">${state.language === 'en' ? 'No GGUF model installed yet.' : 'Aucun modèle GGUF installé.'}</span>`;
        return;
    }
    list.forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'ollama-chip';
        const span = document.createElement('span');
        span.textContent = name.replace(/\.gguf$/i, '');
        span.title = name;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '×';
        rm.title = state.language === 'en' ? 'Delete' : 'Supprimer';
        rm.addEventListener('click', () => deleteGguf(name));
        chip.appendChild(span);
        chip.appendChild(rm);
        box.appendChild(chip);
    });
}

// Fetch installed GGUF models + engine status from the server.
async function loadGgufModels() {
    try {
        const res = await fetch('/api/gguf-models');
        if (!res.ok) return;
        const data = await res.json();
        state.config.ggufModels = (data.models || []).map(m => m.name);
        saveState();
        const st = $('#gguf-engine-status');
        if (st) {
            const v = (data.variant || 'cpu').toUpperCase();
            const selected = state.config.ggufVariant ? state.config.ggufVariant.toUpperCase() : v;
            st.textContent = (state.language === 'en' ? 'Engine: ' : 'Moteur : ') + selected + (data.running ? ' • ON' : '');
        }
        const detected = $('#gguf-detected-variant');
        if (detected) detected.textContent = (data.variant || 'cpu').toUpperCase();
        const autoOpt = $('#gguf-variant-select option[value=""]');
        if (autoOpt) {
            const v = (data.variant || 'cpu').toUpperCase();
            autoOpt.textContent = state.language === 'en' ? `Auto (${v})` : `Auto (${v})`;
        }
        renderGgufModels();
        refreshGgufAgentSelect();
        if (modelSelect.value === 'gguf') {
            updateSubmodelDropdown();
            if (typeof createCustomSelect === 'function') createCustomSelect('ai-submodel');
        }
        // Keep the topbar model loader in sync with installed models + engine state.
        if (typeof syncModelLoader === 'function') syncModelLoader(data);
    } catch {}
}

async function deleteGguf(name) {
    const lang = state.language || 'fr';
    try {
        const res = await fetch('/api/gguf-delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    } catch (e) {
        showToast(lang === 'en' ? 'Delete failed' : 'Suppression impossible', e.message || String(e), { icon: '!' });
    }
    await loadGgufModels();
    if (!$('#catalog-pane-installed')?.classList.contains('hidden')) renderInstalledCatalog();
}

// Download a GGUF from a HF repo+file (or a direct URL), streaming progress.
let _ggufPulling = false;
async function installGguf() {
    if (_ggufPulling) return;
    const lang = state.language || 'fr';
    const repo = ($('#gguf-repo-input').value || '').trim();
    const fileOrUrl = ($('#gguf-file-input').value || '').trim();
    let qs = '';
    if (/^https?:\/\//i.test(repo)) qs = 'url=' + encodeURIComponent(repo);
    else if (/^https?:\/\//i.test(fileOrUrl)) qs = 'url=' + encodeURIComponent(fileOrUrl);
    else if (repo && fileOrUrl) qs = 'repo=' + encodeURIComponent(repo) + '&file=' + encodeURIComponent(fileOrUrl);
    else {
        showToast(lang === 'en' ? 'Missing info' : 'Info manquante',
            lang === 'en' ? 'Enter a HF repo + a .gguf file, or a full URL.' : 'Entre un repo HF + un fichier .gguf, ou une URL complète.',
            { icon: 'ℹ️' });
        return;
    }

    const prog = $('#gguf-progress'), fill = $('#gguf-pfill'), text = $('#gguf-ptext');
    if (prog) prog.style.display = 'block';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = lang === 'en' ? 'Starting…' : 'Démarrage…';
    _ggufPulling = true;
    try {
        const res = await fetch('/api/gguf-pull?' + qs);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const mb = n => (n / 1e6).toFixed(0);
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                if (o.status === 'downloading' && o.total) {
                    const pct = Math.round(o.completed / o.total * 100);
                    if (fill) fill.style.width = pct + '%';
                    if (text) text.textContent = `${pct}% (${mb(o.completed)} / ${mb(o.total)} Mo)`;
                } else if (o.status === 'success') {
                    if (fill) fill.style.width = '100%';
                    if (text) text.textContent = lang === 'en' ? 'Installed ✓' : 'Installé ✓';
                } else if (o.status === 'error') {
                    if (text) text.textContent = (lang === 'en' ? 'Error: ' : 'Erreur : ') + (o.error || '');
                }
            }
        }
        $('#gguf-repo-input').value = '';
        $('#gguf-file-input').value = '';
        await loadGgufModels();
    } catch (e) {
        if (text) text.textContent = (lang === 'en' ? 'Error: ' : 'Erreur : ') + (e.message || e);
    } finally {
        _ggufPulling = false;
        setTimeout(() => { if (prog) prog.style.display = 'none'; }, 2500);
    }
}

const ggAdd = $('#gguf-model-add');
if (ggAdd) ggAdd.addEventListener('click', installGguf);
['#gguf-repo-input', '#gguf-file-input'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); installGguf(); } });
});

// Curated catalog (filtered by the unified search bar).
function renderCatalog() {
    const grid = $('#catalog-grid');
    if (!grid) return;
    const q = ($('#catalog-search-input') ? $('#catalog-search-input').value.trim().toLowerCase() : '');
    const source = catalogInstallTarget === 'gguf' ? (window.GGUF_CATALOG || []) : (window.OLLAMA_CATALOG || []);
    const list = source.filter(m => {
        if (!q) return true;
        return ((m.name || m.repo || '') + ' ' + m.label + ' ' + (m.desc || '') + ' ' + (m.tags || []).join(' ')).toLowerCase().includes(q);
    });
    grid.innerHTML = '';
    if (!list.length) { grid.innerHTML = `<div class="catalog-empty">${state.language === 'en' ? 'No model.' : 'Aucun modèle.'}</div>`; return; }
    list.forEach(m => {
        if (catalogInstallTarget === 'gguf') {
            grid.appendChild(buildCard('hf.co/' + m.repo, m.label, m.size, m.tags, m.desc, '', true, {
                target: 'gguf',
                ggufRepo: m.repo,
                ggufFile: m.file || '',
            }));
        } else {
            grid.appendChild(buildCard(m.name, m.label, m.size, m.tags, m.desc, '', false, { target: 'ollama' }));
        }
    });
}

function renderInstalledCatalog() {
    const grid = $('#installed-grid');
    if (!grid) return;
    const lang = state.language || 'fr';
    const q = ($('#catalog-search-input') ? $('#catalog-search-input').value.trim().toLowerCase() : '');
    grid.innerHTML = '';
    if (catalogInstallTarget === 'gguf') {
        const source = state.config.ggufModels || [];
        const list = source.filter(file => {
            if (!q) return true;
            return String(file || '').replace(/\.gguf$/i, '').toLowerCase().includes(q);
        });
        if (!list.length) {
            grid.innerHTML = `<div class="catalog-empty">${q ? (lang === 'en' ? 'No installed GGUF model matches.' : 'Aucun modele GGUF installe ne correspond.') : (lang === 'en' ? 'No GGUF model installed.' : 'Aucun modele GGUF installe.')}</div>`;
            return;
        }
        list.forEach(file => {
            const label = file.replace(/\.gguf$/i, '');
            grid.appendChild(buildCard('gguf://' + file, label, '', ['local'], lang === 'en' ? 'Installed local GGUF model.' : 'Modele GGUF local installe.', '', false, {
                target: 'gguf',
                ggufRepo: '',
                ggufFile: file,
            }));
        });
        return;
    }

    const source = _installedModels.size ? Array.from(_installedModels).sort() : (state.config.ollamaModels || []);
    const list = source.filter(name => !q || String(name || '').toLowerCase().includes(q));
    if (!list.length) {
        grid.innerHTML = `<div class="catalog-empty">${q ? (lang === 'en' ? 'No installed Ollama model matches.' : 'Aucun modele Ollama installe ne correspond.') : (lang === 'en' ? 'No Ollama model installed.' : 'Aucun modele Ollama installe.')}</div>`;
        return;
    }
    list.forEach(name => {
        grid.appendChild(buildCard(name, name, '', ['local'], lang === 'en' ? 'Installed Ollama model.' : 'Modele Ollama installe.', '', false, { target: 'ollama' }));
    });
}

// --- Hugging Face helpers ---
async function fetchHf(q, sort, limit) {
    const res = await fetch(`/api/hf-search?q=${encodeURIComponent(q || '')}&sort=${sort}&limit=${limit}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
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
        grid.appendChild(buildCard(name, repo, estimateGgufSize(m.id), (m.tags || []).slice(0, 4), desc, extra, true, {
            target: catalogInstallTarget,
            ggufRepo: m.id,
        }));
    });
}

// Default HF view (empty search): trending + most downloaded sections.
async function showHfDefault() {
    $('#hf-default').classList.remove('hidden');
    $('#hf-grid').classList.add('hidden');
    const pop = $('#hf-popular'), dl = $('#hf-downloads');
    const ld = `<div class="catalog-empty">${state.language === 'en' ? 'Loading…' : 'Chargement…'}</div>`;
    pop.innerHTML = ld;
    dl.innerHTML = ld;
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

// ==========================================================
//  AUTO-UPDATE LOGIC
// ==========================================================
let pendingUpdateUrl = null;
let downloadedUpdatePath = null;

async function checkForUpdates() {
    try {
        // Use server-side proxy to avoid CSP/CORS issues
        const res = await fetch('/api/check-update');
        if (!res.ok) return;
        const data = await res.json();

        const btn = document.getElementById('app-update-btn');
        if (data.downloadUrl && data.updateAvailable) {
            pendingUpdateUrl = data.downloadUrl;
            if (btn) {
                btn.classList.remove('hidden');
                btn.classList.remove('version-label');
                btn.disabled = false;
                const label = btn.querySelector('span');
                if (label) {
                    label.dataset.i18n = 'update-btn';
                    label.textContent = "Mise a jour disponible";
                }
                btn.onclick = () => {
                    const releaseNameEl = document.getElementById('update-release-name');
                    const progContainer = document.getElementById('update-progress-container');
                    const waiting = document.getElementById('update-waiting');
                    const statusText = document.getElementById('update-status-text');
                    const progressBar = document.getElementById('update-progress-bar');
                    const stepDownload = document.getElementById('update-step-download');
                    const stepInstall = document.getElementById('update-step-install');
                    if (releaseNameEl) releaseNameEl.textContent = data.name || data.tag_name;
                    if (progContainer) progContainer.classList.remove('hidden');
                    if (waiting) waiting.classList.add('hidden');
                    if (statusText) statusText.textContent = "Pret a telecharger";
                    if (progressBar) progressBar.style.width = '0%';
                    if (stepDownload) {
                        stepDownload.classList.add('active');
                        stepDownload.classList.remove('done');
                    }
                    if (stepInstall) {
                        stepInstall.classList.remove('active', 'done');
                    }
                    downloadedUpdatePath = null;
                    if (confirmUpdateBtn) {
                        confirmUpdateBtn.disabled = false;
                        confirmUpdateBtn.textContent = "Telecharger";
                        confirmUpdateBtn.classList.remove('btn-warning');
                        confirmUpdateBtn.classList.add('btn-primary');
                        confirmUpdateBtn.onclick = null;
                    }
                    const cancelBtn = document.getElementById('cancel-update-btn');
                    if (cancelBtn) {
                        cancelBtn.disabled = false;
                        cancelBtn.textContent = "Annuler";
                        cancelBtn.classList.remove('hidden');
                    }
                    $('#update-modal').classList.add('active');
                };
            }
        } else if (btn) {
            pendingUpdateUrl = null;
            btn.classList.remove('hidden');
            btn.classList.add('version-label');
            btn.disabled = true;
            const label = btn.querySelector('span');
            if (label) {
                label.removeAttribute('data-i18n');
                label.textContent = data.currentVersion ? `v${String(data.currentVersion).replace(/^v/i, '')}` : 'A jour';
            }
            btn.onclick = null;
        }
    } catch (err) {
        console.error("Update check failed:", err);
    }
}

// Update modal logic
const confirmUpdateBtn = document.getElementById('confirm-update-btn');
if (confirmUpdateBtn) {
    confirmUpdateBtn.addEventListener('click', async () => {
        if (!pendingUpdateUrl) return;
        if (downloadedUpdatePath) return;

        confirmUpdateBtn.disabled = true;
        const cancelBtn = document.getElementById('cancel-update-btn');
        if (cancelBtn) cancelBtn.disabled = true;
        const statusText = document.getElementById('update-status-text');
        const progressBar = document.getElementById('update-progress-bar');
        const progContainer = document.getElementById('update-progress-container');
        const waiting = document.getElementById('update-waiting');
        const stepDownload = document.getElementById('update-step-download');
        const stepInstall = document.getElementById('update-step-install');

        if (progContainer) progContainer.classList.remove('hidden');
        if (waiting) waiting.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        if (stepDownload) stepDownload.classList.add('active');
        if (stepInstall) stepInstall.classList.remove('active');
        statusText.textContent = "Telechargement en cours...";

        try {
            const res = await fetch('/api/update/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: pendingUpdateUrl })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const interval = setInterval(async () => {
                try {
                    const pRes = await fetch('/api/update/progress');
                    if (!pRes.ok) return;
                    const pData = await pRes.json();

                    if (pData.progress >= 0) {
                        progressBar.style.width = pData.progress + '%';
                        statusText.textContent = `Telechargement: ${pData.progress}%`;
                    }

                    if (pData.progress === 100) {
                        clearInterval(interval);
                        if (progContainer) progContainer.classList.remove('hidden');
                        if (waiting) waiting.classList.add('hidden');
                        progressBar.style.width = '100%';
                        downloadedUpdatePath = pData.dest || data.dest || "C:\\Users\\boque\\Downloads\\zaalis-update.exe";
                        if (stepDownload) {
                            stepDownload.classList.remove('active');
                            stepDownload.classList.add('done');
                        }
                        if (stepInstall) stepInstall.classList.add('active');
                        statusText.textContent = "Telechargement termine. Cliquez sur Fermer l'IDE, puis lancez zaalis-update.exe depuis votre dossier Telechargements.";
                        // Un seul bouton orange "Fermer l'IDE" qui ferme totalement l'app.
                        if (cancelBtn) cancelBtn.classList.add('hidden');
                        confirmUpdateBtn.disabled = false;
                        confirmUpdateBtn.classList.remove('btn-primary');
                        confirmUpdateBtn.classList.add('btn-warning');
                        confirmUpdateBtn.textContent = "Fermer l'IDE";
                        confirmUpdateBtn.onclick = async () => {
                            confirmUpdateBtn.disabled = true;
                            confirmUpdateBtn.textContent = "Fermeture...";
                            try { await fetch('/api/app/close', { method: 'POST' }); } catch {}
                        };
                    } else if (pData.progress < 0) {
                        clearInterval(interval);
                        statusText.textContent = "Erreur lors du telechargement.";
                        confirmUpdateBtn.disabled = false;
                        if (cancelBtn) cancelBtn.disabled = false;
                    }
                } catch (err) {
                    clearInterval(interval);
                    statusText.textContent = "Erreur: " + err.message;
                    confirmUpdateBtn.disabled = false;
                    if (cancelBtn) cancelBtn.disabled = false;
                }
            }, 500);

        } catch (err) {
            statusText.textContent = "Erreur: " + err.message;
            confirmUpdateBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
        }
    });
}

// Apply the unified search bar to whichever tab is active.
function applyCatalogSearch() {
    const q = $('#catalog-search-input').value.trim();
    const hfActive = !$('#catalog-pane-hf').classList.contains('hidden');
    const installedActive = !$('#catalog-pane-installed').classList.contains('hidden');
    if (installedActive) renderInstalledCatalog();
    else if (hfActive) { q ? hfSearch(q) : showHfDefault(); }
    else { renderCatalog(); }
}

async function installGgufFromCatalog(repo, file, card) {
    const lang = state.language || 'fr';
    const actions = card.querySelector('.cat-actions');
    const prog = card.querySelector('.cat-progress');
    const pfill = card.querySelector('.pfill');
    const ptext = card.querySelector('.ptext');
    actions.innerHTML = '';
    prog.style.display = 'block';
    pfill.style.width = '0%';
    ptext.textContent = lang === 'en' ? 'Starting...' : 'Demarrage...';

    prog.querySelectorAll('.cat-cancel').forEach(b => b.remove());
    const cancel = document.createElement('button');
    cancel.className = 'cat-cancel'; cancel.type = 'button';
    cancel.textContent = lang === 'en' ? 'Cancel' : 'Annuler';
    cancel.disabled = true;
    prog.appendChild(cancel);

    try {
        const qs = 'repo=' + encodeURIComponent(repo) + '&file=' + encodeURIComponent(file);
        const res = await fetch('/api/gguf-pull?' + qs);
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', installedName = '', taskId = '';
        const mb = n => (n / 1e6).toFixed(0);
        cancel.addEventListener('click', async () => {
            if (!taskId) return;
            cancel.disabled = true;
            cancel.textContent = lang === 'en' ? 'Canceling...' : 'Annulation...';
            await fetch('/api/gguf-pull-cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: taskId })
            }).catch(() => {});
        });
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                if (o.id && !taskId) {
                    taskId = o.id;
                    cancel.disabled = false;
                }
                if (o.status === 'downloading' && o.total) {
                    const pct = Math.round((o.completed || 0) / o.total * 100);
                    pfill.style.width = pct + '%';
                    ptext.textContent = `${pct}% (${mb(o.completed || 0)} / ${mb(o.total)} Mo)`;
                } else if (o.status === 'success') {
                    installedName = o.name || ggufFileName(file);
                    pfill.style.width = '100%';
                    ptext.textContent = lang === 'en' ? 'Installed' : 'Installe';
                } else if (o.status === 'canceled') {
                    throw new DOMException('Canceled', 'AbortError');
                } else if (o.status === 'error') {
                    throw new Error(o.error || 'download failed');
                }
            }
        }
        cancel.remove();
        prog.style.display = 'none';
        card.dataset.ggufFile = installedName || ggufFileName(file);
        await refreshGgufInstalled();
        setCardActions(card, card.dataset.name);
        if (modelSelect.value === 'gguf') updateSubmodelDropdown();
    } catch (e) {
        cancel.remove();
        prog.style.display = 'none';
        pfill.style.width = '0%';
        if (e && e.name === 'AbortError') ptext.textContent = lang === 'en' ? 'Canceled' : 'Annule';
        else ptext.textContent = (lang === 'en' ? 'Error: ' : 'Erreur : ') + e.message;
        setCardActions(card, card.dataset.name);
    }
}

async function uninstallGgufModel(file, card) {
    const lang = state.language || 'fr';
    const ok = await customConfirm(ggufFileName(file), {
        title: lang === 'en' ? 'Delete this GGUF model?' : 'Supprimer ce modele GGUF ?',
        okText: lang === 'en' ? 'Delete' : 'Supprimer',
        danger: true
    });
    if (!ok) return;
    const un = card.querySelector('.cat-uninstall');
    if (un) { un.disabled = true; un.textContent = lang === 'en' ? 'Deleting...' : 'Suppression...'; }
    try {
        const res = await fetch('/api/gguf-delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ggufFileName(file) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
        await refreshGgufInstalled();
        renderGgufModels();
        setCardActions(card, card.dataset.name);
        if (!$('#catalog-pane-installed')?.classList.contains('hidden')) renderInstalledCatalog();
    } catch {
        if (un) { un.disabled = false; un.textContent = lang === 'en' ? 'Error' : 'Erreur'; setTimeout(() => setCardActions(card, card.dataset.name), 1600); }
    }
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
        const url = encodeURIComponent(state.config.ollamaUrl || 'http://127.0.0.1:11434');
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
                body: JSON.stringify({ name: t, url: state.config.ollamaUrl || 'http://127.0.0.1:11434' })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) lastErr = data.error || ('HTTP ' + res.status);
            else _installedModels.delete(t);
        }
        await refreshInstalled();
        const installedLower = new Set(Array.from(_installedModels).map(m => m.toLowerCase()));
        const remaining = Array.from(targets).filter(t => installedLower.has(t.toLowerCase()) || installedLower.has(normName(t).toLowerCase()));
        if (lastErr && remaining.length) throw new Error(lastErr);
        const targetLower = new Set(Array.from(targets).map(t => t.toLowerCase()));
        const base = name.toLowerCase().split(':')[0];
        state.config.ollamaModels = (state.config.ollamaModels || []).filter(m => {
            const ml = m.toLowerCase();
            const nl = normName(m).toLowerCase();
            return !targetLower.has(ml) && !targetLower.has(nl) && ml !== name.toLowerCase() && !ml.startsWith(base + ':');
        });
        saveState();
        renderOllamaModels();
        if (modelSelect.value === 'local') updateSubmodelDropdown();
        refreshOllamaAgentSelect();
        setCardActions(card, name);
        if (!$('#catalog-pane-installed')?.classList.contains('hidden')) renderInstalledCatalog();
    } catch (e) {
        if (un) { un.disabled = false; un.textContent = (lang === 'en' ? 'Error' : 'Erreur'); setTimeout(() => setCardActions(card, name), 1800); }
    }
}

// Catalog modal open/close + tabs + unified search.
function updateCatalogChrome() {
    const lang = state.language || 'fr';
    const title = $('#catalog-title');
    if (title) {
        title.textContent = catalogInstallTarget === 'gguf'
            ? (lang === 'en' ? 'Local GGUF models to install' : 'Modeles GGUF locaux a installer')
            : (lang === 'en' ? 'Ollama models to install' : 'Modeles Ollama a installer');
    }
    $$('.catalog-target').forEach(btn => btn.classList.toggle('active', btn.dataset.target === catalogInstallTarget));
}

const catalogBtn = $('#catalog-btn');
if (catalogBtn) catalogBtn.addEventListener('click', async () => {
    $('#catalog-modal').classList.add('active');
    catalogInstallTarget = state.config.catalogTarget || 'gguf';
    updateCatalogChrome();
    await refreshCatalogInstalled();
    if (!$('#catalog-pane-installed')?.classList.contains('hidden')) renderInstalledCatalog();
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

$$('.catalog-target').forEach(btn => btn.addEventListener('click', async () => {
    catalogInstallTarget = btn.dataset.target || 'gguf';
    state.config.catalogTarget = catalogInstallTarget;
    saveState();
    updateCatalogChrome();
    await refreshCatalogInstalled();
    $$('.catalog-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === 'curated'));
    $('#catalog-pane-curated').classList.remove('hidden');
    $('#catalog-pane-hf').classList.add('hidden');
    $('#catalog-pane-installed').classList.add('hidden');
    applyCatalogSearch();
}));

const closeUpdate = $('#close-update-modal');
if (closeUpdate) closeUpdate.addEventListener('click', () => $('#update-modal').classList.remove('active'));
const cancelUpdate = $('#cancel-update-btn');
if (cancelUpdate) cancelUpdate.addEventListener('click', () => $('#update-modal').classList.remove('active'));
const updateModal = $('#update-modal');
if (updateModal) updateModal.addEventListener('click', e => { if (e.target.id === 'update-modal') updateModal.classList.remove('active'); });

$$('.catalog-tab').forEach(tab => tab.addEventListener('click', async () => {
    $$('.catalog-tab').forEach(t => t.classList.toggle('active', t === tab));
    const cat = tab.dataset.cat;
    $('#catalog-pane-curated').classList.toggle('hidden', cat !== 'curated');
    $('#catalog-pane-hf').classList.toggle('hidden', cat !== 'hf');
    $('#catalog-pane-installed').classList.toggle('hidden', cat !== 'installed');
    if (cat === 'installed') await refreshCatalogInstalled();
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
//  INIT
// ==========================================================
document.addEventListener('DOMContentLoaded', async () => {
    loadState();

    // Apply saved appearance (theme / density / font) before anything renders.
    if (typeof applyAppearance === 'function') applyAppearance();
    // Restore the default reasoning effort preference.
    if (typeof state.config.defaultReasoning === 'number') state.reasoningLevel = state.config.defaultReasoning;

    // UI Init
    renderTabs();
    if (state.activeFile) {
        if (!state.openFiles[state.activeFile]) {
            state.activeFile = null;
        } else {
            textarea.value = state.openFiles[state.activeFile].content || '';
            updateGutter(textarea.value);
            renderTabs();
        }
    }
    
    // Auth is handled in-page via the overlay in index.html.
    await checkAuthAndInit();
    await loadSharedHardwareConfig();

    // Tools & Settings Initialization
    if (typeof initAgentModelDropdowns === 'function') initAgentModelDropdowns();
    // Make sure the preferred default agent is enabled in Agents mode.
    if (state.config.defaultAgentModel) {
        const defAgent = document.querySelector(`.agent-check[data-agent="${state.config.defaultAgentModel}"]`);
        if (defAgent) defAgent.checked = true;
    }
    // Curseur d'effort de reflexion : on installe les events maintenant,
    // la compatibilite est evaluee plus bas une fois le modele restaure.
    if (typeof initReasoningSlider === 'function') initReasoningSlider();
    if (typeof updateLanguage === 'function') updateLanguage();

    // Restore Ollama URL in settings modal
    const _set = (sel, val) => { const el = $(sel); if (el) el.value = val; };
    if (modelSelect) {
        modelSelect.value = state.config.aiModel || 'codex';
        if (!modelSelect.value) modelSelect.value = 'codex';
        modelSelect.dispatchEvent(new Event('change'));
        
        if (state.config.aiSubmodel && Array.from(submodelSelect.options).some(opt => opt.value === state.config.aiSubmodel)) {
            submodelSelect.value = state.config.aiSubmodel;
        } else {
            // Default to newest submodel (first in the list) if saved one not found
            const subs = SUBMODELS[modelSelect.value] || [];
            if (subs.length) {
                submodelSelect.value = subs[0]; // newest = first
            }
        }
        submodelSelect.dispatchEvent(new Event('change'));
        if (typeof createCustomSelect === 'function') {
            createCustomSelect('ai-model');
            createCustomSelect('ai-submodel');
        }
    }
    // Maintenant que le modele est restaure : evaluer la compatibilite de
    // l'effort de reflexion et la disponibilite des pieces jointes.
    if (typeof checkReasoningCompatibility === 'function') checkReasoningCompatibility();
    if (typeof updateAttachAvailability === 'function') updateAttachAvailability();
    _set('#ollama-url', state.config.ollamaUrl || 'http://127.0.0.1:11434');
    _set('#settings-lang-select', state.language || 'fr');
    _set('#gguf-variant-select', state.config.ggufVariant || '');
    _set('#profile-pseudo', state.profile?.pseudo || 'Utilisateur');

    if (typeof updateProfileUI === 'function') updateProfileUI();
    if (typeof renderHistory === 'function') renderHistory();

    // Polling Ollama models in background
    if (typeof syncOllamaModels === 'function') {
        setTimeout(syncOllamaModels, 1000);
        setInterval(syncOllamaModels, 30000);
    }

    // Local model loader (LM Studio style) in the top bar.
    if (typeof initModelLoader === 'function') initModelLoader();

    // Check for app updates on GitHub (only if the user kept auto-check on).
    if (state.config.autoCheckUpdates !== false) setTimeout(checkForUpdates, 3000);
});

// Restore language settings and select binding
function setLanguage(lang) {
    state.language = lang || 'fr';
    saveState();
    const topLang = $('#lang-select');
    const settingsLang = $('#settings-lang-select');
    if (topLang) topLang.value = state.language;
    if (settingsLang) settingsLang.value = state.language;
    updateLanguage();
    if (typeof updateCatalogChrome === 'function') updateCatalogChrome();
    if (typeof loadGgufModels === 'function') loadGgufModels();
    if (typeof renderHistory === 'function') renderHistory(); // refresh "Aucun projet" label
}
const langSelect = $('#lang-select');
if (langSelect) {
    langSelect.value = state.language || 'fr';
    langSelect.addEventListener('change', () => {
        setLanguage(langSelect.value);
    });
}
const settingsLangSelect = $('#settings-lang-select');
if (settingsLangSelect) {
    settingsLangSelect.value = state.language || 'fr';
    settingsLangSelect.addEventListener('change', () => setLanguage(settingsLangSelect.value));
}
updateLanguage();

renderHistory();

// ==========================================================
//  LOCAL MODEL LOADER (LM Studio style) — top bar
// ==========================================================
// Holds the installed GGUF files with their byte sizes (from /api/gguf-models)
// so the loader list can show "Qwen2.5-Coder-7B · 4.4 GB".
let _loaderModels = [];      // [{ name, size }]
let _loaderLoaded = null;    // currently loaded .gguf filename, or null
let _loaderBusy = false;     // a load request is in flight

function _fmtBytes(n) {
    if (!n) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
    return Math.round(n / 1e3) + ' KB';
}
// 8192 -> "8K", 131072 -> "128K", 1024 -> "1K"
function _fmtCtx(n) {
    n = parseInt(n, 10) || 0;
    if (n >= 1024 && n % 1024 === 0) return (n / 1024) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}
function _ggufPretty(name) { return String(name || '').replace(/\.gguf$/i, ''); }

// Reflect the loaded/empty state on the top-bar button.
function updateLoaderButton() {
    const wrap = $('#model-loader');
    const label = $('#model-loader-label');
    const badge = $('#model-loader-badge');
    const eject = $('#model-loader-eject');
    if (!wrap || !label) return;
    const lang = state.language || 'fr';
    if (_loaderLoaded) {
        wrap.classList.add('loaded');
        label.textContent = _ggufPretty(_loaderLoaded);
        if (badge) {
            badge.textContent = _fmtCtx(state.config.ggufCtx) + (lang === 'en' ? ' ctx' : ' ctx');
            badge.classList.remove('hidden');
        }
        if (eject) eject.classList.remove('hidden');
    } else {
        wrap.classList.remove('loaded');
        label.textContent = (TRANSLATIONS[lang] && TRANSLATIONS[lang]['loader-empty']) || 'Charger un modèle';
        if (badge) badge.classList.add('hidden');
        if (eject) eject.classList.add('hidden');
    }
}

// Build the model list inside the dropdown.
function renderModelLoaderList() {
    const box = $('#ml-model-list');
    if (!box) return;
    const lang = state.language || 'fr';
    box.innerHTML = '';
    if (!_loaderModels.length) {
        box.innerHTML = `<div class="ml-empty">${lang === 'en'
            ? 'No local model installed yet.<br>Download one to get started.'
            : 'Aucun modèle local installé.<br>Téléchargez-en un pour commencer.'}</div>`;
        return;
    }
    _loaderModels.forEach(m => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ml-item' + (m.name === _loaderLoaded ? ' current' : '');
        const meta = _fmtBytes(m.size);
        item.innerHTML = `
            <span class="ml-item-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg></span>
            <span class="ml-item-info">
                <span class="ml-item-name"></span>
                ${meta ? `<span class="ml-item-meta">${meta}</span>` : ''}
            </span>
            ${m.name === _loaderLoaded ? `<span class="ml-item-tag">${lang === 'en' ? 'LOADED' : 'CHARGÉ'}</span>` : ''}`;
        item.querySelector('.ml-item-name').textContent = _ggufPretty(m.name);
        item.title = m.name;
        item.addEventListener('click', () => openLoaderConfig(m.name));
        box.appendChild(item);
    });
}

// Called by loadGgufModels() with the raw /api/gguf-models payload.
function syncModelLoader(data) {
    if (data && Array.isArray(data.models)) _loaderModels = data.models;
    _loaderLoaded = (data && data.running && data.current) ? data.current : null;
    renderModelLoaderList();
    updateLoaderButton();
}

// Switch to the config pane and prefill controls for `name`.
function openLoaderConfig(name) {
    const panel = $('#model-loader');
    if (!panel) return;
    panel.dataset.selected = name;
    const nameEl = $('#ml-config-name');
    if (nameEl) nameEl.textContent = _ggufPretty(name);

    const ctx = clampGgufCtx(state.config.ggufCtx);
    const slider = $('#ml-ctx-slider'), num = $('#ml-ctx-num'), hint = $('#ml-ctx-hint');
    if (slider) slider.value = ctx;
    if (num) num.value = ctx;
    if (hint) hint.textContent = _fmtCtx(ctx);
    const gpu = $('#ml-gpu-select'); if (gpu) gpu.value = state.config.ggufGpuLayers || '';
    const variant = $('#ml-variant-select'); if (variant) variant.value = state.config.ggufVariant || '';

    // Activate the config tab.
    $$('.ml-tab').forEach(t => t.classList.toggle('active', t.dataset.mlTab === 'config'));
    $$('.ml-pane').forEach(p => p.classList.toggle('active', p.dataset.mlPane === 'config'));
    resetLoadButton();
}

function resetLoadButton() {
    const btn = $('#ml-load-btn');
    const prog = $('#ml-progress'), fill = $('#ml-progress-fill');
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; btn.textContent = (TRANSLATIONS[state.language || 'fr'] || {})['loader-load'] || 'Charger le modèle'; }
    if (prog) prog.classList.add('hidden');
    if (fill) fill.style.width = '0%';
}

// Read + clamp the context input/slider and keep both in sync.
function _syncCtx(fromSlider) {
    const slider = $('#ml-ctx-slider'), num = $('#ml-ctx-num'), hint = $('#ml-ctx-hint');
    if (!slider || !num) return;
    let v = clampGgufCtx(fromSlider ? slider.value : num.value);
    slider.value = v;
    if (fromSlider || document.activeElement !== num) num.value = v;
    if (hint) hint.textContent = _fmtCtx(v);
}

// Load the selected model into memory (streams progress).
async function loadLoaderModel() {
    if (_loaderBusy) return;
    const panel = $('#model-loader');
    const name = panel && panel.dataset.selected;
    if (!name) return;
    const lang = state.language || 'fr';
    const ctx = clampGgufCtx($('#ml-ctx-num').value);
    const gpuLayers = $('#ml-gpu-select') ? $('#ml-gpu-select').value : '';
    const variant = $('#ml-variant-select') ? $('#ml-variant-select').value : '';

    // Persist the chosen options so the chat path reuses the same engine state.
    state.config.ggufCtx = ctx;
    state.config.ggufGpuLayers = gpuLayers;
    state.config.ggufVariant = variant;
    saveState();
    await syncSharedHardwareConfig();
    const ggufCtxInput = $('#gguf-ctx-input'); if (ggufCtxInput) ggufCtxInput.value = ctx;

    const btn = $('#ml-load-btn'), prog = $('#ml-progress'), fill = $('#ml-progress-fill');
    _loaderBusy = true;
    if (btn) { btn.classList.add('loading'); btn.disabled = true; btn.textContent = lang === 'en' ? 'Loading…' : 'Chargement…'; }
    if (prog) prog.classList.remove('hidden');
    if (fill) { fill.style.width = '8%'; }
    // Indeterminate creep while the engine boots (caps below 90%).
    let creep = 8;
    const creepTimer = setInterval(() => { creep = Math.min(88, creep + 4); if (fill) fill.style.width = creep + '%'; }, 700);

    try {
        const res = await fetch('/api/gguf-load', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, ctx, gpuLayers, variant })
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', ok = false, errMsg = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                if (o.status === 'ready') ok = true;
                else if (o.status === 'error') errMsg = o.error || 'load failed';
            }
        }
        clearInterval(creepTimer);
        if (!ok) throw new Error(errMsg || (lang === 'en' ? 'The engine did not start.' : "Le moteur n'a pas démarré."));

        if (fill) fill.style.width = '100%';
        _loaderLoaded = name;

        // Make the loaded model the active chat model.
        state.config.aiModel = 'gguf';
        state.config.aiSubmodel = name;
        saveState();
        if (modelSelect) {
            modelSelect.value = 'gguf';
            if (typeof updateSubmodelDropdown === 'function') updateSubmodelDropdown();
            if (submodelSelect) submodelSelect.value = name;
            if (typeof createCustomSelect === 'function') { createCustomSelect('ai-model'); createCustomSelect('ai-submodel'); }
            if (typeof applyModelColor === 'function') applyModelColor();
            if (typeof checkReasoningCompatibility === 'function') checkReasoningCompatibility();
            if (typeof updateTokenMeter === 'function') updateTokenMeter();
        }
        updateLoaderButton();
        renderModelLoaderList();
        closeModelLoader();
        showToast(lang === 'en' ? 'Model loaded' : 'Modèle chargé',
            `${_ggufPretty(name)} • ${_fmtCtx(ctx)} ${lang === 'en' ? 'context' : 'de contexte'}`,
            { icon: '✓', duration: 5000 });
    } catch (e) {
        clearInterval(creepTimer);
        showToast(lang === 'en' ? 'Load failed' : 'Chargement impossible', e.message || String(e), { icon: '!' });
    } finally {
        _loaderBusy = false;
        resetLoadButton();
    }
}

// Eject (unload) the model currently in memory.
async function ejectLoaderModel() {
    const lang = state.language || 'fr';
    try {
        const res = await fetch('/api/gguf-unload', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
        _loaderLoaded = null;
        updateLoaderButton();
        renderModelLoaderList();
        showToast(lang === 'en' ? 'Model ejected' : 'Modèle déchargé',
            lang === 'en' ? 'Memory has been freed.' : 'La mémoire a été libérée.',
            { icon: '⏏', duration: 4000 });
    } catch (e) {
        showToast(lang === 'en' ? 'Eject failed' : 'Déchargement impossible', e.message || String(e), { icon: '!' });
    }
}

function openModelLoader() {
    const wrap = $('#model-loader');
    if (!wrap) return;
    wrap.classList.add('open');
    // Always open on the model list first.
    $$('.ml-tab').forEach(t => t.classList.toggle('active', t.dataset.mlTab === 'select'));
    $$('.ml-pane').forEach(p => p.classList.toggle('active', p.dataset.mlPane === 'select'));
    if (typeof loadGgufModels === 'function') loadGgufModels();
    renderModelLoaderList();
}
function closeModelLoader() {
    const wrap = $('#model-loader');
    if (wrap) wrap.classList.remove('open');
}

function initModelLoader() {
    const wrap = $('#model-loader');
    if (!wrap) return;
    const btn = $('#model-loader-btn');
    const eject = $('#model-loader-eject');

    if (btn) btn.addEventListener('click', (e) => {
        // The eject button lives inside the main button — ignore its clicks here.
        if (e.target.closest('#model-loader-eject')) return;
        wrap.classList.contains('open') ? closeModelLoader() : openModelLoader();
    });
    if (eject) eject.addEventListener('click', (e) => { e.stopPropagation(); ejectLoaderModel(); });

    $$('.ml-tab').forEach(tab => tab.addEventListener('click', () => {
        const t = tab.dataset.mlTab;
        // Config tab only makes sense once a model is picked.
        if (t === 'config' && !wrap.dataset.selected) return;
        $$('.ml-tab').forEach(x => x.classList.toggle('active', x === tab));
        $$('.ml-pane').forEach(p => p.classList.toggle('active', p.dataset.mlPane === t));
    }));

    const back = $('#ml-config-back');
    if (back) back.addEventListener('click', () => {
        $$('.ml-tab').forEach(t => t.classList.toggle('active', t.dataset.mlTab === 'select'));
        $$('.ml-pane').forEach(p => p.classList.toggle('active', p.dataset.mlPane === 'select'));
    });

    const slider = $('#ml-ctx-slider'), num = $('#ml-ctx-num');
    if (slider) slider.addEventListener('input', () => _syncCtx(true));
    if (num) {
        num.addEventListener('input', () => { const slider2 = $('#ml-ctx-slider'); const v = parseInt(num.value, 10); if (slider2 && Number.isFinite(v)) slider2.value = Math.max(512, Math.min(131072, v)); const hint = $('#ml-ctx-hint'); if (hint && Number.isFinite(v)) hint.textContent = _fmtCtx(Math.max(512, Math.min(131072, v))); });
        num.addEventListener('change', () => _syncCtx(false));
        num.addEventListener('blur', () => _syncCtx(false));
    }

    const loadBtn = $('#ml-load-btn');
    if (loadBtn) loadBtn.addEventListener('click', loadLoaderModel);

    const getModels = $('#ml-get-models');
    if (getModels) getModels.addEventListener('click', () => {
        closeModelLoader();
        const cat = $('#catalog-btn'); if (cat) cat.click();
    });

    // Close when clicking outside the loader.
    document.addEventListener('click', (e) => {
        if (wrap.classList.contains('open') && !e.target.closest('#model-loader')) closeModelLoader();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelLoader(); });

    updateLoaderButton();
}

// Gate the app behind authentication.
setupAuth();
