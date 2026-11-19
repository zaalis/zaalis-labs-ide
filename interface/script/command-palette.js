(() => {
    'use strict';
    const {node,button,text}=window.ZaalisUI, commands=new Map();
    const register=(id,label,action,key)=>commands.set(id,{id,label,action,key});
    const run=id=>commands.get(id)?.action();
    let palette;
    function open() {
        if(palette?.open)return;
        const previous=document.activeElement;
        palette=node('dialog','ui-palette');palette.setAttribute('aria-label',text('Palette de commandes','Command palette'));
        const search=node('input');search.placeholder=text('Rechercher une commande…','Search commands…');search.setAttribute('aria-label',search.placeholder);
        const list=node('div','ui-palette-list');
        function draw(){list.replaceChildren();for(const item of commands.values()){const label=window.ZaalisUI.translate(item.label);if(label.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))list.append(button(label+(item.key?'   '+item.key:''),()=>{palette.close();run(item.id);}));}}
        search.addEventListener('input',draw);
        palette.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();list.querySelector('button')?.focus();}if(event.key==='Enter'&&event.target===search){event.preventDefault();list.querySelector('button')?.click();}});
        palette.addEventListener('close',()=>{palette.remove();previous?.focus();});
        palette.append(search,list,button(text('Fermer','Close'),()=>palette.close()));document.body.append(palette);draw();palette.showModal();search.focus();
    }
    register('settings',text('Réglages','Settings'),()=>document.getElementById('settings-btn').click(),'Ctrl/Cmd + ,');
    register('new-chat',text('Nouveau chat','New chat'),()=>newConversation(document.getElementById('view-agents').classList.contains('active')?'agents':'chat'),'Ctrl/Cmd + N');
    register('open-folder',text('Ouvrir un dossier','Open folder'),()=>document.getElementById('open-project-btn').click(),'Ctrl/Cmd + O');
    register('sidebar',text('Afficher ou masquer la barre latérale','Toggle sidebar'),()=>window.ZaalisShell?.toggleSidebar(),'Ctrl/Cmd + B');
    register('close-tab',text('Fermer l’onglet actif','Close active tab'),()=>{if(state.activeFile)closeFile(state.activeFile);else document.querySelector('.browser-tab.active .browser-tab-close')?.click();},'Ctrl/Cmd + W');
    register('mode',text('Basculer Éditeur / Chat','Switch Editor / Chat'),()=>window.ZaalisWorkspace.setMode(window.ZaalisWorkspace.mode==='chat'?'editor':'chat'),'Ctrl/Cmd + Maj + E');
    register('palette',text('Palette de commandes','Command palette'),open,'Ctrl/Cmd + Maj + P');
    register('clone',text('Cloner un dépôt','Clone repository'),()=>window.ZaalisProjects.clone());
    function shortcut(event) {
        if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
        const key=event.key.toLowerCase();
        const id=event.shiftKey?({p:'palette',e:'mode'})[key]:({',':'settings',n:'new-chat',o:'open-folder',b:'sidebar',w:'close-tab'})[key];
        if(!id)return;
        if(document.querySelector('.modal-overlay.active,dialog[open]')&&id!=='palette')return;
        event.preventDefault();event.stopImmediatePropagation();run(id);
    }
    document.addEventListener('keydown',shortcut,true);
    window.chrome?.webview?.addEventListener('message',event=>{
        let message=event.data;if(typeof message==='string'){try{message=JSON.parse(message);}catch{return;}}
        if(message?.type==='uiCommand'&&commands.has(message.command))run(message.command);
    });
    window.ZaalisCommands={register,run,open,shortcut};
})();
