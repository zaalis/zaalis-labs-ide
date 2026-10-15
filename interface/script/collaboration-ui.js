/* Shared DOM helpers for the optional workspace panels. Content from APIs is
 * always textContent; no server text is interpreted as HTML. */
(() => {
    'use strict';
    const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
    const button = (text, action) => { const el = node('button', text); el.type = 'button'; el.addEventListener('click', action); return el; };
    async function request(path, method = 'GET', body) {
        const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
        return data;
    }
    function dialog(title) {
        const el = node('dialog', undefined, 'collab-dialog');
        const header = node('header'); header.append(node('h2', title), button('Fermer', () => el.close()));
        const status = node('p', '', 'collab-status'); status.setAttribute('role', 'status');
        const content = node('div', undefined, 'collab-content'); el.append(header, status, content); document.body.append(el);
        el.addEventListener('click', event => { if (event.target === el) { const rect = el.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) el.close(); } });
        return { el, content, status, async run(action) { status.textContent = ''; try { return await action(); } catch (error) { status.textContent = error.message; return undefined; } } };
    }
    function field(form, label, type = 'text', value = '') {
        const wrap = node('label', label); const input = node(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') input.type = type;
        input.value = value; wrap.append(input); form.append(wrap); return input;
    }
    function launch(label, open) {
        const toolbar = document.querySelector('.topbar-left'); if (!toolbar) return;
        const control = button('', open); control.className = 'collab-launch'; control.title = label; control.setAttribute('aria-label', label);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', label === 'Historique' ? 'M3 11a9 9 0 1 1 2.7 6.4M3 4v7h7M12 7v5l3 2' : 'M4 4h16v16H4zM8 9l2 2 4-4M8 16h8');
        icon.append(path); control.append(icon, node('span', label)); toolbar.append(control);
    }
    async function confirm(view, title, options) {
        view.el.close();
        try { return await customConfirm(title, options); }
        finally { view.el.showModal(); }
    }
    window.ZaalisCollabUI = { node, button, request, dialog, field, launch, confirm };
})();
