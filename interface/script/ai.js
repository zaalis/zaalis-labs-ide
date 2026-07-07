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
            if (typeof updatePermissionBadge === 'function') updatePermissionBadge();
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
    if (typeof updatePermissionBadge === 'function') updatePermissionBadge();
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
        if (typeof renderHistory === 'function') renderHistory(); // list follows the active tab

        // Re-evaluate the reasoning slider for the active context (chat model or lead agent)
        checkReasoningCompatibility();
        updateAttachAvailability();

        const lang = state.language || 'fr';
        if (isAgentsTab && !state.agentMode) {
            state.agentMode = true;

            const checked = $$('.agent-check:checked');
            if (checked.length < 2) {
                addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['min-agents-required']);
                state.agentMode = false;
            } else {
                addMsg($('#agents-log'), 'system', null, (TRANSLATIONS[lang]['mode-agents-active'] || 'Mode Agents active.') + ' ' + checked.length + ' ' + (TRANSLATIONS[lang]['active-agents'] || 'agents prets.'));
            }
        } else if (!isAgentsTab && state.agentMode) {
            state.agentMode = false;
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

// Detect a file path on a code-fence info line (```js path=src/app.js).
// Mirrors the detection in extractFileBlocks so a collapsed card is shown for
// exactly the blocks that get written to disk. Returns the path or null.
function fenceFilePath(info) {
    info = (info || '').trim();
    if (!info) return null;
    // "run" / "read" blocks are commands / file requests, not files to write.
    if (/(^|\s)(run|read)(\s|$)/i.test(info)) return null;
    const pm = info.match(/(?:path|file|filename)\s*[:=]\s*["'`]?([^\s"'`]+)/i);
    if (pm) return pm[1].replace(/^\.?\//, '');
    // A bare token on the info line that looks like a path (slash or extension).
    for (const tok of info.split(/[\s:]+/).filter(Boolean)) {
        if (/[\/\\]/.test(tok) || /\.[A-Za-z0-9]+$/.test(tok)) return tok.replace(/^\.?\//, '');
    }
    return null;
}

// Wrap a written file's code in a collapsed, expandable card (one per file),
// so the chat stays readable and the user opens just the files they want.
function fileCard(path, innerHTML) {
    const icon = '<svg class="file-card-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    return `<details class="file-card"><summary>${icon}<span class="file-card-name">${escapeHTML(path)}</span>${chevron}</summary><div class="file-card-body">${innerHTML}</div></details>`;
}

// Minimal, safe Markdown -> HTML renderer (no dependency).
// Everything is HTML-escaped before any transform, so AI output cannot
// inject markup; only a known set of formatting tags is produced.
function renderMarkdown(src) {
    if (!src) return '';
    const NUL = '';

    // 1) Extract fenced code blocks so their content is left untouched.
    //    Capture the FULL info line (not just the language) so a file path on it
    //    (```js path=src/app.js) can be detected and rendered as a folded card.
    const codeBlocks = [];
    src = src.replace(/```([^\n]*)\r?\n([\s\S]*?)```/g, (m, info, code) => {
        const infoTrim = (info || '').trim();
        // An ```edit block renders as a red/green diff card, not raw markers.
        let editHunks = null, editPath = null;
        if (/(^|\s)edit(\s|$)/i.test(infoTrim.toLowerCase())) {
            const pm = infoTrim.match(/(?:path|file|filename)\s*[:=]\s*["'`]?([^\s"'`]+)/i);
            editPath = pm ? pm[1].replace(/^\.?\//, '') : (infoTrim.split(/[\s:]+/).find(t => t.toLowerCase() !== 'edit' && (/[\/\\]/.test(t) || /\.[A-Za-z0-9]+$/.test(t))) || null);
            if (editPath && typeof parseSearchReplace === 'function') editHunks = parseSearchReplace(code);
        }
        codeBlocks.push({ code: code.replace(/\n$/, ''), path: fenceFilePath(info), editPath, editHunks });
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
    html = html.replace(new RegExp(`${NUL}CODE(\\d+)${NUL}`, 'g'), (m, i) => {
        const b = codeBlocks[+i];
        // Edit block -> diff card (red/green), so the user never sees raw markers.
        if (b.editPath && b.editHunks && b.editHunks.length) {
            return diffCardHTML(b.editPath, b.editHunks);
        }
        const pre = `<pre class="code-block"><code>${escapeHTML(b.code)}</code></pre>`;
        // Fold ONLY a real code file: it must name a file (path=) AND be more
        // than a couple of lines. A one/two-line snippet — or any block without
        // a path — stays inline, so only full files in the summary collapse.
        const lineCount = b.code.split('\n').length;
        return (b.path && lineCount > 2) ? fileCard(b.path, pre) : pre;
    });

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
        el.innerHTML = renderMarkdown(acc);
        if (scrollEl) followScroll(scrollEl);
        await sleep(13);
    }
    el.innerHTML = finalHTML != null ? finalHTML : renderMarkdown(text);
    if (scrollEl) followScroll(scrollEl);
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
// Web links inside AI/system answers open in zaalis browser, so source links
// from /deep-search stay in the same browsing workspace.
document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[href^="http://"], a[href^="https://"]');
    if (!a || !a.closest('#chat-messages, #agents-log')) return;
    const href = a.href;
    if (!href) return;
    e.preventDefault();
    try {
        const r = await fetch(`/api/browser-open?url=${encodeURIComponent(href)}`);
        if (!r.ok) throw new Error('browser-open failed');
    } catch {
        window.open(href, '_blank', 'noopener,noreferrer');
    }
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
    // A message the user just sent always snaps to the bottom and re-engages
    // following; everything else only follows if the user is already there.
    if (type === 'user') forceScrollBottom(container, false);
    else followScroll(container);
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
    followScroll(container);
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

async function readAgentEventStream(res, onEvent) {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
        try { return await res.json(); }
        catch { return { error: `Reponse invalide du serveur (HTTP ${res.status} ${res.statusText})` }; }
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let streamError = null;
    let parseError = false;
    const handleLine = (line) => {
        const clean = line.trim();
        if (!clean) return;
        let event = null;
        try {
            event = JSON.parse(clean);
        } catch {
            parseError = true;
            return;
        }
        if (event.type === 'done') {
            result = event.result || {};
        } else if (event.type === 'error') {
            streamError = event.error || 'Erreur agent.';
        } else if (typeof onEvent === 'function') {
            onEvent(event);
        }
    };
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
    if (result) return result;
    if (streamError) return { error: streamError };
    if (parseError) return { error: `Flux agent invalide (HTTP ${res.status} ${res.statusText}).` };
    return { error: `Reponse agent incomplete (HTTP ${res.status} ${res.statusText}).` };
}

async function callAgentAI(model, submodel, message, images = [], signal = undefined, history = [], options = {}) {
    const { keys, ...safeConfig } = state.config;
    const wantsStream = typeof options.onEvent === 'function';
    const res = await fetch('/api/agent-chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(wantsStream ? { 'Accept': 'application/x-ndjson' } : {})
        },
        body: JSON.stringify({
            model,
            submodel,
            message,
            root: state.projectRoot,
            permissionMode: state.permissionMode,
            language: state.language || 'fr',
            config: safeConfig,
            reasoningLevel: state.reasoningLevel,
            images,
            history,
            stream: wantsStream
        }),
        signal
    });
    if (wantsStream) return readAgentEventStream(res, options.onEvent);
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
    const threshold = (model === 'local' || model === 'gguf') ? 0.60 : 0.75;
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
let pendingChatDraft = null;
let pendingChatDrawer = null;
let agentTaskRunning = false;
let pendingAgentDraft = null;
let pendingAgentDrawer = null;
const SEND_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
function createQueuedDraft(message) {
    const consumed = consumeAttachments();
    return { message: String(message || '').trim(), ...consumed };
}
function createChatDraft(message) { return createQueuedDraft(message); }
function createAgentDraft(message) { return createQueuedDraft(message); }
function ensurePendingChatDrawer() {
    if (pendingChatDrawer) return pendingChatDrawer;
    const input = $('#chat-input');
    const area = input && input.closest('.chat-input-area');
    pendingChatDrawer = document.createElement('div');
    pendingChatDrawer.className = 'chat-pending-drawer';
    pendingChatDrawer.innerHTML = `
        <div class="chat-pending-head">En attente</div>
        <div class="chat-pending-row">
            <span class="chat-pending-text"></span>
            <button type="button" class="chat-pending-cancel" aria-label="Annuler le message en attente" title="Annuler">&times;</button>
        </div>`;
    const cancel = pendingChatDrawer.querySelector('.chat-pending-cancel');
    cancel.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        restorePendingChatToInput();
    });
    if (area && input) area.insertBefore(pendingChatDrawer, input);
    return pendingChatDrawer;
}
function ensurePendingAgentDrawer() {
    if (pendingAgentDrawer) return pendingAgentDrawer;
    const input = $('#agents-input');
    const area = input && input.closest('.chat-input-area');
    pendingAgentDrawer = document.createElement('div');
    pendingAgentDrawer.className = 'chat-pending-drawer agents-pending-drawer';
    pendingAgentDrawer.innerHTML = `
        <div class="chat-pending-head">En attente</div>
        <div class="chat-pending-row">
            <span class="chat-pending-text"></span>
            <button type="button" class="chat-pending-cancel" aria-label="Annuler la tache en attente" title="Annuler">&times;</button>
        </div>`;
    pendingAgentDrawer.querySelector('.chat-pending-cancel').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        restorePendingAgentToInput();
    });
    if (area && input) area.insertBefore(pendingAgentDrawer, input);
    return pendingAgentDrawer;
}
function renderPendingChat() {
    const drawer = ensurePendingChatDrawer();
    const input = $('#chat-input');
    const area = input && input.closest('.chat-input-area');
    const on = !!pendingChatDraft;
    drawer.classList.toggle('show', on);
    if (area) area.classList.toggle('has-pending-chat', on);
    if (on) {
        drawer.querySelector('.chat-pending-text').textContent = pendingChatDraft.message || '';
    }
}
function queuePendingChat(message) {
    const lang = state.language || 'fr';
    if (pendingChatDraft) {
        showToast(lang === 'en' ? 'Already queued' : 'Deja en attente',
            lang === 'en' ? 'Only one message can wait at a time.' : 'Un seul message peut etre en attente a la fois.',
            { icon: '!', duration: 2600 });
        return false;
    }
    pendingChatDraft = createChatDraft(message);
    renderPendingChat();
    return true;
}
function restorePendingChatToInput() {
    if (!pendingChatDraft) return false;
    const draft = pendingChatDraft;
    pendingChatDraft = null;
    renderPendingChat();
    const input = $('#chat-input');
    if (input) {
        const existing = input.value.trim();
        input.value = draft.message + (existing ? '\n' + existing : '');
        autoGrow(input);
        input.focus();
    }
    if (Array.isArray(draft.attachments) && draft.attachments.length) {
        state.attachments = draft.attachments.concat(state.attachments || []);
        renderAttachments();
    }
    return true;
}
function takePendingChatDraft() {
    const draft = pendingChatDraft;
    pendingChatDraft = null;
    renderPendingChat();
    return draft;
}
function renderPendingAgent() {
    const drawer = ensurePendingAgentDrawer();
    const input = $('#agents-input');
    const area = input && input.closest('.chat-input-area');
    const on = !!pendingAgentDraft;
    drawer.classList.toggle('show', on);
    if (area) area.classList.toggle('has-pending-chat', on);
    if (on) drawer.querySelector('.chat-pending-text').textContent = pendingAgentDraft.message || '';
}
function queuePendingAgent(message) {
    const lang = state.language || 'fr';
    if (pendingAgentDraft) {
        showToast(lang === 'en' ? 'Already queued' : 'Deja en attente',
            lang === 'en' ? 'Only one agent task can wait at a time.' : 'Une seule tache Agents peut etre en attente a la fois.',
            { icon: '!', duration: 2600 });
        return false;
    }
    pendingAgentDraft = createAgentDraft(message);
    renderPendingAgent();
    return true;
}
function restorePendingAgentToInput() {
    if (!pendingAgentDraft) return false;
    const draft = pendingAgentDraft;
    pendingAgentDraft = null;
    renderPendingAgent();
    const input = $('#agents-input');
    if (input) {
        const existing = input.value.trim();
        input.value = draft.message + (existing ? '\n' + existing : '');
        autoGrow(input);
        input.focus();
    }
    if (Array.isArray(draft.attachments) && draft.attachments.length) {
        state.attachments = draft.attachments.concat(state.attachments || []);
        renderAttachments();
    }
    return true;
}
function takePendingAgentDraft() {
    const draft = pendingAgentDraft;
    pendingAgentDraft = null;
    renderPendingAgent();
    return draft;
}
function setChatBusy(on) {
    const btn = $('#send-btn');
    document.body.classList.toggle('ai-busy', !!on);
    if (typeof renderProjectPanelHistory === 'function') renderProjectPanelHistory(activeKind());
    else if (typeof renderSidebarConversations === 'function') renderSidebarConversations();
    if (!btn) return;
    btn.classList.toggle('stop', on);
    btn.innerHTML = on ? STOP_ICON : SEND_ICON;
}

async function sendChat(input) {
    const model = modelSelect.value;
    const submodel = submodelSelect.value;

    const lang = state.language || 'fr';
    const draft = (input && typeof input === 'object') ? input : createChatDraft(input);
    const message = draft.message || '';
    const { aiText = '', names = [], images = [] } = draft;

    const isLocal = model === 'local' || model === 'gguf';
    const modelLabel = modelSelect.options[modelSelect.selectedIndex].text.split(' ')[0];
    let completed = false;
    let aborted = false;

    // Compact the running context first if it's getting close to the limit.
    await maybeCompact(model, submodel);

    // Project tree goes into the SYSTEM prompt (background), on the first message
    // OR whenever the project changed since the last injection — so switching
    // project "à chaud" actually updates the assistant's context instead of
    // keeping the old tree. Weak models still don't get it on every turn.
    // Project context is injected by /api/agent-chat, shared with the CLI.
    if (state.projectRoot) state.lastContextRoot = state.projectRoot;
    let aiMessage = message + aiText;
    // /fast and /deep tweak the answer style without touching the tool protocol.
    if (state.responseStyle === 'fast') {
        aiMessage += lang === 'en'
            ? '\n\n[STYLE] Be concise: short, direct answers, minimal preamble.'
            : '\n\n[STYLE] Sois concis : réponses courtes et directes, peu de préambule.';
    } else if (state.responseStyle === 'deep') {
        aiMessage += lang === 'en'
            ? '\n\n[STYLE] Be thorough: consider edge cases, explain trade-offs, and verify with reads/searches when useful.'
            : '\n\n[STYLE] Sois approfondi : considère les cas limites, explique les compromis, et vérifie via lectures/recherches si utile.';
    }
    // user message stays clean
    const displayMsg = message + (names.length ? `\n📎 ${names.join(', ')}` : '');
    addMsg($('#chat-messages'), 'user', lang === 'en' ? 'You' : 'Vous', displayMsg);
    const liveActivity = createLiveAgentActivity($('#chat-messages'));
    let liveActivityFinished = false;
    const body = addTypingMsg($('#chat-messages'), modelLabel);

    // For local models, limit history to avoid overflowing the context window.
    // Keep only the last N turns so the system prompt + project context fit.
    let history = state.chatHistory.slice();
    if (isLocal) {
        const win = contextWindow(model, submodel);
        const sysTokens = 4096;
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
        const data = await callAgentAI(model, submodel, aiMessage, images, controller.signal, history, {
            onEvent: (event) => liveActivity && liveActivity.onEvent(event)
        });
        stopThinking(body);
        if (data.error) {
            if (liveActivity) liveActivity.fail(data.error);
            body.textContent = data.error;
            body.classList.add('error');
        } else {
            completed = true;
            if (liveActivity) {
                liveActivity.finish(data);
                liveActivityFinished = true;
            }
            const duration = Date.now() - t0;
            if (isMaxReasoning()) body.classList.add('max-reasoning-text');
            const reasoning = data.thinking ? reasoningBlock(data.thinking, duration) : '';
            const responseText = data.response || '';
            const formatted = formatAIResponse(responseText);
            const isImg = formatted.includes('generated-image');
            // Generated image = single rectangle (instant); text = streamed word-by-word.
            body.classList.toggle('has-image', isImg);
            if (isImg) {
                body.innerHTML = reasoning + formatted;
            } else {
                body.innerHTML = reasoning + '<div class="stream-target"></div>';
                await streamInto(body.querySelector('.stream-target'), responseText, formatted, controller.signal, $('#chat-messages'));
            }
            if (!liveActivity && Array.isArray(data.toolResults) && data.toolResults.length) {
                body.insertAdjacentHTML('beforeend', agentToolResultsHTML(data.toolResults));
                followScroll($('#chat-messages'));
            }

            // Update conversation memory + token meter. For images, keep a light
            // placeholder in memory instead of the heavy base64 data URL.
            let assistantMemory = responseText;
            if (isImg) {
                const am = responseText.match(/!\[([^\]]*)\]/);
                assistantMemory = am && am[1] ? `[Image générée : ${am[1]}]` : '[Image générée]';
            }
            if (Array.isArray(data.toolResults) && data.toolResults.length) {
                const toolMemory = data.toolResults
                    .map(t => `[${t.tool || 'outil'}] ${t.summary || ''}\n${String(t.text || '').slice(0, 4000)}`)
                    .join('\n\n');
                assistantMemory += `\n\n[Outils utilises]\n${toolMemory}`;
            }
            if (Array.isArray(data.todos) && data.todos.length) {
                const todoMemory = data.todos
                    .map(t => `- [${t.status || 'pending'}] ${t.content || ''}`)
                    .join('\n');
                assistantMemory += `\n\n[TODO STATE]\n${todoMemory}`;
            }
            state.chatHistory.push({ role: 'user', content: aiMessage }, { role: 'assistant', content: assistantMemory });
            if (data.usage && data.usage.input != null) {
                // Use actual token counts from the API when available.
                state.contextTokens = (data.usage.input || 0) + (data.usage.output || 0);
            } else {
                state.contextTokens = state.chatHistory.reduce((n, h) => n + estimateTokens(h.content), 0);
            }
            updateTokenMeter();
        }
    } catch (err) {
        stopThinking(body);
        if (err && err.name === 'AbortError') {
            aborted = true;
            if (liveActivity && !liveActivityFinished) liveActivity.fail(lang === 'en' ? 'Stopped.' : 'Interrompu.');
            body.textContent = lang === 'en' ? 'Stopped.' : 'Interrompu.';
            restorePendingChatToInput();
        } else {
            if (liveActivity && !liveActivityFinished) liveActivity.fail(TRANSLATIONS[lang]['err-conn'] || 'Erreur de connexion au serveur.');
            body.textContent = TRANSLATIONS[lang]['err-conn'] || 'Erreur de connexion au serveur.';
            body.classList.add('error');
        }
    } finally {
        chatAbort = null;
        setChatBusy(false);
    }

    saveConversation();
    if (completed && !aborted && pendingChatDraft) {
        const next = takePendingChatDraft();
        if (next) setTimeout(() => sendChat(next), 0);
    }
}

// Handle AI file modifications based on permission mode.
// Writes EVERY file block the model emits (creating files/folders as needed),
// not just the currently-open file — this is what makes it behave like a CLI/IDE.
// ==========================================================
//  DIFF-BASED FILE EDITS (Claude-Code-style Edit tool)
// ==========================================================
// Curly quotes -> straight, so a SEARCH typed with straight quotes still matches
// a file that uses typographic quotes (mirrors Claude Code's normalizeQuotes).
function normalizeQuotesEdit(s) {
    return String(s)
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"');
}
// Strip trailing whitespace per line (Claude Code does this on new_string,
// except for markdown where two trailing spaces are a hard line break).
function stripTrailingWS(s) {
    return String(s).split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
}
function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
}

// Apply one SEARCH/REPLACE hunk to `content`. Returns { ok, content, error }.
// Robustness ladder: exact match -> trailing-whitespace-insensitive -> quote
// normalized. Enforces uniqueness like Claude Code (ambiguous = error).
function applyOneHunk(content, search, replace, isMarkdown) {
    const newText = isMarkdown ? replace : stripTrailingWS(replace);

    // Insertion into empty file / append when SEARCH is empty.
    if (search === '') {
        return { ok: true, content: content ? content + '\n' + newText : newText };
    }

    // 1) exact
    let count = countOccurrences(content, search);
    if (count === 1) return { ok: true, content: content.replace(search, () => newText) };
    if (count > 1) return { ok: false, error: `le texte SEARCH apparaît ${count} fois (ajoute des lignes de contexte pour le rendre unique)` };

    // 2) trailing-whitespace-insensitive match (line by line)
    const looseSearch = stripTrailingWS(search);
    const looseContent = stripTrailingWS(content);
    count = countOccurrences(looseContent, looseSearch);
    if (count === 1) {
        // Find the matching span in the ORIGINAL content by walking lines.
        const idx = looseContent.indexOf(looseSearch);
        const before = looseContent.slice(0, idx);
        const startLine = before.split('\n').length - 1;
        const origLines = content.split('\n');
        const searchLineCount = looseSearch.split('\n').length;
        const actual = origLines.slice(startLine, startLine + searchLineCount).join('\n');
        if (countOccurrences(content, actual) === 1) {
            return { ok: true, content: content.replace(actual, () => newText) };
        }
    }

    // 3) quote-normalized match
    const nContent = normalizeQuotesEdit(content);
    const nSearch = normalizeQuotesEdit(search);
    count = countOccurrences(nContent, nSearch);
    if (count === 1) {
        const idx = nContent.indexOf(nSearch);
        const actual = content.substr(idx, search.length);
        if (countOccurrences(content, actual) === 1) {
            return { ok: true, content: content.replace(actual, () => newText) };
        }
    }
    if (count > 1) return { ok: false, error: `le texte SEARCH apparaît ${count} fois (rends-le unique)` };

    return { ok: false, error: 'le texte SEARCH est introuvable dans le fichier (copie-le EXACTEMENT, indentation comprise)' };
}

// Build a compact red/green diff (HTML) from a list of applied hunks.
function diffCardHTML(path, hunks) {
    const rows = [];
    for (const h of hunks) {
        (h.search ? h.search.split('\n') : []).forEach(l => rows.push(`<div class="diff-line del">- ${escapeHTML(l)}</div>`));
        (h.replace ? h.replace.split('\n') : []).forEach(l => rows.push(`<div class="diff-line add">+ ${escapeHTML(l)}</div>`));
        rows.push('<div class="diff-sep"></div>');
    }
    if (rows.length && rows[rows.length - 1] === '<div class="diff-sep"></div>') rows.pop();
    const icon = '<svg class="file-card-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    return `<details class="file-card diff-card"><summary>${icon}<span class="file-card-name">${escapeHTML(path)}</span><span class="diff-badge">diff</span>${chevron}</summary><div class="file-card-body diff-body">${rows.join('')}</div></details>`;
}

function commandCardHTML(cmd, output, opts = {}) {
    const lang = opts.lang || state.language || 'fr';
    const failed = !!opts.error;
    const duration = opts.duration != null ? ` · ${opts.duration}s` : '';
    const badge = failed ? (lang === 'en' ? 'error' : 'erreur') : `ok${duration}`;
    const title = lang === 'en' ? 'Command' : 'Commande';
    const empty = lang === 'en' ? '(no output)' : '(aucune sortie)';
    const text = `$ ${cmd}\n\n${failed ? opts.error : ((output || '').trim() || empty)}`;
    const icon = '<svg class="file-card-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    return `<details class="file-card tool-card command-card"><summary>${icon}<span class="file-card-name">${escapeHTML(title)}</span><span class="tool-badge">${escapeHTML(badge)}</span>${chevron}</summary><div class="file-card-body tool-card-body"><pre class="tool-pre">${escapeHTML(text)}</pre></div></details>`;
}

function agentToolCardHTML(result) {
    const lang = state.language || 'fr';
    const failed = !!(result && (result.error || result.blocked));
    const title = (result && (result.summary || result.tool)) || (lang === 'en' ? 'Tool' : 'Outil');
    const badge = failed ? (lang === 'en' ? 'blocked' : 'bloque') : 'ok';
    const text = (result && result.text) ? String(result.text) : (lang === 'en' ? '(no output)' : '(aucun resultat)');
    const icon = '<svg class="file-card-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82V9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82z"/></svg>';
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    return `<details class="file-card tool-card command-card"><summary>${icon}<span class="file-card-name">${escapeHTML(title)}</span><span class="tool-badge">${escapeHTML(badge)}</span>${chevron}</summary><div class="file-card-body tool-card-body"><pre class="tool-pre">${escapeHTML(text)}</pre></div></details>`;
}

function pluralFr(n, one, many) { return n === 1 ? one : many; }
function toolDisplayName(result) {
    const tool = String(result && result.tool || '').toLowerCase();
    const input = result && result.input || {};
    if (tool === 'glob') return `glob ${input.pattern || ''}`.trim();
    if (tool === 'grep') return `grep ${input.pattern || ''}`.trim();
    if (tool === 'read') return `read ${(input.paths || []).join(', ')}`.trim();
    if (tool === 'task') return `sous-agent ${input.title || ''}`.trim();
    if (tool === 'todo') return 'todo';
    if (tool === 'run') return `run ${input.command || ''}`.trim();
    return result.summary || tool || 'outil';
}
function toolRunDetailsHTML(results) {
    if (!results.length) return '';
    const lang = state.language || 'fr';
    const count = results.length;
    const label = lang === 'en'
        ? `${count} ${count === 1 ? 'command executed' : 'commands executed'}`
        : `${count} ${pluralFr(count, 'commande executee', 'commandes executees')}`;
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    const body = results.map(r => {
        const failed = !!(r.error || r.blocked);
        const name = toolDisplayName(r);
        const badge = failed ? (lang === 'en' ? 'error' : 'erreur') : (r.tool || 'outil');
        const text = r.text ? String(r.text) : (lang === 'en' ? '(no output)' : '(aucun resultat)');
        return `<details class="ghost-tool-item">
            <summary><span class="ghost-tool-name">${escapeHTML(name)}</span><span class="ghost-tool-badge">${escapeHTML(badge)}</span>${chevron}</summary>
            <pre class="ghost-tool-pre">${escapeHTML(text)}</pre>
        </details>`;
    }).join('');
    return `<details class="ghost-tool-group">
        <summary><span class="ghost-chevron">${chevron}</span><span>${escapeHTML(label)}</span></summary>
        <div class="ghost-tool-body">${body}</div>
    </details>`;
}
function fileChangeDetailsHTML(results) {
    const changes = [];
    for (const r of results) {
        const tool = String(r.tool || '').toLowerCase();
        const input = r.input || {};
        if (tool === 'edit' && input.path) {
            changes.push({
                kind: state.language === 'en' ? 'Modified' : 'Modifie',
                path: input.path,
                body: diffCardHTML(input.path, input.hunks || [])
            });
        } else if (tool === 'write' && input.path) {
            const content = String(input.content || '');
            changes.push({
                kind: state.language === 'en' ? 'Written' : 'Ecrit',
                path: input.path,
                body: `<pre class="ghost-tool-pre">${escapeHTML(content || '(vide)')}</pre>`
            });
        }
    }
    if (!changes.length) return '';
    const lang = state.language || 'fr';
    const label = lang === 'en'
        ? `${changes.length} ${changes.length === 1 ? 'file changed' : 'files changed'}`
        : `${changes.length === 1 ? 'Un fichier modifie' : changes.length + ' fichiers modifies'}`;
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    const body = changes.map(c => `<details class="ghost-tool-item ghost-file-change">
        <summary><span class="ghost-tool-name">${escapeHTML(c.kind)} ${escapeHTML(c.path)}</span>${chevron}</summary>
        <div class="ghost-tool-nested">${c.body}</div>
    </details>`).join('');
    return `<details class="ghost-tool-group ghost-change-group">
        <summary><span class="ghost-chevron">${chevron}</span><span>${escapeHTML(label)}</span></summary>
        <div class="ghost-tool-body">${body}</div>
    </details>`;
}
function agentToolResultsHTML(results) {
    const list = Array.isArray(results) ? results : [];
    const changes = list.filter(r => ['edit', 'write'].includes(String(r.tool || '').toLowerCase()));
    const reads = list.filter(r => !['edit', 'write'].includes(String(r.tool || '').toLowerCase()));
    return fileChangeDetailsHTML(changes) + toolRunDetailsHTML(reads);
}

function liveToolResultHTML(result) {
    const tool = String(result && result.tool || '').toLowerCase();
    if (tool === 'edit' || tool === 'write') return fileChangeDetailsHTML([result]);
    return toolRunDetailsHTML([result]);
}

function createLiveAgentActivity(container) {
    if (!container) return null;
    const lang = state.language || 'fr';
    const startedAt = Date.now();
    const body = addMsg(container, 'ai', null, '', true);
    const msg = body.closest('.msg');
    if (msg) msg.classList.add('live-agent-msg');
    body.classList.add('live-agent-body', 'live-agent-active');
    const chevron = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    body.innerHTML = `
        <details class="ghost-tool-group live-agent-activity" open>
            <summary>
                <span class="ghost-chevron">${chevron}</span>
                <span class="live-agent-title">${lang === 'en' ? 'Analyzing' : 'Analyse en cours'}</span>
                <span class="live-agent-status">${lang === 'en' ? 'Preparing context' : 'Preparation du contexte'}</span>
            </summary>
            <div class="ghost-tool-body live-agent-tools"></div>
        </details>`;
    const details = body.querySelector('.live-agent-activity');
    const titleEl = body.querySelector('.live-agent-title');
    const statusEl = body.querySelector('.live-agent-status');
    const toolsEl = body.querySelector('.live-agent-tools');
    let seenActivity = 0;

    const setStatus = (text) => {
        if (!statusEl || !text) return;
        statusEl.textContent = text;
    };
    const pendingHTML = (event) => {
        const id = String(event.id || '');
        const label = toolDisplayName({ tool: event.tool, input: event.input || {}, summary: event.summary });
        const badge = event.tool || 'outil';
        return `<div class="ghost-tool-item live-tool-pending" data-live-tool-id="${escapeHTML(id)}">
            <span class="live-tool-dot"></span>
            <span class="ghost-tool-name">${escapeHTML(label)}</span>
            <span class="ghost-tool-badge">${escapeHTML(badge)}</span>
        </div>`;
    };
    const replacePending = (event, html) => {
        const id = String(event.id || '');
        const existing = id ? toolsEl.querySelector(`[data-live-tool-id="${id}"]`) : null;
        if (existing) existing.outerHTML = html;
        else toolsEl.insertAdjacentHTML('beforeend', html);
        followScroll(container);
    };

    return {
        onEvent(event) {
            if (!event || !event.type) return;
            if (event.type === 'phase' || event.type === 'model_start') {
                setStatus(event.label || (lang === 'en' ? 'Thinking' : 'Reflexion'));
                return;
            }
            if (event.type === 'tool_batch') {
                const count = Number(event.count || 0);
                setStatus(lang === 'en'
                    ? `${count} ${count === 1 ? 'tool' : 'tools'} planned`
                    : `${count} ${pluralFr(count, 'outil prevu', 'outils prevus')}`);
                return;
            }
            if (event.type === 'assistant_note') {
                const note = String(event.text || '').trim();
                if (note) {
                    seenActivity++;
                    toolsEl.insertAdjacentHTML('beforeend', `<div class="live-agent-note">${escapeHTML(note)}</div>`);
                    setStatus(lang === 'en' ? 'Planning tools' : 'Preparation des outils');
                    followScroll(container);
                }
                return;
            }
            if (event.type === 'tool_started') {
                seenActivity++;
                toolsEl.insertAdjacentHTML('beforeend', pendingHTML(event));
                setStatus(toolDisplayName({ tool: event.tool, input: event.input || {}, summary: event.summary }));
                followScroll(container);
                return;
            }
            if (event.type === 'tool_done') {
                seenActivity++;
                const result = {
                    tool: event.tool,
                    input: event.input || {},
                    summary: event.summary,
                    text: event.text,
                    error: event.error,
                    blocked: event.blocked,
                    todos: event.todos,
                    events: event.events,
                    subToolResults: event.subToolResults,
                };
                replacePending(event, liveToolResultHTML(result));
                setStatus(event.summary || toolDisplayName(result));
                return;
            }
            if (event.type === 'error') {
                this.fail(event.error || 'Erreur agent.');
            }
        },
        finish(data) {
            const results = Array.isArray(data && data.toolResults) ? data.toolResults : [];
            if (!results.length && !seenActivity) {
                if (msg) msg.remove();
                return;
            }
            if (titleEl) {
                titleEl.textContent = lang === 'en'
                    ? `Analysis complete in ${fmtDuration(Date.now() - startedAt)}`
                    : `Analyse terminee en ${fmtDuration(Date.now() - startedAt)}`;
            }
            setStatus(results.length
                ? (lang === 'en' ? `${results.length} steps` : `${results.length} ${pluralFr(results.length, 'etape', 'etapes')}`)
                : (lang === 'en' ? 'No tool executed' : 'Aucun outil execute'));
            const html = agentToolResultsHTML(results);
            toolsEl.innerHTML = html || `<div class="live-agent-empty">${lang === 'en' ? 'No tool executed.' : 'Aucun outil execute.'}</div>`;
            if (details) details.removeAttribute('open');
            body.classList.remove('live-agent-active');
            followScroll(container);
        },
        fail(error) {
            seenActivity++;
            if (titleEl) titleEl.textContent = lang === 'en' ? 'Analysis interrupted' : 'Analyse interrompue';
            setStatus(error || (lang === 'en' ? 'Agent error' : 'Erreur agent'));
            toolsEl.insertAdjacentHTML('beforeend', `<pre class="ghost-tool-pre">${escapeHTML(error || 'Erreur agent')}</pre>`);
            body.classList.remove('live-agent-active');
            if (details) details.removeAttribute('open');
            followScroll(container);
        }
    };
}

// Apply every ```edit block. Returns { wroteAny, errors:[{path,error}] }.
async function applyEditBlocks(editBlocks, agentName, out, lang) {
    let wroteAny = false;
    const errors = [];
    const changed = [];
    for (const { path: targetFile, hunks } of editBlocks) {
        const isMarkdown = /\.(md|mdx)$/i.test(targetFile);
        // Load current content (from the open editor if available, else from disk).
        let current = null;
        if (state.openFiles[targetFile] && typeof state.openFiles[targetFile].content === 'string') {
            current = state.openFiles[targetFile].content;
        } else {
            try {
                const res = await fetch(`/api/file?root=${encodeURIComponent(state.projectRoot)}&path=${encodeURIComponent(targetFile)}`);
                const d = await res.json().catch(() => ({}));
                if (res.ok && !d.error) current = d.content || '';
            } catch {}
        }
        if (current === null) {
            errors.push({ path: targetFile, error: lang === 'en' ? 'file not found (use a write block to create it, or read it first)' : "fichier introuvable (utilise un bloc d'écriture pour le créer, ou lis-le d'abord)" });
            continue;
        }

        // Apply hunks sequentially; stop this file on first failure.
        let working = current;
        const applied = [];
        let failed = null;
        for (const h of hunks) {
            const r = applyOneHunk(working, h.search, h.replace, isMarkdown);
            if (!r.ok) { failed = r.error; break; }
            working = r.content;
            applied.push(h);
        }
        if (failed) {
            errors.push({ path: targetFile, error: failed });
            addMsg(out, 'system', null, `${lang === 'en' ? 'Edit failed' : 'Édition échouée'} — ${targetFile}: ${failed}`);
            continue;
        }
        if (working === current) {
            continue; // no-op edit
        }

        // Permission gate (same model as full-file writes).
        if (state.permissionMode === 'supervised') {
            const desc = lang === 'en' ? `${agentName} wants to edit ${targetFile}` : `${agentName} veut modifier ${targetFile}`;
            const preview = applied.map(h => `- ${(h.search || '').split('\n')[0]}\n+ ${(h.replace || '').split('\n')[0]}`).join('\n');
            const approved = await requestApproval(desc, preview.slice(0, 500));
            if (!approved) {
                addMsg(out, 'system', null, TRANSLATIONS[lang]['modification-refused'] || 'Modification refusee.');
                continue;
            }
        }

        try {
            const res = await fetch('/api/file', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root: state.projectRoot, path: targetFile, content: working })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const result = await res.json();
            if (result.error) throw new Error(result.error);

            if (state.openFiles[targetFile]) {
                state.openFiles[targetFile].content = working;
                state.openFiles[targetFile].unsaved = false;
            }
            if (state.activeFile === targetFile) {
                textarea.value = working;
                updateGutter(working);
                if (typeof renderHighlight === 'function') renderHighlight();
                renderTabs();
            }
            changed.push({ tool: 'edit', input: { path: targetFile, hunks: applied } });
            wroteAny = true;
        } catch (err) {
            errors.push({ path: targetFile, error: err.message });
            addMsg(out, 'system', null, `${lang === 'en' ? 'Write error' : 'Erreur ecriture'} ${targetFile}: ${err.message}`);
        }
    }
    if (changed.length) addMsg(out, 'system', null, fileChangeDetailsHTML(changed), true);
    return { wroteAny, errors };
}

async function handleAIResponse(response, agentName, container) {
    const lang = state.language || 'fr';
    // Route system/terminal messages to the right view so Chat and Agents stay
    // completely separate (a refusal in Agents must not appear in the Chat).
    const out = $(container || '#chat-messages');

    if (!state.projectRoot) {
        addMsg(out, 'system', null,
            lang === 'en' ? 'Open a project folder first so changes can be written to disk.'
                          : 'Ouvrez d\'abord un dossier de projet pour pouvoir ecrire les modifications sur le disque.');
        return { editErrors: [] };
    }

    const editBlocks = extractEditBlocks(response);
    let blocks = extractFileBlocks(response);
    const commands = extractRunBlocks(response);

    // Fallback (legacy): prose names a file + a code block exists + a file is open.
    if (blocks.length === 0 && editBlocks.length === 0) {
        const fileMatch = response.match(/(?:fichier|file|ecrire dans|modifier|sauvegarder)\s+[`"]?([^\s`"]+\.\w+)[`"]?/i);
        const codeMatch = response.match(/```[^\n]*\n([\s\S]*?)```/);
        if (fileMatch && codeMatch && state.activeFile) {
            blocks = [{ path: state.activeFile, content: codeMatch[1].replace(/\n$/, '') }];
        }
    }

    if (blocks.length === 0 && editBlocks.length === 0 && commands.length === 0) return { editErrors: [] };

    // PLAN / READ-ONLY modes: the model may have proposed edits or commands, but
    // we never touch the disk or run anything. Tell the user what was skipped.
    if (isReadOnlyMode()) {
        const what = [];
        if (editBlocks.length || blocks.length) what.push(lang === 'en' ? 'file changes' : 'modifications de fichiers');
        if (commands.length) what.push(lang === 'en' ? 'commands' : 'commandes');
        const modeName = permissionLabel(state.permissionMode, lang);
        addMsg(out, 'system', null, lang === 'en'
            ? `${modeName} mode — ${what.join(' & ')} were NOT applied (read-only).`
            : `Mode ${modeName} — ${what.join(' et ')} non appliquées (lecture seule).`);
        return { editErrors: [] };
    }

    // Diff-based edits first (cheaper / preferred path).
    let editErrors = [];
    let wroteAny = false;
    if (editBlocks.length) {
        const er = await applyEditBlocks(editBlocks, agentName, out, lang);
        editErrors = er.errors;
        if (er.wroteAny) wroteAny = true;
    }
    const writeChanges = [];
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

            writeChanges.push({ tool: 'write', input: { path: targetFile, content: codeContent } });
            wroteAny = true;
        } catch (err) {
            addMsg(out, 'system', null,
                `${lang === 'en' ? 'Write error' : 'Erreur ecriture'} ${targetFile}: ${err.message}`);
        }
    }
    if (writeChanges.length) addMsg(out, 'system', null, fileChangeDetailsHTML(writeChanges), true);

    // Refresh the file tree so newly-created files appear in the explorer.
    if (wroteAny) await loadFileTree();

    // Run terminal commands the AI requested (```run blocks).
    // Permission: supervised + semi ask first; auto runs without asking — EXCEPT
    // destructive commands, which always ask (unless mode is bypass).
    for (const cmd of commands) {
        const dangerous = isDangerousCommand(cmd);
        const needAsk = dangerous
            ? state.permissionMode !== 'bypass'
            : state.permissionMode !== 'auto' && state.permissionMode !== 'bypass';
        if (needAsk) {
            const desc = dangerous
                ? (lang === 'en' ? `${agentName} wants to run a DANGEROUS command` : `${agentName} veut exécuter une commande DANGEREUSE`)
                : (lang === 'en' ? `${agentName} wants to run a command` : `${agentName} veut exécuter une commande`);
            const approved = await requestApproval(desc, cmd);
            if (!approved) {
                addMsg(out, 'system', null,
                    lang === 'en' ? 'Command refused.' : 'Commande refusée.');
                continue;
            }
        }
        const t0 = Date.now();
        try {
            const res = await fetch('/api/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd, cwd: state.projectRoot })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const execRes = await res.json();
            const duration = Math.round((Date.now() - t0) / 100) / 10;
            if (execRes.error) {
                addMsg(out, 'system', null, commandCardHTML(cmd, '', { lang, error: execRes.error, duration }), true);
            } else {
                const text = ((execRes.stdout || '') + (execRes.stderr ? '\n' + execRes.stderr : '')).trim();
                addMsg(out, 'system', null, commandCardHTML(cmd, text, { lang, duration }), true);
            }
        } catch (err) {
            const duration = Math.round((Date.now() - t0) / 100) / 10;
            addMsg(out, 'system', null, commandCardHTML(cmd, '', { lang, error: err.message, duration }), true);
        }
    }

    return { editErrors };
}

// When an ```edit block failed to apply (SEARCH not found / not unique), feed the
// exact errors back to the model so it can correct and retry — the agentic loop
// that makes editing feel like Claude Code. Bounded to avoid infinite retries.
async function resolveEditRetries(editErrors, model, submodel, isLocal, lang, depth = 0, opts = {}) {
    if (!editErrors || !editErrors.length || depth >= 2) return;
    if (!state.projectRoot) return;
    const out = $(opts.container || '#chat-messages');
    const retryHistory = Array.isArray(opts.history) ? opts.history : state.chatHistory.slice();
    const modelLabel = opts.modelLabel || (modelSelect.options[modelSelect.selectedIndex]?.text || model).split(' ')[0];
    const persistToChat = opts.persistToChat !== false;

    // Re-send the files involved so the model can copy the exact text.
    let ctx = '';
    const seen = new Set();
    for (const e of editErrors) {
        if (seen.has(e.path)) continue;
        seen.add(e.path);
        try {
            const res = await fetch(`/api/file?root=${encodeURIComponent(state.projectRoot)}&path=${encodeURIComponent(e.path)}`);
            const d = await res.json().catch(() => ({}));
            const full = (res.ok && !d.error) ? (d.content || '') : '';
            const max = isLocal ? 4000 : 12000;
            ctx += `\n# ${e.path} (${lang === 'en' ? 'error' : 'erreur'}: ${e.error})\n\`\`\`\n${full.slice(0, max)}${full.length > max ? '\n... (tronqué)' : ''}\n\`\`\`\n`;
        } catch {}
    }

    const followUp = (lang === 'en'
        ? 'Some edits did not apply. Here is the CURRENT content of each file — copy the SEARCH text EXACTLY from it (indentation included) and resend corrected ```edit blocks. Do not rewrite the whole file.\n'
        : "Certaines éditions n'ont pas pu être appliquées. Voici le contenu ACTUEL de chaque fichier — copie le texte SEARCH EXACTEMENT depuis celui-ci (indentation comprise) et renvoie des blocs ```edit corrigés. Ne réécris pas tout le fichier.\n") + ctx;

    addMsg(out, 'system', null, (lang === 'en' ? 'Retrying edits…' : 'Nouvelle tentative d\'édition…'));
    const sys = codeAgentPrompt(isLocal, modelIdentity(model, submodel, lang));
    const body = addTypingMsg(out, modelLabel);
    const controller = new AbortController();
    chatAbort = controller;
    setChatBusy(true);
    try {
        const data = await callAI(model, submodel, followUp, sys, [], controller.signal, retryHistory);
        stopThinking(body);
        if (data.error) { body.textContent = data.error; body.classList.add('error'); return; }
        const formatted = formatAIResponse(data.response);
        body.innerHTML = '<div class="stream-target"></div>';
        await streamInto(body.querySelector('.stream-target'), data.response, formatted, controller.signal, out);
        if (persistToChat) state.chatHistory.push(
            { role: 'user', content: `[${lang === 'en' ? 'Edit retry' : 'Réessai édition'}]` },
            { role: 'assistant', content: data.response }
        );
        const applied = await handleAIResponse(data.response, modelLabel, opts.container);
        if (applied && applied.editErrors && applied.editErrors.length) {
            await resolveEditRetries(applied.editErrors, model, submodel, isLocal, lang, depth + 1, opts);
        }
        if (opts.saveKind) saveConversation(opts.saveKind);
    } catch (err) {
        stopThinking(body);
        if (!(err && err.name === 'AbortError')) { body.textContent = TRANSLATIONS[lang]['err-conn'] || 'Erreur.'; body.classList.add('error'); }
    } finally {
        chatAbort = null;
        setChatBusy(false);
    }
}

// If the assistant asked to read project files (```read blocks), fetch their
// contents and feed them back so it can analyze them — then let it answer.
// Bounded: max files, max chars per file, and max read rounds (anti-loop).
async function resolveReadRequests(response, model, submodel, isLocal, lang, depth = 0) {
    if (depth >= 3) return;                 // hard cap on read rounds
    if (!state.projectRoot) return;
    const requested = extractReadBlocks(response);
    if (!requested.length) return;

    const maxFiles = isLocal ? 5 : 10;
    const maxChars = isLocal ? 4000 : 12000;
    const picked = requested.slice(0, maxFiles);
    const out = $('#chat-messages');

    let ctx = lang === 'en' ? 'Contents of the requested files:\n' : 'Contenu des fichiers demandés :\n';
    for (const p of picked) {
        try {
            const res = await fetch(`/api/file?root=${encodeURIComponent(state.projectRoot)}&path=${encodeURIComponent(p)}`);
            const d = await res.json().catch(() => ({}));
            if (!res.ok || d.error) { ctx += `\n# ${p}\n(${(d && d.error) || ('HTTP ' + res.status)})\n`; continue; }
            const full = d.content || '';
            ctx += `\n# ${p}\n\`\`\`\n${full.slice(0, maxChars)}${full.length > maxChars ? '\n... (tronqué)' : ''}\n\`\`\`\n`;
        } catch { ctx += `\n# ${p}\n(${lang === 'en' ? 'read failed' : 'lecture impossible'})\n`; }
    }

    addMsg(out, 'system', null, (lang === 'en' ? 'Read: ' : 'Lecture : ') + picked.join(', '));

    // Re-query the model with the file contents so it produces the analysis.
    const sys = codeAgentPrompt(isLocal, modelIdentity(model, submodel, lang));
    const followUp = (lang === 'en'
        ? 'Here is the content you requested. Analyze it and answer the user now (do not request these same files again).\n\n'
        : 'Voici le contenu que tu as demandé. Analyse-le et réponds maintenant à l\'utilisateur (ne redemande pas ces mêmes fichiers).\n\n') + ctx;

    const modelLabel = modelSelect.options[modelSelect.selectedIndex].text.split(' ')[0];
    const body = addTypingMsg(out, modelLabel);
    const controller = new AbortController();
    chatAbort = controller;
    setChatBusy(true);
    try {
        const data = await callAI(model, submodel, followUp, sys, [], controller.signal, state.chatHistory.slice());
        stopThinking(body);
        if (data.error) { body.textContent = data.error; body.classList.add('error'); return; }
        const reasoning = data.thinking ? reasoningBlock(data.thinking, 0) : '';
        const formatted = formatAIResponse(data.response);
        body.innerHTML = reasoning + '<div class="stream-target"></div>';
        await streamInto(body.querySelector('.stream-target'), data.response, formatted, controller.signal, out);
        // Keep conversation memory lean: record that files were read, not the dump.
        state.chatHistory.push(
            { role: 'user', content: `[${lang === 'en' ? 'Read files' : 'Lecture fichiers'}: ${picked.join(', ')}]` },
            { role: 'assistant', content: data.response }
        );
        updateTokenMeter();
        const applied = await handleAIResponse(data.response, modelLabel);
        if (applied && applied.editErrors && applied.editErrors.length) {
            await resolveEditRetries(applied.editErrors, model, submodel, isLocal, lang);
        }
        await resolveReadRequests(data.response, model, submodel, isLocal, lang, depth + 1);
    } catch (err) {
        stopThinking(body);
        if (!(err && err.name === 'AbortError')) { body.textContent = TRANSLATIONS[lang]['err-conn'] || 'Erreur.'; body.classList.add('error'); }
    } finally {
        chatAbort = null;
        setChatBusy(false);
        saveConversation();
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

// ---- Slash commands — central registry + handlers live in commands.js
// (SLASH_COMMANDS and runSlashCommand are defined there). This block only owns
// the Anthropic-style suggestion menu / input wiring.
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
    if (!cmd) { resetInput(slashInput); return; }
    // Commands that take arguments: prefill "/name " and keep editing instead of
    // running immediately, so the user can type the pattern/path/etc.
    if (cmd.args) {
        slashInput.value = '/' + cmd.name + ' ';
        autoGrow(slashInput);
        slashInput.focus();
        return;
    }
    resetInput(slashInput);
    runSlashCommand(cmd.name, '');
}

// Decide whether a typed line is a command or a normal message.
function handleChatSubmit() {
    let text = slashInput.value.trim();
    if (!text) return;
    closeSlash();
    // Raccourcis façon Claude Code : `!commande` = /run, `# note` = /remember.
    if (text.startsWith('!') && text.length > 1) text = '/run ' + text.slice(1).trim();
    else if (/^#\s+\S/.test(text)) text = '/remember ' + text.replace(/^#\s+/, '');
    if (text.startsWith('/')) {
        if (chatAbort) {
            const lang = state.language || 'fr';
            showToast(lang === 'en' ? 'Command paused' : 'Commande en pause',
                lang === 'en' ? 'Wait for the current answer before running a slash command.' : 'Attends la fin de la reponse en cours pour lancer une commande slash.',
                { icon: '!', duration: 2400 });
            return;
        }
        const parts = text.slice(1).split(/\s+/);
        const name = parts[0].toLowerCase();
        const argStr = text.slice(1 + parts[0].length).trim();
        resetInput(slashInput);
        runSlashCommand(name, argStr);
        return;
    }
    if (chatAbort) {
        if (queuePendingChat(text)) resetInput(slashInput);
        return;
    }
    sendChat(createChatDraft(text));
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
async function sendAgentTask(input) {
    const lang = state.language || 'fr';
    let task = (input && typeof input === 'object') ? String(input.message || '').trim() : String(input || '').trim();
    if (!state.agentMode) {
        addMsg($('#agents-log'), 'system', null, lang === 'en' ? "Activate Agent Mode first." : "Activez le Mode Agents d'abord.");
        return;
    }

    const labels = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', mistral: 'Mistral', local: 'Ollama', gguf: 'GGUF' };
    const activeAgents = [];
    $$('.agent-check:checked').forEach(cb => {
        const agent = cb.dataset.agent;
        const card = $(`.agent-card[data-agent="${agent}"]`);
        const role = card.querySelector('.agent-role-select').value;
        const modelSel = card.querySelector('.agent-model-select');
        const submodel = modelSel ? modelSel.value : state.config.ollamaModel;
        activeAgents.push({ agent, role, submodel });
    });

    const missingModels = activeAgents.filter(a => !a.submodel);
    if (missingModels.length) {
        addMsg($('#agents-log'), 'system', null,
            lang === 'en'
                ? `${missingModels.map(a => labels[a.agent] || a.agent).join(', ')} has no installed model selected.`
                : `${missingModels.map(a => labels[a.agent] || a.agent).join(', ')} n'a aucun modele installe selectionne.`);
        return;
    }

    if (activeAgents.length < 2) {
        addMsg($('#agents-log'), 'system', null, TRANSLATIONS[lang]['min-agents-required'] || 'Minimum 2 agents requis.');
        return;
    }

    agentTaskRunning = true;
    try {

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
    const taskDraft = (input && typeof input === 'object') ? input : createAgentDraft(task);
    const { aiText = '', names = [], images: taskImages = [] } = taskDraft;
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
    followScroll(agentsLog);
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
        followScroll(agentsLog);
        const statusText = line.querySelector('.team-agent-status');

        const isLocalAgent = agent === 'local' || agent === 'gguf';
        const systemPrompt = `${ROLE_PROMPTS[role]}\n${AGENT_COLLABORATION_PROMPT}\n${codeAgentPrompt(isLocalAgent, modelIdentity(agent, submodel, lang))}${projCtx}`;
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
        followScroll(agentsLog);
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

    const leadIsLocal = leadAgent.agent === 'local' || leadAgent.agent === 'gguf';
    const leadSystemPrompt = `${ROLE_PROMPTS[leadAgent.role]}\n${AGENT_COLLABORATION_PROMPT}\n${codeAgentPrompt(leadIsLocal, modelIdentity(leadAgent.agent, leadAgent.submodel, lang))}${projCtx}`;
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
            const applied = await handleAIResponse(data.response, labels[leadAgent.agent], '#agents-log');
            if (applied && applied.editErrors && applied.editErrors.length) {
                await resolveEditRetries(applied.editErrors, leadAgent.agent, leadAgent.submodel, leadIsLocal, lang, 0, {
                    container: '#agents-log',
                    history: [
                        { role: 'user', content: leadMessage },
                        { role: 'assistant', content: data.response }
                    ],
                    modelLabel: labels[leadAgent.agent],
                    persistToChat: false,
                    saveKind: 'agents'
                });
            }
        }
    } catch (err) {
        stopThinking(streamTarget);
        streamTarget.textContent = TRANSLATIONS[lang]['err-conn-lead'] || 'Erreur de connexion.';
        streamTarget.classList.add('error');
    }

    leadCard.classList.remove('working');
    leadBadge.textContent = TRANSLATIONS[lang]['status-done'];
    leadBadge.className = 'agent-badge done';
    followScroll(agentsLog);

    // Save this agents session to the (separate) agents history.
    saveConversation('agents');
    } finally {
        agentTaskRunning = false;
        if (pendingAgentDraft) {
            const next = takePendingAgentDraft();
            if (next) setTimeout(() => sendAgentTask(next), 0);
        }
    }
}

function handleAgentsSubmit() {
    const input = $('#agents-input');
    const text = input.value.trim();
    if (!text) return;
    if (agentTaskRunning) {
        if (queuePendingAgent(text)) resetInput(input);
        return;
    }
    sendAgentTask(text);
    resetInput(input);
}
$('#agents-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAgentsSubmit();
    }
});
$('#agents-send-btn').addEventListener('click', handleAgentsSubmit);

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

