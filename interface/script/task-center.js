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
    const text = (fr, en) => state.language === 'en' ? en : fr;
    const dateInput = value => {
        if (!value) return '';
        const date = new Date(value);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const dateValue = (value, original) => value
        ? (value === dateInput(original) ? original : new Date(value).toISOString())
        : null;
    function introduction(title,description){const intro=node('header',undefined,'ui-section-intro');intro.append(node('h3',title),node('p',description));body.append(intro);}
    function form(submit) { const el = node('form', undefined, 'collab-form'); el.addEventListener('submit', event => { event.preventDefault(); view.run(() => submit(el)); }); return el; }
    function saveButton(el, label) { const submit = node('button', label); submit.type = 'submit'; el.append(submit); return submit; }
    async function tasks() {
        const current = ++generation;
        const result = await request('/api/tasks'); if (current !== generation) return;
        body.replaceChildren();
        introduction(text('Automatisations', "Automations"),text('Une phrase dit le rythme. Les rangées en dessous le règlent. Zaalis ne s’exécute que pendant qu’il est ouvert.', "Scheduled tasks run while Zaalis is open."));
        let editingTask = null;
        const create = form(async () => {
            const path = editingTask ? `/api/tasks/${encodeURIComponent(editingTask.id)}` : '/api/tasks';
            await request(path, editingTask ? 'PATCH' : 'POST', {
                title: title.value, prompt: prompt.value, root: project.value,
                model: editingTask?.model || document.getElementById('ai-model')?.value,
                submodel: editingTask?.submodel || document.getElementById('ai-submodel')?.value,
                permissionMode: editingTask?.permissionMode || state.permissionMode,
                intervalMinutes: Number(interval.value) || null,
                cron: cron.value.trim() || null,
                runAt: repeat.value === 'manual' ? null : dateValue(at.value, editingTask?.runAt),
                endsAt: ending.value === 'date' ? dateValue(end.value, editingTask?.endsAt) : null,
                enabled: editingTask?.enabled ?? true,
            });
            await tasks();
        });
        create.classList.add('auto-editor');
        const title = field(create, text('Nom de la tâche', "Task name")); title.required = true; title.maxLength = 200; title.placeholder = text('Veille, bilan, rappel…', "Monitor, summarize, remind…");
        title.parentElement.classList.add('auto-title');
        const statusLine = node('p', '', 'auto-status');
        const sentence = node('p', '', 'auto-sentence');
        create.append(statusLine, sentence);
        const prompt = field(create, text('Instruction', "Instructions"), 'textarea'); prompt.required = true; prompt.rows = 7;
        prompt.placeholder = text('Ce que l’assistant doit faire, avec le résultat attendu.', "Describe what the assistant should do and the expected result.");
        prompt.parentElement.classList.add('auto-prompt');
        const project = field(create, text('Dossier du projet', "Project folder"), 'text', root()); project.required = true;
        const interval = field(create, text('Répéter toutes les N minutes (facultatif)', "Repeat every N minutes (optional)"), 'number'); interval.min = '1';
        const cron = field(create, text('Expression cron', "Cron expression")); cron.maxLength = 120; cron.spellcheck = false; cron.placeholder = '0 14 * * 5';
        const at = field(create, text('Première exécution (facultatif)', "First run"), 'datetime-local');
        const end = field(create, text('Fin le', "End date"), 'datetime-local');
        const days = [text('dimanche', "Sunday"),text('lundi', "Monday"),text('mardi', "Tuesday"),text('mercredi', "Wednesday"),text('jeudi', "Thursday"),text('vendredi', "Friday"),text('samedi', "Saturday")];
        const moments = [['8',text('le matin', "in the morning")],['14',text('l’après-midi', "in the afternoon")],['19',text('le soir', "in the evening")]];
        const group = node('div', undefined, 'auto-group');
        const addOption = (select, label, value) => { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); };
        const repeat = node('select');
        for (const [value, label] of [['week',text('Chaque semaine', "Every week")],['day',text('Chaque jour', "Every day")],['once',text('Une fois', "Once")],['manual',text('Sur demande', "On demand")],['cron',text('Expression cron', "Cron expression")]]) addOption(repeat, label, value);
        const weekday = node('select');
        days.forEach((label, value) => addOption(weekday, label.charAt(0).toUpperCase() + label.slice(1), String(value)));
        weekday.value = '5';
        const moment = node('select');
        moments.forEach(([value, label]) => addOption(moment, label.charAt(0).toUpperCase() + label.slice(1), value));
        moment.value = '14';
        const ending = node('select');
        addOption(ending, text('Jamais', "Never"), 'never'); addOption(ending, text('À une date', "On a date"), 'date');
        function row(label, control) {
            const line = node('label', label, 'auto-row'); line.append(control); return line;
        }
        const dayRow = row(text('Jour', "Day"), weekday);
        const momentRow = row(text('Moment', "Time of day"), moment);
        const endRow = row(text('Fin', "Ends"), ending);
        const endDateRow = row(text('Jusqu’au', "End date"), end);
        group.append(row(text('Répéter', "Repeat"), repeat), dayRow, momentRow, endRow, endDateRow);
        const advanced = node('details', undefined, 'auto-advanced');
        advanced.append(node('summary', text('Réglage précis', "Advanced settings")));
        project.parentElement.classList.add('auto-advanced-field');
        interval.parentElement.classList.add('auto-advanced-field');
        cron.parentElement.classList.add('auto-advanced-field');
        at.parentElement.classList.add('auto-advanced-field');
        advanced.append(project.parentElement, interval.parentElement, cron.parentElement, at.parentElement);
        create.append(group, advanced);
        function showScheduleRows() {
            const custom = repeat.value === 'cron', once = repeat.value === 'once', weekly = repeat.value === 'week', dated = ending.value === 'date';
            dayRow.hidden = !weekly; momentRow.hidden = custom || once || repeat.value === 'manual';
            endDateRow.hidden = !dated; end.required = dated; at.required = once;
            advanced.open = custom || once;
            cron.parentElement.hidden = !custom;
        }
        function describe() {
            const when = moments.find(([value]) => value === moment.value)?.[1] || '';
            const day = days[Number(weekday.value)];
            if (repeat.value === 'week') return text(`Chaque ${day}, ${when}.`, `Every ${day} ${when}.`);
            if (repeat.value === 'day') return text(`Chaque jour, ${when}.`, `Every day ${when}.`);
            if (repeat.value === 'once') return text('Une seule fois.', "Runs once.");
            if (repeat.value === 'manual') return text('Quand vous le demandez.', "Runs when you ask.");
            return text('Selon l’expression que vous écrivez.', "Runs according to the schedule you enter.");
        }
        function syncSchedule() {
            showScheduleRows();
            sentence.textContent = describe();
            if (repeat.value === 'cron') return;
            interval.value = '';
            if (repeat.value === 'manual') { cron.value = ''; at.value = ''; return; }
            const hour = moment.value;
            if (repeat.value === 'once') {
                cron.value = '';
                if (!at.value) {
                    const next = new Date();
                    next.setHours(Number(hour), 0, 0, 0);
                    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
                    at.value = dateInput(next);
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
            end.value = dateInput(task?.endsAt);
            at.value = dateInput(task?.runAt);
            syncSchedule();
            if (repeat.value === 'cron' && task?.cron) cron.value = task.cron;
            if (task?.intervalMinutes) interval.value = String(task.intervalMinutes);
            if (task?.runAt) at.value = dateInput(task.runAt);
        }
        repeat.addEventListener('change', () => { at.value = ''; syncSchedule(); });
        for (const control of [weekday, moment]) control.addEventListener('change', syncSchedule);
        ending.addEventListener('change', () => {
            endDateRow.hidden = ending.value !== 'date';
            end.required = !endDateRow.hidden;
        });
        readSchedule(null);
        const footer = node('div', undefined, 'auto-footer');
        const resume = button(text('Reprendre', "Resume"), () => { if (!editingTask) return; view.run(async () => { await request(`/api/tasks/${encodeURIComponent(editingTask.id)}`, 'PATCH', { enabled: true }); await tasks(); }); });
        resume.type = 'button'; resume.className = 'auto-resume'; resume.hidden = true;
        const submitTask = node('button', text('Enregistrer', "Save")); submitTask.type = 'submit'; submitTask.className = 'auto-save';
        footer.append(resume, submitTask); create.append(node('small', text('Le dossier, les permissions et le modèle déjà choisis sont conservés.', "The selected folder, permissions and model are kept.")), footer);
        const createBox=node('details',undefined,'ui-create-box auto-sheet');createBox.open=!result.tasks.length;createBox.append(node('summary',text('Nouvelle automatisation', "New automation")),create);
        body.append(createBox);
        const paintStatus = () => {
            const paused = editingTask ? editingTask.enabled === false : false;
            statusLine.textContent = editingTask ? (paused ? text('En pause', "Paused") : text('Active', "Enabled")) : text('Nouvelle', "New");
            statusLine.setAttribute('data-state', paused ? 'paused' : 'active');
            resume.hidden = !paused;
        };
        paintStatus();
        const statuses = {
            running: text('En cours', 'Running'),
            waiting: text('En attente d’une décision', 'Waiting for a decision'),
            interrupted: text('Interrompue', 'Interrupted'),
            completed: text('Terminée', 'Completed'),
            failed: text('À vérifier', 'Failed'),
            cancelled: text('Arrêtée', 'Stopped'),
            idle: text('Prête', 'Ready'),
        };
        for (const task of result.tasks) {
            const card = node('article', undefined, 'collab-card auto-card'); card.append(node('strong', task.title), node('p', task.prompt));
            const rhythm = task.cron || (task.intervalMinutes
                ? text(`Toutes les ${task.intervalMinutes} min`, `Every ${task.intervalMinutes} min`)
                : task.runAt ? text('Une fois', 'Once') : text('Sur demande', 'On demand'));
            const status = statuses[task.status] || text('Prête', 'Ready');
            const paused = task.enabled === false ? ` · ${text('Planification en pause', 'Schedule paused')}` : '';
            const nextRun = task.nextRunAt ? ' · ' + new Date(task.nextRunAt).toLocaleString(state.language) : '';
            card.append(node('small', `${status}${paused} · ${rhythm}${nextRun}`));
            if (task.lastError) card.append(node('p', String(task.lastError), 'collab-error'));
            if (task.pending) {
                card.append(node('p', task.pending.summary || task.pending.content || text('Une décision est nécessaire pour continuer.', "A decision is required to continue.")));
                card.append(button(text('Répondre à la demande', "Respond"), () => view.run(async () => {
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
            actions.append(button(text('Modifier', 'Edit'), () => {
                createBox.open = true;
                editingTask = task;
                title.value = task.title;
                prompt.value = task.prompt;
                project.value = task.root;
                interval.value = task.intervalMinutes || '';
                cron.value = task.cron || '';
                readSchedule(task);
                paintStatus();
                title.focus();
            }), button(text('Exécuter', 'Run'), () => mutation('/run')), button(task.enabled ? text('Mettre en pause', 'Pause') : text('Reprendre', 'Resume'), () => mutation('', 'PATCH', { enabled: !task.enabled })), button(text('Arrêter', 'Stop'), () => mutation('/cancel')), button(text('Supprimer', 'Delete'), () => view.run(async () => {
                if (await confirm(view, task.title, { title: text('Supprimer cette tâche ?', "Delete this task?"), danger: true })) await mutation('', 'DELETE');
            })));
            card.append(actions); body.append(card);
        }
    }
    async function memory(query = '') {
        const restoreFocus = document.activeElement === body.querySelector('input[type=search]');
        const current = ++generation;
        const result = await request(`/api/knowledge?root=${encodeURIComponent(root())}&q=${encodeURIComponent(query)}`); if (current !== generation) return;
        body.replaceChildren();
        introduction(text('Ce que votre assistant retient', "What your assistant remembers"),text('Gardez les préférences et les informations utiles pour vos prochaines conversations.', "Save preferences and information for future conversations."));
        const filters = node('div'); const search = field(filters, text('Rechercher dans la mémoire', "Search memory"), 'search', query);
        let debounce; search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => view.run(() => memory(search.value)), 400); }); body.append(filters);
        if (restoreFocus) { search.focus(); search.setSelectionRange(query.length, query.length); }
        let editingId = null;
        const create = form(async () => { await request(editingId ? `/api/knowledge/${encodeURIComponent(editingId)}` : '/api/knowledge', editingId ? 'PATCH' : 'POST', { root: project.value, title: title.value, content: content.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean) }); await memory(query); });
        const title = field(create, text('Titre', "Title")); title.required = true;
        const content = field(create, text('Information durable', "Information to remember"), 'textarea'); content.required = true;
        const tags = field(create, text('Étiquettes séparées par des virgules', "Comma-separated tags"));
        const project = field(create, text('Projet (vide pour une mémoire globale)', "Project (leave blank for global memory)"), 'text', root());
        const submitMemory = saveButton(create, text('Mémoriser', "Remember")); body.append(create);
        for (const record of result.records) {
            const card = node('article', undefined, 'collab-card'); card.append(node('strong', record.title), node('p', record.content), node('small', (record.tags || []).join(', ')));
            card.append(button(text('Modifier', "Edit"), () => { title.value = record.title; content.value = record.content; tags.value = (record.tags || []).join(', '); project.value = record.root || ''; submitMemory.textContent = text('Enregistrer les modifications', "Save changes"); title.focus(); editingId = record.id; }));
            card.append(button(text('Supprimer', "Delete"), () => view.run(async () => {
                if (await confirm(view, record.title, { title: text('Supprimer ce souvenir ?', "Delete this memory?"), danger: true })) {
                    await request(`/api/knowledge/${encodeURIComponent(record.id)}`, 'DELETE'); await memory(query);
                }
            })));
            body.append(card);
        }
        if (!result.records.length) body.append(node('p', text('Aucun souvenir enregistré pour ce projet.', "No memories stored for this project.")));
    }
    async function tools(query = '') {
        const restoreFocus = document.activeElement === body.querySelector('input[type=search]');
        const current = ++generation;
        const result = await request(`/api/tools?root=${encodeURIComponent(root())}&q=${encodeURIComponent(query)}`); if (current !== generation) return;
        body.replaceChildren();introduction(text('Les outils de votre assistant', "Assistant tools"),text('Découvrez ce qu’il peut faire. Ouvrez un outil pour consulter ses détails.', "Open a tool to see what it does.")); const filters = node('div'); const search = field(filters, text('Rechercher un outil', "Find a tool"), 'search', query);
        let debounce; search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => view.run(() => tools(search.value)), 400); }); body.append(filters);
        if (restoreFocus) { search.focus(); search.setSelectionRange(query.length, query.length); }
        for (const tool of result.tools) {
            const card = node('details', undefined, 'collab-card'); card.append(node('summary', tool.name || tool.id), node('p', tool.description || ''));
            card.append(node('pre', JSON.stringify(tool.input_schema || tool.parameters || tool.inputSchema || tool.schema || {}, null, 2))); body.append(card);
        }
        if (!result.tools.length) body.append(node('p', text('Aucun outil ne correspond à cette recherche.', "No tools match your search.")));
    }
    const refresh = () => { view.status.textContent = ''; return ({ tasks, memory, tools }[section])(); };
    const open = () => { if (!view.el.open) view.el.showModal(); view.run(refresh); };
    const launcher = launch('Tâches et mémoire', () => view.el.open ? view.el.close() : open());
    function localize() {
        const title = text('Centre de travail', 'Work center');
        view.heading.textContent = title;
        view.close.textContent = text('Fermer', 'Close');
        tabs.setAttribute('aria-label', title);
        if (launcher) {
            const label = text('Tâches et mémoire', 'Tasks and memory');
            launcher.title = label;
            launcher.setAttribute('aria-label', label);
            launcher.querySelector('span').textContent = label;
        }
        tabs.replaceChildren();
        for (const [key, label] of [['tasks', text('Tâches', 'Tasks')], ['memory', text('Mémoire générale', 'General memory')], ['tools', text('Outils', 'Tools')]]) {
            const control = button(label, () => {
                section = key;
                for (const tab of tabs.querySelectorAll('[aria-pressed]')) tab.setAttribute('aria-pressed', String(tab === control));
                view.run(refresh);
            });
            control.setAttribute('aria-pressed', String(key === section));
            tabs.append(control);
        }
        tabs.append(button(text('Actualiser', 'Refresh'), () => view.run(refresh)));
    }
    localize();
    document.addEventListener('zaalis-language-changed', () => {
        localize();
        if (view.el.open) view.run(refresh);
    });
    window.ZaalisTaskCenter = { open, refresh };
})();
