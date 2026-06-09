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