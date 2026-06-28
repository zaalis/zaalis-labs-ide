// ==========================================================
//  SLASH COMMANDS — central registry + handlers
// ==========================================================
// Loaded BEFORE ai.js. ai.js owns the suggestion-menu UI and calls into the
// globals defined here: SLASH_COMMANDS (the registry) and runSlashCommand().
// Every command is read-only or permission-gated; nothing here bypasses the
// existing write/run safeguards.

// ---- Registry -------------------------------------------------------------
// { name, category, fr, en, usage?, args?:true (prefill instead of run), stub?:true }
const SLASH_COMMANDS = [
    // core
    { name: 'help',     category: 'core', fr: 'Liste toutes les commandes disponibles', en: 'List every available command' },
    { name: 'clear',    category: 'core', fr: 'Efface la conversation et le contexte',  en: 'Clear the conversation and context' },
    { name: 'compact',  category: 'core', fr: 'Compresse le contexte pour libérer de la place', en: 'Compact the context to free space' },
    { name: 'reset',    category: 'core', fr: 'Réinitialisation locale (confirmation)',  en: 'Local reset (asks confirmation)' },

    // tools
    { name: 'grep',     category: 'tools', fr: 'Recherche un motif dans le projet', en: 'Search a pattern across the project', usage: '<motif> [chemin]', args: true },
    { name: 'glob',     category: 'tools', fr: 'Trouve des fichiers par motif',     en: 'Find files by glob pattern',        usage: '<**/*.js>', args: true },
    { name: 'diff',     category: 'tools', fr: 'Affiche le diff Git (status + diff)', en: 'Show the Git diff (status + diff)',  usage: '[staged|unstaged]' },
    { name: 'run',      category: 'tools', fr: 'Exécute une commande (selon permissions)', en: 'Run a command (respects permissions)', usage: '<commande>', args: true },
    { name: 'files',    category: 'tools', fr: 'Liste les fichiers ouverts / pertinents', en: 'List open / relevant files' },

    // review (read-only)
    { name: 'review',          category: 'review', fr: 'Revue du diff Git (aucune modification)', en: 'Review the Git diff (no edits)' },
    { name: 'security-review', category: 'review', fr: 'Revue de sécurité du diff Git',          en: 'Security review of the Git diff' },

    // context / diagnostics
    { name: 'context', category: 'context', fr: 'Affiche le contexte courant',        en: 'Show the current context' },
    { name: 'status',  category: 'context', fr: 'État : modèle, projet, branche, mode', en: 'Status: model, project, branch, mode' },
    { name: 'doctor',  category: 'context', fr: 'Vérifie l’environnement (node, git, rg…)', en: 'Check the environment (node, git, rg…)' },
    { name: 'version', category: 'context', fr: 'Affiche la version de l’application',  en: 'Show the application version' },
    { name: 'cost',    category: 'context', fr: 'Estimation des tokens / coût',         en: 'Token / cost estimate' },
    { name: 'usage',   category: 'context', fr: 'Estimation des tokens / coût',         en: 'Token / cost estimate' },
    { name: 'summary', category: 'context', fr: 'Résume la session courante',           en: 'Summarize the current session' },
    { name: 'memory',  category: 'context', fr: 'Affiche la mémoire projet (ZAALIS.md)', en: 'Show the project memory (ZAALIS.md)' },

    // mode
    { name: 'plan',        category: 'mode', fr: 'Mode plan : propose sans modifier',   en: 'Plan mode: propose without editing' },
    { name: 'permissions', category: 'mode', fr: 'Affiche / change le mode de permission', en: 'Show / change the permission mode', usage: '[' + PERMISSION_MODES.join('|') + ']', args: true },
    { name: 'model',       category: 'mode', fr: 'Affiche / change le modèle',          en: 'Show / change the model', usage: '[fournisseur [sous-modèle]]', args: true },
    { name: 'fast',        category: 'mode', fr: 'Réponses courtes et directes',         en: 'Short, direct answers' },
    { name: 'deep',        category: 'mode', fr: 'Réponses approfondies',               en: 'Thorough answers' },

    // project
    { name: 'init',    category: 'project', fr: 'Crée un fichier mémoire ZAALIS.md',    en: 'Create a ZAALIS.md memory file' },
    { name: 'export',  category: 'project', fr: 'Exporte la conversation en Markdown',  en: 'Export the conversation as Markdown' },
    { name: 'agents',  category: 'project', fr: 'Affiche les agents et leurs rôles',    en: 'Show the agents and their roles' },

    // stubs (respond cleanly, not yet available)
    { name: 'branch',      category: 'misc', fr: 'Gestion des branches Git', en: 'Git branch management', stub: true },
    { name: 'pr-comments', category: 'misc', fr: 'Commentaires de PR',       en: 'PR comments',           stub: true },
    { name: 'resume',      category: 'misc', fr: 'Reprendre une session',    en: 'Resume a session',      stub: true },
    { name: 'session',     category: 'misc', fr: 'Gestion de session',       en: 'Session management',    stub: true },
    { name: 'tasks',       category: 'misc', fr: 'Liste de tâches',          en: 'Task list',             stub: true },
    { name: 'skills',      category: 'misc', fr: 'Compétences disponibles',  en: 'Available skills',      stub: true },
    { name: 'mcp',         category: 'misc', fr: 'Serveurs MCP',             en: 'MCP servers',           stub: true },
    { name: 'theme',       category: 'misc', fr: 'Changer le thème',         en: 'Change the theme',      stub: true },
    { name: 'keybindings', category: 'misc', fr: 'Raccourcis clavier',       en: 'Keyboard shortcuts',    stub: true },
    { name: 'vim',         category: 'misc', fr: 'Mode Vim',                 en: 'Vim mode',              stub: true },
    { name: 'voice',       category: 'misc', fr: 'Commandes vocales',        en: 'Voice commands',        stub: true }
];