// Display name of the open project (last path segment) — used to group
// conversations by project in the mobile remote view. null when no project.
function projectLabel() {
    if (!state.projectRoot) return null;
    const parts = String(state.projectRoot).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || null;
}

const PERSISTED_MSG_CLASSES = [
    'deep-search-host',
    'has-image',
    'max-reasoning-text'
];
function persistedBodyClasses(body) {
    if (!body) return [];
    return PERSISTED_MSG_CLASSES.filter((cls) => body.classList.contains(cls));
}
function shouldPersistRichHTML(body, entry) {
    if (!body || entry.type === 'user') return false;
    return body.classList.contains('deep-search-host') ||
        body.classList.contains('has-image') ||
        !!body.querySelector('.deep-search-flow, .md, .thinking-details, .response-text, a[href], details.file-card, .generated-image');
}

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
        const classes = persistedBodyClasses(body);
        if (classes.length) entry.bodyClasses = classes;
        if (shouldPersistRichHTML(body, entry)) entry.html = body.innerHTML;
        // Persist generated images so they survive a reload of the conversation.
        if (img) entry.image = { url: img.getAttribute('src'), alt: img.getAttribute('alt') || '' };
        data.push(entry);
    });

    if (data.length <= 1) return; // only the default system message

    const title = data.find(d => d.type === 'user')?.text?.substring(0, 40) || 'Conversation';
    const project = projectLabel();          // folder name (mobile groups by it)
    const projectPath = state.projectRoot || null;  // full path, lets us re-open it
    const listArr = state[cfg.store];
    let curId = state[cfg.current];

    if (!curId) {
        curId = Date.now().toString();
        state[cfg.current] = curId;
        listArr.push({ id: curId, title, date: new Date().toLocaleDateString(), project, projectPath, messages: data });
    } else {
        const conv = listArr.find(c => c.id === curId);
        if (conv) {
            conv.messages = data;
            if (!conv.project && project) conv.project = project;
            if (!conv.projectPath && projectPath) conv.projectPath = projectPath;
            if (!conv.title || conv.title === 'Conversation') conv.title = title;
        }
        else listArr.push({ id: curId, title, date: new Date().toLocaleDateString(), project, projectPath, messages: data });
    }

    persistChats(kind);
    renderHistory();
}

