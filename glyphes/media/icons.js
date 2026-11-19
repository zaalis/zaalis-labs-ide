// window.show(kind, variant): draws one icon into #host for a screenshot.
window.show = (kind, variant) => {
    const host = document.getElementById('host');
    host.replaceChildren();
    if (kind === 'badge') {
        // Monochrome silhouette for Android's status bar: white body, eyes cut out.
        const v = Glyph.variant(variant);
        const box = document.createElement('div'); box.className = 'badge';
        box.innerHTML = `<svg viewBox="0 0 100 100"><defs><mask id="m"><rect width="100" height="100" fill="#fff"/><ellipse cx="38.5" cy="52" rx="6.2" ry="8.8" fill="#000"/><ellipse cx="61.5" cy="52" rx="6.2" ry="8.8" fill="#000"/></mask></defs><path d="${Glyph.polygonPath(v.sides, 50, 52, 44, 12)}" fill="#fff" mask="url(#m)"/></svg>`;
        host.append(box);
        return;
    }
    const box = document.createElement('div'); box.className = 'icon' + (kind === 'mask' ? ' mask' : '');
    const g = document.createElement('div'); g.className = 'g'; box.append(g); host.append(box);
    const glyph = Glyph.mount(g, { variant, manual: true, seed: 4 });
    glyph.lookAt(0, -0.05); glyph.turnTo(0, 0); glyph.nextBlink = 1e9; glyph.blinkT = -1;
    for (let i = 0; i < 120; i++) glyph.step(1 / 60);
};
