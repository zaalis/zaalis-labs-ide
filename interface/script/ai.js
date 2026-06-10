// ==========================================================
//  PERMISSION MODE
// ==========================================================
const MODE_ICONS = {
    supervised: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    semi: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    auto: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`
};

function setupModeSelector(btnId, menuId) {
    const btn = $('#' + btnId);
    const menu = $('#' + menuId);
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        $$('.mode-dropdown.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
        $$('.attach-menu.open').forEach(m => m.classList.remove('open'));
        menu.classList.toggle('open');
    });

    menu.querySelectorAll('.mode-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const perm = item.dataset.perm;
            state.permissionMode = perm;
            
            // Sync all selectors (chat + agents)
            $$('.mode-dropdown').forEach(m => {
                m.querySelectorAll('.mode-item').forEach(mi => {
                    mi.classList.toggle('active', mi.dataset.perm === perm);
                });
            });

            // Update labels on the buttons
            const titleEl = item.querySelector('.mode-item-title');
            const labelText = titleEl.textContent;
            const itemI18n = titleEl.getAttribute('data-i18n');
            $$('.mode-select-label').forEach(lbl => {
                lbl.textContent = labelText;
                if (itemI18n) {
                    lbl.setAttribute('data-i18n', itemI18n);
                } else {
                    lbl.removeAttribute('data-i18n');
                }
            });

            // Toggle orange class and dynamic icons on the mode selector buttons
            $$('.mode-select-btn').forEach(b => {
                b.classList.toggle('orange', perm === 'auto');
                const svgIcon = b.querySelector('svg:not(.chevron)');
                if (svgIcon && MODE_ICONS[perm]) {
                    svgIcon.outerHTML = MODE_ICONS[perm];
                }
            });

            menu.classList.remove('open');
        });
    });
}

function syncModeSelectorUI() {
    const perm = state.permissionMode || 'supervised';
    
    // Sync active classes
    $$('.mode-dropdown').forEach(m => {
        m.querySelectorAll('.mode-item').forEach(mi => {
            mi.classList.toggle('active', mi.dataset.perm === perm);
        });
    });

    // Update labels on the buttons
    const activeItem = document.querySelector(`.mode-dropdown .mode-item[data-perm="${perm}"]`);
    if (activeItem) {
        const titleEl = activeItem.querySelector('.mode-item-title');
        if (titleEl) {
            const labelText = titleEl.textContent;
            const itemI18n = titleEl.getAttribute('data-i18n');
            $$('.mode-select-label').forEach(lbl => {
                lbl.textContent = labelText;
                if (itemI18n) {
                    lbl.setAttribute('data-i18n', itemI18n);
                } else {
                    lbl.removeAttribute('data-i18n');
                }
            });
        }
    }

    // Toggle orange class and dynamic icons on the mode selector buttons
    $$('.mode-select-btn').forEach(b => {
        b.classList.toggle('orange', perm === 'auto');
        const svgIcon = b.querySelector('svg:not(.chevron)');
        if (svgIcon && MODE_ICONS[perm]) {
            svgIcon.outerHTML = MODE_ICONS[perm];
        }
    });
}

// Initialize Mode Selectors
setupModeSelector('chat-mode-btn', 'chat-mode-menu');
setupModeSelector('agents-mode-btn', 'agents-mode-menu');
syncModeSelectorUI();

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
        s = s.replace(/!\[([^\]]*)\]\((data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+)\)/g, 
            '<img src="$2" alt="$1" class="generated-image">');
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Reveal `text` word-by-word into `el` (live typing effect), then replace it
// with the final rendered HTML. Used for the chat reply and the lead synthesis.
async function streamInto(el, text, finalHTML, signal, scrollEl) {
    const words = String(text).split(/(\s+)/);
    // Reveal several words at a time for long answers so it never feels sluggish.
    const chunk = words.length > 400 ? 4 : (words.length > 150 ? 2 : 1);
    let acc = '';
    el.classList.add('md');
    for (let i = 0; i < words.length; i += chunk) {
        if (signal && signal.aborted) { acc = text; break; }
        acc += words.slice(i, i + chunk).join('');
        el.textContent = acc;
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        await sleep(13);
    }
    el.innerHTML = finalHTML != null ? finalHTML : renderMarkdown(text);
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

// Single rounded frame holding a generated image (clicking opens the lightbox).
function imageBubble(url, alt) {
    const safeAlt = (alt || '').replace(/"/g, '&quot;');
    return `<div class="image-gen-container"><img src="${url}" alt="${safeAlt}" class="generated-image"></div>`;
}

// Full-screen image viewer: download (top-left), close (top-right), title (bottom-left).
function openImageLightbox(url, alt) {
    const modal = $('#image-lightbox');
    if (!modal) return;
    $('#lightbox-img').src = url;
    $('#lightbox-img').alt = alt || '';
    const cap = $('#lightbox-caption');
    cap.textContent = alt || '';
    cap.style.display = alt ? 'block' : 'none';
    const dl = $('#lightbox-download');
    dl.href = url;
    dl.download = (alt ? alt.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) : 'image') + '.png';
    modal.classList.add('active');
}
function closeImageLightbox() { const m = $('#image-lightbox'); if (m) m.classList.remove('active'); }
if ($('#lightbox-close')) $('#lightbox-close').addEventListener('click', closeImageLightbox);
if ($('#image-lightbox')) $('#image-lightbox').addEventListener('click', e => { if (e.target.id === 'image-lightbox') closeImageLightbox(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeImageLightbox(); });
// Click any generated image (chat or reloaded) to open the lightbox.
document.addEventListener('click', e => {
    const img = e.target.closest && e.target.closest('.generated-image');
    if (img) { e.preventDefault(); openImageLightbox(img.getAttribute('src'), img.getAttribute('alt') || ''); }
});

function formatAIResponse(text) {
    const isImageGen = state.config.aiModel === 'grok' && 
        (state.config.aiSubmodel === 'grok-2-image-gen' || state.config.aiSubmodel === 'grok-image-gen');

    if (isImageGen) {
        const imgMatch = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (imgMatch) return imageBubble(imgMatch[2], imgMatch[1] || '');
    }

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
    const { keys, ...safeConfig } = state.config;
    const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model, submodel, message, systemPrompt,
            config: safeConfig,
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
// Local models compact earlier (60 %) because they have smaller windows.
async function maybeCompact(model, submodel) {
    return compactContext(model, submodel, { force: false });
}

// Summarize older turns into a compact recap to free up context space.
// force = true runs it on demand (the /compact command), even below the threshold.
async function compactContext(model, submodel, opts = {}) {
    const force = !!opts.force;
    const win = contextWindow(model, submodel);
    const threshold = model === 'local' ? 0.60 : 0.75;
    const lang = state.language || 'fr';
    if (!force && state.contextTokens < win * threshold) return false;
    if (state.chatHistory.length <= 4) {
        if (force) addMsg($('#chat-messages'), 'system', null,
            lang === 'en' ? 'Nothing to compact yet — the conversation is too short.'
                          : 'Rien à compacter pour l’instant — la conversation est trop courte.');
        return false;
    }
    const beforeTokens = state.contextTokens;
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
        const freed = Math.max(0, beforeTokens - state.contextTokens);
        const freedTxt = freed > 0 ? ` (−${fmtTokens(freed)})` : '';
        addMsg($('#chat-messages'), 'system', null,
            (lang === 'en' ? 'Context compacted.' : 'Contexte compacté.') + freedTxt);
        saveConversation();
        return true;
    } catch {
        addMsg($('#chat-messages'), 'system', null,
            lang === 'en' ? 'Compaction failed.' : 'Échec du compactage.');
        return false;
    }
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

    const isLocal = model === 'local';

    // Compact the running context first if it's getting close to the limit.
    await maybeCompact(model, submodel);

    // Project tree goes into the SYSTEM prompt (background), only on the first
    // message — so weak models don't echo it and later questions aren't drowned.
    const ctx = state.chatHistory.length === 0 ? await projectContext(isLocal) : '';
    const sys = codeAgentPrompt(isLocal, modelIdentity(model, submodel, lang)) + ctx;
    const aiMessage = message + aiText;            // user message stays clean
    const displayMsg = message + (names.length ? `\n📎 ${names.join(', ')}` : '');
    addMsg($('#chat-messages'), 'user', lang === 'en' ? 'You' : 'Vous', displayMsg);
    const body = addTypingMsg($('#chat-messages'), modelLabel);

    // For local models, limit history to avoid overflowing the context window.
    // Keep only the last N turns so the system prompt + project context fit.
    let history = state.chatHistory.slice();
    if (isLocal) {
        const win = contextWindow(model, submodel);
        const sysTokens = estimateTokens(sys);
        const msgTokens = estimateTokens(aiMessage);
        const budget = Math.max(0, win - sysTokens - msgTokens - 2048); // reserve 2k for response
        let histTokens = 0;
        let cutIdx = history.length;
        for (let i = history.length - 1; i >= 0; i--) {
            histTokens += estimateTokens(history[i].content);
            if (histTokens > budget) { cutIdx = i + 1; break; }
        }
        if (cutIdx > 0 && cutIdx < history.length) {
            history = history.slice(cutIdx);
        }
    }

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
            const formatted = formatAIResponse(data.response);
            const isImg = formatted.includes('generated-image');
            // Generated image = single rectangle (instant); text = streamed word-by-word.
            body.classList.toggle('has-image', isImg);
            if (isImg) {
                body.innerHTML = reasoning + formatted;
            } else {
                body.innerHTML = reasoning + '<div class="stream-target"></div>';
                await streamInto(body.querySelector('.stream-target'), data.response, formatted, controller.signal, $('#chat-messages'));
            }

            // Update conversation memory + token meter. For images, keep a light
            // placeholder in memory instead of the heavy base64 data URL.
            let assistantMemory = data.response;
            if (isImg) {
                const am = data.response.match(/!\[([^\]]*)\]/);
                assistantMemory = am && am[1] ? `[Image générée : ${am[1]}]` : '[Image générée]';
            }
            state.chatHistory.push({ role: 'user', content: message }, { role: 'assistant', content: assistantMemory });
            if (data.usage && data.usage.input != null) {
                // Use actual token counts from the API when available.
                state.contextTokens = (data.usage.input || 0) + (data.usage.output || 0);
            } else {
                state.contextTokens = state.chatHistory.reduce((n, h) => n + estimateTokens(h.content), 0) + estimateTokens(codeAgentPrompt(isLocal));
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
async function handleAIResponse(response, agentName, container) {
    const lang = state.language || 'fr';
    // Route system/terminal messages to the right view so Chat and Agents stay
    // completely separate (a refusal in Agents must not appear in the Chat).
    const out = $(container || '#chat-messages');

    if (!state.projectRoot) {
        addMsg(out, 'system', null,
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
                addMsg(out, 'system', null, TRANSLATIONS[lang]['modification-refused'] || 'Modification refusee.');
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
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const result = await res.json();
            if (result.error) throw new Error(result.error);

            if (state.openFiles[targetFile]) {
                state.openFiles[targetFile].content = codeContent;
                state.openFiles[targetFile].unsaved = false;
            }
            if (state.activeFile === targetFile) {
                textarea.value = codeContent;
                updateGutter(codeContent);
                if (typeof renderHighlight === 'function') renderHighlight();
                renderTabs();
            }

            addMsg(out, 'system', null, `${lang === 'en' ? 'File' : 'Fichier'} ${targetFile} ${TRANSLATIONS[lang]['file-modified'] || 'modifie.'}`);
            wroteAny = true;
        } catch (err) {
            addMsg(out, 'system', null,
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
                addMsg(out, 'system', null,
                    lang === 'en' ? 'Command refused.' : 'Commande refusée.');
                continue;
            }
        }
        addMsg(out, 'system', null, '$ ' + cmd);
        try {
            const res = await fetch('/api/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd, cwd: state.projectRoot })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const execRes = await res.json();
            if (execRes.error) {
                addMsg(out, 'system', null,
                    `${lang === 'en' ? 'Command error' : 'Erreur commande'}: ${execRes.error}`);
            } else {
                const text = ((execRes.stdout || '') + (execRes.stderr ? '\n' + execRes.stderr : '')).trim();
                addMsg(out, 'ai', 'Terminal', text || (lang === 'en' ? '(no output)' : '(aucune sortie)'));
            }
        } catch (err) {
            addMsg(out, 'system', null,
                `${lang === 'en' ? 'Command error' : 'Erreur commande'}: ${err.message}`);
        }
    }
}

// Auto-grow a textarea downward as the user types (up to its CSS max-height).
function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
function resetInput(el) { if (el) { el.value = ''; el.style.height = 'auto'; } }
['#chat-input', '#agents-input'].forEach(sel => {
    const t = $(sel);
    if (t) t.addEventListener('input', () => autoGrow(t));
});

// ---- Slash commands (/compact, /clear) + Anthropic-style suggestion menu ----
const SLASH_COMMANDS = [
    { name: 'compact', fr: 'Compresser le contexte pour libérer de la place', en: 'Compress the context to free up space' },
    { name: 'clear',   fr: 'Effacer la conversation et le contexte',          en: 'Clear the conversation and the context' }
];

const slashInput = $('#chat-input');
const slashMenu = document.createElement('div');
slashMenu.className = 'slash-menu';
slashMenu.id = 'slash-menu';
slashInput.closest('.chat-input-area').appendChild(slashMenu);
let slashItems = [], slashIndex = 0;
const slashOpen = () => slashMenu.classList.contains('open');

function renderSlash() {
    const lang = state.language || 'fr';
    slashMenu.innerHTML = '';
    slashItems.forEach((c, i) => {
        const item = document.createElement('div');
        item.className = 'slash-item' + (i === slashIndex ? ' active' : '');
        item.innerHTML = `<span class="slash-name">/${c.name}</span><span class="slash-desc">${lang === 'en' ? c.en : c.fr}</span>`;
        item.addEventListener('mousedown', e => { e.preventDefault(); slashIndex = i; acceptSlash(); });
        slashMenu.appendChild(item);
    });
}
function openSlash(prefix) {
    slashItems = SLASH_COMMANDS.filter(c => c.name.startsWith(prefix));
    if (!slashItems.length) { closeSlash(); return; }
    slashIndex = 0;
    renderSlash();
    slashMenu.classList.add('open');
}
function closeSlash() { slashMenu.classList.remove('open'); slashItems = []; }
function moveSlash(d) { slashIndex = (slashIndex + d + slashItems.length) % slashItems.length; renderSlash(); }
function acceptSlash() {
    const cmd = slashItems[slashIndex];
    closeSlash();
    resetInput(slashInput);
    if (cmd) runSlashCommand(cmd.name);
}
function runSlashCommand(name) {
    const lang = state.language || 'fr';
    if (name === 'clear') { newConversation('chat'); return; }
    if (name === 'compact') {
        if (chatAbort) return;
        compactContext(modelSelect.value, submodelSelect.value, { force: true });
        return;
    }
    addMsg($('#chat-messages'), 'system', null, (lang === 'en' ? 'Unknown command: /' : 'Commande inconnue : /') + name);
}

// Decide whether a typed line is a command or a normal message.
function handleChatSubmit() {
    if (chatAbort) return;
    const text = slashInput.value.trim();
    if (!text) return;
    closeSlash();
    if (text.startsWith('/')) {
        const name = text.slice(1).split(/\s+/)[0].toLowerCase();
        resetInput(slashInput);
        runSlashCommand(name);
        return;
    }
    sendChat(text);
    resetInput(slashInput);
}

// Show/hide the menu as the user types a "/command" (no space yet).
slashInput.addEventListener('input', () => {
    const v = slashInput.value;
    if (/^\/[a-z]*$/i.test(v)) openSlash(v.slice(1).toLowerCase());
    else closeSlash();
});
// Capture phase so menu navigation wins over the Enter-to-send handler below.
slashInput.addEventListener('keydown', e => {
    if (!slashOpen()) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); moveSlash(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); moveSlash(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); acceptSlash(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeSlash(); }
}, true);
document.addEventListener('click', e => { if (!slashMenu.contains(e.target) && e.target !== slashInput) closeSlash(); });

// Chat input — Enter sends, Shift+Enter inserts a new line.
$('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleChatSubmit();
    }
});
$('#send-btn').addEventListener('click', () => {
    // While the AI is generating, the button is a "stop" circle -> cancel.
    if (chatAbort) { chatAbort.abort(); return; }
    handleChatSubmit();
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
    const projCtx = await projectContext(false); // appended to each agent's SYSTEM prompt (full for agents)
    addMsg($('#agents-log'), 'user', lang === 'en' ? 'You' : 'Vous', displayTask);

    const agentsLog = $('#agents-log');

    // Thinking indicator = ONE standalone rectangle (no chat bubble around it),
    // with the wavy-dot animation. It shows only each agent's status
    // (analysing → done), never their full text — the lead does the summary.
    const teamBox = document.createElement('div');
    teamBox.className = 'msg msg-ai';
    teamBox.innerHTML = `
        <div class="team-thinking">
            <canvas class="wave-canvas"></canvas>
            <div class="team-thinking-body">
                <div class="team-thinking-head">
                    <span class="team-thinking-spark"></span>
                    <span>${TRANSLATIONS[lang]['team-thinking-title']}</span>
                    <span class="team-progress">0/${workers.length}</span>
                </div>
                <div class="team-thinking-list"></div>
            </div>
        </div>`;
    agentsLog.appendChild(teamBox);
    const teamList = teamBox.querySelector('.team-thinking-list');
    const teamProgress = teamBox.querySelector('.team-progress');
    const waveCanvas = teamBox.querySelector('.wave-canvas');
    startWave(waveCanvas);

    let context = '';
    let completedCount = 0;

    // Run worker agents sequentially — each only contributes to the shared context.
    for (const { agent, role, submodel } of workers) {
        const card = $(`.agent-card[data-agent="${agent}"]`);
        card.classList.add('working');
        const badge = card.querySelector('.agent-badge');
        badge.textContent = TRANSLATIONS[lang]['status-working'];
        badge.className = 'agent-badge working';

        const roleLabel = TRANSLATIONS[lang]['role-' + role] || role;
        const line = document.createElement('div');
        line.className = 'team-agent-line';
        line.innerHTML = `<span class="team-agent-name">${labels[agent]} · ${roleLabel}</span><span class="team-agent-status">${lang === 'en' ? 'analysing…' : 'analyse en cours…'}</span>`;
        teamList.appendChild(line);
        agentsLog.scrollTop = agentsLog.scrollHeight;
        const statusText = line.querySelector('.team-agent-status');

        const systemPrompt = `${ROLE_PROMPTS[role]}\n${AGENT_COLLABORATION_PROMPT}\n${codeAgentPrompt(agent === 'local')}${projCtx}`;
        const fullMessage = context
            ? (lang === 'en'
                ? `[Previous agents context]:\n${context}\n\n[User task]: ${task}`
                : `[Contexte des agents precedents]:\n${context}\n\n[Tache utilisateur]: ${task}`)
            : task;

        try {
            const data = await callAI(agent, submodel, fullMessage, systemPrompt, taskImages);
            if (data.error) {
                statusText.textContent = lang === 'en' ? 'error' : 'erreur';
                statusText.classList.add('err');
            } else {
                statusText.textContent = TRANSLATIONS[lang]['lead-thinking-done'];
                statusText.classList.add('ok');
                context += `\n[${labels[agent]} (${roleLabel})]: ${data.response}\n`;
            }
        } catch (err) {
            statusText.textContent = lang === 'en' ? 'connection error' : 'erreur de connexion';
            statusText.classList.add('err');
        }

        card.classList.remove('working');
        badge.textContent = TRANSLATIONS[lang]['status-done'];
        badge.className = 'agent-badge done';

        completedCount++;
        teamProgress.textContent = `${completedCount}/${workers.length}`;
        agentsLog.scrollTop = agentsLog.scrollHeight;
    }

    // Workers done — stop the animation, keep their statuses for a collapsed recap.
    stopWave(waveCanvas);
    const recapHTML = teamList.innerHTML;
    teamBox.remove();

    const leadCard = $(`.agent-card[data-agent="${leadAgent.agent}"]`);
    leadCard.classList.add('working');
    const leadBadge = leadCard.querySelector('.agent-badge');
    leadBadge.textContent = TRANSLATIONS[lang]['status-working'];
    leadBadge.className = 'agent-badge working';

    const leadSystemPrompt = `${ROLE_PROMPTS[leadAgent.role]}\n${AGENT_COLLABORATION_PROMPT}\n${codeAgentPrompt(leadAgent.agent === 'local')}${projCtx}`;
    const leadMessage = lang === 'fr'
        ? `[Tache utilisateur]: ${task}

Voici les contributions et analyses des autres membres de l'equipe :
${context}

En tant que Chef de Projet, synthetise leur travail, prends les decisions finales et formule une reponse unique, structuree, coherente et complete pour l'utilisateur.`
        : `[User task]: ${task}

Here are the contributions and analyses from the other team members:
${context}

As the Project Lead, synthesize their work, make final decisions, and formulate a single, structured, coherent, and complete response for the user.`;

    // Lead writes as a NORMAL chat message (its own bubble), streamed word-by-word,
    // with a collapsed recap of the team's statuses above it.
    const leadBody = addMsg(agentsLog, 'ai', labels[leadAgent.agent], '', true);
    const recapChevron = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    leadBody.innerHTML = `
        <details class="reasoning team-recap">
            <summary><span class="reasoning-spark"></span><span class="reasoning-label">${TRANSLATIONS[lang]['team-thinking-title']}</span>${recapChevron}</summary>
            <div class="reasoning-body team-thinking-list">${recapHTML}</div>
        </details>
        <div class="stream-target"></div>`;
    const streamTarget = leadBody.querySelector('.stream-target');
    startThinking(streamTarget);

    try {
        const data = await callAI(leadAgent.agent, leadAgent.submodel, leadMessage, leadSystemPrompt, taskImages);
        stopThinking(streamTarget);
        if (data.error) {
            streamTarget.textContent = data.error;
            streamTarget.classList.add('error');
        } else {
            const formatted = formatAIResponse(data.response);
            if (formatted.includes('generated-image')) {
                streamTarget.innerHTML = formatted;
            } else {
                await streamInto(streamTarget, data.response, formatted, null, agentsLog);
            }
            await handleAIResponse(data.response, labels[leadAgent.agent], '#agents-log');
        }
    } catch (err) {
        stopThinking(streamTarget);
        streamTarget.textContent = TRANSLATIONS[lang]['err-conn-lead'] || 'Erreur de connexion.';
        streamTarget.classList.add('error');
    }

    leadCard.classList.remove('working');
    leadBadge.textContent = TRANSLATIONS[lang]['status-done'];
    leadBadge.className = 'agent-badge done';
    agentsLog.scrollTop = agentsLog.scrollHeight;

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
        const img = body && body.querySelector('.generated-image');
        const entry = {
            label: label ? label.textContent : null,
            text: body ? body.textContent : '',
            type: m.classList.contains('msg-system') ? 'system' : m.classList.contains('msg-user') ? 'user' : 'ai'
        };
        // Persist generated images so they survive a reload of the conversation.
        if (img) entry.image = { url: img.getAttribute('src'), alt: img.getAttribute('alt') || '' };
        data.push(entry);
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
    (conv.messages || []).forEach(m => {
        const body = addMsg(container, m.type, m.label, m.text || '');
        if (m.image && m.image.url) {
            body.innerHTML = imageBubble(m.image.url, m.image.alt || '');
            body.classList.add('has-image');
        }
    });
    container.scrollTop = container.scrollHeight;

    // Rebuild the API memory for the chat from its messages. For images we keep
    // a short text placeholder instead of the heavy base64 data URL.
    if (kind === 'chat') {
        state.chatHistory = (conv.messages || [])
            .filter(m => m.type === 'user' || m.type === 'ai')
            .map(m => ({
                role: m.type === 'user' ? 'user' : 'assistant',
                content: m.image
                    ? (m.image.alt ? `[Image générée : ${m.image.alt}]` : '[Image générée]')
                    : (m.text || '')
            }));
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
// `isLocal` = true produces a trimmed context to save tokens on Ollama.
async function projectContext(isLocal) {
    if (!state.projectRoot) return '';
    try {
        const res = await fetch(`/api/tree?root=${encodeURIComponent(state.projectRoot)}`);
        if (!res.ok) return '';
        const data = await res.json();
        let files = data.files || [];
        if (!files.length) return '';

        // For local models, limit the tree to 120 entries max to save tokens.
        const maxFiles = isLocal ? 120 : 600;
        if (files.length > maxFiles) {
            files = files.slice(0, maxFiles);
            data.truncated = true;
        }

        let ctx = `\n\n[CONTEXTE DU PROJET — racine: ${state.projectRoot}]\nArborescence:\n${files.join('\n')}`;
        if (data.truncated) ctx += '\n(liste tronquée)';
        if (state.activeFile && state.openFiles[state.activeFile]) {
            const c = state.openFiles[state.activeFile].content || '';
            // Local models: 3000 chars max; cloud models: 8000.
            const maxChars = isLocal ? 3000 : 8000;
            ctx += `\n\n[Fichier ouvert: ${state.activeFile}]\n\`\`\`\n${c.slice(0, maxChars)}\n\`\`\``;
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
document.addEventListener('click', () => {
    $$('.attach-menu.open').forEach(m => m.classList.remove('open'));
    $$('.mode-dropdown.open').forEach(m => m.classList.remove('open'));
});

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
    if (model === 'claude' && (submodel.includes('3.7') || submodel.includes('3-7') || submodel.includes('4.8') || submodel.includes('4-8') || submodel.includes('opus-4') || submodel.includes('sonnet-4') || submodel.includes('fable'))) return true;
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

    let isDragging = false;

    sliderBar.addEventListener('mousedown', e => {
        if (sliderBar.classList.contains('locked')) {
            showIncompatibleTooltip();
            return;
        }
        
        e.preventDefault();
        isDragging = true;
        handle.classList.add('dragging');
        
        const notch = e.target.closest('.slider-notch');
        if (notch) {
            const level = parseInt(notch.dataset.level);
            const model = reasoningContext().model;
            const modes = REASONING_MODES[model] || REASONING_MODES.local;
            const totalLevels = modes.length;
            const targetPercentage = (1 - (level / (totalLevels - 1))) * 100;
            handle.style.top = targetPercentage + '%';
            
            sliderBar.querySelectorAll('.slider-notch').forEach(n => {
                n.classList.toggle('active', parseInt(n.dataset.level) === level);
            });
            sliderBar.querySelectorAll('.slider-dot').forEach(d => {
                d.classList.toggle('active', parseInt(d.dataset.level) === level);
            });
        } else {
            onMouseMove(e);
        }
        
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
//  VOICE DICTATION (SPEECH-TO-TEXT)
// ==========================================================
function setupVoiceRecognition(btnId, textareaId) {
    const btn = $('#' + btnId);
    const textarea = $('#' + textareaId);
    if (!btn || !textarea) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        btn.style.display = 'none';
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    // Track state: 'inactive' | 'starting' | 'active' | 'stopping'
    let engineState = 'inactive';
    let baseText = '';

    recognition.onstart = () => {
        engineState = 'active';
        btn.classList.add('recording');
        textarea.classList.add('recording-text');
        btn.title = state.language === 'en' ? 'Recording... click to stop' : 'Enregistrement... cliquer pour arrêter';
    };

    recognition.onresult = (event) => {
        let sessionTranscript = '';
        for (let i = 0; i < event.results.length; ++i) {
            sessionTranscript += event.results[i][0].transcript;
        }
        sessionTranscript = sessionTranscript.trim();
        
        const separator = (baseText && !baseText.endsWith(' ')) ? ' ' : '';
        const newText = baseText ? `${baseText}${separator}${sessionTranscript}` : sessionTranscript;
        textarea.value = newText;
        autoGrow(textarea);
        textarea.dispatchEvent(new Event('input'));
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        cleanupState();
    };

    recognition.onend = () => {
        cleanupState();
    };

    function cleanupState() {
        engineState = 'inactive';
        btn.classList.remove('recording');
        textarea.classList.remove('recording-text');
        btn.title = state.language === 'en' ? 'Start voice dictation' : 'Activer la dictée vocale';
    }

    function startRecording() {
        if (engineState !== 'inactive') return;
        engineState = 'starting';
        baseText = textarea.value;
        recognition.lang = state.language === 'en' ? 'en-US' : 'fr-FR';
        try {
            recognition.start();
        } catch (err) {
            console.error("Failed to start speech recognition:", err);
            cleanupState();
        }
    }

    function stopRecording() {
        if (engineState !== 'active' && engineState !== 'starting') return;
        engineState = 'stopping';
        try {
            recognition.stop();
        } catch (err) {
            console.error("Failed to stop speech recognition:", err);
            cleanupState();
        }
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (engineState === 'active' || engineState === 'starting') {
            stopRecording();
        } else if (engineState === 'inactive') {
            startRecording();
        }
    });
}

// Initialize Voice Recognition
setupVoiceRecognition('chat-voice-btn', 'chat-input');
setupVoiceRecognition('agents-voice-btn', 'agents-input');