// Last server snapshot per kind — drives the live history sync below so we only
// re-render when conversations actually changed (and ignore our own writes).
const _chatSnap = { chat: '', agents: '' };

// Save a kind's conversations to the server (debounced, per kind).
const _persistTimers = {};
function persistChats(kind = 'chat') {
    const cfg = HIST[kind];
    clearTimeout(_persistTimers[kind]);
    _persistTimers[kind] = setTimeout(() => {
        // Our own write becomes the next expected server state — don't let the
        // live sync treat it as an external change and re-render needlessly.
        _chatSnap[kind] = JSON.stringify(state[cfg.store] || []);
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
            if (res.ok) {
                state[HIST[kind].store] = await res.json();
                _chatSnap[kind] = JSON.stringify(state[HIST[kind].store] || []);
            }
        } catch {}
    }
    renderHistory();
    // Push the locally-stored recent projects to the account so the mobile
    // remote's "Projets" list mirrors what the desktop has opened.
    if (typeof syncRecentProjects === 'function') {
        const local = (typeof getRecentProjects === 'function') ? getRecentProjects() : [];
        if (local.length) syncRecentProjects(local);
    }
    startChatSync();
}

// ----------------------------------------------------------------------------
// LIVE HISTORY SYNC — reflect conversations created elsewhere (e.g. the phone
// remote) in the desktop history in (near) real time, without relaunching.
// ----------------------------------------------------------------------------
let _chatSyncTimer = null;
function startChatSync() {
    if (_chatSyncTimer) return;
    _chatSyncTimer = setInterval(syncChatsFromServer, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncChatsFromServer(); });
}