const CAT_LABELS = {
    core:    { fr: 'Général',       en: 'Core' },
    tools:   { fr: 'Outils',        en: 'Tools' },
    review:  { fr: 'Revue',         en: 'Review' },
    context: { fr: 'Contexte',      en: 'Context' },
    mode:    { fr: 'Mode',          en: 'Mode' },
    project: { fr: 'Projet',        en: 'Project' },
    misc:    { fr: 'Bientôt',       en: 'Soon' }
};
const CAT_ORDER = ['core', 'tools', 'review', 'context', 'mode', 'project', 'misc'];

// ---- Small shared helpers -------------------------------------------------
function _sysMsg(out, text) { addMsg(out, 'system', null, text); }
function _sysHTML(out, html) { addMsg(out, 'system', null, html, true); }
function _esc(s) { return (typeof escapeHTML === 'function') ? escapeHTML(s) : String(s == null ? '' : s); }
function _lang() { return state.language || 'fr'; }

function _needProject(out, lang) {
    if (state.projectRoot) return true;
    _sysMsg(out, lang === 'en' ? 'Open a project folder first.' : "Ouvre d'abord un dossier de projet.");
    return false;
}

// Split an argument string into tokens, honoring "double" and 'single' quotes.
function _parseArgs(s) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s || '')) !== null) out.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
    return out;
}

async function _getJSON(url) {
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (d && d.error) throw new Error(d.error);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return d;
}
async function _postJSON(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (d && d.error) throw new Error(d.error);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return d;
}

