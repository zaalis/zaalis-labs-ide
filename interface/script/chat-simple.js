/* Chat-first shell. In the Chat layout the conversation is the only permanent
 * surface: the tool rail is replaced by one "Outils" menu, and an empty chat
 * offers a few starting points. Every entry drives a control that already
 * exists, so panels, shortcuts and the editor layout keep their behaviour. */
(() => {
    'use strict';
    const { node, text } = window.ZaalisUI;
    const right = document.querySelector('.topbar-right'), rail = document.querySelector('.workspace-rail');
    const workspace = window.ZaalisWorkspace, view = document.getElementById('view-chat'), chat = document.getElementById('chat-messages');
    if (!right || !rail || !workspace || !view || !chat) return;
    const svg = paths => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const ICONS = {
        tools: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
        editor: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>',
        models: '<path d="m12 3 9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        machine: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
        pointer: '<path d="m5 3 14 8-6 2-2 6z"/>',
        document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
    };
    const railTools = () => [...rail.querySelectorAll('.ws-rail-button:not(#workspace-tools-toggle)')];
    const labelOf = control => control.getAttribute('aria-label') || control.title || control.textContent.trim();
    // The rail keeps working while hidden; a rail the user had folded away is unfolded first.
    function openTool(control) {
        if (document.body.classList.contains('ui-tools-collapsed')) document.getElementById('workspace-tools-toggle')?.click();
        if (control.getAttribute('aria-expanded') !== 'true') control.click();
    }

    // ---- "Outils" menu -------------------------------------------------
    const trigger = node('button', 'cs-tools-trigger'); trigger.type = 'button'; trigger.id = 'chat-tools-btn';
    trigger.innerHTML = svg(ICONS.tools); trigger.append(node('span', '', text('Outils', 'Tools')));
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    const menu = node('div', 'ui-action-menu cs-tools-menu'); menu.id = 'chat-tools-menu'; menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', text('Outils', 'Tools')); menu.popover = 'auto';
    function item(label, iconMarkup, action, current) {
        const control = node('button', 'cs-menu-item'); control.type = 'button'; control.setAttribute('role', 'menuitem');
        const glyph = node('span', 'cs-menu-icon'); glyph.setAttribute('aria-hidden', 'true'); glyph.innerHTML = iconMarkup;
        control.append(glyph, node('span', '', label));
        if (current) control.setAttribute('aria-current', 'true');
        control.addEventListener('click', () => { menu.hidePopover(); action(); });
        return control;
    }
    function fill() {
        menu.replaceChildren();
        for (const control of railTools()) {
            if (control.hidden || control.disabled) continue;
            const icon = control.querySelector('svg');
            menu.append(item(labelOf(control), icon ? icon.outerHTML : svg(ICONS.tools), () => openTool(control), control.getAttribute('aria-expanded') === 'true'));
        }
        menu.append(node('hr', 'cs-menu-rule'));
        menu.append(item(text('Éditeur de code', 'Code editor'), svg(ICONS.editor), () => workspace.setMode('editor')));
        const catalog = document.getElementById('catalog-btn'), help = document.getElementById('help-btn');
        if (catalog) menu.append(item(text('Installer des modèles', 'Install models'), svg(ICONS.models), () => catalog.click()));
        if (help) menu.append(item(text('Aide', 'Help'), svg(ICONS.help), () => help.click()));
    }
    function place() {
        const box = trigger.getBoundingClientRect(), width = Math.min(280, innerWidth - 16);
        menu.style.width = width + 'px';
        menu.style.left = Math.max(8, Math.min(innerWidth - width - 8, box.right - width)) + 'px';
        menu.style.top = box.bottom + 6 + 'px';
    }
    trigger.addEventListener('click', () => { if (menu.matches(':popover-open')) menu.hidePopover(); else { fill(); menu.showPopover(); place(); menu.querySelector('button')?.focus(); } });
    menu.addEventListener('toggle', event => { const open = event.newState === 'open'; trigger.setAttribute('aria-expanded', String(open)); if (!open && menu.contains(document.activeElement)) trigger.focus(); });
    menu.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        event.preventDefault(); items[next]?.focus();
    });
    addEventListener('resize', () => { if (menu.matches(':popover-open')) place(); });
    right.prepend(trigger); document.body.append(menu);
    window.ZaalisCommands?.register('tools-menu', text('Outils', 'Tools'), () => { if (workspace.mode !== 'chat') workspace.setMode('chat'); trigger.click(); });

    // ---- Starting points under an empty chat ---------------------------
    const input = document.getElementById('chat-input');
    function draft(value) {
        if (!input) return;
        input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus(); input.setSelectionRange(value.length, value.length);
    }
    const starters = node('div', 'cs-starters'); starters.setAttribute('role', 'group'); starters.setAttribute('aria-label', text('Pour commencer', 'Starting points'));
    const starter = (label, iconMarkup, action) => { const control = node('button', 'cs-starter'); control.type = 'button'; control.innerHTML = svg(iconMarkup); control.append(node('span', '', label)); control.addEventListener('click', action); return control; };
    starters.append(
        starter(text('Ouvrir un projet', 'Open a project'), ICONS.folder, () => (document.getElementById('open-project-btn') || document.getElementById('project-btn'))?.click()),
        starter(text('Tester dans une machine virtuelle', 'Test in a virtual machine'), ICONS.machine, () => { const vm = railTools().find(control => labelOf(control) === text('Machines virtuelles', 'Virtual machines')); if (vm) openTool(vm); }),
        starter(text('Faire une tâche sur mon PC', 'Do a task on my PC'), ICONS.pointer, () => draft(text('Sur mon PC, ', 'On my PC, '))),
        starter(text('Créer un document', 'Create a document'), ICONS.document, () => draft(text('Crée un document sur ', 'Create a document about ')))
    );
    view.append(starters);
    // CSS centres the composer while the launch greeting is the only content.
    const sync = () => { view.classList.toggle('cs-empty', !!chat.querySelector('[data-launch-welcome]')); };
    new MutationObserver(sync).observe(chat, { childList: true }); sync();
    window.ZaalisUI.accessibility?.(right);
})();
