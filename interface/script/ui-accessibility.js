/* Shared keyboard behavior for existing dialogs and dropdowns. */
(() => {
    'use strict';
    let sequence=0;const focusBefore=new WeakMap();
    function enhance(root=document){
        for(const modal of root.querySelectorAll('.modal-overlay')){
            const active=modal.classList.contains('active');modal.inert=!active;modal.setAttribute('aria-hidden',String(!active));
        }
        for(const select of root.querySelectorAll('select')){
            select.id ||= 'ui-select-'+(++sequence);
            if(document.getElementById('custom-select-'+select.id))continue;
            createCustomSelect(select.id,{dropDown:true,viewport:true});
            const trigger=document.getElementById('custom-select-'+select.id)?.querySelector('.custom-select-trigger');
            const label=select.getAttribute('aria-label')||document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent||select.closest('label')?.firstChild?.textContent||select.title;
            if(label)trigger?.setAttribute('aria-label',label.trim());
        }
        window.ZaalisUI.accessibility(root);
    }
    const observer=new MutationObserver(records=>{
        if(records.some(record=>record.type==='childList'))enhance();
        for(const record of records){
            const modal=record.target;
            if(record.type!=='attributes'||!modal.classList.contains('modal-overlay'))continue;
            modal.inert=!modal.classList.contains('active');modal.setAttribute('aria-hidden',String(modal.inert));
            if(modal.classList.contains('active')){
                if(!focusBefore.has(modal))focusBefore.set(modal,document.activeElement);
                modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
                const title=modal.querySelector('h2');if(title){title.id ||= 'ui-dialog-'+(++sequence);modal.setAttribute('aria-labelledby',title.id);}
                if(!modal.contains(document.activeElement))modal.querySelector('input,button,textarea,[tabindex="0"]')?.focus();
            }else if(focusBefore.has(modal)){
                const previous=focusBefore.get(modal);focusBefore.delete(modal);if(previous?.isConnected)previous.focus();
            }
        }
    });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});enhance();
    document.addEventListener('keydown',event=>{
        const modal=[...document.querySelectorAll('.modal-overlay.active')].at(-1);if(!modal)return;
        if(event.key==='Escape'){
            if(modal.querySelector('.custom-select-container.open'))return;
            modal.querySelector('.modal-close')?.click();event.preventDefault();return;
        }
        if(event.key!=='Tab')return;
        const controls=[...modal.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length&&!el.closest('[hidden]'));
        if(!controls.length)return;const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
})();
