/* Persistent project experiences, shared by Chat IDE and Editor. */
(() => {
    let dialog, root, offset = 0;
    const copy = (fr, en) => state.language === 'en' ? en : fr;
    const node = (tag, text) => { const n = document.createElement(tag); if (text) { n.textContent = text; if (!['pre', 'summary'].includes(tag)) { const original = Object.hasOwn(UI_EN, text) ? text : Object.keys(UI_EN).find(key => UI_EN[key] === text); if (original) n.dataset.memoryCopy = original; } } return n; };
    document.addEventListener('zaalis-language-changed', () => {
        if (!dialog) return;
        dialog.querySelectorAll('[data-memory-copy]').forEach(n => { n.textContent = uiText(n.dataset.memoryCopy); });
        dialog.querySelectorAll('input,textarea').forEach(n => { for (const attr of ['placeholder','aria-label']) { const value=n.getAttribute(attr); const original=Object.hasOwn(UI_EN,value)?value:Object.keys(UI_EN).find(key=>UI_EN[key]===value); if(original)n.setAttribute(attr,uiText(original)); } });
        const count = dialog.querySelector('.memory-count'); if(count) count.textContent = countText(Number(count.dataset.total));
    });
    const countText = total => copy(`${total} fiche${total === 1 ? '' : 's'} · Les vérifications concernent le code au moment de leur enregistrement.`, `${total} record${total === 1 ? '' : 's'} · Checks describe the code at the time they were recorded.`);
    async function api(body, query = '') {
        const response = await fetch(body ? '/api/memory' : `/api/memory?root=${encodeURIComponent(root)}${query}`, body ? {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, root })
        } : undefined);
        const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
    }
    const button = (text, action) => { const b = node('button', text); b.type = 'button'; b.className = 'btn btn-secondary'; b.onclick = action; return b; };
    window.openCorrectionMemory = async () => {
        root = state.projectRoot;
        if (!root) { showToast(uiText('Mémoire des corrections'), uiText('Ouvre un projet pour consulter sa mémoire.')); return; }
        offset = 0;
        if (!dialog) { dialog = node('dialog'); dialog.className = 'correction-memory-dialog'; document.body.append(dialog); }
        dialog.replaceChildren();
        const heading = node('header'), title = node('h2', uiText('Mémoire des corrections'));
        dialog.setAttribute('aria-labelledby', 'memory-dialog-title'); title.id = 'memory-dialog-title';
        heading.append(title, button(uiText('Fermer'), () => dialog.close())); dialog.append(heading);
        const intro = node('p', uiText('Les expériences sont conservées sur ce PC pour ce compte. Les vérifications enregistrées restent à revalider sur le code actuel.')); intro.className = 'memory-intro'; dialog.append(intro);
        const error = node('p'); error.setAttribute('role', 'status');
        const controls = node('div'), records = node('div'), search = node('input');
        search.type = 'search'; search.placeholder = uiText('Rechercher un problème, une solution…'); search.setAttribute('aria-label', uiText('Rechercher dans la mémoire'));
        controls.className = 'memory-controls'; records.className = 'memory-records'; error.className = 'memory-status';
        dialog.append(controls, search, records, error);
        const safe = fn => async () => { try { error.textContent = ''; await fn(); } catch (e) { error.textContent = e.message; } };
        async function render() {
            const data = await api(null, `&q=${encodeURIComponent(search.value)}&offset=${offset}`);
            controls.replaceChildren();
            for (const [key, label] of [['enabled', uiText('Mémoire activée pour ce projet')], ['crossProject', uiText('Consulter aussi les fiches partagées des autres projets')]]) {
                const wrap = node('label'), check = node('input'); check.type = 'checkbox'; check.checked = data.settings[key];
                check.onchange = safe(async () => { await api({ action: 'settings', settings: { [key]: check.checked } }); await render(); });
                wrap.append(check, node('span', label)); controls.append(wrap);
            }
            const count = node('p', countText(data.total)); count.className = 'memory-count'; count.dataset.total = data.total; records.replaceChildren(count);
            controls.append(button(uiText('Ajouter une note'), safe(async () => {
                const form = node('form'), problem = node('input'), summary = node('textarea');
                problem.placeholder = uiText('Problème'); problem.required = true; problem.setAttribute('aria-label', uiText('Problème'));
                summary.placeholder = uiText('Cause ou solution'); summary.required = true; summary.setAttribute('aria-label', uiText('Cause ou solution'));
                const submit = node('button', uiText('Enregistrer')); submit.type = 'submit'; submit.className = 'btn btn-primary';
                form.append(problem, summary, submit, button(uiText('Annuler'), () => form.remove())); records.prepend(form); problem.focus();
                form.onsubmit = event => { event.preventDefault(); safe(async () => { await api({action:'save',problem:problem.value,summary:summary.value}); await render(); })(); };
            })));
            if (!data.records.length) { const empty = node('div'); empty.className = 'memory-empty'; empty.append(node('strong', copy('Aucune fiche pour le moment', 'No records yet')), node('p', copy('Ajoutez une note pour retrouver une solution lors de votre prochaine session.', 'Add a note to find a solution again in your next session.'))); records.append(empty); }
            for (const r of data.records) {
                const card = node('details'), label = node('summary', `${r.status === 'verified' ? uiText('Vérifié') : r.status === 'note' ? 'Note' : uiText('Tentative')} · ${r.problem || uiText('Correction')} · ${r.project}`);
                card.append(label, node('p', new Date(r.updatedAt).toLocaleString(state.language === 'en' ? 'en-GB' : 'fr-FR')), node('pre', r.summary), node('pre', r.cause));
                if (r.checks.length) card.append(node('pre', r.checks.map(c => `${c.passed ? '✓' : '?'} ${c.command} · code ${c.exitCode ?? '?'}`).join('\n')));
                if (r.sameProject) {
                    const edit = node('textarea'); edit.value = r.summary; edit.setAttribute('aria-label', uiText('Modifier la fiche'));
                    const share = node('input'); share.type = 'checkbox'; share.checked = r.shared; const shareLabel = node('label'); shareLabel.append(share, document.createTextNode(uiText('Partager cette fiche entre mes projets')));
                    card.append(edit, shareLabel, button(uiText('Enregistrer'), safe(async () => { await api({ action:'save',id:r.id,summary:edit.value,shared:share.checked }); await render(); })),
                        button(uiText('Supprimer'), safe(async () => { await api({action:'delete',id:r.id}); await render(); })));
                }
                records.append(card);
            }
            const pages = node('footer');
            if (offset) pages.append(button(uiText('Précédent'), safe(async () => { offset = Math.max(0,offset-50); await render(); })));
            if(offset+50<data.total) pages.append(button(uiText('Suivant'), safe(async () => {offset+=50; await render();})));
            records.append(pages);
        }
        search.onchange = safe(async () => { offset = 0; await render(); });
        dialog.showModal(); await safe(render)();
    };
})();
