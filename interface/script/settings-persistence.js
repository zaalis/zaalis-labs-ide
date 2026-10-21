/* Preferences are independent of credentials and connection configurations. */
(() => {
    'use strict';
    const {text} = window.ZaalisUI;
    const fields = {
        'settings-lang-select':['language'], 'settings-theme-select':['theme'],
        'settings-density-select':['density'],'settings-fontsize-select':['fontSize'],
        'settings-default-chat-select':['aiModel'],'settings-default-agent-select':['defaultAgentModel'],
        'settings-default-reasoning-select':['defaultReasoning','number'],
        'settings-default-permission-select':['defaultPermissionMode'],
        'settings-terminal-profile':['terminalProfile','runtime'],
        'gguf-ctx-input':['ggufCtx','context'], 'gguf-ngl-select':['ggufGpuLayers','layers'],
        'gguf-variant-select':['ggufVariant','runtime'],
        'settings-default-folder':['defaultProjectFolder'], 'settings-reopen-toggle':['reopenLastProject','boolean'],
        'settings-autoupdate-toggle':['autoCheckUpdates','boolean'],'settings-channel-select':['updateChannel']
    };
    const confirmed = new Map();
    let queue = Promise.resolve();
    const status = window.ZaalisSettings.status;
    async function save(control, key, type) {
        const old = confirmed.has(key) ? confirmed.get(key) : key === 'language' ? state.language : state.config[key];
        let value = type === 'boolean' ? control.checked : control.value;
        if (type === 'context') value = clampGgufCtx(value);
        if (type === 'number') value = Number(value) || 0;
        if (type === 'layers') value = value === '' ? '' : Math.max(0,Number(value)||0);
        if(value===old)return;
        control.disabled = true; status.textContent = text('Enregistrement…','Saving…'); status.dataset.error='false';
        try {
            if (key === 'language') setLanguage(value); else state.config[key] = value;
            if (['runtime','context','layers'].includes(type)) {
                const response = await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:sharedHardwareConfigPayload()})});
                const data = await response.json(); if(!response.ok) throw new Error(data.error || text('Enregistrement impossible','Unable to save'));
                if(key==='terminalProfile') document.dispatchEvent(new CustomEvent('terminal-profile-changed'));
            }
            if(key==='defaultPermissionMode') {
                const response=await fetch('/api/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:value})});
                if(!response.ok)throw new Error(text('Enregistrement du mode impossible','Unable to save permission mode'));
                setPermissionMode(value,false);
            }
            saveState(); applyAppearance(); confirmed.set(key,value);
            status.textContent=text('Enregistré','Saved');
        } catch(error) {
            if(key==='language') setLanguage(old); else state.config[key]=old;
            if(type==='boolean')control.checked=!!old;else control.value=old??'';
            control._customSelectRefresh?.(); applyAppearance();
            status.textContent=error.message+text(' — modifiez à nouveau pour réessayer.',' — change again to retry.');status.dataset.error='true';
        } finally { control.disabled=false; }
    }
    for (const [id,[key,type]] of Object.entries(fields)) {
        const control=document.getElementById(id); if(!control)continue;
        const event=control.tagName==='INPUT' && !['checkbox','range'].includes(control.type)?'blur':'change';
        control.addEventListener(event,()=>{queue=queue.then(()=>save(control,key,type));});
    }
})();
