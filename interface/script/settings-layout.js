(() => {
    'use strict';
    const { node, button, text } = window.ZaalisUI;
    const groups = {
        general:{label:text('Général','General'),panes:['general']},
        appearance:{label:text('Apparence','Appearance'),panes:['appearance']},
        models:{label:text('Modèles','Models'),panes:['models']},
        api:{label:text('Clés et abonnements','Keys and subscriptions'),panes:['api']},
        mcp:{label:'MCP',panes:['mcp']},
        hardware:{label:text('Matériel','Hardware'),panes:['hardware']},
        vm:{label:text('Machines virtuelles','Virtual machines'),panes:['vm']},
        integrations:{label:text('Intégrations','Integrations'),panes:['integrations']},
        tokens:{label:text('Consommation','Usage'),panes:['tokens']},
        project:{label:text('Projet','Project'),panes:['project']},
        privacy:{label:text('Confidentialité','Privacy'),panes:['privacy']},
        updates:{label:text('Mises à jour','Updates'),panes:['updates']},
        backup:{label:text('Sauvegarde','Backup'),panes:['backup']}
    };
    const sidebar = document.querySelector('.settings-sidebar');
    const existing = [...sidebar.querySelectorAll('.settings-nav-item')];
    sidebar.replaceChildren(node('div','settings-sidebar-title',text('Réglages','Settings')));
    const controls = {};
    // Group order is explicit; the original pane ids and handlers are retained.
    for(const group of Object.values(groups))for(const name of group.panes){const pane=document.querySelector(`[data-settings-pane="${name}"]`);if(pane)pane.parentElement.append(pane);}
    for (const [key,group] of Object.entries(groups)) {
        const control = button(group.label,()=>navigate(key),'settings-nav-item');
        const svg = existing.find(item=>item.dataset.settingsSection===(key==='extensions'?'mcp':key))?.querySelector('svg');
        if (svg) control.prepend(svg); control.dataset.settingsSection=key; sidebar.append(control); controls[key] = control;
    }
    function navigate(section) {
        const key = groups[section] ? section : Object.keys(groups).find(key=>groups[key].panes.includes(section)) || 'general';
        for (const [id,control] of Object.entries(controls)) { control.classList.toggle('active',id===key); control.setAttribute('aria-current',id===key?'page':'false'); }
        document.querySelectorAll('.settings-pane').forEach(pane=>pane.classList.toggle('active',groups[key].panes.includes(pane.dataset.settingsPane)));
        const title = document.getElementById('settings-active-title'); title.removeAttribute('data-i18n'); title.textContent = window.ZaalisUI.translate(groups[key].label);
        if (key === 'vm') window.ZaalisVM?.settings();
        if (key === 'integrations') window.ZaalisIntegrations?.settings();
        if (key === 'tokens') window.ZaalisTokenProfile?.mount();
        return true;
    }
    document.getElementById('save-btn').closest('.modal-footer').classList.add('ui-settings-footer');
    const status = node('p','ui-status'); status.id = 'settings-save-status'; status.setAttribute('role','status');
    document.querySelector('.settings-main-header').after(status);
    for (const [key,label] of [['api',text('Enregistrer les clés et connexions','Save keys and connections')],['mcp',text('Enregistrer la configuration MCP','Save MCP configuration')],['hardware',text('Enregistrer la connexion locale','Save local connection')]]) {
        const pane = document.querySelector(`[data-settings-pane="${key}"]`);
        const result = node('p','ui-status'); result.setAttribute('role','status');
        const control = button(label,async()=>{
            control.disabled=true; result.textContent=text('Enregistrement…','Saving…');
            try { await saveSensitiveSettings(key); result.dataset.error='false'; result.textContent=text('Enregistré','Saved'); }
            catch(error) { result.dataset.error='true'; result.textContent=error.message; }
            finally { control.disabled=false; }
        },'ui-button ui-sensitive-action');
        pane.append(control,result);
    }
    const theme = document.getElementById('settings-theme-select');
    const option = node('option','',text('Automatique — système','Automatic — system')); option.value='system'; theme.prepend(option);
    theme.value = state.config.theme || 'system';
    window.ZaalisSettings = {navigate,groups,status}; navigate('general');
    document.addEventListener('zaalis-language-changed',()=>navigate(document.querySelector('.settings-nav-item.active')?.dataset.settingsSection));
})();
