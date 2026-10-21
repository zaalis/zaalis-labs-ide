(() => {
    'use strict';
    const {node,text}=window.ZaalisUI;
    const bar=document.querySelector('#view-chat .model-selector-bar');
    const picker=node('details','ui-model-picker'),summary=node('summary'),menu=node('div','ui-menu');
    summary.setAttribute('aria-label',text('Fournisseur, modèle et raisonnement','Provider, model and reasoning'));
    const reasoning=node('select');reasoning.id='unified-reasoning';
    const label=node('label','',text('Raisonnement','Reasoning'));label.append(reasoning);
    const title=node('p','ui-status',text('Fournisseur et modèle','Provider and model'));
    menu.append(title,bar,label);picker.append(summary,menu);
    const right=document.querySelector('#view-chat .chat-input-bottom-right');right.prepend(picker);
    const original=document.getElementById('token-meter');right.prepend(original);
    const names={off:text('Désactivé','Off'),minimal:text('Minimal','Minimal'),low:text('Faible','Low'),medium:text('Moyen','Medium'),high:text('Élevé','High'),max:text('Maximum','Maximum'),ultra:text('Maximum','Maximum')};
    let last='';
    function refresh(){
        // The workspace can move the legacy bar while switching layouts.
        if(bar.parentElement!==menu)menu.insertBefore(bar,label);
        if(original.parentElement!==right)right.insertBefore(original,picker);
        const select=document.getElementById('ai-submodel'),provider=document.getElementById('ai-model');
        const levels=reasoningLevels();
        const key=JSON.stringify([select.value,provider.value,state.reasoningLevel,levels,state.language]);
        if(key===last)return;last=key;
        reasoning.replaceChildren();
        for(const level of levels.length?levels:[{value:0,id:'off'}]){const option=node('option','',window.ZaalisUI.translate(names[level.id])||level.label||level.id);option.value=String(level.value);reasoning.append(option);}
        reasoning.value=String(state.reasoningLevel);reasoning.disabled=levels.length<2;
        const model=select.selectedOptions[0]?.textContent||provider.selectedOptions[0]?.textContent||text('Choisir un modèle','Choose model');
        const effort=reasoning.selectedOptions[0]?.textContent||names.off;
        summary.textContent=model+' · '+effort+' ⌄';summary.title=model+' · '+text('Raisonnement : ','Reasoning: ')+effort;
    }
    reasoning.addEventListener('change',()=>{state.reasoningLevel=Number(reasoning.value);window.ZaalisWorkspace.syncReasoning();refresh();});
    picker.addEventListener('toggle',()=>{if(picker.open)refresh();});
    new MutationObserver(refresh).observe(document.getElementById('reasoning-slider-bar'),{attributes:true,childList:true,subtree:true});
    for(const id of ['ai-model','ai-submodel'])document.getElementById(id).addEventListener('change',refresh);
    document.addEventListener('click',event=>{if(!picker.contains(event.target)&&!event.target.closest('.custom-select-options'))picker.open=false;});
    document.addEventListener('zaalis-language-changed',refresh);
    window.addEventListener('resize',refresh);window.ZaalisModelPicker={refresh};refresh();
})();