async function syncChatsFromServer() {
    if (document.hidden) return;
    if (chatAbort) return; // never mutate the stores while a request is in flight
    let changed = false;
    // Kinds whose currently-open conversation was replaced by a newer server
    // version (typically because the phone remote appended a message to it).
    // We re-render its container after the merge so the new messages appear.
    const reopenCur = [];
    for (const kind of ['chat', 'agents']) {
        const cfg = HIST[kind];
        try {
            const res = await fetch('/api/chats?kind=' + kind);
            if (!res.ok) continue;
            const server = await res.json();
            const snap = JSON.stringify(Array.isArray(server) ? server : []);
            if (snap === _chatSnap[kind]) continue; // unchanged since last seen
            _chatSnap[kind] = snap;
            const curId = state[cfg.current];
            const prevCur = (state[cfg.store] || []).find(c => c.id === curId);
            state[cfg.store] = mergeConversations(state[cfg.store] || [], Array.isArray(server) ? server : [], curId);
            const nextCur = (state[cfg.store] || []).find(c => c.id === curId);
            if (curId && nextCur && nextCur !== prevCur) reopenCur.push(kind);
            changed = true;
        } catch {}
    }
    if (changed) renderHistory();
    // Reopen after renderHistory so the sidebar's active row stays in sync.
    reopenCur.forEach(kind => { try { loadConversation(kind, state[HIST[kind].current]); } catch {} });
}

