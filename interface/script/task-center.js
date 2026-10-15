/* Task, memory and tool panels share presentation helpers while their APIs and
 * state remain separate. No model request starts when merely opening a panel. */
(() => {
    'use strict';
    const { node, button, request, dialog, field, launch, confirm } = window.ZaalisCollabUI;
    const view = dialog('Centre de travail');
    const tabs = node('nav', undefined, 'collab-actions'); tabs.setAttribute('aria-label', 'Centre de travail');
    const body = node('section'); view.content.append(tabs, body);
    let section = 'tasks', generation = 0;
    const root = () => state.projectRoot || '';
    function form(submit) { const el = node('form', undefined, 'collab-form'); el.addEventListener('submit', event => { event.preventDefault(); view.run(() => submit(el)); }); return el; }
    function saveButton(el, label) { const submit = node('button', label); submit.type = 'submit'; el.append(submit); return submit; }
    async function tasks() {
        const current = ++generation;
        const result = await request('/api/tasks'); if (current !== generation) return;
        body.replaceChildren();
        let editingTask = null;
        const create = form(async () => {
            const path = editingTask ? `/api/tasks/${encodeURIComponent(editingTask.id)}` : '/api/tasks';
            await request(path, editingTask ? 'PATCH' : 'POST', {
                title: title.value, prompt: prompt.value, root: project.value,
                model: editingTask?.model || document.getElementById('ai-model')?.value,
                submodel: editingTask?.submodel || document.getElementById('ai-submodel')?.value,
                permissionMode: editingTask?.permissionMode || state.permissionMode,
                intervalMinutes: Number(interval.value) || null,
                runAt: at.value ? new Date(at.value).toISOString() : null,
                enabled: editingTask?.enabled ?? true,
            });
            await tasks();
        });
        const title = field(create, 'Nom de la tâche'); title.required = true; title.maxLength = 200;
        const prompt = field(create, 'Instruction', 'textarea'); prompt.required = true;
        const project = field(create, 'Dossier du projet', 'text', root()); project.required = true;
        const interval = field(create, 'Répéter toutes les N minutes (facultatif)', 'number'); interval.min = '1';
        const at = field(create, 'Première exécution (facultatif)', 'datetime-local');
        create.append(node('small', 'Exécution locale : laissez Zaalis ouvert. Les permissions sélectionnées s’appliquent.'));
        const submitTask = saveButton(create, 'Créer la tâche'); body.append(create);
        for (const task of result.tasks) {
            const card = node('article', undefined, 'collab-card'); card.append(node('strong', task.title), node('p', task.prompt));
            card.append(node('small', `${task.status || (task.enabled ? 'active' : 'en pause')}${task.nextRunAt ? ' · ' + new Date(task.nextRunAt).toLocaleString() : ''}`));
            if (task.lastError) card.append(node('p', String(task.lastError), 'collab-error'));
            if (task.pending) {
                card.append(node('p', task.pending.summary || task.pending.content || 'Une décision est nécessaire pour continuer.'));
                card.append(button('Répondre à la demande', () => view.run(async () => {
                    const pending = task.pending;
                    view.el.close();
                    try { await handleRustInteractiveEvent({ ...pending, type: pending.type?.endsWith('_required') ? pending.type : `${pending.type || 'permission'}_required` }); }
                    finally { view.el.showModal(); }
                    await tasks();
                })));
            }
            if (task.lastResult) card.append(node('pre', typeof task.lastResult === 'string' ? task.lastResult : JSON.stringify(task.lastResult, null, 2)));
            const actions = node('div', undefined, 'collab-actions');
            const mutation = (path, method = 'POST', payload) => view.run(async () => { await request(`/api/tasks/${encodeURIComponent(task.id)}${path}`, method, payload); await tasks(); });
            actions.append(button('Modifier', () => { editingTask = task; title.value = task.title; prompt.value = task.prompt; project.value = task.root; interval.value = task.intervalMinutes || ''; at.value = task.runAt ? new Date(new Date(task.runAt).getTime() - new Date(task.runAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; submitTask.textContent = 'Enregistrer les modifications'; title.focus(); }), button('Exécuter', () => mutation('/run')), button(task.enabled ? 'Mettre en pause' : 'Reprendre', () => mutation('', 'PATCH', { enabled: !task.enabled })), button('Arrêter', () => mutation('/cancel')), button('Supprimer', () => view.run(async () => {
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
        body.replaceChildren(); const filters = node('div'); const search = field(filters, 'Rechercher un outil', 'search', query);
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
        control.setAttribute('aria-pressed', String(key === section)); tabs.append(control);
    }
    tabs.append(button('Actualiser', () => view.run(refresh)));
    const open = () => { if (!view.el.open) view.el.showModal(); view.run(refresh); };
    launch('Tâches et mémoire', open);
    window.ZaalisTaskCenter = { open, refresh };
})();
