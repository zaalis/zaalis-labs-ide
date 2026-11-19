/* Restore the original workspace layout while keeping the shared visual style. */
(() => {
    'use strict';
    const {node,button,text}=window.ZaalisUI;
    const left=document.querySelector('.topbar-left'),sidebar=document.getElementById('sidebar');
    const toggle=document.getElementById('sidebar-toggle'),home=toggle.parentElement;
    const narrow=matchMedia('(max-width:900px)');
    left.querySelector('.ws-mobile-menu')?.remove();
    function placeSidebarToggle(){
        if(narrow.matches)left.prepend(toggle);else home.append(toggle);
        toggle.setAttribute('aria-expanded',String(narrow.matches?document.body.classList.contains('ws-mobile-navigation'):!sidebar.classList.contains('collapsed')));
        window.dispatchEvent(new Event('resize'));
    }
    narrow.addEventListener('change',placeSidebarToggle);placeSidebarToggle();
    const clear=document.getElementById('clear-terminal');
    clear.setAttribute('aria-label',text('Effacer le chat','Clear chat'));home.insertBefore(clear,narrow.matches?null:toggle);
    const tools=document.querySelector('.workspace-rail');
    for(const control of [...left.querySelectorAll('.collab-launch')]){control.classList.add('ws-rail-button');tools.append(control);}
    const memory=[...left.querySelectorAll('button')].find(item=>item.title===text('Mémoire des corrections','Correction memory'));
    if(memory){memory.className='ws-rail-button';tools.append(memory);}
    let toolsCollapsed=false;try{toolsCollapsed=localStorage.getItem('zaalis-tools-collapsed')==='true';}catch{}
    const railToggle=button('',()=>{toolsCollapsed=!toolsCollapsed;if(toolsCollapsed)window.ZaalisWorkspace.setPanel(null);applyTools();});
    railToggle.id='workspace-tools-toggle';railToggle.className='ws-rail-button';
    railToggle.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18m-7-12 3 3-3 3"/></svg>';
    tools.prepend(railToggle);
    function applyTools(){
        tools.classList.toggle('is-collapsed',toolsCollapsed);document.body.classList.toggle('ui-tools-collapsed',toolsCollapsed);
        const label=text(toolsCollapsed?'Afficher les outils':'Masquer les outils',toolsCollapsed?'Show tools':'Hide tools');
        railToggle.title=label;railToggle.setAttribute('aria-label',label);railToggle.setAttribute('aria-expanded',String(!toolsCollapsed));
        try{localStorage.setItem('zaalis-tools-collapsed',String(toolsCollapsed));}catch{}
        window.dispatchEvent(new Event('resize'));
    }
    if(toolsCollapsed)window.ZaalisWorkspace.setPanel(null);applyTools();
    function agents(){
        document.querySelectorAll('.agent-card').forEach(card=>{
            if(card.querySelector('.ui-agent-details'))return;
            card.classList.add('ui-agent-row');const name=card.querySelector('.agent-name');if(name)name.dataset.monogram=name.textContent.trim().slice(0,1);
            const details=node('details','ui-agent-details'),summary=node('summary','',text('Rôle et modèle','Role and model')),config=node('div','agent-config');
            for(const select of [...card.querySelectorAll('.agent-role-select,.agent-model-select')]){
                const custom=document.getElementById('custom-select-'+select.id);if(custom)config.append(custom);config.append(select);
            }
            details.append(summary,config);card.append(details);card.querySelector('.agent-dot')?.remove();
            const check=card.querySelector('.agent-check');if(check)check.setAttribute('role','switch');
        });
        document.querySelectorAll('.agent-badge').forEach(badge=>{badge.hidden=/^(inactif|idle)$/i.test(badge.textContent.trim());});
    }
    new MutationObserver(agents).observe(document.getElementById('agents-list'),{childList:true,subtree:true,characterData:true});agents();
    window.ZaalisCommands.register('history',text('Historique','History'),()=>window.ZaalisConversations.open());
    window.ZaalisCommands.register('memory',text('Mémoire des corrections','Correction memory'),()=>window.openCorrectionMemory());
    for(const control of tools.querySelectorAll('.ws-rail-button:not(#workspace-tools-toggle)')){
        const label=control.getAttribute('aria-label')||control.title;
        window.ZaalisCommands.register('tool-'+label,label,()=>{if(toolsCollapsed){toolsCollapsed=false;applyTools();}control.click();});
    }
    window.ZaalisShell={toggleSidebar:()=>toggle.click()};
    document.addEventListener('click',event=>{if(narrow.matches&&!sidebar.contains(event.target)&&!toggle.contains(event.target)){document.body.classList.remove('ws-mobile-navigation');toggle.setAttribute('aria-expanded','false');}});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('ws-mobile-navigation')){document.body.classList.remove('ws-mobile-navigation');toggle.setAttribute('aria-expanded','false');toggle.focus();}});
    window.ZaalisUI.accessibility();
})();
