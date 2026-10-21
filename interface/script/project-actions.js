(() => {
    'use strict';
    const { node, button, text } = window.ZaalisUI;
    async function clone() {
        const modal = node('dialog', 'ui-palette'); modal.setAttribute('aria-label', text('Cloner un dépôt','Clone repository'));
        const form = node('form'), title = node('h2', '', text('Cloner un dépôt','Clone repository')); title.style.fontSize = '22px';
        const inputs = {};
        for (const [key, label, value] of [['url',text('URL HTTPS ou SSH','HTTPS or SSH URL'),''],['parent',text('Dossier parent','Parent folder'),state.config.defaultProjectFolder || ''],['name',text('Nom du dossier (facultatif)','Folder name (optional)'),'']]) {
            const wrap = node('label','ui-clone-field',label), input = node('input'); input.value = value; input.required = key !== 'name'; input.setAttribute('aria-label', label); wrap.append(input); form.append(wrap); inputs[key] = input;
        }
        const status = node('p','ui-status'); status.setAttribute('role','status');
        const submit = button(text('Cloner et ouvrir','Clone and open'), () => {}); submit.type = 'submit';
        const controller = new AbortController();
        modal.addEventListener('close', () => { controller.abort(); modal.remove(); });
        form.addEventListener('submit', async event => {
            event.preventDefault(); submit.disabled = true; status.textContent = text('Clonage en cours…','Cloning…');
            try {
                const response = await fetch('/api/projects/clone', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value]))),signal:controller.signal});
                const data = await response.json(); if (!response.ok) throw new Error(data.error);
                await openProject(data.path, false); modal.close();
            } catch (error) { if (!controller.signal.aborted) { status.textContent = error.message; status.dataset.error = 'true'; submit.disabled = false; } }
        });
        form.append(status,submit,button(text('Annuler','Cancel'),()=>modal.close())); modal.append(title,form); document.body.append(modal); modal.showModal(); inputs.url.focus();
    }
    function welcome() {
        const chat=document.getElementById('chat-messages');
        if(chat && (!chat.children.length || chat.children.length===1 && chat.firstElementChild.classList.contains('msg-system'))) {
            chat.replaceChildren(); const greeting=node('div','launch-welcome'),message=window.ZaalisWelcome?.message();greeting.dataset.launchWelcome='true';greeting.append(node('h2','',message?.title||text('Bonjour','Hello')),node('p','',message?.text||text('Une nouvelle journée pour créer.','A new day to create.')));chat.append(greeting);
            window.ZaalisWelcome?.render();
        }
    }
    window.ZaalisProjects = { clone, welcome };
    new MutationObserver(welcome).observe(document.getElementById('chat-messages'),{childList:true});
    welcome();
})();