// Server is the source of truth across devices. Keep local versions only for
// conversations the server doesn't know about yet (just started on this
// desktop and not persisted). For the conversation currently open, adopt the
// server version whenever it's actually different — that's how a message the
// phone appended shows up on the PC without losing an in-flight desktop reply.
function mergeConversations(local, server, curId) {
    const localById = new Map(local.map(c => [c.id, c]));
    const serverIds = new Set(server.map(c => c.id));
    const merged = server.map(c => {
        if (c.id !== curId) return c;
        const localCur = localById.get(curId);
        if (!localCur) return c;
        const localMsgs = (localCur.messages || []).length;
        const serverMsgs = (c.messages || []).length;
        // Server has fewer messages -> our local reply is not persisted yet;
        // keep local so it doesn't get wiped by a mid-flight poll.
        if (serverMsgs < localMsgs) return localCur;
        return c;
    });
    local.forEach(c => { if (!serverIds.has(c.id)) merged.push(c); });
    return merged;
}

// Restore a saved conversation into its view (chat or agents).
function loadConversation(kind, id) {
    const cfg = HIST[kind];
    const conv = state[cfg.store].find(c => c.id === id);
    if (!conv) return;
    state[cfg.current] = id;

    // Link the chat to its project: re-open the folder it belongs to (or drop the
    // project for a classic "no project" chat) so the AI keeps the right context.
    applyConversationProject(conv);

    const container = $(cfg.container);
    container.innerHTML = '';
    (conv.messages || []).forEach(m => {
        const hasRichHtml = m.html && m.type !== 'user';
        const body = addMsg(container, m.type, m.label, hasRichHtml ? m.html : (m.text || ''), !!hasRichHtml);
        (Array.isArray(m.bodyClasses) ? m.bodyClasses : []).forEach((cls) => {
            if (PERSISTED_MSG_CLASSES.includes(cls)) body.classList.add(cls);
        });
        if (!hasRichHtml && m.image && m.image.url) {
            body.innerHTML = imageBubble(m.image.url, m.image.alt || '');
            body.classList.add('has-image');
        }
    });
    forceScrollBottom(container, false);

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

// ==========================================================
//  HISTORY — chats grouped by the project they belong to
// ==========================================================
const NO_PROJECT_KEY = '\u0000noproject';   // sentinel group for classic chats
const historyExpanded = {};                  // `${kind}|${groupKey}` -> expanded?

function noProjectLabel() {
    const lang = state.language || 'fr';
    return TRANSLATIONS[lang]['history-no-project'] || 'Aucun projet';
}

// Resolve a project folder NAME back to its full path via the recent list.
function recentPathByName(name) {
    if (!name) return null;
    const recent = (typeof getRecentProjects === 'function') ? getRecentProjects() : [];
    for (const p of recent) {
        const seg = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        if (seg === name) return p;
    }
    return null;
}

// Switch the open project so a loaded/continued chat matches its folder.
function applyConversationProject(conv) {
    if (!conv) return;
    if (!conv.project) {                       // classic chat -> no project
        if (state.projectRoot && typeof clearProject === 'function') clearProject();
        return;
    }
    const target = conv.projectPath || recentPathByName(conv.project);
    if (target && target !== state.projectRoot && typeof openProject === 'function') {
        openProject(target, false);            // async; the file tree loads in the background
    }
}

const PH_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

// The AI tab currently shown (chat | agents) drives which conversations show.
function activeKind() {
    const t = document.querySelector('.ai-tab.active');
    return (t && t.dataset.tab === 'agents') ? 'agents' : 'chat';
}

function renderProjectPanelHistory(kind = activeKind()) {
    const cfg = HIST[kind];
    const list = $(cfg.list);
    if (!list) return;

    const lang = state.language || 'fr';
    if (!state.projectRoot) {
        list.innerHTML = `<div class="history-empty" data-i18n="history-empty">${TRANSLATIONS[lang]['history-empty'] || 'Aucune conversation'}</div>`;
        return;
    }

    const folderName = projectLabel();
    const convs = (typeof conversationsForProject === 'function')
        ? conversationsForProject(state.projectRoot, folderName, kind)
        : (state[cfg.store] || []).filter(c => c.project === folderName);

    if (!convs.length) {
        list.innerHTML = `<div class="history-empty" data-i18n="history-empty">${TRANSLATIONS[lang]['history-empty'] || 'Aucune conversation'}</div>`;
        return;
    }

    list.innerHTML = '';
    convs.forEach(conv => {
        const row = document.createElement('div');
        row.className = 'convo-item' + (conv.id === state[cfg.current] ? ' active' : '');
        row.title = conv.date || '';

        const titleEl = document.createElement('span');
        titleEl.className = 'convo-title';
        titleEl.textContent = conv.title;
        titleEl.addEventListener('click', () => loadConversation(kind, conv.id));

        const delBtn = document.createElement('button');
        delBtn.className = 'convo-del';
        delBtn.type = 'button';
        delBtn.title = lang === 'en' ? 'Delete' : 'Supprimer';
        delBtn.innerHTML = PH_TRASH;
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            deleteConversation(kind, conv.id);
        });

        row.appendChild(titleEl);
        row.appendChild(delBtn);
        list.appendChild(row);
    });
}

