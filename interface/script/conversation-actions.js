/* Conversation navigation uses canonical APIs; the existing renderer remains
 * responsible for restoring messages and project context. */
(() => {
    'use strict';
    const { node, button, request, dialog, field, launch } = window.ZaalisCollabUI;
    const view = dialog('Conversations');
    const filters = node('div', undefined, 'collab-filters');
    const search = field(filters, 'Rechercher'); search.type = 'search';
    const archived = field(filters, 'Inclure les archives', 'checkbox');
    const list = node('div', undefined, 'collab-list');
    view.content.append(filters, list);
    let generation = 0, offset = 0;
    async function openConversation(conversation) {
        if (document.body.classList.contains('ai-busy')) throw new Error('Arrêtez la réponse en cours avant de changer de conversation.');
        const kind = conversation.kind === 'agents' ? 'agents' : 'chat';
        const cfg = HIST[kind];
        const full = (await request(`/api/conversations/${encodeURIComponent(conversation.id)}?kind=${kind}`)).conversation;
        const existing = state[cfg.store].find(item => item.id === full.id);
        if (existing) Object.assign(existing, full); else state[cfg.store].push(full);
        await loadConversation(kind, full.id); view.el.close();
    }
    function updateLocal(conversation) {
        const cfg = HIST[conversation.kind === 'agents' ? 'agents' : 'chat'];
        const existing = state[cfg.store].find(item => item.id === conversation.id);
        if (existing) Object.assign(existing, conversation);
        renderHistory();
    }
    async function refresh() {
        const current = ++generation;
        view.status.textContent = 'Chargement…';
        const result = await request(`/api/conversations?kind=all&archived=${archived.checked ? 'all' : 'false'}&q=${encodeURIComponent(search.value)}&limit=100&offset=${offset}`);
        if (current !== generation) return;
        list.replaceChildren(); view.status.textContent = `${result.total ?? result.conversations.length} conversation(s)`;
        for (const conversation of result.conversations) {
            const card = node('article', undefined, 'collab-card');
            card.append(button(conversation.title || 'Conversation', () => view.run(() => openConversation(conversation))));
            card.append(node('small', [conversation.kind || 'chat', conversation.projectPath || 'Sans projet', conversation.archived ? 'Archivée' : ''].filter(Boolean).join(' · ')));
            const actions = node('div', undefined, 'collab-actions');
            actions.append(button('Renommer', () => {
                const form = node('form', undefined, 'collab-inline');
                const title = field(form, 'Titre', 'text', conversation.title || ''); title.required = true; title.maxLength = 200;
                const submit = node('button', 'Enregistrer'); submit.type = 'submit';
                form.append(submit, button('Annuler', () => form.remove())); card.append(form); title.focus();
                form.addEventListener('submit', event => { event.preventDefault(); view.run(async () => {
                    const result = await request(`/api/conversations/${encodeURIComponent(conversation.id)}`, 'PATCH', { title: title.value.trim(), kind: conversation.kind }); updateLocal({ ...result.conversation, kind: conversation.kind }); await refresh();
                }); });
            }));
            actions.append(button(conversation.archived ? 'Restaurer' : 'Archiver', () => view.run(async () => {
                const result = await request(`/api/conversations/${encodeURIComponent(conversation.id)}`, 'PATCH', { archived: !conversation.archived, kind: conversation.kind }); updateLocal({ ...result.conversation, kind: conversation.kind }); await refresh();
            })));
            actions.append(button('Créer une branche', () => view.run(async () => {
                const result = await request(`/api/conversations/${encodeURIComponent(conversation.id)}/fork`, 'POST', { kind: conversation.kind }); await openConversation(result.conversation);
            })));
            actions.append(button('Supprimer', () => view.run(async () => {
                view.el.close();
                try { await deleteConversation(conversation.kind === 'agents' ? 'agents' : 'chat', conversation.id); }
                finally { view.el.showModal(); }
                await refresh();
            })));
            card.append(actions); list.append(card);
        }
        if (!result.conversations.length) list.append(node('p', 'Aucune conversation trouvée.'));
        const pages = node('nav', undefined, 'collab-actions');
        if (offset) pages.append(button('Page précédente', () => { offset = Math.max(0, offset - 100); view.run(refresh); }));
        if (offset + result.conversations.length < result.total) pages.append(button('Page suivante', () => { offset += 100; view.run(refresh); }));
        list.append(pages);
    }
    let debounce;
    search.addEventListener('input', () => { clearTimeout(debounce); offset = 0; debounce = setTimeout(() => view.run(refresh), 180); });
    archived.addEventListener('change', () => { offset = 0; view.run(refresh); });
    const open = (query = '') => { offset = 0; search.value = typeof query === 'string' ? query : ''; if (!view.el.open) view.el.showModal(); search.focus(); view.run(refresh); };
    launch('Historique', () => open());
    document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'h') { event.preventDefault(); open(); } });
    window.ZaalisConversations = { open, refresh };
})();
