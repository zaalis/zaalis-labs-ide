//  SETTINGS MODAL
// ==========================================================
const SETTINGS_SECTION_TITLES = {
    general: 'settings-general-title',
    api: 'settings-api-keys-title',
    hardware: 'settings-hardware-title'
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

$('#settings-btn').addEventListener('click', () => {
    const settingsLang = $('#settings-lang-select');
    if (settingsLang) settingsLang.value = state.language || 'fr';
    const variantSelect = $('#gguf-variant-select');
    if (variantSelect) variantSelect.value = state.config.ggufVariant || '';
    if (typeof loadGgufModels === 'function') loadGgufModels();
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
    saveState();
    const btn = $('#save-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    try {
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

    const controller = new AbortController();
    prog.querySelectorAll('.cat-cancel').forEach(b => b.remove());
    const cancel = document.createElement('button');
    cancel.className = 'cat-cancel'; cancel.type = 'button';
    cancel.textContent = lang === 'en' ? 'Cancel' : 'Annuler';
    cancel.addEventListener('click', () => controller.abort());
    prog.appendChild(cancel);

    try {
        const qs = 'repo=' + encodeURIComponent(repo) + '&file=' + encodeURIComponent(file);
        const res = await fetch('/api/gguf-pull?' + qs, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', installedName = '';
        const mb = n => (n / 1e6).toFixed(0);
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                if (o.status === 'downloading' && o.total) {
                    const pct = Math.round((o.completed || 0) / o.total * 100);
                    pfill.style.width = pct + '%';
                    ptext.textContent = `${pct}% (${mb(o.completed || 0)} / ${mb(o.total)} Mo)`;
                } else if (o.status === 'success') {
                    installedName = o.name || ggufFileName(file);
                    pfill.style.width = '100%';
                    ptext.textContent = lang === 'en' ? 'Installed' : 'Installe';
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
        if (!(e && e.name === 'AbortError')) {
            ptext.textContent = (lang === 'en' ? 'Error: ' : 'Erreur : ') + e.message;
        }
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

    // Tools & Settings Initialization
    if (typeof initAgentModelDropdowns === 'function') initAgentModelDropdowns();
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

    // Check for app updates on GitHub
    setTimeout(checkForUpdates, 3000);
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

// Gate the app behind authentication.
setupAuth();
