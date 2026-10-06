/* Persistent project experiences, shared by Chat IDE and Editor. */
(() => {
    let dialog, root, offset = 0;
    const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
    async function api(body, query = '') {
        const response = await fetch(body ? '/api/memory' : `/api/memory?root=${encodeURIComponent(root)}${query}`, body ? {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, root })
        } : undefined);
        const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
    }
    const button = (text, action) => { const b = node('button', text); b.type = 'button'; b.className = 'btn btn-secondary'; b.onclick = action; return b; };
    window.openCorrectionMemory = async () => {
        root = state.projectRoot;
        if (!root) { showToast('Mémoire des corrections', 'Ouvre un projet pour consulter sa mémoire.'); return; }
        offset = 0;
        if (!dialog) { dialog = node('dialog'); dialog.className = 'correction-memory-dialog'; document.body.append(dialog); }
        dialog.replaceChildren();
        const heading = node('header'), title = node('h2', 'Mémoire des corrections');
        heading.append(title, button('Fermer', () => dialog.close())); dialog.append(heading);
        dialog.append(node('p', 'Les expériences sont conservées sur ce PC pour ce compte. Les vérifications enregistrées restent à revalider sur le code actuel.'));
        const error = node('p'); error.setAttribute('role', 'status');
        const controls = node('div'), records = node('div'), search = node('input');
        search.type = 'search'; search.placeholder = 'Rechercher un problème, une solution…'; search.setAttribute('aria-label', 'Rechercher dans la mémoire');
        dialog.append(controls, search, records, error);
        const safe = fn => async () => { try { error.textContent = ''; await fn(); } catch (e) { error.textContent = e.message; } };
        async function render() {
            const data = await api(null, `&q=${encodeURIComponent(search.value)}&offset=${offset}`);
            controls.replaceChildren();
            for (const [key, label] of [['enabled', 'Mémoire activée pour ce projet'], ['crossProject', 'Consulter aussi les fiches partagées des autres projets']]) {
                const wrap = node('label'), check = node('input'); check.type = 'checkbox'; check.checked = data.settings[key];
                check.onchange = safe(async () => { await api({ action: 'settings', settings: { [key]: check.checked } }); await render(); });
                wrap.append(check, document.createTextNode(label)); controls.append(wrap);
            }
            records.replaceChildren(node('p', `${data.total} fiche(s) · vérifié = checks réussis, tentative = validation incomplète`));
            controls.append(button('Ajouter une note', safe(async () => {
                const form = node('form'), problem = node('input'), summary = node('textarea');
                problem.placeholder = 'Problème'; problem.required = true; problem.setAttribute('aria-label', 'Problème');
                summary.placeholder = 'Cause ou solution'; summary.required = true; summary.setAttribute('aria-label', 'Cause ou solution');
                const submit = node('button', 'Enregistrer'); submit.type = 'submit'; submit.className = 'btn btn-primary';
                form.append(problem, summary, submit, button('Annuler', () => form.remove())); records.prepend(form); problem.focus();
                form.onsubmit = event => { event.preventDefault(); safe(async () => { await api({action:'save',problem:problem.value,summary:summary.value}); await render(); })(); };
            })));
            for (const r of data.records) {
                const card = node('details'), label = node('summary', `${r.status === 'verified' ? 'Vérifié' : r.status === 'note' ? 'Note' : 'Tentative'} · ${r.problem || 'Correction'} · ${r.project}`);
                card.append(label, node('p', new Date(r.updatedAt).toLocaleString()), node('pre', r.summary), node('pre', r.cause));
                if (r.checks.length) card.append(node('pre', r.checks.map(c => `${c.passed ? '✓' : '?'} ${c.command} · code ${c.exitCode ?? '?'}`).join('\n')));
                if (r.sameProject) {
                    const edit = node('textarea'); edit.value = r.summary; edit.setAttribute('aria-label', 'Modifier la fiche');
                    const share = node('input'); share.type = 'checkbox'; share.checked = r.shared; const shareLabel = node('label'); shareLabel.append(share, document.createTextNode('Partager cette fiche entre mes projets'));
                    card.append(edit, shareLabel, button('Enregistrer', safe(async () => { await api({ action:'save',id:r.id,summary:edit.value,shared:share.checked }); await render(); })),
                        button('Supprimer', safe(async () => { await api({action:'delete',id:r.id}); await render(); })));
                }
                records.append(card);
            }
            const pages = node('footer');
            if (offset) pages.append(button('Précédent', safe(async () => { offset = Math.max(0,offset-50); await render(); })));
            if(offset+50<data.total) pages.append(button('Suivant', safe(async () => {offset+=50; await render();})));
            records.append(pages);
        }
        search.onchange = safe(async () => { offset = 0; await render(); });
        dialog.showModal(); await safe(render)();
    };
})();
