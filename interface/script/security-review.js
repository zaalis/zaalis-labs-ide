// ==========================================================
//  CENTRAL SECURITY REVIEW WORKSPACE
// ==========================================================
// A dedicated editor tab, not a chat card: it follows the durable server-side
// review job over SSE and leaves files one click away throughout the analysis.
(() => {
    const TAB = '__security_review__';
    let stream = null;
    let chatSaveTimer = null;
    const seenChatEvents = new Set();
    const $review = (id) => document.getElementById(id);
    const escape = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
    const labelForStatus = (status) => ({ starting: 'Démarrage', running: 'En cours', completed: 'Terminé', cancelled: 'Annulé', cancelling: 'Annulation…', failed: 'Échec' }[status] || 'En attente');
    const stageLabel = (review) => (review.stages || []).find((stage) => stage.id === review.stage)?.label || 'Préparation de la revue';

    function stopStream() {
        if (stream) { stream.close(); stream = null; }
    }

    function current() { return state.securityReview && state.securityReview.data; }

    function queueChatSave() {
        clearTimeout(chatSaveTimer);
        chatSaveTimer = setTimeout(() => { if (typeof saveConversation === 'function') saveConversation('chat'); }, 350);
    }

    function appendChatActivity(event) {
        const eventId = String(event && event.id || '');
        const activity = String(event && event.activity || '').trim();
        if (!activity || (eventId && seenChatEvents.has(eventId))) return;
        if (eventId) { seenChatEvents.add(eventId); if (seenChatEvents.size > 100) seenChatEvents.delete(seenChatEvents.values().next().value); }
        const chat = document.getElementById('chat-messages');
        if (!chat || typeof addMsg !== 'function') return;
        const body = addMsg(chat, 'ai', 'Sécurité', activity);
        const message = body.closest('.msg');
        if (message) message.classList.add('security-review-chat-event', `security-review-chat-${String(event.type || 'progress')}`);
        queueChatSave();
    }

    function setReview(review) {
        if (!review) return;
        state.securityReview = { ...(state.securityReview || {}), open: true, id: review.id, data: review };
        renderSecurityReview();
        if (typeof renderTabs === 'function') renderTabs();
    }

    function renderAgents(review) {
        const host = $review('security-review-agent-list'); if (!host) return;
        const agents = review.agents || [];
        $review('security-review-agent-count').textContent = String(agents.length);
        if (!agents.length) { host.innerHTML = '<p class="security-review-empty">Les sous-agents seront lancés étape par étape.</p>'; return; }
        host.innerHTML = agents.map((agent) => `<div class="security-review-agent ${escape(agent.status)}">
            <span class="security-review-agent-dot"></span><div class="security-review-agent-body"><strong>${escape(agent.label)}</strong><span>${escape(agent.stage || '')} · ${escape(labelForStatus(agent.status))}</span></div><span class="security-review-agent-findings">${Number(agent.findings || 0)}</span>
        </div>`).join('');
    }

    function renderFindings(review) {
        const host = $review('security-review-finding-list'); if (!host) return;
        const result = review.result || {}; const findings = Array.isArray(result.findings) ? result.findings : [];
        const summary = result.summary || {};
        $review('security-review-summary').textContent = findings.length ? `${summary.total || findings.length} à examiner` : '';
        if (!findings.length) {
            host.innerHTML = `<p class="security-review-empty">${review.status === 'completed' ? 'Aucun constat candidat.' : 'Les résultats apparaîtront après la revue du code.'}</p>`;
            return;
        }
        host.innerHTML = findings.slice(0, 8).map((finding, index) => `<button class="security-review-finding" type="button" data-review-finding="${index}">
            <span class="security-review-severity ${escape(finding.severity || 'low')}">${escape(String(finding.severity || 'info').toUpperCase())}</span><span class="security-review-finding-path">${escape(finding.file || '—')}:${escape(finding.line || '—')}</span><span class="security-review-finding-message">${escape(finding.message || finding.rule || '')}</span>
        </button>`).join('');
        host.querySelectorAll('[data-review-finding]').forEach((button) => button.addEventListener('click', () => {
            const finding = findings[Number(button.dataset.reviewFinding)];
            if (!finding || !finding.file || typeof openFile !== 'function') return;
            const name = String(finding.file).split('/').pop() || finding.file;
            openFile(finding.file, name);
        }));
    }

    function renderSecurityReview() {
        const review = current(); if (!review) return;
        const title = $review('security-review-stage-title'); const meta = $review('security-review-meta');
        const progress = $review('security-review-progress'); const progressBar = $review('security-review-progress-bar');
        const currentStage = $review('security-review-current-stage'); const stageList = $review('security-review-stage-list');
        const spinner = $review('security-review-spinner'); const cancel = $review('security-review-cancel');
        if (!title || !stageList) return;
        const stages = review.stages || [];
        const done = stages.filter((stage) => stage.status === 'completed').length;
        const active = stages.some((stage) => stage.status === 'active') ? .5 : 0;
        const percent = stages.length ? Math.min(100, Math.round(((done + active) / stages.length) * 100)) : 0;
        const result = review.result || {}; const summary = result.summary || {};
        const hasFindings = Number(summary.total || 0) > 0;
        title.textContent = review.status === 'completed'
            ? (hasFindings ? `Review terminée — ${summary.total} constat(s) à examiner` : 'Review terminée sans constat')
            : review.status === 'cancelled' ? 'Review annulée' : review.status === 'failed' ? 'Review interrompue' : stageLabel(review);
        meta.textContent = `${state.projectRoot ? state.projectRoot.split(/[\\/]/).pop() : 'Projet'} · ${String(review.workflow || 'scan').toUpperCase()} · ${review.id.slice(-10)}`;
        progress.textContent = review.status === 'completed' ? '100 %' : `${percent} %`;
        $review('security-review-findings').textContent = review.status === 'completed' ? (hasFindings ? `${summary.total} à examiner` : 'Aucun') : 'En analyse';
        currentStage.textContent = review.status === 'running' ? 'Étape courante' : labelForStatus(review.status);
        progressBar.style.width = `${review.status === 'completed' ? 100 : percent}%`;
        spinner.className = `security-review-spinner ${review.status === 'completed' ? 'done' : ['cancelled', 'failed'].includes(review.status) ? 'idle' : ''} ${review.status === 'completed' && hasFindings ? 'warning' : ''}`;
        progressBar.classList.toggle('warning', review.status === 'completed' && hasFindings);
        stageList.classList.toggle('has-findings', review.status === 'completed' && hasFindings);
        const workspace = $review('security-review-workspace');
        if (workspace) workspace.classList.toggle('has-findings', review.status === 'completed' && hasFindings);
        cancel.classList.toggle('hidden', !['starting', 'running', 'cancelling'].includes(review.status));
        stageList.innerHTML = stages.map((stage) => `<li class="security-review-stage ${escape(stage.status || 'pending')}"><span class="security-review-stage-dot"></span><span class="security-review-stage-label">${escape(stage.label)}<small>${stage.status === 'active' ? 'Sous-agent en cours' : stage.status === 'completed' ? 'Terminé' : 'En attente'}</small></span></li>`).join('');
        renderAgents(review); renderFindings(review);
    }

    async function refreshReview(id) {
        const response = await fetch(`/api/security/reviews/${encodeURIComponent(id)}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.review) throw new Error(data.error || 'Review sécurité introuvable.');
        setReview(data.review); return data.review;
    }

    function connectReview(id) {
        stopStream();
        stream = new EventSource(`/api/security/reviews/${encodeURIComponent(id)}/stream`);
        stream.addEventListener('review', (event) => {
            try {
                const value = JSON.parse(event.data || '{}');
                appendChatActivity(value);
                if (value.snapshot) setReview(value.snapshot);
                const review = current();
                if (review && ['completed', 'cancelled', 'failed'].includes(review.status)) stopStream();
            } catch {}
        });
        stream.onerror = () => {
            // EventSource retries itself. The explicit refresh keeps the UI
            // informative if the server was restarted between two events.
            setTimeout(() => { if (state.securityReview && state.securityReview.id === id) refreshReview(id).catch(() => {}); }, 700);
        };
    }

    async function openSecurityReview({ workflow = 'scan' } = {}) {
        if (!state.projectRoot) throw new Error('Ouvrez un projet avant de lancer une review sécurité.');
        const response = await fetch('/api/security/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            root: state.projectRoot, workflow, source: 'slash',
            model: typeof modelSelect !== 'undefined' ? modelSelect.value : state.config.aiModel,
            submodel: typeof submodelSelect !== 'undefined' ? submodelSelect.value : state.config.aiSubmodel,
            reasoningLevel: state.reasoningLevel || 0, permissionMode: state.permissionMode,
            config: { ...(state.config || {}), keys: undefined }
        }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.review) throw new Error(data.error || 'Impossible de lancer la review sécurité.');
        const previousFile = state.activeFile && state.activeFile !== TAB ? state.activeFile : null;
        seenChatEvents.clear();
        state.securityReview = { open: true, id: data.review.id, previousFile, data: data.review };
        state.activeFile = TAB;
        renderSecurityReview(); if (typeof renderTabs === 'function') renderTabs(); connectReview(data.review.id);
        return data.review;
    }

    async function openExistingSecurityReview(id) {
        const previousFile = state.activeFile && state.activeFile !== TAB ? state.activeFile : null;
        const review = await refreshReview(id);
        state.securityReview = { open: true, id: review.id, previousFile, data: review };
        state.activeFile = TAB;
        renderSecurityReview(); if (typeof renderTabs === 'function') renderTabs(); connectReview(review.id);
    }

    async function cancelSecurityReview() {
        const review = current(); if (!review || !review.id) return;
        const response = await fetch(`/api/security/reviews/${encodeURIComponent(review.id)}/cancel`, { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Impossible d’annuler la review.');
        if (data.review) setReview(data.review);
    }

    function closeSecurityReview() {
        stopStream();
        const previous = state.securityReview && state.securityReview.previousFile;
        state.securityReview = { open: false, id: null, previousFile: null, data: null };
        state.activeFile = previous && state.openFiles[previous] ? previous : (Object.keys(state.openFiles)[0] || null);
        if (typeof renderTabs === 'function') renderTabs();
    }

    window.openSecurityReview = openSecurityReview;
    window.openExistingSecurityReview = openExistingSecurityReview;
    window.closeSecurityReview = closeSecurityReview;
    window.renderSecurityReview = renderSecurityReview;
    document.addEventListener('DOMContentLoaded', () => {
        $review('security-review-cancel')?.addEventListener('click', () => cancelSecurityReview().catch((error) => alert(error.message)));
    });
})();
