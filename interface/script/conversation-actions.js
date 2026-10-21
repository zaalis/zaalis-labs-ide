/* Conversation navigation uses canonical APIs; the existing renderer remains
 * responsible for restoring messages and project context. */
(() => {
    'use strict';
    const { node, button, request, dialog, field, launch } = window.ZaalisCollabUI;
    const view = dialog('Vos conversations');view.el.classList.add('ui-conversations');
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
    function rename(conversation){
        const modal=node('dialog',undefined,'ui-palette'),form=node('form',undefined,'ui-rename-form');
        modal.setAttribute('aria-label','Renommer la conversation');form.append(node('h2','Renommer la conversation'));
        const title=field(form,'Nouveau titre','text',conversation.title||'');title.required=true;title.maxLength=200;
        const status=node('p','','collab-status');status.setAttribute('role','status');
        const actions=node('div',undefined,'collab-actions'),submit=button('Enregistrer',()=>{});submit.type='submit';
        actions.append(button('Annuler',()=>modal.close()),submit);form.append(status,actions);modal.append(form);document.body.append(modal);
        modal.addEventListener('close',()=>modal.remove());modal.showModal();title.focus();title.select();
        form.addEventListener('submit',async event=>{
            event.preventDefault();if(!title.value.trim())return;submit.disabled=true;
            try{const result=await request(`/api/conversations/${encodeURIComponent(conversation.id)}`,'PATCH',{title:title.value.trim(),kind:conversation.kind});updateLocal({...result.conversation,kind:conversation.kind});modal.close();if(view.el.open)view.run(refresh);}
            catch(error){status.textContent=error.message;submit.disabled=false;}
        });
    }
    function menuFor(kind,conversation,anchor){
        const conv={...conversation,kind};
        window.ZaalisActionMenu.open(anchor,[
            {label:'Renommer',run:()=>rename(conv)},
            {label:conv.archived?'Restaurer':'Archiver',run:()=>view.run(async()=>{
                const result=await request(`/api/conversations/${encodeURIComponent(conv.id)}`,'PATCH',{archived:!conv.archived,kind});updateLocal({...result.conversation,kind});if(view.el.open)await refresh();
            })},
            {label:'Créer une branche',run:()=>view.run(async()=>{const result=await request(`/api/conversations/${encodeURIComponent(conv.id)}/fork`,'POST',{kind});await openConversation(result.conversation);})},
            {label:'Supprimer',danger:true,run:()=>view.run(async()=>{
                const wasOpen=view.el.open;if(wasOpen)view.el.close();
                try{await deleteConversation(kind,conv.id);}finally{if(wasOpen)view.el.showModal();}
                if(wasOpen)await refresh();
            })}
        ]);
    }
    async function refresh() {
        const current = ++generation;
        view.status.textContent = 'Chargement…';
        const result = await request(`/api/conversations?kind=all&archived=${archived.checked ? 'all' : 'false'}&q=${encodeURIComponent(search.value)}&limit=100&offset=${offset}`);
        if (current !== generation) return;
        list.replaceChildren(); view.status.textContent = `${result.total ?? result.conversations.length} conversation(s)`;
        for (const conversation of result.conversations) {
            const card=node('article',undefined,'collab-card ui-conversation-card'),copy=node('div',undefined,'ui-conversation-copy');
            const title=button(conversation.title||'Conversation',()=>view.run(()=>openConversation(conversation)));title.title=conversation.title||'Conversation';
            const project=(conversation.projectPath||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop();
            copy.append(title,node('small',[conversation.kind==='agents'?'Équipe d’agents':'Chat',project||'Conversation libre',conversation.archived?'Archivée':''].filter(Boolean).join(' · ')));
            const more=button('…',()=>menuFor(conversation.kind==='agents'?'agents':'chat',conversation,more));more.className='ui-conversation-options';more.setAttribute('aria-label','Options de la conversation');more.setAttribute('aria-haspopup','menu');
            card.append(copy,more);list.append(card);
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
    window.ZaalisConversations = { open, refresh, menuFor };
})();
