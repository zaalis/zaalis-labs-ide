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
