// Live turn timeline, in the order the agent works: the text it writes,
// grouped action lines with their tool icon or logo, file changes inline with
// their added (green) and removed (red) lines, automatic context compaction
// and approvals. Built from the Rust core's event frames; the resulting HTML
// is plain markup (details/summary), so a saved conversation restores as is.
(() => {
    'use strict';
    const L = (fr, en) => (state.language === 'en' ? en : fr);
    const esc = value => escapeHTML(String(value == null ? '' : value));
    const full = n => new Intl.NumberFormat(state.language === 'en' ? 'en' : 'fr').format(Number(n) || 0);
    const svg = body => `<svg class="tl-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const ICONS = {
        terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
        file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
        search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
        globe: svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
        page: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
        browser: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="6.5" cy="6.5" r=".5"/><circle cx="9" cy="6.5" r=".5"/>'),
        monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
        server: svg('<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>'),
        todo: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
        users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
        plug: svg('<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>'),
        sparkle: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
        flask: svg('<path d="M9 2h6"/><path d="M10 2v7L4 20a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 20l-6-11V2"/>'),
        git: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7"/><path d="M18 11.5c0 3-3 3.5-9.5 5"/>'),
        map: svg('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>'),
        gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
        pencil: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
        lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
        compress: svg('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'),
        alert: svg('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
        // Simple Icons, CC0 (see assets/integrations/NOTICE.md).
        github: '<svg class="tl-icon tl-brand" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
    };
    const chevron = '<svg class="tl-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    const FILE_TOOLS = new Set(['edit', 'write', 'apply_patch', 'delete', 'move']);

    // What a tool call means for the person reading: an icon, a short verb
    // phrase (counted), and the key that merges identical phrases in a group.
    function classify(tool, input = {}) {
        const name = String(tool || '').toLowerCase();
        const server = String(input.server || input.server_name || '').trim();
        const action = String(input.action || '').toLowerCase();
        if (name === 'run' || name === 'exec' || name === 'shell') return { key: 'command', icon: 'terminal', fr: n => n > 1 ? `a exécuté ${n} commandes` : 'a exécuté une commande', en: n => n > 1 ? `ran ${n} commands` : 'ran a command' };
        if (name === 'read') { const count = Math.max(1, (input.paths || []).length || 1); return { key: 'read', icon: 'file', weight: count, fr: n => n > 1 ? `a lu ${n} fichiers` : 'a lu un fichier', en: n => n > 1 ? `read ${n} files` : 'read a file' }; }
        if (['glob', 'grep', 'ls', 'list'].includes(name)) return { key: 'explore', icon: 'search', fr: () => 'a exploré le code', en: () => 'explored the code' };
        if (['web_search', 'deep_search', 'image_search'].includes(name)) return { key: 'web', icon: 'globe', fr: () => 'a recherché sur le Web', en: () => 'searched the web' };
        if (name === 'web_fetch') return { key: 'page', icon: 'page', fr: n => n > 1 ? `a consulté ${n} pages web` : 'a consulté une page web', en: n => n > 1 ? `read ${n} web pages` : 'read a web page' };
        if (name === 'browser') return { key: 'browser', icon: 'browser', fr: () => 'a utilisé le navigateur', en: () => 'used the browser' };
        if (name === 'computer') return { key: 'computer', icon: 'monitor', fr: () => 'a utilisé l’ordinateur', en: () => 'used the computer' };
        if (name === 'vm') return { key: 'vm', icon: 'server', fr: () => 'a utilisé une machine virtuelle', en: () => 'used a virtual machine' };
        if (name === 'github' || (name === 'workspace' && action === 'github')) return { key: 'github', icon: 'github', brand: 'GitHub', fr: () => 'a utilisé GitHub', en: () => 'used GitHub' };
        if (name === 'workspace') return { key: 'workspace', icon: 'file', fr: () => 'a utilisé l’espace de travail', en: () => 'used the workspace' };
        if (name === 'mcp' || name.startsWith('mcp__')) {
            const label = server || name.split('__')[1] || 'MCP';
            const pretty = label.charAt(0).toUpperCase() + label.slice(1);
            return { key: 'mcp:' + label.toLowerCase(), icon: label.toLowerCase() === 'github' ? 'github' : 'plug', brand: pretty, fr: () => `a utilisé ${pretty}`, en: () => `used ${pretty}` };
        }
        if (name === 'todo') return { key: 'todo', icon: 'todo', fr: () => 'a mis à jour ses tâches', en: () => 'updated its tasks' };
        if (['task', 'spawn_agent', 'merge_agent'].includes(name)) return { key: 'agent', icon: 'users', fr: n => n > 1 ? `a délégué ${n} tâches à des sous-agents` : 'a délégué une tâche à un sous-agent', en: n => n > 1 ? `delegated ${n} tasks to sub-agents` : 'delegated a task to a sub-agent' };
        if (name === 'skill') return { key: 'skill', icon: 'sparkle', fr: () => 'a utilisé une compétence', en: () => 'used a skill' };
        if (name === 'laboratory') return { key: 'lab', icon: 'flask', fr: () => 'a utilisé le laboratoire', en: () => 'used the laboratory' };
        if (name === 'git_status') return { key: 'git', icon: 'git', fr: () => 'a vérifié l’état Git', en: () => 'checked Git status' };
        if (name === 'checkpoint_create') return { key: 'checkpoint', icon: 'git', fr: () => 'a créé un point de restauration', en: () => 'created a restore point' };
        if (name === 'enter_plan_mode') return { key: 'plan', icon: 'map', fr: () => 'a préparé un plan', en: () => 'prepared a plan' };
        return { key: 'tool:' + name, icon: 'gear', fr: () => `a utilisé ${name || 'un outil'}`, en: () => `used ${name || 'a tool'}` };
    }
    // The line shown for one call: the command, file, query or page itself.
    function describe(tool, input = {}, fallback = '') {
        const name = String(tool || '').toLowerCase(), pick = (...values) => values.find(v => typeof v === 'string' && v.trim());
        const text = name === 'read' ? (input.paths || []).join(', ')
            : name === 'run' ? pick(input.command)
            : ['glob', 'grep'].includes(name) ? [input.pattern, input.path && L(`dans ${input.path}`, `in ${input.path}`)].filter(Boolean).join(' ')
            : name === 'ls' ? pick(input.path, '.')
            : ['web_search', 'deep_search', 'image_search'].includes(name) ? pick(input.query, input.q)
            : name === 'web_fetch' ? pick(input.url)
            : name === 'browser' ? [input.action, pick(input.url, input.query, input.text)].filter(Boolean).join(' ')
            : name === 'mcp' ? [input.server, input.tool].filter(Boolean).join(' · ')
            : name === 'workspace' ? [input.action, input.repo || input.path].filter(Boolean).join(' ')
            : ['task', 'spawn_agent'].includes(name) ? pick(input.title, input.description, input.role)
            : '';
        return text || fallback || name || L('outil', 'tool');
    }
    function joinPhrases(parts) {
        if (!parts.length) return '';
        const and = L(' et ', ' and ');
        const text = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + and + parts[parts.length - 1];
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
    function fmtDurationShort(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return `${s} s`;
        const m = Math.floor(s / 60), rest = s % 60;
        return rest ? `${m} min ${rest} s` : `${m} min`;
    }
    // Unified diff -> colored lines (bounded, for large rewrites).
    function diffHTML(diff) {
        const lines = String(diff || '').split('\n').filter(line => !/^(---|\+\+\+) /.test(line));
        const shown = lines.slice(0, 400).map(line => {
            const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
            return `<div class="tl-diff-line ${cls}">${esc(line) || '&nbsp;'}</div>`;
        }).join('');
        const more = lines.length > 400 ? `<div class="tl-diff-line hunk">${esc(L(`… ${lines.length - 400} lignes de plus`, `… ${lines.length - 400} more lines`))}</div>` : '';
        return shown || more ? `<div class="tl-diff">${shown}${more}</div>` : '';
    }
    function outcomeText(outcome) {
        if (!outcome) return '';
        if (outcome.status === 'ok') {
            const result = outcome.result;
            if (result == null) return outcome.summary || '';
            if (typeof result === 'string') return result;
            // Files read: their numbered lines rather than the raw structure.
            const files = Array.isArray(result) ? result : Array.isArray(result.files) ? result.files : null;
            if (files && files.length && files.every(file => file && Array.isArray(file.lines))) {
                return files.map(file => [file.path ? `── ${file.path}` : '', ...file.lines.slice(0, 300).map(line => `${String(line.number ?? '').padStart(4)}  ${line.text ?? ''}`), file.lines.length > 300 ? '…' : ''].filter(Boolean).join('\n')).join('\n\n');
            }
            if (typeof result.output === 'string' || typeof result.stdout === 'string') return [result.stdout ?? result.output, result.stderr].filter(Boolean).join('\n') || L('(aucune sortie)', '(no output)');
            return JSON.stringify(result, null, 2);
        }
        return outcome.message || outcome.reason || outcome.summary || '';
    }

    function create(container, options = {}) {
        const startedAt = Date.now();
        const body = addMsg(container, 'ai', options.label || null, '', true);
        const msg = body.closest('.msg');
        msg.classList.add('tl-msg');
        body.classList.add('tl-body', 'tl-running');
        body.innerHTML = `<div class="tl-head"><span class="tl-pulse"></span><span class="tl-head-text"></span></div><div class="tl-flow"></div>`;
        const head = body.querySelector('.tl-head-text'), flowEl = body.querySelector('.tl-flow');
        let leadId = options.leadId ? String(options.leadId) : null;
        const agents = new Map();
        const segments = new Map();   // segment id -> { kind, el, text }
        const tools = new Map();      // call id -> { info, item, group?, row? }
        let lastBlock = null;         // the block new actions can merge into
        let compactions = 0, finished = false, renderQueued = new Set(), steps = 0;
        let fullText = '';
        const tick = () => { if (!finished) head.textContent = L('En cours depuis ', 'Working for ') + fmtDurationShort(Date.now() - startedAt); };
        tick();
        const clock = setInterval(tick, 1000);
        const scroll = () => followScroll(container);
        const append = (el, mergeable) => { flowEl.append(el); lastBlock = mergeable || null; scroll(); return el; };
        const isLead = frame => {
            const id = String(frame.agent_id || '');
            if (!id) return !leadId;
            if (!leadId) leadId = id;
            return id === leadId;
        };

        // ── Text and reasoning ──
        const flush = () => {
            for (const segment of renderQueued) {
                if (segment.kind === 'text') segment.el.innerHTML = renderMarkdown(segment.text);
                else segment.content.innerHTML = renderMarkdown(segment.text);
            }
            renderQueued = new Set(); scroll();
        };
        const queue = segment => { if (!renderQueued.size) requestAnimationFrame(flush); renderQueued.add(segment); };
        function startSegment(segment) {
            if (segment.kind === 'reasoning') {
                const el = document.createElement('details');
                el.className = 'reasoning tl-reasoning';
                el.innerHTML = `<summary><span class="reasoning-spark"></span><span class="reasoning-label">${esc(L('Réflexion en cours…', 'Thinking…'))}</span>${chevron}</summary><div class="reasoning-body md"></div>`;
                const entry = { kind: 'reasoning', el, content: el.querySelector('.reasoning-body'), label: el.querySelector('.reasoning-label'), text: '', started: Date.now() };
                append(el); return entry;
            }
            const el = document.createElement('div');
            el.className = 'tl-text md';
            const entry = { kind: 'text', el, text: '' };
            append(el); return entry;
        }
        function segmentFor(frame, kind) {
            let segment = segments.get(String(frame.segment_id));
            if (!segment) { segment = startSegment({ kind }); segments.set(String(frame.segment_id), segment); }
            return segment;
        }
        function completeSegment(frame) {
            const segment = segments.get(String(frame.segment_id));
            if (!segment) return;
            renderQueued.delete(segment);
            if (segment.kind === 'reasoning') {
                segment.content.innerHTML = renderMarkdown(segment.text);
                segment.label.textContent = L('Réflexion durant ', 'Thought for ') + fmtDurationShort(frame.duration_ms ?? (Date.now() - segment.started));
                if (!segment.text.trim()) segment.el.remove();
            } else {
                if (segment.text.trim()) segment.el.innerHTML = formatAIResponse(segment.text);
                else segment.el.remove();
            }
            scroll();
        }

        // ── Actions (grouped) ──
        function newGroup() {
            const el = document.createElement('details');
            el.className = 'tl-group';
            el.innerHTML = `<summary><span class="tl-group-icon"></span><span class="tl-group-label"></span><span class="tl-group-state"></span>${chevron}</summary><div class="tl-group-items"></div>`;
            const group = { kind: 'group', el, items: el.querySelector('.tl-group-items'), calls: [] };
            append(el, group);
            return group;
        }
        function refreshGroup(group) {
            const order = [], counts = new Map();
            for (const call of group.calls) {
                if (!counts.has(call.info.key)) { order.push(call.info); counts.set(call.info.key, 0); }
                counts.set(call.info.key, counts.get(call.info.key) + (call.info.weight || 1));
            }
            const phrases = order.map(info => (state.language === 'en' ? info.en : info.fr)(counts.get(info.key)));
            const brand = order.find(info => info.brand);
            group.el.querySelector('.tl-group-icon').innerHTML = ICONS[(brand || order[0] || {}).icon] || ICONS.gear;
            group.el.querySelector('.tl-group-label').textContent = joinPhrases(phrases);
            const running = group.calls.some(call => call.state === 'running');
            const failed = group.calls.filter(call => call.state === 'error').length;
            const stateEl = group.el.querySelector('.tl-group-state');
            stateEl.className = 'tl-group-state' + (running ? ' running' : failed ? ' failed' : '');
            stateEl.textContent = running ? '' : failed ? L(`${failed} échec${failed > 1 ? 's' : ''}`, `${failed} failed`) : '';
            group.el.dataset.state = running ? 'running' : failed ? 'failed' : 'done';
        }
        function startTool(frame) {
            const info = classify(frame.tool, frame.input || {});
            const call = { id: String(frame.call_id), tool: String(frame.tool || ''), input: frame.input || {}, info, state: 'running', title: describe(frame.tool, frame.input || {}, frame.title) };
            tools.set(call.id, call);
            steps++;
            if (FILE_TOOLS.has(call.tool.toLowerCase())) { startFileCall(call); return; }
            const group = lastBlock && lastBlock.kind === 'group' ? lastBlock : newGroup();
            call.group = group; group.calls.push(call);
            const item = document.createElement('details');
            item.className = 'tl-item'; item.dataset.state = 'running';
            item.innerHTML = `<summary><span class="tl-item-icon">${ICONS[info.icon] || ICONS.gear}</span><span class="tl-item-title">${esc(call.title)}</span><span class="tl-item-state"></span></summary><pre class="tl-item-output"></pre>`;
            call.item = item; group.items.append(item);
            refreshGroup(group); scroll();
        }
        function finishTool(frame) {
            const call = tools.get(String(frame.call_id));
            if (!call) return;
            const outcome = frame.outcome || {};
            call.state = outcome.status === 'ok' ? 'done' : 'error';
            if (call.rowGroup) { finishFileCall(call, outcome); return; }
            if (!call.item) return;
            // A command that ran but exited non-zero is a result, flagged apart.
            const exitCode = outcome.status === 'ok' && outcome.result && outcome.result.success === false ? outcome.result.exit_code : null;
            call.item.dataset.state = exitCode != null || outcome.result?.timed_out ? 'warn' : call.state;
            const stateEl = call.item.querySelector('.tl-item-state');
            stateEl.textContent = outcome.status === 'denied' ? L('refusé', 'denied') : outcome.status === 'cancelled' ? L('annulé', 'cancelled')
                : call.state === 'error' ? L('échec', 'failed') : outcome.result?.timed_out ? L('délai dépassé', 'timed out')
                : exitCode != null ? L(`code ${exitCode}`, `exit ${exitCode}`) : (outcome.duration_ms ? fmtDurationShort(outcome.duration_ms) : '');
            const output = outcomeText(outcome);
            const pre = call.item.querySelector('.tl-item-output');
            if (output) pre.textContent = output.length > 20000 ? output.slice(0, 20000) + '\n…' : output; else pre.remove();
            refreshGroup(call.group); scroll();
        }

        // ── File changes: always visible rows, +added (green) −removed (red) ──
        function newFileBlock() {
            const el = document.createElement('div');
            el.className = 'tl-files';
            el.innerHTML = `<div class="tl-files-head">${ICONS.pencil}<span class="tl-files-label"></span><span class="tl-files-total"></span></div><div class="tl-files-rows"></div>`;
            const block = { kind: 'files', el, rows: el.querySelector('.tl-files-rows'), files: new Map() };
            append(el, block);
            return block;
        }
        function refreshFiles(block) {
            const files = [...block.files.values()].filter(file => file.state !== 'error');
            const created = files.filter(file => file.kind === 'add').length, removed = files.filter(file => file.kind === 'del').length;
            const changed = files.length - created - removed;
            const parts = [];
            if (changed) parts.push(L(changed > 1 ? `a modifié ${changed} fichiers` : 'a modifié un fichier', changed > 1 ? `edited ${changed} files` : 'edited a file'));
            if (created) parts.push(L(created > 1 ? `a ajouté ${created} fichiers` : 'a ajouté un fichier', created > 1 ? `added ${created} files` : 'added a file'));
            if (removed) parts.push(L(removed > 1 ? `a supprimé ${removed} fichiers` : 'a supprimé un fichier', removed > 1 ? `deleted ${removed} files` : 'deleted a file'));
            const running = [...block.files.values()].some(file => file.state === 'running');
            block.el.querySelector('.tl-files-label').textContent = joinPhrases(parts) || (running ? L('Modification de fichiers…', 'Editing files…') : L('Aucun fichier modifié', 'No file changed'));
            const add = files.reduce((n, file) => n + file.added, 0), del = files.reduce((n, file) => n + file.removed, 0);
            block.el.querySelector('.tl-files-total').innerHTML = (add || del) ? `<span class="tl-add">+${full(add)}</span><span class="tl-del">−${full(del)}</span>` : '';
            block.el.dataset.state = running ? 'running' : 'done';
        }
        function fileRow(block, path) {
            let file = block.files.get(path);
            if (file) return file;
            const row = document.createElement('details');
            row.className = 'tl-file';
            row.innerHTML = `<summary><span class="tl-file-kind"></span><span class="tl-file-path">${esc(path)}</span><span class="tl-file-counts"></span>${chevron}</summary><div class="tl-file-body"></div>`;
            file = { row, path, added: 0, removed: 0, diff: '', kind: 'mod', state: 'running' };
            block.files.set(path, file); block.rows.append(row);
            return file;
        }
        function paintFile(file) {
            const kind = file.state === 'error' ? 'error' : file.state === 'running' ? 'running' : file.kind;
            file.row.dataset.kind = kind;
            file.row.querySelector('.tl-file-kind').textContent = { add: L('Ajouté', 'Added'), del: L('Supprimé', 'Deleted'), mod: L('Modifié', 'Edited'), move: L('Déplacé', 'Moved'), error: L('Échec', 'Failed'), running: L('En cours', 'Working') }[kind];
            file.row.querySelector('.tl-file-counts').innerHTML = file.state === 'done' && (file.added || file.removed) ? `${file.added ? `<span class="tl-add">+${full(file.added)}</span>` : ''}${file.removed ? `<span class="tl-del">−${full(file.removed)}</span>` : ''}` : '';
            const bodyEl = file.row.querySelector('.tl-file-body');
            bodyEl.innerHTML = file.error ? `<pre class="tl-item-output">${esc(file.error)}</pre>` : diffHTML(file.diff);
            if (!bodyEl.innerHTML) file.row.classList.add('tl-file-nodiff');
            else file.row.classList.remove('tl-file-nodiff');
        }
        function startFileCall(call) {
            const block = lastBlock && lastBlock.kind === 'files' ? lastBlock : newFileBlock();
            call.rowGroup = block;
            const tool = call.tool.toLowerCase();
            const paths = tool === 'apply_patch' ? (call.input.files || []).map(file => file.path) : [call.input.path || call.input.from || call.title];
            call.paths = paths.filter(Boolean).map(String);
            for (const path of call.paths) {
                const file = fileRow(block, path);
                file.state = 'running';
                if (tool === 'delete') file.kind = 'del';
                if (tool === 'move') file.kind = 'move';
                paintFile(file);
            }
            refreshFiles(block); scroll();
        }
        function finishFileCall(call, outcome) {
            const block = call.rowGroup, tool = call.tool.toLowerCase();
            if (outcome.status !== 'ok') {
                for (const path of call.paths) { const file = fileRow(block, path); file.state = 'error'; file.error = outcomeText(outcome) || L('Modification refusée.', 'Change refused.'); paintFile(file); }
                refreshFiles(block); return;
            }
            const results = Array.isArray(outcome.result) ? outcome.result : [];
            for (const path of call.paths) if (!results.some(item => item && item.path === path)) { const file = fileRow(block, path); if (file.state === 'running') { file.state = 'done'; paintFile(file); } }
            for (const item of results) {
                if (!item || !item.path) continue;
                const file = fileRow(block, String(item.path));
                file.added += Number(item.added) || 0; file.removed += Number(item.removed) || 0;
                if (item.diff) file.diff = file.diff ? file.diff + '\n' + item.diff : item.diff;
                if (item.created && file.kind !== 'del') file.kind = 'add';
                if (tool === 'delete') file.kind = 'del';
                file.state = 'done'; file.error = '';
                paintFile(file);
            }
            refreshFiles(block); scroll();
        }

        // ── Notes: compaction, approvals, provider errors ──
        function note(kind, icon, text, attrs = '') {
            const el = document.createElement('div');
            el.className = 'tl-note tl-note-' + kind;
            el.innerHTML = `${ICONS[icon] || ''}<span>${esc(text)}</span>`;
            if (attrs) el.dataset.request = attrs;
            return append(el);
        }

        return {
            body,
            onEvent(event) {
                if (!event || finished) return;
                if (event.type === 'permission_required') { note('wait', 'lock', L('En attente de votre autorisation : ', 'Waiting for your approval: ') + (event.summary || event.target || ''), String(event.requestId || '')); return; }
                if (event.type === 'plan_required') { note('wait', 'map', L('Plan proposé : en attente de votre validation.', 'Plan proposed: waiting for your approval.'), String(event.requestId || '')); return; }
                if (event.type !== 'rust_event' || !event.event) return;
                const frame = event.event;
                if (frame.type === 'agent_spawned' && frame.agent) {
                    const agent = frame.agent; agents.set(String(agent.id), agent);
                    if (agent.role?.name === 'lead') leadId = String(agent.id);
                    else if (!leadId && !agent.parent_id) leadId = String(agent.id);
                    // A resumed session already counts its earlier compactions.
                    if (String(agent.id) === leadId) compactions = Number(agent.usage?.context_compactions || 0);
                    return;
                }
                if (frame.type === 'permission_resolved') {
                    const pending = flowEl.querySelector(`.tl-note-wait[data-request="${CSS.escape(String(frame.request_id || ''))}"]`);
                    if (pending) { pending.className = 'tl-note ' + (frame.allowed ? 'tl-note-ok' : 'tl-note-denied'); pending.querySelector('span').textContent += frame.allowed ? L(' · autorisé', ' · approved') : L(' · refusé', ' · denied'); }
                    return;
                }
                if (!isLead(frame)) return;
                switch (frame.type) {
                    case 'segment_started': {
                        const kind = frame.segment?.kind;
                        if ((kind === 'text' || kind === 'reasoning') && frame.segment?.id && !segments.has(String(frame.segment.id))) segments.set(String(frame.segment.id), startSegment({ kind }));
                        break;
                    }
                    case 'text_delta': { const s = segmentFor(frame, 'text'); s.text += frame.text || ''; fullText += frame.text || ''; queue(s); break; }
                    case 'reasoning_delta': { const s = segmentFor(frame, 'reasoning'); s.text += frame.text || ''; queue(s); break; }
                    case 'segment_completed': completeSegment(frame); break;
                    case 'tool_started': startTool(frame); break;
                    case 'tool_completed': finishTool(frame); break;
                    case 'usage_updated': {
                        const count = Number(frame.usage?.context_compactions || 0);
                        if (count > compactions) { note('divider', 'compress', L('Contexte compacté automatiquement', 'Context automatically compacted')); compactions = count; }
                        break;
                    }
                    case 'provider_error': note('warn', 'alert', (frame.retry_in_ms ? L('Fournisseur indisponible, nouvel essai automatique : ', 'Provider unavailable, retrying automatically: ') : L('Erreur du fournisseur : ', 'Provider error: ')) + (frame.message || '')); break;
                }
            },
            // Final reply: anything the stream did not carry (older servers,
            // providers without deltas) is rendered from the turn result.
            finish(data = {}) {
                if (finished) return;
                flush();
                for (const segment of segments.values()) if (segment.kind === 'text' && segment.el.isConnected && segment.text.trim()) segment.el.innerHTML = formatAIResponse(segment.text);
                const response = String(data.response || '');
                if (!fullText.trim() && response.trim()) { const el = document.createElement('div'); el.className = 'tl-text md'; el.innerHTML = formatAIResponse(response); flowEl.append(el); }
                if (!steps && Array.isArray(data.toolResults) && data.toolResults.length) flowEl.insertAdjacentHTML('beforeend', agentToolResultsHTML(data.toolResults));
                for (const call of tools.values()) if (call.state === 'running') finishTool({ call_id: call.id, outcome: { status: 'error', message: L('Interrompu.', 'Interrupted.') } });
                finished = true; clearInterval(clock);
                body.classList.remove('tl-running');
                const elapsed = Date.now() - startedAt;
                if (steps || segments.size > 1 || [...segments.values()].some(s => s.kind === 'reasoning')) head.textContent = L('A travaillé pendant ', 'Worked for ') + fmtDurationShort(elapsed);
                else body.querySelector('.tl-head').remove();
                const usage = data.usage;
                if (usage && (usage.turnInput || usage.turnOutput)) {
                    const foot = document.createElement('div');
                    foot.className = 'tl-foot';
                    foot.textContent = L(`${full(usage.turnInput)} tokens en entrée · ${full(usage.turnOutput)} en sortie (mesurés par le fournisseur)`, `${full(usage.turnInput)} input tokens · ${full(usage.turnOutput)} output (measured by the provider)`);
                    body.append(foot);
                }
                body.dataset.markdownSource = response || fullText;
                scroll();
            },
            fail(message) {
                if (finished) return;
                flush();
                for (const call of tools.values()) if (call.state === 'running') finishTool({ call_id: call.id, outcome: { status: 'error', message: L('Interrompu.', 'Interrupted.') } });
                finished = true; clearInterval(clock);
                body.classList.remove('tl-running');
                head.textContent = L('Interrompu après ', 'Stopped after ') + fmtDurationShort(Date.now() - startedAt);
                const el = document.createElement('div'); el.className = 'tl-error'; el.textContent = message || L('Erreur agent.', 'Agent error.');
                flowEl.append(el);
                body.dataset.markdownSource = fullText;
                scroll();
            },
            get text() { return fullText; },
        };
    }
    window.ZaalisTimeline = { create, classify, describe };
})();
