/* Durable view model for native root agents and delegated children. */
(() => {
    'use strict';
    const terminal = state => ['done', 'failed', 'cancelled'].includes(state);
    const stateName = value => typeof value === 'string' ? value : value?.state;
    function update(agents, frame, sessionId, now = Date.now()) {
        const id = String(frame.agent_id || frame.agentId || frame.agent?.id || '');
        if (!id) return;
        let agent = agents.find(item => item.id === id && item.sessionId === sessionId);
        if (!agent && ['agent_spawned', 'agent_state_changed', 'agent_state'].includes(frame.type)) {
            agent = { id, sessionId, label: 'Assistant', state: 'pending', startedAt: new Date(now).toISOString(), report: '' };
            agents.push(agent);
        }
        if (!agent) return;
        if (frame.type === 'agent_spawned') {
            const node = frame.agent;
            agent.parentId = node.parent_id || null;
            agent.label = node.role?.label || node.role?.name || (agent.parentId ? 'Sous-agent' : 'Assistant');
            agent.objective = node.objective || '';
            agent.state = stateName(node.state) || agent.state;
            if (node.started_at_ms || node.created_at_ms) agent.startedAt = new Date(node.started_at_ms || node.created_at_ms).toISOString();
            if (node.finished_at_ms) agent.finishedAt = new Date(node.finished_at_ms).toISOString();
            if (node.state?.error) agent.error = node.state.error;
        }
        if (frame.state) {
            agent.state = stateName(frame.state) || agent.state;
            if (frame.state.error) agent.error = frame.state.error;
        }
        if (frame.type === 'text_delta') agent.report = (agent.report + (frame.text || '')).slice(-100000);
        if (frame.type === 'agent_completed') { agent.state = 'done'; agent.report = frame.report?.summary || agent.report; }
        if (frame.type === 'agent_failed') { agent.state = 'failed'; agent.error = frame.error || frame.message; }
        if (frame.type === 'agent_cancelled') agent.state = 'cancelled';
        if (terminal(agent.state)) agent.finishedAt ||= new Date(now).toISOString();
        else delete agent.finishedAt;
        return agent;
    }
    function groups(agents) {
        const children = agents.filter(agent => agent.parentId);
        const recent = list => [...list].sort((a, b) => Date.parse(b.finishedAt || b.startedAt) - Date.parse(a.finishedAt || a.startedAt));
        return { active: recent(children.filter(agent => !terminal(agent.state))), completed: recent(children.filter(agent => terminal(agent.state))), roots: agents.filter(agent => !agent.parentId) };
    }
    function age(value, english, now = Date.now()) {
        const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
        if (!Number.isFinite(seconds) || seconds < 60) return english ? 'just now' : 'à l’instant';
        const amount = seconds < 3600 ? Math.floor(seconds / 60) : seconds < 86400 ? Math.floor(seconds / 3600) : Math.floor(seconds / 86400);
        const unit = seconds < 3600 ? 'min' : seconds < 86400 ? 'h' : english ? 'd' : 'j';
        return english ? `${amount} ${unit} ago` : `il y a ${amount} ${unit}`;
    }
    function render(pane, agents, { el, text, stop }) {
        const expanded = new Set([...pane.querySelectorAll('details')].filter(item => item.open).map(item => item.getAttribute('data-agent-key')));
        pane.replaceChildren();
        const grouped = groups(agents);
        const labels = { pending: text('En attente', 'Queued'), queued: text('En attente', 'Queued'), running: text('En cours', 'Running'), waiting_permission: text('Autorisation requise', 'Approval required'), waiting_budget: text('Budget requis', 'Budget required'), blocked: text('En attente', 'Waiting'), done: text('Terminé', 'Done'), failed: text('Échec', 'Failed'), cancelled: text('Arrêté', 'Stopped') };
        function card(agent) {
            const item = el('details', 'ws-agent-run'), summary = el('summary');
            const key = `${agent.sessionId || ''}:${agent.id}`;
            item.setAttribute('data-agent-key', key); item.open = expanded.has(key);
            const icon = el('span', 'ws-agent-avatar'); icon.setAttribute('aria-hidden', 'true');
            let hash = 0; for (const ch of agent.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
            icon.setAttribute('style', `--agent-hue:${hash % 360}`);
            const name = el('strong', 'ws-agent-name', agent.label);
            summary.append(icon, name, el('span', `ws-agent-status ws-status-${agent.state}`, labels[agent.state] || agent.state));
            const time = el('time', 'ws-agent-age', age(agent.finishedAt || agent.startedAt, text(false, true)));
            time.setAttribute('datetime', agent.finishedAt || agent.startedAt); summary.append(time); item.append(summary);
            if (agent.objective) item.append(el('p', 'ws-meta', agent.objective));
            if (agent.report) item.append(el('pre', 'ws-agent-report', agent.report));
            if (agent.error) item.append(el('p', 'ws-error', String(agent.error)));
            if (!terminal(agent.state)) {
                const cancel = el('button', 'ws-button', agent.parentId ? text('Arrêter cet agent', 'Stop this agent') : text('Arrêter la session', 'Stop session'));
                cancel.type = 'button'; cancel.addEventListener('click', () => stop(agent)); item.append(cancel);
            }
            return item;
        }
        for (const [title, list, empty] of [
            [text('Actifs', 'Active'), grouped.active, text('Aucun sous-agent actif', 'No active subagents')],
            [text('Terminés', 'Completed'), grouped.completed, text('Aucun sous-agent terminé', 'No completed subagents')],
        ]) {
            const section = el('section', 'ws-agent-group'); section.setAttribute('aria-label', title);
            section.append(el('h3', 'ws-agent-group-title', `${title} · ${list.length}`));
            if (!list.length) section.append(el('p', 'ws-meta', empty));
            for (const agent of list) section.append(card(agent));
            pane.append(section);
        }
        if (grouped.roots.length) {
            const section = el('section', 'ws-agent-group'); section.append(el('h3', 'ws-agent-group-title', text('Assistant principal', 'Main assistant')));
            for (const agent of grouped.roots) section.append(card(agent)); pane.append(section);
        }
    }
    window.ZaalisAgentActivity = { update, groups, render, terminal, age };
})();
