/* Two workspaces, one conversation engine. Existing editors and terminals are
 * moved, never cloned, so a layout switch keeps drafts, selections and streams. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const text = (fr, en) => state.language === 'en' ? en : fr;
    const el = (tag, className, value) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = value;
        return node;
    };
    const icons = {
        files: '<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>',
        browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
        terminal: '<path d="m4 6 6 6-6 6M12 18h8"/>',
        artifacts: '<path d="m12 3 9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9"/>',
        agents: '<circle cx="8" cy="8" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 15a5 5 0 0 1 5 5"/>',
        chat: '<path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        editor: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>',
        menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    };
    function icon(name) {
        const span = el('span', 'ws-icon');
        span.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.files}</svg>`;
        return span;
    }
    function button(label, iconName, handler, className = 'ws-button') {
        const node = el('button', className);
        node.type = 'button';
        node.title = label;
        node.setAttribute('aria-label', label);
        if (iconName) node.append(icon(iconName));
        if (label) node.append(el('span', '', label));
        if (handler) node.addEventListener('click', handler);
        return node;
    }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('zaalis-workspace') || '{}'); } catch {}
    let mode = saved.mode === 'chat' ? 'chat' : 'editor';
    let panel = ['files', 'browser', 'terminal', 'artifacts', 'agents', 'chat'].includes(saved.panel) ? saved.panel : null;
    let width = Math.max(300, Math.min(760, Number(saved.width) || 420));
    // The left sidebar shows either the project files or the conversations.
    // Each layout keeps its own choice: files for the editor, chats for Chat IDE.
    const sidebarViews = { editor: 'files', chat: 'chats' };
    for (const key of Object.keys(sidebarViews)) {
        if (['files', 'chats'].includes(saved.sidebarView?.[key])) sidebarViews[key] = saved.sidebarView[key];
    }
    const workspace = byId('workspace');
    if (!workspace) return;
    const editor = byId('editor-panel');
    const editorAnchor = document.createComment('editor home');
    editor.before(editorAnchor);
    const terminal = byId('integrated-terminal');
    const terminalAnchor = document.createComment('terminal home');
    terminal.before(terminalAnchor);
    const aiPanel = byId('ai-panel');
    const panes = {};
    let filesPaneRoot = null;
    const railButtons = {};
    const navigation = el('nav', 'workspace-navigation');
    navigation.setAttribute('aria-label', text('Projets et conversations', 'Projects and conversations'));
    byId('sidebar-stack').before(navigation);
    const chatsTitle = el('span', 'ws-sidebar-title', text('Conversations', 'Conversations'));
    byId('project-btn').after(chatsTitle);
    const filesEmpty = el('div', 'ws-files-empty');
    byId('sidebar-stack').after(filesEmpty);
    const viewSwitch = el('button', 'ws-view-switch');
    viewSwitch.type = 'button';
    viewSwitch.addEventListener('click', () => setSidebarView(sidebarViews[mode] === 'files' ? 'chats' : 'files'));
    byId('sidebar-profile').before(viewSwitch);
    const modeControl = el('div', 'workspace-modes');
    modeControl.setAttribute('role', 'group');
    modeControl.setAttribute('aria-label', text('Disposition', 'Workspace layout'));
    const editorButton = button(text('Éditeur', 'Editor'), 'editor', () => setMode('editor'));
    const chatButton = button('Chat IDE', 'chat', () => setMode('chat'));
    modeControl.append(editorButton, chatButton);
    document.querySelector('.topbar-left').append(modeControl);
    const mobileMenu = button(text('Projets', 'Projects'), 'menu', () => {
        document.body.classList.toggle('ws-mobile-navigation');
        mobileMenu.setAttribute('aria-expanded', String(document.body.classList.contains('ws-mobile-navigation')));
        syncBrowser();
    }, 'ws-button ws-mobile-menu');
    mobileMenu.setAttribute('aria-expanded', 'false');
    modeControl.before(mobileMenu);
    const dock = el('aside', 'workspace-dock');
    dock.id = 'workspace-dock';
    const dockHead = el('header', 'ws-dock-head');
    const dockTitle = el('strong');
    const dockClose = button(text('Fermer le panneau', 'Close panel'), 'close', () => setPanel(null), 'ws-icon-button');
    dockHead.append(dockTitle, dockClose);
    dock.append(dockHead);
    const rail = el('nav', 'workspace-rail');
    rail.setAttribute('aria-label', text('Outils de travail', 'Workspace tools'));
    const panelLabels = {
        files: text('Fichiers', 'Files'), browser: 'zaalis browser', terminal: 'Terminal',
        artifacts: text('Artefacts', 'Artifacts'), agents: text('Activité des agents', 'Agent activity'), chat: text('Autre chat', 'Another chat'),
    };
    for (const name of Object.keys(panelLabels)) {
        const pane = el('section', `ws-pane ws-pane-${name}`);
        pane.id = `ws-pane-${name}`;
        pane.setAttribute('aria-label', panelLabels[name]);
        dock.append(pane);
        panes[name] = pane;
        const control = button(panelLabels[name], name, () => setPanel(panel === name ? null : name), 'ws-rail-button');
        control.setAttribute('aria-controls', pane.id);
        control.setAttribute('aria-expanded', 'false');
        rail.append(control);
        railButtons[name] = control;
    }
    const splitter = el('div', 'ws-dock-splitter');
    splitter.tabIndex = 0;
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-label', text('Largeur du panneau droit', 'Right panel width'));
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.setAttribute('aria-valuemin', '300');
    splitter.setAttribute('aria-valuemax', '760');
    workspace.append(splitter, dock, rail);
    function saveLayout() {
        try { localStorage.setItem('zaalis-workspace', JSON.stringify({ mode, panel, width, sidebarView: sidebarViews })); } catch {}
    }
    function setSidebarView(view) {
        sidebarViews[mode] = view === 'chats' ? 'chats' : 'files';
        applySidebarView();
        saveLayout();
    }
    function applySidebarView() {
        const view = sidebarViews[mode];
        document.body.dataset.sidebarView = view;
        const next = view === 'files'
            ? { label: text('Afficher les chats', 'Show chats'), icon: 'chat' }
            : { label: text('Afficher les fichiers', 'Show files'), icon: 'files' };
        viewSwitch.replaceChildren(icon(next.icon), el('span', '', next.label));
        viewSwitch.title = next.label;
        viewSwitch.setAttribute('aria-label', next.label);
        if (view === 'chats') renderNavigation();
        else renderFilesEmpty();
    }
    function renderFilesEmpty() {
        filesEmpty.replaceChildren(el('p', 'ws-files-empty-title', text('Aucun projet ouvert', 'No project open')));
        filesEmpty.append(button(text('Ouvrir un dossier', 'Open a folder'), 'files', () => byId('open-project-btn').click()));
        const recent = getRecentProjects().slice(0, 6);
        if (!recent.length) return;
        filesEmpty.append(el('p', 'ws-files-empty-label', text('Projets récents', 'Recent projects')));
        for (const path of recent) {
            const row = button(path.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), 'files', () => safelyNavigate(() => openProject(path, false)), 'ws-conversation');
            row.title = path;
            filesEmpty.append(row);
        }
    }
    function applyWidth() {
        dock.style.width = `${width}px`;
        splitter.setAttribute('aria-valuenow', String(width));
    }
    splitter.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        width = event.key === 'Home' ? 300 : event.key === 'End' ? 760 : Math.max(300, Math.min(760, width + (event.key === 'ArrowLeft' ? 24 : -24)));
        applyWidth(); saveLayout(); syncBrowser();
    });
    splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        const startX = event.clientX, initial = width;
        const move = e => { width = Math.max(300, Math.min(760, initial + startX - e.clientX)); applyWidth(); syncBrowser(); };
        const end = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', end); splitter.removeEventListener('pointercancel', end); saveLayout(); };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', end);
        splitter.addEventListener('pointercancel', end);
    });
    function setMode(value) {
        mode = value === 'chat' ? 'chat' : 'editor';
        document.body.dataset.workspaceMode = mode;
        editorButton.setAttribute('aria-pressed', String(mode === 'editor'));
        chatButton.setAttribute('aria-pressed', String(mode === 'chat'));
        if (mode === 'chat') { panes.files.replaceChildren(editor); filesPaneRoot = null; }
        else { editorAnchor.after(editor); renderEditorFilesPane(); }
        placeComposerControls();
        applySidebarView();
        saveLayout();
        renderNavigation();
        updatePanels();
        window.dispatchEvent(new Event('resize'));
    }
    function setPanel(value) {
        panel = value;
        document.body.classList.remove('ws-mobile-navigation');
        mobileMenu.setAttribute('aria-expanded', 'false');
        updatePanels(); saveLayout();
        if (panel === 'files' && mode === 'editor') renderEditorFilesPane();
        if (panel === 'terminal') {
            if (terminalSessionId) attachIntegratedTerminal(terminalSessionId).catch(showError);
            else openIntegratedTerminal().catch(showError);
        }
        if (panel === 'artifacts') renderArtifacts();
        if (panel === 'agents') renderAgents();
        if (panel === 'chat') renderOtherChat();
    }
    function updatePanels() {
        const visiblePanel = panel;
        dock.hidden = !visiblePanel;
        splitter.hidden = !visiblePanel;
        dockTitle.textContent = panelLabels[visiblePanel] || '';
        Object.entries(panes).forEach(([name, pane]) => { pane.hidden = name !== visiblePanel; railButtons[name].setAttribute('aria-expanded', String(name === visiblePanel)); });
        if (visiblePanel === 'terminal') { panes.terminal.append(terminal); terminal.classList.remove('hidden'); }
        else if (terminal.parentElement === panes.terminal) { terminalAnchor.after(terminal); terminal.classList.add('hidden'); }
        applyWidth();
        syncBrowser();
    }
    async function renderEditorFilesPane(force = false) {
        if (mode !== 'editor' || (filesPaneRoot === state.projectRoot && panes.files.childElementCount && !force)) return;
        const root = state.projectRoot;
        filesPaneRoot = root;
        const pane = panes.files;
        pane.replaceChildren();
        if (!root) {
            const empty = el('div', 'ws-empty-state');
            empty.append(el('h3', '', text('Aucun projet ouvert', 'No project open')),
                button(text('Ouvrir un dossier', 'Open a folder'), 'files', () => byId('open-project-btn').click()));
            pane.append(empty);
            return;
        }
        pane.append(el('p', 'ws-files-heading', root));
        const tree = el('div', 'ws-dock-file-tree');
        pane.append(tree);
        const files = await fetchFiles('');
        if (mode !== 'editor' || state.projectRoot !== root) return;
        if (!files.length) tree.append(el('p', 'ws-empty-project', text('Ce dossier ne contient aucun fichier visible.', 'No visible files in this folder.')));
        else renderTree(files, tree, 0);
    }
    function showError(error) { if (typeof showToast === 'function') showToast(text('Action impossible', 'Action unavailable'), error.message || String(error), { icon: '!' }); }
    function isBusy() { return !!chatAbort || !!document.querySelector('.agent-card.working'); }
    function safelyNavigate(action) {
        if (isBusy()) { showError(new Error(text('Arrêtez la tâche en cours avant de changer de conversation.', 'Stop the running task before switching conversations.'))); return; }
        saveConversation(activeKind());
        action();
        document.body.classList.remove('ws-mobile-navigation');
        mobileMenu.setAttribute('aria-expanded', 'false');
    }
    const allConversations = () => [
        ...(state.conversations || []).map(conv => ({ conv, kind: 'chat' })),
        ...(state.agentConversations || []).map(conv => ({ conv, kind: 'agents' })),
    ];
    const currentConversation = (kind = activeKind()) => (state[kind === 'agents' ? 'agentConversations' : 'conversations'] || []).find(c => c.id === state[kind === 'agents' ? 'currentAgentConvId' : 'currentConvId']);
    const expanded = new Map();
    function renderNavigation() {
        const focusKey = navigation.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
        navigation.replaceChildren();
        const actions = el('div', 'ws-nav-actions');
        actions.append(button(text('Nouveau chat', 'New chat'), 'plus', () => safelyNavigate(() => newConversation(activeKind()))));
        actions.append(button(text('Ouvrir un projet', 'Open project'), 'files', () => byId('open-project-btn').click(), 'ws-icon-button'));
        navigation.append(actions);
        const groups = new Map();
        groups.set('', { label: text('Sans projet', 'Without project'), path: null, items: [] });
        for (const path of getRecentProjects()) groups.set(normalizeProjectPath(path), { label: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), path, items: [] });
        for (const item of allConversations()) {
            const path = item.conv.projectPath || (item.conv.project ? recentPathByName(item.conv.project) : null);
            const key = path ? normalizeProjectPath(path) : (item.conv.project || '');
            if (!groups.has(key)) groups.set(key, { label: item.conv.project || text('Sans projet', 'Without project'), path, items: [] });
            groups.get(key).items.push(item);
        }
        for (const [key, group] of groups) {
            const section = el('section', 'ws-project-group');
            const head = el('div', 'ws-project-heading');
            const toggle = button(group.label, group.path ? 'files' : 'chat', () => { expanded.set(key, !(expanded.get(key) !== false)); renderNavigation(); }, 'ws-project-toggle');
            toggle.dataset.focusKey = `project:${key}`;
            toggle.setAttribute('aria-expanded', String(expanded.get(key) !== false));
            toggle.title = group.path || group.label;
            head.append(toggle, button(text('Nouveau chat dans ce projet', 'New chat in this project'), 'plus', () => safelyNavigate(async () => {
                if (group.path) await openProject(group.path, false, { preserveConversation: true });
                else clearProject({ preserveConversation: true });
                newConversation('chat');
                document.querySelector('.ai-tab[data-tab="chat"]').click();
                refresh();
            }), 'ws-icon-button'));
            section.append(head);
            if (expanded.get(key) !== false) {
                const list = el('div', 'ws-project-chats');
                for (const { conv, kind } of [...group.items].reverse()) {
                    const row = button(conv.title || 'Conversation', kind === 'agents' ? 'agents' : 'chat', () => safelyNavigate(() => loadConversation(kind, conv.id)), 'ws-conversation');
                    row.dataset.focusKey = `${kind}:${conv.id}`;
                    const selected = kind === activeKind() && conv.id === state[kind === 'chat' ? 'currentConvId' : 'currentAgentConvId'];
                    row.classList.toggle('active', selected);
                    if (selected) row.setAttribute('aria-current', 'page');
                    list.append(row);
                }
                if (!group.items.length) {
                    if (group.path) list.append(button(text('Ouvrir les fichiers', 'Open files'), null, () => safelyNavigate(() => openProject(group.path, false)), 'ws-empty-project'));
                    else list.append(el('p', 'ws-empty-project', text('Vos conversations libres apparaîtront ici.', 'Your conversations will appear here.')));
                }
                section.append(list);
            }
            navigation.append(section);
        }
        if (focusKey) [...navigation.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
    }

    // The browser owns its native tabs and toolbar; this node only reserves its
    // viewport. External pages are never injected into the IDE DOM or an iframe.
    const browserHost = el('div', 'ws-browser-host');
    browserHost.id = 'ws-browser-host';
    const browserFallback = el('div', 'ws-empty-state');
    browserFallback.append(icon('browser'), el('h3', '', 'zaalis browser'), el('p', '', text('Le navigateur intégré est disponible dans la fenêtre native de zaalis IDE.', 'The integrated browser is available in the native zaalis IDE window.')));
    const browserForm = el('form', 'ws-browser-form');
    const browserAddress = el('input');
    browserAddress.type = 'url'; browserAddress.placeholder = 'https://'; browserAddress.required = true;
    browserAddress.setAttribute('aria-label', text('Adresse du site', 'Website address'));
    const externalOpen = button(text('Ouvrir dans zaalis browser', 'Open in zaalis browser'));
    externalOpen.type = 'submit';
    browserForm.append(browserAddress, externalOpen);
    browserFallback.append(browserForm);
    browserHost.append(browserFallback);
    panes.browser.append(browserHost);
    let nativeAvailable = false;
    let lastBrowserCommand = '';
    function nativePost(message) { window.chrome?.webview?.postMessage(message); }
    function browserOccluded() {
        return document.hidden || document.body.classList.contains('ws-mobile-navigation') || [...document.querySelectorAll('.modal-overlay.active, .modal.active, .settings-overlay.active, #auth-overlay, .catalog-overlay.open, .help-overlay.open, .remote-overlay.open')].some(node => {
            const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && node.getBoundingClientRect().height > 0;
        });
    }
    function syncBrowser() {
        if (!nativeAvailable) return;
        const rect = browserHost.getBoundingClientRect();
        const visible = panel === 'browser' && !dock.hidden && rect.width > 1 && rect.height > 1 && !browserOccluded();
        const command = visible ? { type: 'browser', action: 'show', bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, devicePixelRatio: window.devicePixelRatio || 1 } : { type: 'browser', action: 'hide' };
        const signature = JSON.stringify(command);
        if (signature !== lastBrowserCommand) { nativePost(command); lastBrowserCommand = signature; }
    }
    browserForm.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const url = new URL(browserAddress.value);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error(text('Utilisez une adresse HTTP ou HTTPS.', 'Use an HTTP or HTTPS address.'));
            const response = await fetch(`/api/browser-open?url=${encodeURIComponent(url.href)}`);
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || 'Navigateur indisponible');
        } catch (error) { showError(error); }
    });
    if (window.chrome?.webview) {
        window.chrome.webview.addEventListener('message', event => {
            let data = event.data;
            if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
            if (data?.type === 'nativeCapabilities' || data?.type === 'browserState') {
                nativeAvailable = data.browser === true || data.available === true;
                browserFallback.hidden = nativeAvailable && !data.error;
                if (data.error) { browserFallback.hidden = false; browserFallback.querySelector('p').textContent = data.error; }
                syncBrowser();
            }
        });
        nativePost({ type: 'browser', action: 'state' });
    }
    new ResizeObserver(syncBrowser).observe(browserHost);
    new MutationObserver(syncBrowser).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
    document.addEventListener('visibilitychange', syncBrowser);
    window.addEventListener('resize', syncBrowser);

    function emptyPane(pane, title, description) { pane.replaceChildren(el('div', 'ws-empty-state')); pane.firstChild.append(el('h3', '', title), el('p', '', description)); }
    const pendingArtifacts = new Map();
    function registerArtifacts(items, kind = activeKind()) {
        const conv = currentConversation(kind);
        const list = conv ? (conv.artifacts ||= []) : (pendingArtifacts.get(kind) || []);
        for (const item of Array.isArray(items) ? items : []) {
            if (!item || (!item.path && !item.url)) continue;
            if (item.url) { try { if (!['https:', 'http:', 'data:'].includes(new URL(item.url).protocol)) continue; } catch { continue; } }
            const key = `${item.type || 'file'}:${item.path || item.url}`;
            const artifact = { ...item, id: item.id || key, title: item.title || String(item.path || item.url).split(/[\\/]/).pop(), project: item.project || state.projectRoot, createdAt: item.createdAt || new Date().toISOString() };
            const previous = list.findIndex(x => x.id === artifact.id);
            if (previous >= 0) list[previous] = { ...list[previous], ...artifact };
            else list.push(artifact);
        }
        if (conv) { conv.artifacts = list.slice(-500); persistChats(kind); }
        else pendingArtifacts.set(kind, list.slice(-500));
        if (panel === 'artifacts') renderArtifacts();
    }
    function flushConversation(kind) {
        const conv = currentConversation(kind);
        if (!conv) return;
        if (pendingArtifacts.has(kind)) { const pending = pendingArtifacts.get(kind); pendingArtifacts.delete(kind); registerArtifacts(pending, kind); }
        if (kind === 'chat') conv.apiHistory = state.chatHistory.map(item => ({ ...item }));
    }
    function renderArtifacts() {
        const pane = panes.artifacts;
        const items = currentConversation()?.artifacts || [];
        if (!items.length) { emptyPane(pane, text('Les résultats de votre travail', 'Your work results'), text('Les fichiers créés ou modifiés par les outils apparaissent ici, avec leur provenance.', 'Files created or edited by tools appear here with their origin.')); return; }
        pane.replaceChildren();
        for (const item of [...items].reverse()) {
            const card = el('article', 'ws-artifact');
            card.append(el('span', 'ws-eyebrow', item.type || 'file'), el('h3', '', item.title), el('p', 'ws-path', item.path || item.url));
            if (item.provenance?.tool) card.append(el('p', 'ws-meta', `${item.provenance.tool} · ${new Date(item.createdAt).toLocaleString()}`));
            card.append(button(text('Ouvrir', 'Open'), item.url ? 'browser' : 'files', async () => {
                if (item.path) {
                    if (normalizeProjectPath(item.project) !== normalizeProjectPath(state.projectRoot)) { showError(new Error(text('Ouvrez la conversation du projet associé à ce fichier.', 'Open the conversation for this file’s project.'))); return; }
                    await openFile(item.path, item.title);
                } else if (item.url) {
                    if (/^https?:/i.test(item.url)) {
                        if (nativeAvailable) { setPanel('browser'); nativePost({ type: 'browser', action: 'navigate', url: item.url }); }
                        else { browserAddress.value = item.url; setPanel('browser'); }
                    } else if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(item.url)) {
                        const img = el('img', 'ws-artifact-image'); img.src = item.url; img.alt = item.title; card.append(img);
                    }
                }
            }));
            pane.append(card);
        }
    }
    const runContexts = new Map();
    let activeRun = null;
    let refreshTimer = null;
    function scheduleRefresh() { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 100); }
    function onAgentEvent(event) {
        if (!event || !event.type) return;
        if (event.type === 'run_started') {
            const kind = activeKind();
            if (!currentConversation(kind)) saveConversation(kind);
            const conv = currentConversation(kind);
            activeRun = event.sessionId || event.runId;
            if (conv && activeRun) { conv.sessionId = activeRun; runContexts.set(activeRun, { conv, kind }); persistChats(kind); }
        }
        const context = runContexts.get(event.sessionId || activeRun) || { conv: currentConversation(), kind: activeKind() };
        const { conv, kind } = context;
        const frame = event.type === 'rust_event' ? event.event : event;
        if (!frame) return;
        if (conv) {
            const agents = (conv.agentRuns ||= []);
            const id = String(frame.agent_id || frame.agentId || frame.agent?.id || '');
            let agent = id ? agents.find(item => item.id === id && item.sessionId === activeRun) : null;
            if (id && !agent && ['agent_spawned', 'agent_state_changed', 'agent_state'].includes(frame.type)) {
                agent = { id, sessionId: activeRun, label: frame.agent?.role?.label || frame.agent?.role?.name || text('Agent', 'Agent'), state: 'queued', startedAt: new Date().toISOString(), report: '' };
                agents.push(agent);
            }
            if (agent) {
                if (frame.state) agent.state = typeof frame.state === 'string' ? frame.state : frame.state.state || agent.state;
                if (frame.type === 'agent_spawned') { agent.label = frame.agent?.role?.label || frame.agent?.role?.name || agent.label; agent.parentId = frame.agent?.parent_id || null; }
                if (frame.type === 'text_delta') agent.report = (agent.report + (frame.text || '')).slice(-100000);
                if (frame.type === 'agent_failed') { agent.state = 'failed'; agent.error = frame.error || frame.message; }
            }
            if (event.type === 'done' || event.type === 'error') {
                for (const agent of agents.filter(item => item.sessionId === activeRun)) if (!['done', 'failed', 'cancelled'].includes(agent.state)) agent.state = event.type === 'error' || event.result?.error ? 'failed' : 'done';
                if (event.result?.sessionId) conv.sessionId = event.result.sessionId;
            }
            if (!['text_delta', 'reasoning_delta'].includes(frame.type)) persistChats(kind);
        }
        if (event.type === 'tool_done' && !event.error && !event.blocked) {
            if (Array.isArray(event.artifacts)) registerArtifacts(event.artifacts, kind);
            const path = event.input?.path || event.input?.file_path || event.input?.filePath;
            if (path && /write|edit|patch|create_file/i.test(event.tool || '')) registerArtifacts([{ type: 'file', path, provenance: { tool: event.tool, callId: event.id, sessionId: activeRun } }], kind);
            if (path && panel === 'files' && mode === 'editor') renderEditorFilesPane(true);
        }
        if (event.type === 'artifact_created') registerArtifacts([event.artifact || event], kind);
        if (!['text_delta', 'reasoning_delta'].includes(frame.type) || panel === 'agents') scheduleRefresh();
    }
    function renderAgents() {
        const pane = panes.agents;
        const agents = currentConversation()?.agentRuns || [];
        if (!agents.length) { emptyPane(pane, text('Les agents au travail', 'Agents at work'), text('Demandez une délégation dans le chat ou lancez une équipe dans l’onglet Agents. Leur progression et leurs résultats apparaîtront ici.', 'Ask for delegation in chat or start a team in the Agents tab. Their progress and results will appear here.')); return; }
        pane.replaceChildren();
        const labels = { queued: text('En attente', 'Queued'), running: text('En cours', 'Running'), done: text('Terminé', 'Done'), failed: text('Échec', 'Failed'), cancelled: text('Arrêté', 'Stopped'), blocked: text('En attente', 'Waiting') };
        for (const agent of [...agents].reverse()) {
            const card = el('details', 'ws-agent-run');
            const summary = el('summary');
            summary.append(el('strong', '', agent.label), el('span', `ws-agent-status ws-status-${agent.state}`, labels[agent.state] || agent.state));
            card.append(summary);
            card.append(el('p', 'ws-meta', agent.parentId ? text('Sous-agent délégué', 'Delegated subagent') : text('Agent de la session', 'Session agent')));
            if (agent.report) card.append(el('pre', 'ws-agent-report', agent.report));
            if (agent.error) card.append(el('p', 'ws-error', String(agent.error)));
            if (['running', 'queued'].includes(agent.state)) card.append(button(agent.parentId ? text('Arrêter cet agent', 'Stop this agent') : text('Arrêter la session', 'Stop session'), null, async () => {
                try {
                    const response = await fetch('/api/rust-core/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: agent.sessionId, agentId: agent.parentId ? agent.id : undefined }) });
                    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Annulation impossible');
                    for (const sibling of agents.filter(item => item.sessionId === agent.sessionId && (!agent.parentId || item.id === agent.id || item.parentId === agent.id))) if (['running', 'queued'].includes(sibling.state)) sibling.state = 'cancelled';
                    renderAgents(); persistChats(activeKind());
                } catch (error) { showError(error); }
            }));
            pane.append(card);
        }
    }
    let otherSelection = '';
    function renderOtherChat() {
        const pane = panes.chat;
        const options = allConversations();
        if (!options.length) { emptyPane(pane, text('Consulter un autre chat', 'Read another chat'), text('Les conversations enregistrées seront accessibles ici.', 'Saved conversations will be available here.')); return; }
        pane.replaceChildren();
        const label = el('label', 'ws-other-label', text('Conversation à consulter', 'Conversation to read'));
        const select = el('select', 'ws-select'); select.id = 'ws-other-conversation'; label.htmlFor = select.id;
        for (const { conv, kind } of options) { const opt = el('option', '', `${conv.project || text('Sans projet', 'Without project')} · ${conv.title}`); opt.value = `${kind}:${conv.id}`; select.append(opt); }
        if (options.some(({ conv, kind }) => `${kind}:${conv.id}` === otherSelection)) select.value = otherSelection;
        else select.selectedIndex = options.length - 1;
        otherSelection = select.value;
        select.addEventListener('change', () => { otherSelection = select.value; renderOtherChat(); });
        pane.append(label, select);
        const { conv, kind } = options.find(({ conv, kind }) => `${kind}:${conv.id}` === otherSelection);
        pane.append(button(text('Continuer cette conversation au centre', 'Continue this conversation in the main view'), 'chat', () => safelyNavigate(() => { loadConversation(kind, conv.id); setMode('chat'); setPanel(null); })));
        const content = el('div', 'ws-other-messages');
        for (const message of conv.messages || []) {
            const item = el('article', `ws-other-message ws-other-${message.type}`);
            item.append(el('strong', '', message.label || (message.type === 'user' ? text('Vous', 'You') : 'Assistant')), el('div', '', message.text || ''));
            content.append(item);
        }
        pane.append(content);
    }

    // Model capabilities are authoritative server data. Keep the selector
    // disabled until the selected model's response arrives (including races).
    const capabilityCache = new Map();
    // Keep the same vertical control in both layouts. In Chat IDE it sits
    // beside the composer; in Editor it sits beside the AI panel.
    const reasoningBar = byId('reasoning-slider-bar');
    const composerMeta = el('div', 'ws-composer-meta');
    const modelBar = document.querySelector('#view-chat .model-selector-bar');
    const modelBarAnchor = document.createComment('model bar home');
    modelBar.before(modelBarAnchor);
    const tokenMeter = byId('token-meter');
    const tokenMeterAnchor = document.createComment('token meter home');
    tokenMeter.before(tokenMeterAnchor);
    function composerRight(kind) { return byId(kind === 'agents' ? 'view-agents' : 'view-chat').querySelector('.chat-input-bottom-right'); }
    function placeComposerControls() {
        if (mode === 'chat') {
            composerMeta.append(tokenMeter, modelBar);
            composerRight('chat').prepend(composerMeta);
            byId('view-' + activeKind()).querySelector('.chat-input-area').append(reasoningBar);
        } else {
            tokenMeterAnchor.after(tokenMeter);
            modelBarAnchor.after(modelBar);
            composerMeta.remove();
            aiPanel.prepend(reasoningBar);
        }
    }
    const capabilityKey = (provider, model) => `${provider}:${model}`;
    let capabilityRequest = 0;
    function getCapabilities(provider, model) { return capabilityCache.get(capabilityKey(provider, model)); }
    async function refreshCapabilities(force = false) {
        const current = reasoningContext();
        const key = capabilityKey(current.model, current.submodel);
        const request = ++capabilityRequest;
        if (current.model === 'gguf' && !current.submodel) {
            tokenMeter.dataset.capabilities = text('Aucun modèle GGUF installé', 'No GGUF model installed');
            renderReasoningSlider(null);
            updateTokenMeter();
            return;
        }
        try {
            let caps = force ? null : capabilityCache.get(key);
            if (!caps) {
                const response = await fetch(`/api/model-capabilities?provider=${encodeURIComponent(current.model)}&model=${encodeURIComponent(current.submodel)}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                caps = await response.json(); capabilityCache.set(key, caps);
            }
            if (request !== capabilityRequest) return;
            const supported = !!caps.reasoning?.supported;
            const levels = supported && Array.isArray(caps.reasoning.levels) ? caps.reasoning.levels : [];
            const validLevel = levels.some(level => Number(level.value) === Number(state.reasoningLevel));
            if (!validLevel) state.reasoningLevel = Number(levels[0]?.value || 0);
            renderReasoningSlider(caps);
            const details = [caps.contextWindow ? `${fmtTokens(caps.contextWindow)} ${text('de contexte', 'context')}` : null, caps.tools ? text('Outils', 'Tools') : null, caps.vision ? 'Vision' : null, caps.ready === false ? text('À configurer', 'Setup needed') : null].filter(Boolean);
            tokenMeter.dataset.capabilities = details.join(' · ');
            updateTokenMeter();
        } catch {
            if (request !== capabilityRequest) return;
            renderReasoningSlider(null);
            tokenMeter.dataset.capabilities = text('Capacités du modèle indisponibles', 'Model capabilities unavailable');
        }
    }
    function syncReasoning() { updateSliderVisuals(); }
    // The context meter's tooltip also carries what the model supports.
    tokenMeter.addEventListener('mouseenter', () => {
        const usage = byId('token-text')?.textContent || '';
        tokenMeter.title = [text('Contexte utilisé', 'Context used') + ` : ${usage}`, tokenMeter.dataset.capabilities].filter(Boolean).join('\n');
    });
    document.addEventListener('change', event => { if (event.target.matches('#ai-model, #ai-submodel, .agent-model-select, .agent-role-select, .agent-check')) refreshCapabilities(); });
    document.querySelectorAll('.ai-tab').forEach(tab => tab.addEventListener('click', () => { placeComposerControls(); refresh(); refreshCapabilities(); }));
    // In Chat IDE the editor lives in the Files dock: reveal it when a file opens.
    const openFileInEditor = window.openFile;
    window.openFile = async (...args) => {
        const result = await openFileInEditor(...args);
        if (mode === 'chat' && panel !== 'files') setPanel('files');
        return result;
    };
    function refresh() {
        renderNavigation();
        if (sidebarViews[mode] === 'files') renderFilesEmpty();
        if (panel === 'artifacts') renderArtifacts();
        if (panel === 'agents') renderAgents();
        if (panel === 'chat') renderOtherChat();
        if (panel === 'files' && mode === 'editor') renderEditorFilesPane();
    }
    // Capture runs before the legacy terminal button so it can reuse the same
    // session instead of creating a second terminal while opening the dock.
    byId('open-integrated-terminal').addEventListener('click', event => { event.stopImmediatePropagation(); setPanel('terminal'); }, true);
    byId('terminal-close-btn').addEventListener('click', () => { if (panel === 'terminal') setPanel(null); });
    document.addEventListener('keydown', event => {
        if (event.ctrlKey && event.shiftKey && event.code === 'KeyE') { event.preventDefault(); setMode(mode === 'chat' ? 'editor' : 'chat'); }
        if (event.key === 'Escape' && !document.querySelector('.modal-overlay.active')) { document.body.classList.remove('ws-mobile-navigation'); syncBrowser(); }
    });
    window.ZaalisWorkspace = { setMode, setPanel, setSidebarView, refresh, renderNavigation, registerArtifacts, onAgentEvent, flushConversation, getCapabilities, refreshCapabilities, syncReasoning, safelyNavigate, get mode() { return mode; } };
    setMode(mode);
    // The authenticated startup path refreshes this after model restoration.
})();
