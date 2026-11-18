/* Task, memory and tool panels share presentation helpers while their APIs and
 * state remain separate. No model request starts when merely opening a panel. */
(() => {
    'use strict';
    const { node, button, request, dialog, field, launch, confirm } = window.ZaalisCollabUI;
    const view = dialog('Centre de travail');view.el.classList.add('ui-work-center');
    const tabs = node('nav', undefined, 'collab-actions'); tabs.setAttribute('aria-label', 'Centre de travail');
    const body = node('section'); view.content.append(tabs, body);
    let section = 'tasks', generation = 0;
    const root = () => state.projectRoot || '';
    function introduction(title,description){const intro=node('header',undefined,'ui-section-intro');intro.append(node('h3',title),node('p',description));body.append(intro);}
    function form(submit) { const el = node('form', undefined, 'collab-form'); el.addEventListener('submit', event => { event.preventDefault(); view.run(() => submit(el)); }); return el; }
    function saveButton(el, label) { const submit = node('button', label); submit.type = 'submit'; el.append(submit); return submit; }
    async function tasks() {
        const current = ++generation;
        const result = await request('/api/tasks'); if (current !== generation) return;
        body.replaceChildren();
        introduction('Automatisations','Une phrase dit le rythme. Les rangées en dessous le règlent. Zaalis ne s’exécute que pendant qu’il est ouvert.');
        let editingTask = null;
        const create = form(async () => {
            syncSchedule();
            const path = editingTask ? `/api/tasks/${encodeURIComponent(editingTask.id)}` : '/api/tasks';
            await request(path, editingTask ? 'PATCH' : 'POST', {
                title: title.value, prompt: prompt.value, root: project.value,
                model: editingTask?.model || document.getElementById('ai-model')?.value,
                submodel: editingTask?.submodel || document.getElementById('ai-submodel')?.value,
                permissionMode: editingTask?.permissionMode || state.permissionMode,
                intervalMinutes: Number(interval.value) || null,
                cron: cron.value.trim() || null,
                runAt: at.value ? new Date(at.value).toISOString() : null,
                endsAt: end.value ? new Date(end.value).toISOString() : null,
                enabled: editingTask?.enabled ?? true,
            });
            await tasks();
        });
        create.classList.add('auto-editor');
        const title = field(create, 'Nom de la tâche'); title.required = true; title.maxLength = 200; title.placeholder = 'Veille, bilan, rappel…';
        title.parentElement.classList.add('auto-title');
        const statusLine = node('p', '', 'auto-status');
        const sentence = node('p', '', 'auto-sentence');
        create.append(statusLine, sentence);
        const prompt = field(create, 'Instruction', 'textarea'); prompt.required = true; prompt.rows = 7;
        prompt.placeholder = 'Ce que l’assistant doit faire, avec le résultat attendu.';
        prompt.parentElement.classList.add('auto-prompt');
        const project = field(create, 'Dossier du projet', 'text', root()); project.required = true;
        const interval = field(create, 'Répéter toutes les N minutes (facultatif)', 'number'); interval.min = '1';
        const cron = field(create, 'Expression cron'); cron.maxLength = 120; cron.spellcheck = false; cron.placeholder = '0 14 * * 5';
        const at = field(create, 'Première exécution (facultatif)', 'datetime-local');
        const end = field(create, 'Fin le', 'datetime-local');
        const days = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
        const moments = [['8','le matin'],['14','l’après-midi'],['19','le soir']];
        const group = node('div', undefined, 'auto-group');
        const addOption = (select, label, value) => { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); };
        const repeat = node('select');
        for (const [value, label] of [['week','Chaque semaine'],['day','Chaque jour'],['once','Une fois'],['manual','Sur demande'],['cron','Expression cron']]) addOption(repeat, label, value);
        const weekday = node('select');
        days.forEach((label, value) => addOption(weekday, label.charAt(0).toUpperCase() + label.slice(1), String(value)));
        weekday.value = '5';
        const moment = node('select');
        moments.forEach(([value, label]) => addOption(moment, label.charAt(0).toUpperCase() + label.slice(1), value));
        moment.value = '14';
        const ending = node('select');
        addOption(ending, 'Jamais', 'never'); addOption(ending, 'À une date', 'date');
        function row(label, control) {
            const line = node('label', label, 'auto-row'); line.append(control); return line;
        }
        const dayRow = row('Jour', weekday);
        const momentRow = row('Moment', moment);
        const endRow = row('Fin', ending);
        const endDateRow = row('Jusqu’au', end);
        group.append(row('Répéter', repeat), dayRow, momentRow, endRow, endDateRow);
        const advanced = node('details', undefined, 'auto-advanced');
        advanced.append(node('summary', 'Réglage précis'));
        project.parentElement.classList.add('auto-advanced-field');
        interval.parentElement.classList.add('auto-advanced-field');
        cron.parentElement.classList.add('auto-advanced-field');
        at.parentElement.classList.add('auto-advanced-field');
        advanced.append(project.parentElement, interval.parentElement, cron.parentElement, at.parentElement);
        create.append(group, advanced);
        function showScheduleRows() {
            const custom = repeat.value === 'cron', once = repeat.value === 'once', weekly = repeat.value === 'week', dated = ending.value === 'date';
            dayRow.hidden = !weekly; momentRow.hidden = custom || repeat.value === 'manual';
            endDateRow.hidden = !dated; advanced.open = custom;
            cron.parentElement.hidden = !custom;
        }
        function describe() {
            const when = moments.find(([value]) => value === moment.value)?.[1] || '';
            if (repeat.value === 'week') return `Chaque ${days[Number(weekday.value)]}, ${when}.`;
            if (repeat.value === 'day') return `Chaque jour, ${when}.`;
            if (repeat.value === 'once') return 'Une seule fois.';
            if (repeat.value === 'manual') return 'Quand vous le demandez.';
            return 'Selon l’expression que vous écrivez.';
        }
        function syncSchedule() {
            showScheduleRows();
            sentence.textContent = describe();
            if (repeat.value === 'cron') return;
            interval.value = '';
            if (repeat.value === 'manual') { cron.value = ''; if (!editingTask) at.value = ''; return; }
            const hour = moment.value;
            if (repeat.value === 'once') {
                cron.value = '';
                if (!at.value) {
                    const next = new Date(); next.setDate(next.getDate() + ((7 + Number(weekday.value) - next.getDay()) % 7));
                    next.setHours(Number(hour), 0, 0, 0); if (next.getTime() < Date.now()) next.setDate(next.getDate() + 7);
                    at.value = new Date(next.getTime() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                }
                return;
            }
            at.value = '';
            cron.value = repeat.value === 'day' ? `0 ${hour} * * *` : `0 ${hour} * * ${weekday.value}`;
        }
        function readSchedule(task) {
            const match = String(task?.cron || '').match(/^0 (\d{1,2}) \* \* (\*|\d)$/);
            if (task?.intervalMinutes) repeat.value = 'cron';
            else if (!task?.cron && task?.runAt) repeat.value = 'once';
            else if (!task?.cron) repeat.value = task ? 'manual' : 'week';
            else if (match && match[2] === '*' && ['8','14','19'].includes(match[1])) { repeat.value = 'day'; moment.value = match[1]; }
            else if (match && ['8','14','19'].includes(match[1])) { repeat.value = 'week'; weekday.value = match[2]; moment.value = match[1]; }
            else repeat.value = 'cron';
            ending.value = task?.endsAt ? 'date' : 'never';
            if (task?.endsAt) end.value = new Date(new Date(task.endsAt).getTime() - new Date(task.endsAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            else end.value = '';
            syncSchedule();
            if (repeat.value === 'cron' && task?.cron) cron.value = task.cron;
            if (task?.intervalMinutes) interval.value = String(task.intervalMinutes);
            if (task?.runAt) at.value = new Date(new Date(task.runAt).getTime() - new Date(task.runAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
        for (const control of [repeat, weekday, moment, ending, end]) control.addEventListener('change', syncSchedule);
        readSchedule(null);
        const footer = node('div', undefined, 'auto-footer');
        const resume = button('Reprendre', () => { if (!editingTask) return; view.run(async () => { await request(`/api/tasks/${encodeURIComponent(editingTask.id)}`, 'PATCH', { enabled: true }); await tasks(); }); });
        resume.type = 'button'; resume.className = 'auto-resume'; resume.hidden = true;
        const submitTask = node('button', 'Enregistrer'); submitTask.type = 'submit'; submitTask.className = 'auto-save';
        footer.append(resume, submitTask); create.append(node('small', 'Le dossier, les permissions et le modèle déjà choisis sont conservés.'), footer);
        const createBox=node('details',undefined,'ui-create-box auto-sheet');createBox.open=!result.tasks.length;createBox.append(node('summary','Nouvelle automatisation'),create);
        body.append(createBox);
        const paintStatus = () => {
            const paused = editingTask ? editingTask.enabled === false : false;
            statusLine.textContent = editingTask ? (paused ? 'En pause' : 'Active') : 'Nouvelle';
            statusLine.setAttribute('data-state', paused ? 'paused' : 'active');
            resume.hidden = !paused;
        };
        paintStatus();
        for (const task of result.tasks) {
            const card = node('article', undefined, 'collab-card auto-card'); card.append(node('strong', task.title), node('p', task.prompt));
            const statuses={running:'En cours',completed:'Terminée',failed:'À vérifier',cancelled:'Arrêtée',pending:'En attente',scheduled:'Planifiée',paused:'En pause',idle:'Prête'};
            const rhythm = task.cron ? task.cron : task.runAt ? 'Une fois' : task.intervalMinutes ? `Toutes les ${task.intervalMinutes} min` : 'Sur demande';
            card.append(node('small', `${task.enabled === false ? 'En pause' : (statuses[task.status] || 'Prête')} · ${rhythm}${task.nextRunAt ? ' · ' + new Date(task.nextRunAt).toLocaleString() : ''}`));
            if (task.lastError) card.append(node('p', String(task.lastError), 'collab-error'));
            if (task.pending) {
                card.append(node('p', task.pending.summary || task.pending.content || 'Une décision est nécessaire pour continuer.'));
                card.append(button('Répondre à la demande', () => view.run(async () => {
                    const pending = task.pending;
                    const question = pending.type?.startsWith('clarification');
                    if (question) view.el.close();
                    try { await handleRustInteractiveEvent({ ...pending, approvalHost: card, type: pending.type?.endsWith('_required') ? pending.type : `${pending.type || 'permission'}_required` }); }
                    finally { if (question) view.el.showModal(); }
                    await tasks();
                })));
            }
            if (task.lastResult) card.append(node('pre', typeof task.lastResult === 'string' ? task.lastResult : JSON.stringify(task.lastResult, null, 2)));
            const actions = node('div', undefined, 'collab-actions');
            const mutation = (path, method = 'POST', payload) => view.run(async () => { await request(`/api/tasks/${encodeURIComponent(task.id)}${path}`, method, payload); await tasks(); });
            actions.append(button('Modifier', () => { createBox.open=true;editingTask = task; title.value = task.title; prompt.value = task.prompt; project.value = task.root; interval.value = task.intervalMinutes || ''; cron.value = task.cron || ''; at.value = task.runAt ? new Date(new Date(task.runAt).getTime() - new Date(task.runAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; readSchedule(task); paintStatus(); submitTask.textContent = 'Enregistrer'; title.focus(); }), button('Exécuter', () => mutation('/run')), button(task.enabled ? 'Mettre en pause' : 'Reprendre', () => mutation('', 'PATCH', { enabled: !task.enabled })), button('Arrêter', () => mutation('/cancel')), button('Supprimer', () => view.run(async () => {
                if (await confirm(view, task.title, { title: 'Supprimer cette tâche ?', danger: true })) await mutation('', 'DELETE');
            })));
            card.append(actions); body.append(card);
        }
    }
    async function memory(query = '') {
        const restoreFocus = document.activeElement === body.querySelector('input[type=search]');
        const current = ++generation;
        const result = await request(`/api/knowledge?root=${encodeURIComponent(root())}&q=${encodeURIComponent(query)}`); if (current !== generation) return;
        body.replaceChildren();
        introduction('Ce que votre assistant retient','Gardez les préférences et les informations utiles pour vos prochaines conversations.');
        const filters = node('div'); const search = field(filters, 'Rechercher dans la mémoire', 'search', query);
        let debounce; search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => view.run(() => memory(search.value)), 400); }); body.append(filters);
        if (restoreFocus) { search.focus(); search.setSelectionRange(query.length, query.length); }
        let editingId = null;
        const create = form(async () => { await request(editingId ? `/api/knowledge/${encodeURIComponent(editingId)}` : '/api/knowledge', editingId ? 'PATCH' : 'POST', { root: project.value, title: title.value, content: content.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean) }); await memory(query); });
        const title = field(create, 'Titre'); title.required = true;
        const content = field(create, 'Information durable', 'textarea'); content.required = true;
        const tags = field(create, 'Étiquettes séparées par des virgules');
        const project = field(create, 'Projet (vide pour une mémoire globale)', 'text', root());
        const submitMemory = saveButton(create, 'Mémoriser'); body.append(create);
        for (const record of result.records) {
            const card = node('article', undefined, 'collab-card'); card.append(node('strong', record.title), node('p', record.content), node('small', (record.tags || []).join(', ')));
            card.append(button('Modifier', () => { title.value = record.title; content.value = record.content; tags.value = (record.tags || []).join(', '); project.value = record.root || ''; submitMemory.textContent = 'Enregistrer les modifications'; title.focus(); editingId = record.id; }));
            card.append(button('Supprimer', () => view.run(async () => {
                if (await confirm(view, record.title, { title: 'Supprimer ce souvenir ?', danger: true })) {
                    await request(`/api/knowledge/${encodeURIComponent(record.id)}`, 'DELETE'); await memory(query);
                }
            })));
            body.append(card);
        }
        if (!result.records.length) body.append(node('p', 'Aucun souvenir enregistré pour ce projet.'));
    }
    async function tools(query = '') {
        const restoreFocus = document.activeElement === body.querySelector('input[type=search]');
        const current = ++generation;
        const result = await request(`/api/tools?root=${encodeURIComponent(root())}&q=${encodeURIComponent(query)}`); if (current !== generation) return;
        body.replaceChildren();introduction('Les outils de votre assistant','Découvrez ce qu’il peut faire. Ouvrez un outil pour consulter ses détails.'); const filters = node('div'); const search = field(filters, 'Rechercher un outil', 'search', query);
        let debounce; search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => view.run(() => tools(search.value)), 400); }); body.append(filters);
        if (restoreFocus) { search.focus(); search.setSelectionRange(query.length, query.length); }
        for (const tool of result.tools) {
            const card = node('details', undefined, 'collab-card'); card.append(node('summary', tool.name || tool.id), node('p', tool.description || ''));
            card.append(node('pre', JSON.stringify(tool.input_schema || tool.parameters || tool.inputSchema || tool.schema || {}, null, 2))); body.append(card);
        }
        if (!result.tools.length) body.append(node('p', 'Aucun outil ne correspond à cette recherche.'));
    }
    const refresh = () => { view.status.textContent = ''; return ({ tasks, memory, tools }[section])(); };
    for (const [key, label] of [['tasks', 'Tâches'], ['memory', 'Mémoire générale'], ['tools', 'Outils']]) {
        const control = button(label, () => { section = key; for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab === control)); view.run(refresh); });
        control.title = key === 'memory' ? 'Préférences et faits que l’assistant peut réutiliser' : key === 'tools' ? 'Catalogue de ce que l’assistant sait faire' : 'Instructions qui reviennent toutes seules';
        control.setAttribute('aria-pressed', String(key === section)); tabs.append(control);
    }
    tabs.append(button('Actualiser', () => view.run(refresh)));
    const open = () => { if (!view.el.open) view.el.showModal(); view.run(refresh); };
    launch('Tâches et mémoire', open);
    window.ZaalisTaskCenter = { open, refresh };
})();
