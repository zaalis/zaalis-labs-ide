// Skills share the existing settings surface and chat runtime.
(() => {
    const $id = id => document.getElementById(id);
    const en = () => state.language === 'en';
    const t = (fr, english) => en() ? english : fr;
    const rootQuery = () => state.projectRoot ? '?root=' + encodeURIComponent(state.projectRoot) : '';
    let skills = [], loading = false, requestId = 0;
    const status = (text, error = false) => {
        const el = $id('skills-status'); if (!el) return;
        el.textContent = text; el.classList.toggle('error', error);
    };
    async function api(url, options) {
        const answer = await fetch(url, options);
        const body = await answer.json();
        if (!answer.ok) throw Error(body.error || `HTTP ${answer.status}`);
        return body;
    }
    function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
    function render() {
        const list = $id('skills-list'); if (!list) return;
        list.replaceChildren();
        const query = ($id('skills-filter')?.value || '').toLocaleLowerCase();
        const visible = skills.filter(s => `${s.name} ${s.description}`.toLocaleLowerCase().includes(query));
        if (!visible.length) list.append(element('p', 'form-hint', t('Aucune compétence correspondante.', 'No matching skills.')));
        for (const skill of visible) {
            const row = element('article', 'skill-row');
            const head = element('div', 'skill-row-head');
            const label = element('label', 'skill-toggle');
            const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = skill.enabled;
            toggle.setAttribute('aria-label', t('Activer ', 'Enable ') + skill.name);
            label.append(toggle, element('span', 'skill-name', skill.name));
            const scope = skill.scope === 'builtin' ? t('Intégrée', 'Built in') : skill.scope === 'project' ? t('Projet', 'Project') : t('Personnelle', 'Personal');
            head.append(label, element('span', 'skill-scope', scope));
            row.append(head, element('p', 'form-hint', skill.description));
            const details = document.createElement('details'); details.append(element('summary', '', t('Voir les instructions', 'View instructions')), element('pre', 'skill-instructions', skill.instructions));
            row.append(details);
            const use = element('button', 'btn btn-ghost', t('Utiliser', 'Use')); use.type = 'button'; use.disabled = !skill.enabled;
            use.addEventListener('click', async () => {
                if (typeof chatAbort !== 'undefined' && chatAbort) { status(t('Attendez la fin de la réponse.', 'Wait for the current answer.'), true); return; }
                $id('close-modal')?.click();
                document.querySelector('[data-tab="chat"]')?.click();
                const input = $id('chat-input'); input.value = skill.name === 'revers' ? '/revers ' : `/skill ${skill.name} `; input.dispatchEvent(new Event('input')); input.focus();
            });
            row.append(use);
            toggle.addEventListener('change', async () => {
                toggle.disabled = true;
                try {
                    await api('/api/skills/' + encodeURIComponent(skill.name) + rootQuery(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }) });
                    skill.enabled = toggle.checked; use.disabled = !skill.enabled;
                    status(t('Activation enregistrée. Appliquée au prochain tour.', 'Saved. Applies on the next turn.'));
                } catch (e) { toggle.checked = skill.enabled; status(e.message, true); }
                finally { toggle.disabled = false; }
            });
            list.append(row);
        }
    }
    async function refresh() {
        const id = ++requestId; loading = true;
        $id('skills-list')?.setAttribute('aria-busy', 'true');
        status(t('Chargement…', 'Loading…'));
        try {
            const data = await api('/api/skills' + rootQuery());
            if (id !== requestId) return;
            skills = data.skills || []; render();
            status(data.warnings?.join(' · ') || t(`${skills.length} compétence${skills.length > 1 ? 's' : ''} · projet actif et bibliothèque personnelle`, `${skills.length} skill${skills.length === 1 ? '' : 's'} · active project and personal library`), !!data.warnings?.length);
        } catch (e) { if (id === requestId) status(e.message, true); }
        finally { if (id === requestId) { loading = false; $id('skills-list')?.setAttribute('aria-busy', 'false'); } }
    }
    async function access() {
        try {
            const data = await api('/api/openai/access');
            $id('cyber-program').value = data.program;
            $id('cyber-program')._customSelectRefresh?.();
            const last = data.lastRequest;
            $id('cyber-status').textContent = last ? `${last.model} · ${last.status} · ${t('programme retourné', 'returned program')} : ${last.applied || t('non communiqué', 'not reported')}` : t('Les droits seront vérifiés par OpenAI lors de la requête.', 'OpenAI verifies access when a request is made.');
        } catch (e) { $id('cyber-status').textContent = e.message; }
    }
    function open() {
        const trigger = $id('settings-btn'); trigger?.click();
        document.querySelector('[data-settings-section="skills"]')?.click();
        refresh();
    }
    $id('skills-filter')?.addEventListener('input', render);
    $id('skills-refresh')?.addEventListener('click', refresh);
    document.querySelector('[data-settings-section="skills"]')?.addEventListener('click', refresh);
    document.querySelector('[data-settings-section="api"]')?.addEventListener('click', access);
    $id('skills-import')?.addEventListener('change', async event => {
        const file = event.target.files?.[0]; if (!file) return;
        const button = $id('skills-import'); button.disabled = true;
        try {
            if (file.size > 262144 || !/\.md$/i.test(file.name)) throw Error(t('Choisissez un fichier Markdown de 256 Ko maximum.', 'Choose a Markdown file up to 256 KB.'));
            await api('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instructions: await file.text() }) });
            await refresh();
        } catch (e) { status(e.message, true); }
        finally { button.disabled = false; button.value = ''; }
    });
    $id('cyber-program')?.addEventListener('change', async event => {
        const select = event.target; select.disabled = true;
        try { await api('/api/openai/access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ program: select.value }) }); await access(); }
        catch (e) { await access(); $id('cyber-status').textContent = e.message; }
        finally { select.disabled = false; }
    });
    document.addEventListener('zaalis-language-changed', () => { render(); access(); });
    window.ZaalisSkills = { open, refresh, access, get loading() { return loading; } };
})();
