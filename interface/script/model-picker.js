(() => {
    'use strict';
    // Composer footer: a model pill (provider chips, model list, reasoning) and
    // a context ring whose card also shows the plan usage limits when known.
    // The legacy selects stay in the DOM (parked hidden) as the source of truth.
    const {node,text}=window.ZaalisUI;
    const bar=document.querySelector('#view-chat .model-selector-bar');
    const right=document.querySelector('#view-chat .chat-input-bottom-right');
    const original=document.getElementById('token-meter');
    const providerSelect=document.getElementById('ai-model'),modelSelect=document.getElementById('ai-submodel');
    const park=node('div','ui-legacy-source');park.hidden=true;

    const names={off:text('Désactivé','Off'),minimal:text('Minimal','Minimal'),low:text('Faible','Low'),medium:text('Moyen','Medium'),high:text('Élevé','High'),max:text('Maximum','Maximum'),ultra:text('Maximum','Maximum')};
    const ICON_CHECK='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    // ---- Model pill + menu -------------------------------------------------
    const picker=node('details','ui-model-picker'),summary=node('summary','ui-mp-summary'),menu=node('div','ui-menu ui-mp-menu');
    summary.setAttribute('aria-label',text('Fournisseur, modèle et raisonnement','Provider, model and reasoning'));
    const sumModel=node('span','ui-mp-model'),sumEffort=node('span','ui-mp-effort'),sumCaret=node('span','ui-mp-caret');
    sumCaret.innerHTML='<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    summary.append(sumModel,sumEffort,sumCaret);

    const vendor=node('details','ui-model-picker ui-vendor-picker'),vendorSummary=node('summary','ui-mp-summary'),vendorMenu=node('div','ui-menu ui-mp-menu ui-mp-menu-left');
    vendorSummary.setAttribute('aria-label',text('Fournisseur','Provider'));
    const vendorName=node('span','ui-mp-model'),vendorCaret=node('span','ui-mp-caret');
    vendorCaret.innerHTML=sumCaret.innerHTML;vendorSummary.append(vendorName,vendorCaret);
    const providerRow=node('div','ui-mp-list');providerRow.setAttribute('role','listbox');
    vendorMenu.append(providerRow);vendor.append(vendorSummary,vendorMenu);
    const modelTitle=node('p','ui-mp-title',text('Modèle','Model')),modelList=node('div','ui-mp-list');
    modelList.setAttribute('role','listbox');
    const reasonTitle=node('p','ui-mp-title',text('Raisonnement','Reasoning')),reasonRow=node('div','ui-mp-seg');
    reasonRow.setAttribute('role','radiogroup');
    const install=node('button','ui-mp-install',text('Installer un modèle GGUF','Install a GGUF model'));install.type='button';
    install.addEventListener('click',()=>{document.getElementById('gguf-install-shortcut')?.click();picker.open=false;});
    const reasonBlock=node('div','ui-mp-block');reasonBlock.append(reasonTitle,reasonRow);
    menu.append(modelTitle,modelList,install,reasonBlock);
    picker.append(summary,menu);

    const setValue=(select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));};
    const clean=label=>String(label||'').replace(/\s*\([^)]*\)\s*$/,'').trim()||label;

    // ---- Context ring + usage card ----------------------------------------
    const usage=node('div','ui-usage');
    const ring=node('button','ui-ring');ring.type='button';ring.setAttribute('aria-haspopup','true');
    ring.setAttribute('aria-label',text('Contexte et limites d’utilisation','Context and usage limits'));
    const R=9,C=2*Math.PI*R;
    ring.innerHTML=`<svg width="22" height="22" viewBox="0 0 22 22"><circle class="ui-ring-track" cx="11" cy="11" r="${R}"/><circle class="ui-ring-fill" cx="11" cy="11" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}" transform="rotate(-90 11 11)"/></svg>`;
    const fillCircle=ring.querySelector('.ui-ring-fill');
    const card=node('div','ui-usage-card');card.hidden=true;
    usage.append(ring,card);

    let limits=null,limitsAt=0,limitsBusy=false;
    function fmtReset(ms){
        if(!ms)return '';
        const d=new Date(ms),now=new Date(),lang=state.language==='en'?'en-GB':'fr-FR';
        const time=d.toLocaleTimeString(lang,{hour:'2-digit',minute:'2-digit'});
        if(d.toDateString()===now.toDateString())return text('Réinitialisation à ','Resets at ')+time;
        const day=d.toLocaleDateString(lang,{weekday:'short'});
        return text('Réinitialisation le ','Resets ')+day+' '+time;
    }
    function windowLabel(w){
        const m=w.windowMinutes;
        if(!m)return text('Limite','Limit');
        if(m>=60*24*6)return text('Hebdomadaire','Weekly');
        if(m>=60)return text('Limite de ','')+Math.round(m/60)+text(' heures',' hour limit');
        return text('Limite de ','')+m+' min';
    }
    function row(label,detail,percent){
        const wrap=node('div','ui-usage-row'),head=node('div','ui-usage-head');
        head.append(node('span','ui-usage-label',label),node('span','ui-usage-detail',detail));
        const track=node('div','ui-usage-track'),fill=node('div','ui-usage-fill');
        fill.style.width=Math.max(0,Math.min(100,percent))+'%';
        fill.classList.toggle('warn',percent>=70&&percent<90);fill.classList.toggle('full',percent>=90);
        track.append(fill);wrap.append(head,track);return wrap;
    }
    function renderCard(){
        const fill=document.getElementById('token-fill'),txt=document.getElementById('token-text');
        const measured=original.dataset.measured==='true';
        const pct=parseFloat(fill?.style.width)||0;
        card.replaceChildren();
        card.append(node('p','ui-usage-title',text('Contexte utilisé','Context used')));
        card.append(row(text('Fenêtre de contexte','Context window'),measured?(txt?.textContent||''):text('Pas encore mesuré','Not measured yet'),measured?pct:0));
        card.append(node('div','ui-usage-sep'));
        if(limits&&limits.available&&limits.windows?.length){
            card.append(node('p','ui-usage-title',text('Limites d’utilisation du forfait','Plan usage limits')+(limits.plan?' · '+limits.plan.charAt(0).toUpperCase()+limits.plan.slice(1):'')));
            for(const w of limits.windows)card.append(row(windowLabel(w),(fmtReset(w.resetsAt)+'  '+w.usedPercent+' %').trim(),w.usedPercent));
        }else{
            card.append(node('p','ui-usage-title',text('Limites d’utilisation du forfait','Plan usage limits')));
            card.append(node('p','ui-usage-unknown',limitsBusy?text('Chargement…','Loading…'):text('Inconnues — non communiquées par ce fournisseur.','Unknown — not reported by this provider.')));
        }
    }
    async function loadLimits(){
        if(limitsBusy||Date.now()-limitsAt<60000)return;
        limitsBusy=true;renderCard();
        try{const r=await fetch('/api/plan-limits');limits=r.ok?await r.json():{available:false};}catch{limits={available:false};}
        limitsBusy=false;limitsAt=Date.now();if(!card.hidden)renderCard();
    }
    function updateRing(){
        const fill=document.getElementById('token-fill');
        const pct=original.dataset.measured==='true'?(parseFloat(fill?.style.width)||0):0;
        fillCircle.style.strokeDashoffset=(C*(1-pct/100)).toFixed(2);
        ring.classList.toggle('warn',pct>=70&&pct<90);ring.classList.toggle('full',pct>=90);
        ring.title=text('Contexte : ','Context: ')+(original.dataset.measured==='true'?Math.round(pct)+' %':text('non mesuré','not measured'));
        if(!card.hidden)renderCard();
    }
    function toggleCard(open){
        card.hidden=!open;ring.setAttribute('aria-expanded',String(open));
        if(open){renderCard();loadLimits();picker.open=false;vendor.open=false;}
    }
    ring.addEventListener('click',()=>toggleCard(card.hidden));

    // ---- Placement ---------------------------------------------------------
    right.prepend(usage);right.prepend(picker);right.prepend(vendor);
    park.append(bar,original);picker.append(park);

    // ---- Rendering ---------------------------------------------------------
    let last='';
    function refresh(){
        // The workspace can move the legacy controls while switching layouts.
        if(bar.parentElement!==park)park.append(bar);
        if(original.parentElement!==park)park.append(original);
        if(!right.contains(picker))right.prepend(picker);
        if(!right.contains(vendor))right.prepend(vendor);
        const levels=reasoningLevels();
        const providers=[...providerSelect.options].map(o=>({value:o.value,label:clean(o.textContent),action:o.dataset.action||'',group:o.parentElement.label||''}));
        const models=[...modelSelect.options].filter(o=>o.value).map(o=>({value:o.value,label:o.textContent.trim()}));
        const key=JSON.stringify([providerSelect.value,modelSelect.value,state.reasoningLevel,levels,providers,models,state.language,document.getElementById('gguf-install-shortcut')?.hidden]);
        if(key===last)return;last=key;

        providerRow.replaceChildren();
        let lastGroup=null;
        for(const p of providers){
            if(p.group!==lastGroup){lastGroup=p.group;if(p.group)providerRow.append(node('p','ui-mp-title',p.group));}
            const selected=!p.action&&p.value===providerSelect.value;
            const item=node('button','ui-mp-item'+(selected?' is-on':'')+(p.action?' is-action':''));item.type='button';item.setAttribute('role','option');item.setAttribute('aria-selected',String(selected));
            item.append(node('span','ui-mp-item-name',p.action?'+ '+p.label.replace(/…$/,''):p.label));
            const mark=node('span','ui-mp-check');if(selected)mark.innerHTML=ICON_CHECK;item.append(mark);
            item.addEventListener('click',()=>{
                vendor.open=false;
                if(p.action){providerSelect.dispatchEvent(new CustomEvent('custom-select-action',{detail:p.action}));return;}
                setValue(providerSelect,p.value);
                setTimeout(()=>{picker.open=true;},60);
            });
            providerRow.append(item);
        }
        vendorName.textContent=clean(providerSelect.selectedOptions[0]?.textContent)||text('Fournisseur','Provider');
        modelList.replaceChildren();
        if(!models.length)modelList.append(node('p','ui-mp-empty',text('Aucun modèle disponible pour ce fournisseur.','No model available for this provider.')));
        for(const m of models){
            const selected=m.value===modelSelect.value;
            const item=node('button','ui-mp-item'+(selected?' is-on':''));item.type='button';item.setAttribute('role','option');item.setAttribute('aria-selected',String(selected));
            item.append(node('span','ui-mp-item-name',m.label));
            const mark=node('span','ui-mp-check');if(selected)mark.innerHTML=ICON_CHECK;item.append(mark);
            item.addEventListener('click',()=>{setValue(modelSelect,m.value);picker.open=false;});
            modelList.append(item);
        }
        install.hidden=providerSelect.value!=='gguf'||!document.getElementById('gguf-install-shortcut');

        reasonRow.replaceChildren();
        const usable=levels.length>1;
        reasonBlock.hidden=!levels.length;
        for(const level of levels){
            const b=node('button','ui-mp-seg-btn'+(Number(level.value)===Number(state.reasoningLevel)?' is-on':''),window.ZaalisUI.translate(names[level.id])||level.label||level.id);
            b.type='button';b.disabled=!usable;b.setAttribute('role','radio');
            b.addEventListener('click',()=>{state.reasoningLevel=Number(level.value);window.ZaalisWorkspace.syncReasoning();last='';refresh();});
            reasonRow.append(b);
        }
        const current=levels.find(l=>Number(l.value)===Number(state.reasoningLevel));
        const effort=current?(window.ZaalisUI.translate(names[current.id])||current.label||current.id):'';
        const model=modelSelect.selectedOptions[0]?.textContent.trim()||providerSelect.selectedOptions[0]?.textContent.trim()||text('Choisir un modèle','Choose model');
        sumModel.textContent=model;sumEffort.textContent=effort;sumEffort.hidden=!effort;
        summary.title=model+(effort?' · '+text('Raisonnement : ','Reasoning: ')+effort:'');
        updateRing();
    }
    picker.addEventListener('toggle',()=>{if(picker.open){vendor.open=false;toggleCard(false);last='';refresh();}});
    vendor.addEventListener('toggle',()=>{if(vendor.open){picker.open=false;toggleCard(false);last='';refresh();}});
    new MutationObserver(refresh).observe(document.getElementById('reasoning-slider-bar'),{attributes:true,childList:true,subtree:true});
    new MutationObserver(refresh).observe(modelSelect,{childList:true,subtree:true,attributes:true});
    new MutationObserver(refresh).observe(providerSelect,{childList:true,subtree:true});
    const tokenText=document.getElementById('token-text');
    if(tokenText)new MutationObserver(updateRing).observe(original,{attributes:true,childList:true,subtree:true,characterData:true});
    for(const select of [providerSelect,modelSelect])select.addEventListener('change',refresh);
    document.addEventListener('click',event=>{
        if(!picker.contains(event.target)&&!event.target.closest('.custom-select-options'))picker.open=false;
        if(!vendor.contains(event.target))vendor.open=false;
        if(!usage.contains(event.target))toggleCard(false);
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){picker.open=false;vendor.open=false;toggleCard(false);}});
    document.addEventListener('zaalis-language-changed',()=>{last='';refresh();});
    window.addEventListener('resize',refresh);window.ZaalisModelPicker={refresh};refresh();
})();
