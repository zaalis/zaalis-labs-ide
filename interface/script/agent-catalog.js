// Agent providers and models follow the same catalogue as Chat.
(() => {
    function enhance(card) {
        for (const kind of ['role', 'model']) {
            const select = card.querySelector(`.agent-${kind}-select`);
            select.id ||= `agent-${kind}-${card.dataset.agent.replace(/[^a-z0-9_-]/gi, '-')}`;
            if (!document.getElementById(`custom-select-${select.id}`)) createCustomSelect(select.id, { dropDown: true, viewport: true });
        }
        const check = card.querySelector('.agent-check');
        check.setAttribute('aria-label', (state.language === 'en' ? 'Activate ' : 'Activer ') + card.querySelector('.agent-name').textContent);
    }
    window.refreshAgentCatalog = () => {
        const list = document.getElementById('agents-list');
        const providers = [...document.getElementById('ai-model').options].filter(o => !o.dataset.action && o.value);
        const ids = new Set(providers.map(o => o.value));
        list.querySelectorAll('[data-catalog-agent]').forEach(card => {
            if (!ids.has(card.dataset.agent)) { card.querySelectorAll('select').forEach(s => s._customSelectCleanup?.()); card.remove(); }
        });
        for (const provider of providers) {
            let card = [...list.children].find(c => c.dataset.agent === provider.value);
            if (!card) {
                card = list.querySelector('.agent-card').cloneNode(true);
                card.querySelectorAll('.custom-select-container').forEach(n => n.remove());
                card.dataset.agent = provider.value; card.dataset.catalogAgent = '1';
                card.querySelector('.agent-check').checked = state.config.defaultAgentModel === provider.value;
                card.querySelector('.agent-name').textContent = provider.textContent;
                card.querySelector('.agent-badge').textContent = state.language === 'en' ? 'Idle' : 'Inactif';
                card.querySelectorAll('input,select').forEach(n => { n.dataset.agent = provider.value; n.removeAttribute('id'); });
                card.querySelector('.agent-role-select').value = 'developer';
                list.append(card);
            }
            const models = card.querySelector('.agent-model-select');
            const wanted = models.value;
            const entries = submodelsFor(provider.value);
            if (JSON.stringify([...models.options].map(o => o.value)) !== JSON.stringify(entries.length ? entries : [''])) {
                setAgentModelOptions(models, entries, s => submodelLabelFor(provider.value, s), state.language === 'en' ? 'No model available' : 'Aucun modèle disponible');
                if (entries.includes(wanted)) models.value = wanted;
            }
            models.dataset.allowCustom = provider.value.startsWith('compat:') ? '1' : '';
            enhance(card);
            if (provider.value.startsWith('compat:')) fetchCompatModels(provider.value.slice(7));
        }
        updateLanguage();
    };
    document.addEventListener('zaalis-language-changed', () => {
        document.querySelectorAll('.agent-card').forEach(enhance);
    });
    document.addEventListener('change', event => {
        if (event.target.matches('.agent-model-select') && event.target.dataset.agent.startsWith('compat:')) {
            rememberCompatModel(event.target.dataset.agent, event.target.value);
            saveState();
        }
    });
    document.getElementById('agents-list').addEventListener('scroll', closeAllCustomSelects, { passive: true });
    window.addEventListener('resize', closeAllCustomSelects);
})();
