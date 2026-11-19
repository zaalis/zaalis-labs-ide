/* zaalis Glyphes in the IDE: "Outils › Glyphes" opens the Glyphes app in a
 * large centred window (same app as on the phone, relayed by the local server). */
(() => {
    'use strict';
    const text = (fr, en) => (window.ZaalisUI && window.ZaalisUI.text ? window.ZaalisUI.text(fr, en) : fr);
    // Small Glyph mark (hexagon with two oval eyes) in the current text colour.
    const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 3.5h6.8a2 2 0 0 1 1.7 1l3.4 5.9a2 2 0 0 1 0 2l-3.4 5.9a2 2 0 0 1-1.7 1H8.6a2 2 0 0 1-1.7-1L3.5 12.4a2 2 0 0 1 0-2l3.4-5.9a2 2 0 0 1 1.7-1z"/><ellipse cx="9.6" cy="11.6" rx="1.2" ry="1.8" fill="currentColor" stroke="none"/><ellipse cx="14.4" cy="11.6" rx="1.2" ry="1.8" fill="currentColor" stroke="none"/></svg>';
    let layer = null, frame = null, lastFocus = null;

    function build() {
        layer = document.createElement('div');
        layer.className = 'glyphes-layer';
        layer.setAttribute('role', 'dialog');
        layer.setAttribute('aria-modal', 'true');
        layer.setAttribute('aria-label', 'Glyphes');
        const win = document.createElement('div'); win.className = 'glyphes-window';
        const bar = document.createElement('div'); bar.className = 'glyphes-bar';
        const title = document.createElement('span'); title.className = 'glyphes-title'; title.innerHTML = ICON; title.append(' Glyphes');
        const close = document.createElement('button'); close.type = 'button'; close.className = 'glyphes-close';
        close.setAttribute('aria-label', text('Fermer Glyphes', 'Close Glyphs'));
        close.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
        close.addEventListener('click', hide);
        bar.append(title, close);
        frame = document.createElement('iframe');
        frame.className = 'glyphes-frame';
        frame.title = 'Glyphes';
        frame.setAttribute('allow', 'microphone');
        win.append(bar, frame);
        layer.append(win);
        layer.addEventListener('mousedown', (e) => { if (e.target === layer) hide(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && layer.classList.contains('open')) hide(); });
        document.body.append(layer);
    }
    function show() {
        if (!layer) build();
        lastFocus = document.activeElement;
        // Load on first open only: the app keeps its live connection afterwards.
        if (!frame.src) frame.src = '/glyphes/index.html';
        layer.hidden = false;
        requestAnimationFrame(() => layer.classList.add('open'));
        setTimeout(() => frame.focus(), 200);
    }
    function hide() {
        if (!layer) return;
        layer.classList.remove('open');
        setTimeout(() => { if (!layer.classList.contains('open')) layer.hidden = true; }, 320);
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    // Entry in the "Outils" menu (built each time the menu opens).
    const menu = document.getElementById('chat-tools-menu');
    function addEntry() {
        if (!menu || menu.querySelector('[data-glyphes]')) return;
        const item = document.createElement('button');
        item.type = 'button'; item.className = 'cs-menu-item'; item.setAttribute('role', 'menuitem'); item.dataset.glyphes = '1';
        const icon = document.createElement('span'); icon.className = 'cs-menu-icon'; icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = ICON;
        const label = document.createElement('span'); label.textContent = 'Glyphes';
        item.append(icon, label);
        item.addEventListener('click', () => { try { menu.hidePopover(); } catch {} show(); });
        const rule = menu.querySelector('.cs-menu-rule');
        menu.insertBefore(item, rule || null);
    }
    if (menu) {
        new MutationObserver(addEntry).observe(menu, { childList: true });
        addEntry();
    }
    window.ZaalisCommands?.register('glyphes', 'Glyphes', show);
    window.ZaalisGlyphes = { show, hide };
})();