// ---- Result cards (match the existing file-card visual language) ----------
const _CARD_ICON = '<svg class="file-card-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const _CARD_CHEV = '<svg class="file-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
function _toolCard(title, badge, innerHTML, open) {
    const b = badge != null && badge !== '' ? `<span class="tool-badge">${_esc(badge)}</span>` : '';
    return `<details class="file-card tool-card"${open === false ? '' : ' open'}><summary>${_CARD_ICON}<span class="file-card-name">${_esc(title)}</span>${b}${_CARD_CHEV}</summary><div class="file-card-body tool-card-body">${innerHTML}</div></details>`;
}
function _kvRows(rows) {
    return '<div class="kv-list">' + rows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${_esc(k)}</span><span class="kv-v">${_esc(v)}</span></div>`).join('') + '</div>';
}

// ==========================================================
//  PERMISSION BADGE (lives in the AI panel header)
// ==========================================================
function updatePermissionBadge() {
    const header = document.querySelector('.ai-panel-header');
    if (!header) return;
    let badge = document.getElementById('perm-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.id = 'perm-badge';
        const clearBtn = header.querySelector('#clear-terminal');
        if (clearBtn) header.insertBefore(badge, clearBtn);
        else header.appendChild(badge);
    }
    const mode = state.permissionMode || 'supervised';
    badge.className = 'perm-badge perm-' + mode;
    badge.textContent = permissionLabel(mode, _lang());
    badge.title = (_lang() === 'en' ? 'Permission mode: ' : 'Mode de permission : ') + permissionLabel(mode, _lang());
}

// Apply a permission mode from a slash command and refresh all UI.
function _applyPermissionMode(mode, out, lang) {
    state.permissionMode = mode;
    if (typeof syncModeSelectorUI === 'function') syncModeSelectorUI();
    updatePermissionBadge();
    if (mode === 'bypass') {
        _sysMsg(out, lang === 'en'
            ? '⚠ Bypass mode: every action runs with NO confirmation, including destructive commands.'
            : '⚠ Mode bypass : chaque action s’exécute SANS confirmation, y compris les commandes destructives.');
    } else {
        _sysMsg(out, (lang === 'en' ? 'Permission mode → ' : 'Mode de permission → ') + permissionLabel(mode, lang));
    }
}

// ==========================================================
//  READ-ONLY AI HELPER (used by /review, /security-review, /summary)
//  Streams a model answer into the chat WITHOUT applying any edit/run blocks.
// ==========================================================
async function _aiReadOnly(systemPrompt, userPrompt, label) {
    if (chatAbort) return;
    const lang = _lang();
    const model = modelSelect.value, submodel = submodelSelect.value;
    const out = $('#chat-messages');
    const lbl = label || (modelSelect.options[modelSelect.selectedIndex].text.split(' ')[0]);
    const body = addTypingMsg(out, lbl);
    const controller = new AbortController();
    chatAbort = controller;
    setChatBusy(true);
    try {
        const data = await callAI(model, submodel, userPrompt, systemPrompt, [], controller.signal, []);
        stopThinking(body);
        if (data.error) { body.textContent = data.error; body.classList.add('error'); return; }
        const formatted = formatAIResponse(data.response);
        body.innerHTML = '<div class="stream-target"></div>';
        await streamInto(body.querySelector('.stream-target'), data.response, formatted, controller.signal, out);
    } catch (e) {
        stopThinking(body);
        if (!(e && e.name === 'AbortError')) { body.textContent = (lang === 'en' ? 'Error.' : 'Erreur.'); body.classList.add('error'); }
    } finally {
        chatAbort = null;
        setChatBusy(false);
        saveConversation('chat');
    }
}

// ==========================================================
//  HANDLERS
// ==========================================================
const SLASH_HANDLERS = {};

SLASH_HANDLERS.help = async (arg, out, lang) => {
    const byCat = {};
    SLASH_COMMANDS.forEach((c) => { (byCat[c.category] = byCat[c.category] || []).push(c); });
    let html = '';
    for (const cat of CAT_ORDER) {
        if (!byCat[cat]) continue;
        html += `<div class="help-cat">${_esc((CAT_LABELS[cat] || {})[lang] || cat)}</div>`;
        for (const c of byCat[cat]) {
            const desc = lang === 'en' ? c.en : c.fr;
            const usage = c.usage ? ' <span class="help-usage">' + _esc(c.usage) + '</span>' : '';
            const soon = c.stub ? ` · ${lang === 'en' ? 'soon' : 'bientôt'}` : '';
            html += `<div class="help-cmd"><span class="help-cmd-name">/${_esc(c.name)}${usage}</span><span class="help-cmd-desc">${_esc(desc)}${soon}</span></div>`;
        }
    }
    _sysHTML(out, _toolCard(lang === 'en' ? 'Slash commands' : 'Commandes slash', String(SLASH_COMMANDS.length), html));
};

SLASH_HANDLERS.clear = async () => { newConversation('chat'); };

SLASH_HANDLERS.compact = async (arg, out, lang) => {
    if (chatAbort) { _sysMsg(out, lang === 'en' ? 'Busy — wait for the current answer.' : 'Occupé — attends la réponse en cours.'); return; }
    compactContext(modelSelect.value, submodelSelect.value, { force: true });
};

SLASH_HANDLERS.reset = async (arg, out, lang) => {
    const ok = await customConfirm(
        lang === 'en' ? 'Reset local settings, history and preferences on this machine? (API keys are kept server-side.)'
                      : 'Réinitialiser réglages, historique et préférences locaux sur cette machine ? (Les clés API restent côté serveur.)',
        { danger: true, title: lang === 'en' ? 'Local reset' : 'Réinitialisation locale' });
    if (!ok) return;
    try { localStorage.removeItem('zaalis-state'); localStorage.removeItem('zaalis-recent'); } catch {}
    _sysMsg(out, lang === 'en' ? 'Local data cleared. Reloading…' : 'Données locales effacées. Rechargement…');
    setTimeout(() => location.reload(), 600);
};

SLASH_HANDLERS.context = async (arg, out, lang) => {
    const open = Object.keys(state.openFiles || {});
    const rows = [
        [lang === 'en' ? 'Project' : 'Projet', state.projectRoot || (lang === 'en' ? '(none)' : '(aucun)')],
        [lang === 'en' ? 'Active file' : 'Fichier actif', state.activeFile || '—'],
        [lang === 'en' ? 'Open files' : 'Fichiers ouverts', open.length ? `${open.length} — ${open.slice(0, 8).join(', ')}${open.length > 8 ? '…' : ''}` : '—'],
        [lang === 'en' ? 'Model' : 'Modèle', `${modelSelect.value} / ${submodelSelect.value}`],
        [lang === 'en' ? 'Permission' : 'Permission', permissionLabel(state.permissionMode, lang)],
        [lang === 'en' ? 'Style' : 'Style', state.responseStyle || 'normal'],
        [lang === 'en' ? 'Est. context' : 'Contexte est.', `${fmtTokens(state.contextTokens || 0)} / ${fmtTokens(contextWindow(modelSelect.value, submodelSelect.value))} tokens`],
        [lang === 'en' ? 'Language' : 'Langue', state.language]
    ];
    _sysHTML(out, _toolCard(lang === 'en' ? 'Context' : 'Contexte', null, _kvRows(rows)));
};

SLASH_HANDLERS.diff = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    const data = await _getJSON(`/api/gitdiff?root=${encodeURIComponent(state.projectRoot)}`);
    if (!data.available) { _sysMsg(out, lang === 'en' ? 'git is not installed.' : 'git n’est pas installé.'); return; }
    if (!data.repo) { _sysMsg(out, lang === 'en' ? 'This project is not a Git repository.' : 'Ce projet n’est pas un dépôt Git.'); return; }
    const which = (arg || '').toLowerCase();
    const statusHtml = (data.status || '').trim()
        ? '<div class="diff-status">' + _esc(data.status.trim()) + '</div>'
        : `<div class="kv-row"><span class="kv-v">${lang === 'en' ? 'working tree clean' : 'arbre de travail propre'}</span></div>`;
    let diffText = '';
    if (which === 'staged') diffText = data.staged || '';
    else if (which === 'unstaged') diffText = data.unstaged || '';
    else diffText = [data.staged, data.unstaged].filter(Boolean).join('\n');
    const diffHtml = diffText.trim() ? _renderDiffLines(diffText) : `<div class="kv-row"><span class="kv-v">${lang === 'en' ? '(no diff)' : '(aucun diff)'}</span></div>`;
    _sysHTML(out, _toolCard(`git diff${which ? ' ' + which : ''} · ${data.branch || ''}`, null, statusHtml + diffHtml));
};
function _renderDiffLines(text) {
    const rows = String(text).split('\n').map((l) => {
        let cls = '';
        if (/^\+\+\+|^---/.test(l)) cls = 'diff-meta';
        else if (/^@@/.test(l)) cls = 'diff-hunk';
        else if (l.startsWith('+')) cls = 'add';
        else if (l.startsWith('-')) cls = 'del';
        return `<div class="diff-line ${cls}">${_esc(l) || '&nbsp;'}</div>`;
    });
    return '<div class="diff-body">' + rows.join('') + '</div>';
}

SLASH_HANDLERS.grep = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    const toks = _parseArgs(arg);
    if (!toks.length) { _sysMsg(out, lang === 'en' ? 'Usage: /grep <pattern> [path]' : 'Usage : /grep <motif> [chemin]'); return; }
    const pattern = toks[0];
    const pth = toks[1] || '';
    const data = await _postJSON('/api/grep', { root: state.projectRoot, pattern, path: pth, ignoreCase: true });
    if (!data.results || !data.results.length) {
        _sysMsg(out, lang === 'en' ? `No match for "${pattern}".` : `Aucune correspondance pour « ${pattern} ».`);
        return;
    }
    const rows = data.results.map((r) =>
        `<div class="grep-row"><span class="grep-loc">${_esc(r.file)}:${r.line}</span><span class="grep-text">${_esc(r.text)}</span></div>`).join('');
    const badge = `${data.count}${data.truncated ? '+' : ''}`;
    _sysHTML(out, _toolCard(`grep · ${pattern}`, badge, rows + (data.truncated ? `<div class="tool-more">${lang === 'en' ? 'results truncated' : 'résultats tronqués'}</div>` : '')));
};

SLASH_HANDLERS.glob = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    const pattern = (arg || '').trim() || '**/*';
    const data = await _getJSON(`/api/glob?root=${encodeURIComponent(state.projectRoot)}&pattern=${encodeURIComponent(pattern)}`);
    if (!data.files || !data.files.length) { _sysMsg(out, lang === 'en' ? `No file matches "${pattern}".` : `Aucun fichier pour « ${pattern} ».`); return; }
    const rows = data.files.map((f) => `<div class="glob-row">${_esc(f)}</div>`).join('');
    const badge = `${data.count}${data.truncated ? '+' : ''}`;
    _sysHTML(out, _toolCard(`glob · ${pattern}`, badge, rows + (data.truncated ? `<div class="tool-more">${lang === 'en' ? 'truncated' : 'tronqué'}</div>` : '')));
};

SLASH_HANDLERS.run = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    const cmd = (arg || '').trim();
    if (!cmd) { _sysMsg(out, lang === 'en' ? 'Usage: /run <command>' : 'Usage : /run <commande>'); return; }
    if (isReadOnlyMode()) {
        _sysMsg(out, lang === 'en'
            ? `${permissionLabel(state.permissionMode, lang)} mode — commands are blocked.`
            : `Mode ${permissionLabel(state.permissionMode, lang)} — commandes bloquées.`);
        return;
    }
    const dangerous = isDangerousCommand(cmd);
    const needAsk = dangerous ? state.permissionMode !== 'bypass'
                              : state.permissionMode !== 'auto' && state.permissionMode !== 'bypass';
    if (needAsk) {
        const ok = await requestApproval(
            dangerous ? (lang === 'en' ? 'Run this DANGEROUS command?' : 'Exécuter cette commande DANGEREUSE ?')
                      : (lang === 'en' ? 'Run this command?' : 'Exécuter cette commande ?'),
            cmd);
        if (!ok) { _sysMsg(out, lang === 'en' ? 'Command refused.' : 'Commande refusée.'); return; }
    }
    const t0 = Date.now();
    try {
        const res = await _postJSON('/api/exec', { command: cmd, cwd: state.projectRoot });
        const text = ((res.stdout || '') + (res.stderr ? '\n' + res.stderr : '')).trim();
        const dur = Math.round((Date.now() - t0) / 100) / 10;
        const html = (typeof commandCardHTML === 'function')
            ? commandCardHTML(cmd, text, { lang, duration: dur })
            : _toolCard(lang === 'en' ? 'Command' : 'Commande', `ok · ${dur}s`, `<pre class="tool-pre">$ ${_esc(cmd)}\n\n${_esc(text || (lang === 'en' ? '(no output)' : '(aucune sortie)'))}</pre>`, false);
        _sysHTML(out, html);
    } catch (e) {
        const dur = Math.round((Date.now() - t0) / 100) / 10;
        const html = (typeof commandCardHTML === 'function')
            ? commandCardHTML(cmd, '', { lang, error: e.message, duration: dur })
            : _toolCard(lang === 'en' ? 'Command' : 'Commande', lang === 'en' ? 'error' : 'erreur', `<pre class="tool-pre">$ ${_esc(cmd)}\n\n${_esc(e.message)}</pre>`, false);
        _sysHTML(out, html);
    }
};

SLASH_HANDLERS.files = async (arg, out, lang) => {
    const open = Object.keys(state.openFiles || {});
    let html = '';
    html += `<div class="help-cat">${lang === 'en' ? 'Open files' : 'Fichiers ouverts'}</div>`;
    html += open.length ? open.map((f) => `<div class="glob-row">${_esc(f)}${f === state.activeFile ? ' ·' : ''}</div>`).join('')
                        : `<div class="kv-row"><span class="kv-v">${lang === 'en' ? '(none)' : '(aucun)'}</span></div>`;
    if (state.projectRoot) {
        try {
            const data = await _getJSON(`/api/glob?root=${encodeURIComponent(state.projectRoot)}&pattern=*&maxResults=40`);
            if (data.files && data.files.length) {
                html += `<div class="help-cat">${lang === 'en' ? 'Project root' : 'Racine du projet'}</div>`;
                html += data.files.map((f) => `<div class="glob-row">${_esc(f)}</div>`).join('');
            }
        } catch {}
    }
    _sysHTML(out, _toolCard(lang === 'en' ? 'Files' : 'Fichiers', null, html));
};

SLASH_HANDLERS.doctor = async (arg, out, lang) => {
    const root = state.projectRoot ? `?root=${encodeURIComponent(state.projectRoot)}` : '';
    const data = await _getJSON(`/api/doctor${root}`);
    let keys = {};
    try { const k = await _getJSON('/api/keys'); keys = (k && k.keys) || {}; } catch {}
    const mark = (ok, warn) => warn ? '<span class="doc-warn">●</span>' : (ok ? '<span class="doc-ok">●</span>' : '<span class="doc-bad">●</span>');
    const line = (ok, label, detail, warn) => `<div class="doc-row">${mark(ok, warn)}<span class="doc-label">${_esc(label)}</span><span class="doc-detail">${_esc(detail || '')}</span></div>`;
    const cfgKeys = Object.keys(keys).filter((p) => keys[p] && keys[p].set);
    let html = '';
    html += line(true, 'Node', data.node);
    html += line(data.npm && data.npm.available, 'npm', data.npm && data.npm.version);
    html += line(data.git && data.git.available, 'git', data.git && data.git.version);
    html += line(data.rg && data.rg.available, 'ripgrep', (data.rg && data.rg.available) ? data.rg.version : (lang === 'en' ? 'absent (JS fallback used)' : 'absent (repli JS utilisé)'), data.rg && !data.rg.available);
    html += line(data.ollama && data.ollama.reachable, 'Ollama', data.ollama && data.ollama.reachable ? `${data.ollama.models} ${lang === 'en' ? 'models' : 'modèles'}` : (lang === 'en' ? 'unreachable' : 'injoignable'), data.ollama && !data.ollama.reachable);
    html += line(data.gguf && data.gguf.installed, 'GGUF', data.gguf ? `${data.gguf.variant}${data.gguf.installed ? '' : (lang === 'en' ? ' (not installed)' : ' (non installé)')}` : '', data.gguf && !data.gguf.installed);
    html += line(!!data.installer, lang === 'en' ? 'Installer' : 'Installateur', data.installer ? 'native/installer/zaalis-setup.exe' : (lang === 'en' ? 'missing' : 'absent'), !data.installer);
    html += line((data.scripts || []).length > 0, lang === 'en' ? 'npm scripts' : 'scripts npm', (data.scripts || []).join(', '));
    html += line(!!data.projectGit, lang === 'en' ? 'Project git' : 'Git projet', data.projectGit ? `branch ${data.projectGit}` : (lang === 'en' ? 'not a repo / no project' : 'pas un dépôt / pas de projet'), !data.projectGit);
    html += line(cfgKeys.length > 0, lang === 'en' ? 'API keys' : 'Clés API', cfgKeys.length ? cfgKeys.join(', ') : (lang === 'en' ? 'none configured' : 'aucune configurée'), cfgKeys.length === 0);
    _sysHTML(out, _toolCard(`/doctor · v${data.version}`, null, html));
};

SLASH_HANDLERS.version = async (arg, out, lang) => {
    const data = await _getJSON('/api/version');
    _sysMsg(out, `zaalis IDE v${data.version}`);
};

SLASH_HANDLERS.status = async (arg, out, lang) => {
    const root = state.projectRoot ? `?root=${encodeURIComponent(state.projectRoot)}` : '';
    let d = {};
    try { d = await _getJSON(`/api/doctor${root}`); } catch {}
    const rows = [
        [lang === 'en' ? 'Model' : 'Modèle', `${modelSelect.value} / ${submodelSelect.value}`],
        [lang === 'en' ? 'Project' : 'Projet', state.projectRoot ? state.projectRoot.split(/[\\/]/).pop() : (lang === 'en' ? '(none)' : '(aucun)')],
        [lang === 'en' ? 'Git branch' : 'Branche Git', d.projectGit || '—'],
        [lang === 'en' ? 'Permission' : 'Permission', permissionLabel(state.permissionMode, lang)],
        [lang === 'en' ? 'Agents mode' : 'Mode Agents', state.agentMode ? 'ON' : 'OFF'],
        ['GGUF', d.gguf ? `${d.gguf.variant}${d.gguf.installed ? ' ✓' : ''}` : '—'],
        ['Ollama', d.ollama ? (d.ollama.reachable ? `${d.ollama.models} ${lang === 'en' ? 'models' : 'modèles'}` : (lang === 'en' ? 'off' : 'éteint')) : '—']
    ];
    _sysHTML(out, _toolCard(lang === 'en' ? 'Status' : 'État', null, _kvRows(rows)));
};

SLASH_HANDLERS.cost = async (arg, out, lang) => {
    const isLocal = modelSelect.value === 'local' || modelSelect.value === 'gguf';
    const rows = [
        [lang === 'en' ? 'Model' : 'Modèle', `${modelSelect.value} / ${submodelSelect.value}`],
        [lang === 'en' ? 'Est. tokens' : 'Tokens est.', `${fmtTokens(state.contextTokens || 0)} / ${fmtTokens(contextWindow(modelSelect.value, submodelSelect.value))}`],
        [lang === 'en' ? 'Cost' : 'Coût', isLocal ? (lang === 'en' ? '0 (local)' : '0 (local)') : (lang === 'en' ? 'n/a (provider billing)' : 'n/d (facturé par le fournisseur)')]
    ];
    _sysHTML(out, _toolCard(lang === 'en' ? 'Usage' : 'Utilisation', null, _kvRows(rows)));
};
SLASH_HANDLERS.usage = SLASH_HANDLERS.cost;

SLASH_HANDLERS.agents = async (arg, out, lang) => {
    const cards = Array.from(document.querySelectorAll('.agent-card'));
    const rows = cards.map((c) => {
        const name = (c.querySelector('.agent-name') || {}).textContent || c.dataset.agent;
        const roleSel = c.querySelector('.agent-role-select');
        const role = roleSel ? (roleSel.options[roleSel.selectedIndex] || {}).textContent : '';
        const on = !!(c.querySelector('.agent-check') && c.querySelector('.agent-check').checked);
        return [name, `${role}${on ? ' · ON' : ''}`];
    });
    _sysHTML(out, _toolCard(lang === 'en' ? 'Agents' : 'Agents', String(cards.length), _kvRows(rows)));
};

SLASH_HANDLERS.plan = async (arg, out, lang) => {
    _applyPermissionMode('plan', out, lang);
    _sysMsg(out, lang === 'en'
        ? 'Plan mode: I will read, search and propose a plan — no files or commands will be changed until you switch back to an editing mode.'
        : 'Mode plan : je lis, recherche et propose un plan — aucun fichier ni commande ne sera modifié tant que tu ne reviens pas à un mode d’édition.');
};

SLASH_HANDLERS.permissions = async (arg, out, lang) => {
    const mode = (arg || '').trim().toLowerCase();
    if (!mode) {
        const rows = PERMISSION_MODES.map((m) => [m === state.permissionMode ? '→ ' + m : m, permissionLabel(m, lang)]);
        _sysHTML(out, _toolCard(lang === 'en' ? 'Permission modes' : 'Modes de permission', permissionLabel(state.permissionMode, lang),
            _kvRows(rows) + `<div class="tool-more">${lang === 'en' ? 'Usage: /permissions <mode>' : 'Usage : /permissions <mode>'}</div>`));
        return;
    }
    if (!PERMISSION_MODES.includes(mode)) {
        _sysMsg(out, (lang === 'en' ? 'Unknown mode. Choose: ' : 'Mode inconnu. Choisis : ') + PERMISSION_MODES.join(', '));
        return;
    }
    _applyPermissionMode(mode, out, lang);
};

SLASH_HANDLERS.model = async (arg, out, lang) => {
    const toks = _parseArgs(arg);
    if (!toks.length) {
        _sysMsg(out, (lang === 'en' ? 'Current model: ' : 'Modèle actuel : ') + `${modelSelect.value} / ${submodelSelect.value}`);
        return;
    }
    const provider = toks[0].toLowerCase();
    const valid = Array.from(modelSelect.options).map((o) => o.value);
    if (!valid.includes(provider)) {
        _sysMsg(out, (lang === 'en' ? 'Unknown provider. Choose: ' : 'Fournisseur inconnu. Choisis : ') + valid.join(', '));
        return;
    }
    modelSelect.value = provider;
    modelSelect.dispatchEvent(new Event('change'));
    if (toks[1]) {
        const sub = toks[1];
        const has = Array.from(submodelSelect.options).some((o) => o.value === sub);
        if (has) { submodelSelect.value = sub; submodelSelect.dispatchEvent(new Event('change')); }
        else _sysMsg(out, (lang === 'en' ? 'Sub-model not found, kept: ' : 'Sous-modèle introuvable, conservé : ') + submodelSelect.value);
    }
    _sysMsg(out, (lang === 'en' ? 'Model → ' : 'Modèle → ') + `${modelSelect.value} / ${submodelSelect.value}`);
};

SLASH_HANDLERS.fast = async (arg, out, lang) => {
    state.responseStyle = state.responseStyle === 'fast' ? 'normal' : 'fast';
    _sysMsg(out, state.responseStyle === 'fast'
        ? (lang === 'en' ? 'Fast mode ON — short, direct answers.' : 'Mode rapide ON — réponses courtes et directes.')
        : (lang === 'en' ? 'Fast mode OFF.' : 'Mode rapide OFF.'));
};
SLASH_HANDLERS.deep = async (arg, out, lang) => {
    state.responseStyle = state.responseStyle === 'deep' ? 'normal' : 'deep';
    _sysMsg(out, state.responseStyle === 'deep'
        ? (lang === 'en' ? 'Deep mode ON — thorough answers.' : 'Mode approfondi ON — réponses détaillées.')
        : (lang === 'en' ? 'Deep mode OFF.' : 'Mode approfondi OFF.'));
};

SLASH_HANDLERS.memory = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    for (const name of ['ZAALIS.md', 'AGENTS.md']) {
        try {
            const r = await fetch(`/api/file?root=${encodeURIComponent(state.projectRoot)}&path=${encodeURIComponent(name)}`);
            const d = await r.json().catch(() => ({}));
            if (r.ok && !d.error && typeof d.content === 'string') {
                const body = d.content.length > 4000 ? d.content.slice(0, 4000) + '\n… (tronqué)' : d.content;
                _sysHTML(out, _toolCard(name, null, `<pre class="tool-pre">${_esc(body)}</pre>`));
                return;
            }
        } catch {}
    }
    _sysMsg(out, lang === 'en' ? 'No ZAALIS.md / AGENTS.md found. Create one with /init.' : 'Aucun ZAALIS.md / AGENTS.md. Crée-en un avec /init.');
};

SLASH_HANDLERS.init = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    if (isReadOnlyMode()) { _sysMsg(out, lang === 'en' ? 'Read-only/plan mode — cannot create files.' : 'Mode lecture seule/plan — création impossible.'); return; }
    // Refuse to overwrite an existing memory file.
    try {
        const r = await fetch(`/api/file?root=${encodeURIComponent(state.projectRoot)}&path=ZAALIS.md`);
        const d = await r.json().catch(() => ({}));
        if (r.ok && !d.error && typeof d.content === 'string') {
            _sysMsg(out, lang === 'en' ? 'ZAALIS.md already exists — not overwritten.' : 'ZAALIS.md existe déjà — non écrasé.');
            return;
        }
    } catch {}
    const name = state.projectRoot.split(/[\\/]/).pop() || 'projet';
    const tmpl = `# ${name}\n\n` +
        (lang === 'en'
            ? `Project notes for the AI assistant (zaalis IDE).\n\n## Overview\n- What this project does:\n\n## Conventions\n- Code style / structure notes:\n\n## Commands\n- Install: \n- Build: \n- Test: \n- Run: \n\n## Useful notes\n- \n`
            : `Notes de projet pour l'assistant IA (zaalis IDE).\n\n## Vue d'ensemble\n- Rôle du projet :\n\n## Conventions\n- Style / structure du code :\n\n## Commandes\n- Installation : \n- Build : \n- Tests : \n- Lancement : \n\n## Notes utiles\n- \n`);
    await _postJSON('/api/file', { root: state.projectRoot, path: 'ZAALIS.md', content: tmpl });
    if (typeof loadFileTree === 'function') await loadFileTree();
    _sysMsg(out, lang === 'en' ? 'Created ZAALIS.md at the project root.' : 'ZAALIS.md créé à la racine du projet.');
};