function renderHistory() {
    if (!state.projectRoot) {
        if (typeof loadFileTree === 'function') {
            loadFileTree();
        }
        renderProjectPanelHistory('chat');
        renderProjectPanelHistory('agents');
        return;
    }
    if (typeof initRecentProjects === 'function') {
        initRecentProjects();
    }
    renderProjectPanelHistory('chat');
    renderProjectPanelHistory('agents');
}

// Start a brand-new conversation for the given kind (in the current context).
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
    if (!state.attachments.length) return { aiText: '', names: [], images: [], attachments: [] };
    const attachments = state.attachments.slice();
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
    return { aiText, names, images, attachments };
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
        case 'gguf': return /llava|vision|bakllava/.test(s);  // GGUF: only vision-capable local models
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
    ],
    gguf: [
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
    // Gemini 2.5 and 3.x support native thinking via generationConfig.thinkingConfig.
    if (model === 'gemini' && (submodel.includes('2.5') || submodel.includes('-3') || submodel.includes('3.') || submodel.includes('thinking'))) return true;
    if ((model === 'local' || model === 'gguf') && submodel.includes('r1')) return true;
    // Grok 4.x reasoning models reason natively and reject reasoning_effort,
    // so there is no controllable budget to expose — keep the slider locked.
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
function setupMacNativeVoiceRecognition(btn, textarea) {
    const nativeSpeech = window.zaalisNative && window.zaalisNative.speech;
    if (!nativeSpeech || typeof nativeSpeech.start !== 'function' || typeof nativeSpeech.stop !== 'function') return false;

    let engineState = 'inactive';
    let baseText = '';
    let detachNativeEvents = null;

    if (typeof nativeSpeech.supported === 'function') {
        nativeSpeech.supported().then((supported) => {
            if (!supported) btn.style.display = 'none';
        }).catch(() => {});
    }

    function setRecording(active, starting) {
        btn.classList.toggle('recording', !!active);
        textarea.classList.toggle('recording-text', !!active);
        if (starting) btn.title = state.language === 'en' ? 'Starting voice dictation...' : 'Démarrage de la dictée vocale...';
        else if (active) btn.title = state.language === 'en' ? 'Recording... click to stop' : 'Enregistrement... cliquer pour arrêter';
        else btn.title = state.language === 'en' ? 'Start voice dictation' : 'Activer la dictée vocale';
    }

    function applyTranscript(text) {
        const transcript = String(text || '').trim();
        const separator = (baseText && !baseText.endsWith(' ') && transcript) ? ' ' : '';
        textarea.value = baseText ? `${baseText}${separator}${transcript}` : transcript;
        autoGrow(textarea);
        textarea.dispatchEvent(new Event('input'));
    }

    function cleanupState() {
        engineState = 'inactive';
        setRecording(false, false);
    }

    detachNativeEvents = nativeSpeech.onEvent((event) => {
        if (!event || engineState === 'inactive') return;
        if (event.status === 'ready') {
            engineState = 'active';
            setRecording(true, false);
        } else if (event.status === 'transcript') {
            applyTranscript(event.text);
        } else if (event.status === 'error') {
            console.error('macOS speech recognition error:', event.error);
            cleanupState();
        } else if (event.status === 'end') {
            cleanupState();
        }
    });

    async function startRecording() {
        if (engineState !== 'inactive') return;
        engineState = 'starting';
        baseText = textarea.value;
        setRecording(true, true);
        try {
            const language = state.language === 'en' ? 'en-US' : 'fr-FR';
            const result = await nativeSpeech.start(language);
            if (!result || !result.ok) throw new Error((result && result.error) || 'speech-start-failed');
        } catch (err) {
            console.error('Failed to start macOS speech recognition:', err);
            cleanupState();
        }
    }

    async function stopRecording() {
        if (engineState !== 'active' && engineState !== 'starting') return;
        engineState = 'stopping';
        try {
            await nativeSpeech.stop();
        } catch (err) {
            console.error('Failed to stop macOS speech recognition:', err);
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

    window.addEventListener('beforeunload', () => {
        if (detachNativeEvents) detachNativeEvents();
        if (engineState !== 'inactive') nativeSpeech.stop().catch(() => {});
    });

    return true;
}

function setupVoiceRecognition(btnId, textareaId) {
    const btn = $('#' + btnId);
    const textarea = $('#' + textareaId);
    if (!btn || !textarea) return;

    if (window.zaalisNative && window.zaalisNative.platform === 'darwin' && setupMacNativeVoiceRecognition(btn, textarea)) {
        return;
    }

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
