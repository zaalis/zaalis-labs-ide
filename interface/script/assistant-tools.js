/* Shared assistant catalogue and human interactions for IDE and terminal. */
(() => {
    const seen = new Set(),questionDialogs=new Map(); let panel, stream, account, section = 'catalog';
    const copy = (fr, en) => state.language === 'en' ? en : fr;
    const connectionTitle = c => ({media:copy('Images, vidéo et voix','Image, video and speech providers'),cdp:copy('Navigateur CDP','CDP browser'),execution:copy('Environnements d’exécution','Execution backends'),a2a:copy('Agents A2A','A2A agents')})[c.id] || c.title;
    const node = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
    const button = (text, fn) => { const b = node('button', text); b.type = 'button'; b.className = 'btn btn-ghost'; b.onclick = fn; return b; };
    async function api(url, body) { const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const data = await r.json(); if (!r.ok) throw Error(data.error || `HTTP ${r.status}`); return data; }
    function dialog(title) {
        const previous = document.activeElement, d = node('dialog'); d.className = 'assistant-dialog';
        const h = node('h2', title); h.id = 'assistant-title-' + crypto.randomUUID(); d.setAttribute('aria-labelledby', h.id);
        const header = node('header'); header.append(h, button(copy('Fermer', 'Close'), () => d.close())); d.append(header);
        document.body.append(d); d.addEventListener('close', () => { d.remove(); previous?.focus(); }); return d;
    }
    async function question(event) {
        if (seen.has(event.requestId)) return; seen.add(event.requestId);
        const d = dialog(event.question), form = node('form'), fields = {}, status = node('p'); status.setAttribute('role', 'status');
        const list = event.fields || [{ name: 'answer', label: copy('Réponse', 'Answer'), type: event.secret ? 'password' : 'text' }];
        for (const field of list) {
            const label = node('label', field.label || field.name), input = event.options && !event.fields ? node('select') : node('input');
            if (input.tagName === 'SELECT') for (const option of event.options) { const item = node('option', option); item.value = option; input.append(item); }
            else { input.type = field.type || 'text'; input.autocomplete = input.type === 'password' ? 'off' : 'on'; }
            input.required = field.required !== false; if(event.multi_select && input.tagName==='SELECT'){input.multiple=true;input.size=Math.min(8,event.options.length);} input.name = field.name; label.append(input); form.append(label); fields[field.name] = input;
        }
        const submit = node('button', copy('Répondre', 'Submit')); submit.className = 'btn btn-primary'; submit.type = 'submit'; form.append(submit, status); d.append(form);
        let answered = false;questionDialogs.set(event.requestId,()=>{answered=true;d.close();});
        d.addEventListener("close",()=>questionDialogs.delete(event.requestId));
        form.onsubmit = async e => { e.preventDefault(); submit.disabled = true; try { const answer = Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, event.multi_select && input.tagName==='SELECT' ? Array.from(input.selectedOptions).map(o=>o.value) : input.value])); await api('/api/assistant/answer', { requestId: event.requestId, answer }); answered = true; for (const input of Object.values(fields)) input.value = ''; d.close(); } catch (error) { status.textContent = error.message; submit.disabled = false; } };
        d.addEventListener('close', () => { if (!answered) api('/api/assistant/answer', { requestId: event.requestId, answer: { cancelled: true } }).catch(() => {}); });
        d.showModal(); Object.values(fields)[0]?.focus();
    }
    function uiRequest(event) {
        const i = event.input || {};
        if (event.name === 'panel_focus') { if(i.panel==='tools')open();else if(['terminal','browser','chat','agents','files','vm','artifacts'].includes(i.panel))window.ZaalisWorkspace?.setPanel(i.panel); }
        else if(event.name==='close_terminal'){window.ZaalisWorkspace?.setPanel(null);}
        else if(event.name==='apply_layout'){const presets={default:{mode:'editor',panel:null},focus:{mode:'chat',panel:null},coding:{mode:'editor',panel:'terminal'},research:{mode:'chat',panel:'browser'}};const preset=presets[i.preset||'default'];if(preset){window.ZaalisWorkspace?.setMode(preset.mode);window.ZaalisWorkspace?.setPanel(preset.panel);}}
        else if(event.name==='desktop_annotate'){const d=dialog(i.title||copy('Annotation','Annotation'));d.append(node('p',i.text||''));d.showModal();}
        else if (event.name === 'desktop_tour') { const d = dialog(i.title || copy('Visite guidée', 'Guided tour')); const ol = node('ol'); for (const step of (i.steps || []).slice(0, 20)) ol.append(node('li', step.text || step.title || '')); d.append(ol); d.showModal(); }
        else showToast(String(i.text || i.title || i.emoji || '').slice(0, 1000));
    }
    const model = () => ({ root: state.projectRoot, model: state.config.aiModel, submodel: state.config.aiSubmodel, permissionMode: state.permissionMode });
    const views = { memory: ['memory', { action: 'list' }], sessions: ['session_search', { scope: 'account' }], skills: ['skills_list', {}], tasks: ['kanban_list', {}], schedule: ['cronjob_manage', { action: 'list', scope: 'account' }], jobs: ['delegate_task', { action: 'list', scope: 'account' }] };
    async function open() {
        if (panel?.open) { panel.focus(); return; }
        panel = dialog(copy('Outils de l’assistant', 'Assistant tools')); const controls = node('nav'), content = node('div'), status = node('p'); status.setAttribute('role', 'status'); panel.append(controls, content, status);
        const labels = { catalog: copy('Catalogue', 'Catalogue'), connections: copy('Connexions', 'Connections'), memory: copy('Mémoire', 'Memory'), sessions: copy('Sessions', 'Sessions'), skills: copy('Compétences', 'Skills'), tasks: copy('Tâches', 'Tasks'), schedule: copy('Planification', 'Schedules'), jobs: copy('Agents détachés', 'Background agents') };
        const safe = fn => async () => { try { status.textContent = ''; await fn(); } catch (e) { status.textContent = e.message; } };
        for (const [key, label] of Object.entries(labels)) controls.append(button(label, safe(async () => { section = key; await render(); })));
        async function render() {
            content.replaceChildren();
            if (section === 'catalog') {
                const data = await api('/api/assistant/catalog'), search = node('input'), list = node('div'); search.type = 'search'; search.setAttribute('aria-label', copy('Rechercher un outil', 'Search tools')); content.append(node('p', copy('Capacités partagées par l’IDE et le terminal. Les services externes nécessitent leurs connexions.', 'Capabilities shared by the IDE and terminal. External services require connections.')), search, list);
                const statuses = { ready: copy('Disponible', 'Ready'), configured_unverified: copy('Configuré, à vérifier', 'Configured, unverified'), connection_required: copy('Connexion requise', 'Connection required'), service_unavailable: copy('Service indisponible', 'Service unavailable'), requires_computer_control:copy('Contrôle ordinateur requis','Computer control required'), requires_vision_model: copy('Modèle vision requis', 'Vision model required'), requires_ffmpeg_and_vision: copy('FFmpeg et modèle vision requis', 'FFmpeg and vision model required') };
                const draw = () => { list.replaceChildren(); for (const tool of data.tools.filter(t => (`${t.name} ${t.family} ${t.description}`).toLowerCase().includes(search.value.toLowerCase()))) { const details = node('details'); details.append(node('summary', `${tool.name} · ${statuses[tool.status] || tool.status}`), node('p', tool.description), node('pre', JSON.stringify(tool.input_schema, null, 2))); list.append(details); } }; search.oninput = draw; draw();
            } else if (section === 'connections') {
                const data = await api('/api/assistant/catalog');
                for (const c of data.connections) { const card = node('section'); card.append(node('h3', connectionTitle(c)), node('p', c.status === 'configured' ? copy('Configuré', 'Configured') : c.status === 'disabled' ? copy('Désactivé', 'Disabled') : copy('Connexion requise', 'Connection required')));
                    card.append(button(copy('Configurer', 'Configure'), () => connection(c)), button(copy('Vérifier', 'Verify'), safe(async () => { const r = await owner('manage_connections', { action: 'test', id: c.id }); status.textContent = JSON.stringify(r); })), button(copy('Autoriser', 'Authorize'), safe(async () => { const r = await owner('manage_connections', { action: 'authorize', id: c.id }); if (r.authorizeUrl) window.open(r.authorizeUrl, '_blank', 'noopener'); }))); content.append(card); }
            } else {
                const [tool, input] = views[section], data = await api('/api/assistant/manage/' + tool + '?root=' + encodeURIComponent(state.projectRoot || '') + '&input=' + encodeURIComponent(JSON.stringify(input)));
                if (['memory','skills','schedule','jobs'].includes(section)) content.append(button(copy('Ajouter', 'Add'), () => create(section)));
                const rows = data.records || data.skills || data.jobs || data.tasks || data.sessions || [];
                for (const row of rows) { const card = node('details'); card.append(node('summary', row.title || row.name || row.id), node('pre', JSON.stringify(row, null, 2)));
                    if (section === 'schedule') for (const action of ['pause','resume','run','remove']) card.append(button(({pause:copy('Pause','Pause'),resume:copy('Reprendre','Resume'),run:copy('Exécuter','Run'),remove:copy('Supprimer','Remove')})[action], safe(async () => { await owner('cronjob_manage', { action, job_id: row.id }); await render(); })));
                    if (section === 'jobs') for (const action of ['result','cancel','resume']) card.append(button(({result:copy('Résultat','Result'),cancel:copy('Annuler','Cancel'),resume:copy('Reprendre','Resume')})[action], safe(async () => { const r = await owner('delegate_task', { action, delegation_id: row.id }); status.textContent = JSON.stringify(r); if (action !== 'result') await render(); })));
                    if (section === 'memory') card.append(button(copy('Supprimer','Delete'), safe(async () => { await owner('memory',{action:'delete',id:row.id});await render(); })));
                    if (section === 'skills') card.append(button(copy('Lire','Read'),safe(async()=>{status.textContent=JSON.stringify(await api('/api/assistant/manage/skill_view?root='+encodeURIComponent(state.projectRoot||'')+'&input='+encodeURIComponent(JSON.stringify({name:row.name,scope:row.scope}))));})));
                    if (section === 'sessions') card.append(button(copy('Lire','Read'),safe(async()=>{status.textContent=JSON.stringify(await api('/api/assistant/manage/session_search?root='+encodeURIComponent(state.projectRoot||'')+'&input='+encodeURIComponent(JSON.stringify({session_id:row.id,scope:'account'}))));})));
                    content.append(card);
                }
                if (!rows.length) content.append(node('p', copy('Aucun élément.', 'No entries.')));
            }
        }
        const owner = (name, input) => api('/api/assistant/manage/' + name, { ...model(), input });
        function form(title, definitions, submit) { const d = dialog(title), f = node('form'), values = {}, error = node('p'); error.setAttribute('role','status');
            for (const field of definitions) { const label = node('label', field.label), input = field.area ? node('textarea') : node('input'); if (!field.area) input.type = field.secret ? 'password' : 'text'; input.value = field.value || ''; input.required = !!field.required; if (field.secret) input.autocomplete='off'; label.append(input); f.append(label); values[field.name] = input; }
            const save = node('button',copy('Enregistrer','Save'));save.type='submit';save.className='btn btn-primary';f.append(save,error);d.append(f);f.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await submit(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v.value])));for(const v of Object.values(values))if(v.type==='password')v.value='';d.close();await render();}catch(e){error.textContent=e.message;save.disabled=false;}};d.showModal();Object.values(values)[0]?.focus(); }
        function connection(c){form(copy('Configurer ','Configure ')+connectionTitle(c),[{name:'baseUrl',label:copy('Adresse du service','Service URL'),value:c.baseUrl},{name:'token',label:copy('Jeton (facultatif)','Token (optional)'),secret:true},{name:'credentials',label:copy('Identifiants avancés (JSON chiffré, facultatif)','Advanced credentials (encrypted JSON, optional)'),secret:true},{name:'clientId',label:copy('Identifiant de l’application OAuth','OAuth client ID')},{name:'mcpServer',label:copy('Serveur MCP (facultatif)','MCP server (optional)')},{name:'options',label:copy('Options avancées (JSON)','Advanced options (JSON)'),area:true,value:'{}'}],v=>api('/api/assistant/connections',{id:c.id,baseUrl:v.baseUrl||undefined,mcpServer:v.mcpServer||undefined,options:{...JSON.parse(v.options||'{}'),...(v.clientId?{clientId:v.clientId}:{})},...((v.token||v.credentials)?{credentials:{...(v.credentials?JSON.parse(v.credentials):{}),...(v.token?{token:v.token}:{})}}:{})}));}
        function create(key){const choices={memory:['memory',{action:'add',scope:'personal'},[{name:'title',label:copy('Titre','Title')},{name:'text',label:copy('Note','Note'),area:true,required:true}]],skills:['skill_manage',{action:'create'},[{name:'name',label:copy('Nom','Name'),required:true},{name:'content',label:'SKILL.md',area:true,required:true}]],schedule:['cronjob_manage',{action:'create'},[{name:'name',label:copy('Nom','Name')},{name:'prompt',label:copy('Instruction','Instruction'),area:true,required:true},{name:'schedule',label:copy('Calendrier (every 5m, cron ou date ISO)','Schedule (every 5m, cron or ISO date)'),required:true},{name:'timezone',label:copy('Fuseau horaire','Time zone'),value:'Europe/Paris'}]],jobs:['delegate_task',{action:'start',background:true},[{name:'goal',label:copy('Objectif','Goal'),area:true,required:true}]]};const[name,input,fields]=choices[key];form(copy('Ajouter','Add'),fields,v=>owner(name,{...input,...v}));}
        panel.showModal(); await safe(render)();
    }
    function connectEvents(){if(!document.getElementById('auth-overlay')?.classList.contains('hidden')){stream?.close();stream=null;account=null;seen.clear();document.querySelectorAll('.assistant-dialog[open]').forEach(d=>d.close());return;}const id=document.getElementById('profile-email')?.textContent||'local';if(account===id&&stream&&stream.readyState!==EventSource.CLOSED)return;stream?.close();account=id;stream=new EventSource('/api/assistant/events');stream.onmessage=e=>{let event;try{event=JSON.parse(e.data)}catch{return;}if(event.type==='question_required')question(event).catch(()=>{});else if(event.type==='question_closed')questionDialogs.get(event.requestId)?.();else if(event.type==='background_event')handleRustInteractiveEvent(event.event).catch(()=>{});else if(event.type==='ui_request')uiRequest(event);};api('/api/assistant/questions').then(d=>d.questions.forEach(q=>question(q).catch(()=>{}))).catch(()=>{});}
    window.ZaalisAssistant={open,question,uiRequest};
    const b=button(copy('Outils','Tools'),()=>open());b.id='assistant-tools-btn';b.className='topbar-label-btn';document.querySelector('.topbar-right')?.prepend(b);
    document.addEventListener('zaalis-language-changed',()=>{b.textContent=copy('Outils','Tools');if(panel?.open){panel.close();open();}});
    const auth=document.getElementById('auth-overlay');if(auth)new MutationObserver(connectEvents).observe(auth,{attributes:true,attributeFilter:['class']});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)connectEvents();});connectEvents();
})();