SLASH_HANDLERS.export = async (arg, out, lang) => {
    const msgs = Array.from($('#chat-messages').querySelectorAll('.msg'));
    let md = `# zaalis IDE — ${lang === 'en' ? 'conversation export' : 'export de conversation'}\n${new Date().toISOString()}\n\n`;
    msgs.forEach((m) => {
        const label = (m.querySelector('.msg-label') || {}).textContent || (m.classList.contains('msg-user') ? 'User' : m.classList.contains('msg-system') ? 'System' : 'AI');
        const body = (m.querySelector('.msg-body') || {}).innerText || '';
        if (body.trim()) md += `**${label.trim()}**\n\n${body.trim()}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `zaalis-chat-${Date.now()}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    _sysMsg(out, lang === 'en' ? 'Conversation exported as Markdown.' : 'Conversation exportée en Markdown.');
};

SLASH_HANDLERS.summary = async (arg, out, lang) => {
    if (!state.chatHistory || !state.chatHistory.length) {
        _sysMsg(out, lang === 'en' ? 'Nothing to summarize yet.' : 'Rien à résumer pour le moment.');
        return;
    }
    const convo = state.chatHistory.map((h) => `${h.role}: ${h.content}`).join('\n').slice(0, 12000);
    const sys = lang === 'en'
        ? 'You summarize a coding session concisely. Output: 1) what was done, 2) current state, 3) next steps. No code edits.'
        : 'Tu résumes une session de code de façon concise. Donne : 1) ce qui a été fait, 2) l’état actuel, 3) prochaines étapes. Aucune modification de code.';
    const user = (lang === 'en' ? 'Summarize this session:\n\n' : 'Résume cette session :\n\n') + convo;
    await _aiReadOnly(sys, user, lang === 'en' ? 'Summary' : 'Résumé');
};

SLASH_HANDLERS.review = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    const data = await _getJSON(`/api/gitdiff?root=${encodeURIComponent(state.projectRoot)}`);
    if (!data.available) { _sysMsg(out, lang === 'en' ? 'git is not installed.' : 'git n’est pas installé.'); return; }
    if (!data.repo) { _sysMsg(out, lang === 'en' ? 'Not a Git repository.' : 'Pas un dépôt Git.'); return; }
    const diff = [data.staged, data.unstaged].filter(Boolean).join('\n').slice(0, 40000);
    if (!diff.trim()) { _sysMsg(out, lang === 'en' ? 'No changes to review (clean working tree).' : 'Aucune modification à relire (arbre propre).'); return; }
    const sys = lang === 'en'
        ? 'You are a senior code reviewer. Review ONLY the provided git diff. Do NOT propose edit/write/run blocks. Format: 1) Findings (each with severity high/medium/low and file:line when possible), 2) Questions, 3) Short summary.'
        : 'Tu es un relecteur de code senior. Relis UNIQUEMENT le diff git fourni. NE PROPOSE PAS de blocs edit/write/run. Format : 1) Constats (chacun avec sévérité haute/moyenne/basse et fichier:ligne si possible), 2) Questions, 3) Résumé court.';
    const user = (lang === 'en' ? 'Review this diff:\n\n' : 'Relis ce diff :\n\n') + '```diff\n' + diff + '\n```';
    _sysMsg(out, lang === 'en' ? 'Reviewing the Git diff (read-only)…' : 'Revue du diff Git (lecture seule)…');
    await _aiReadOnly(sys, user, lang === 'en' ? 'Review' : 'Revue');
};

SLASH_HANDLERS['security-review'] = async (arg, out, lang) => {
    if (!_needProject(out, lang)) return;
    const data = await _getJSON(`/api/gitdiff?root=${encodeURIComponent(state.projectRoot)}`);
    if (!data.available) { _sysMsg(out, lang === 'en' ? 'git is not installed.' : 'git n’est pas installé.'); return; }
    if (!data.repo) { _sysMsg(out, lang === 'en' ? 'Not a Git repository.' : 'Pas un dépôt Git.'); return; }
    const diff = [data.staged, data.unstaged].filter(Boolean).join('\n').slice(0, 40000);
    if (!diff.trim()) { _sysMsg(out, lang === 'en' ? 'No changes to review.' : 'Aucune modification à relire.'); return; }
    const sys = lang === 'en'
        ? 'You are a security reviewer. Review ONLY the provided git diff for: secrets/credentials, injection (SQL/command/path traversal), unsafe eval, auth/session issues, insecure storage, dangerous shell commands. Do NOT propose edit/write/run blocks. Format: Findings with severity and file:line, then a short summary.'
        : 'Tu es un relecteur sécurité. Relis UNIQUEMENT le diff git fourni pour : secrets/identifiants, injections (SQL/commande/traversée de chemin), eval dangereux, problèmes d’auth/session, stockage non sécurisé, commandes shell dangereuses. NE PROPOSE PAS de blocs edit/write/run. Format : Constats avec sévérité et fichier:ligne, puis résumé court.';
    const user = (lang === 'en' ? 'Security-review this diff:\n\n' : 'Relis ce diff côté sécurité :\n\n') + '```diff\n' + diff + '\n```';
    _sysMsg(out, lang === 'en' ? 'Security review (read-only)…' : 'Revue de sécurité (lecture seule)…');
    await _aiReadOnly(sys, user, lang === 'en' ? 'Security' : 'Sécurité');
};

// ---- Dispatcher -----------------------------------------------------------
async function runSlashCommand(name, argStr) {
    const lang = _lang();
    const out = $('#chat-messages');
    const arg = (argStr || '').trim();
    const cmd = SLASH_COMMANDS.find((c) => c.name === name);
    if (!cmd) {
        _sysMsg(out, lang === 'en' ? `Unknown command: /${name} — type /help` : `Commande inconnue : /${name} — tape /help`);
        return;
    }
    if (cmd.stub || !SLASH_HANDLERS[name]) {
        _sysMsg(out, lang === 'en' ? `/${name} is not available yet.` : `/${name} n'est pas encore disponible.`);
        return;
    }
    try {
        await SLASH_HANDLERS[name](arg, out, lang);
    } catch (e) {
        _sysMsg(out, (lang === 'en' ? 'Command error: ' : 'Erreur commande : ') + ((e && e.message) || e));
    }
}
