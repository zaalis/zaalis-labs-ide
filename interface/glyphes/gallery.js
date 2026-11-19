  const all = [];
  all.push(Glyph.mount(document.getElementById('hero'), { variant: 'nova' }));
  for (const v of Glyph.VARIANTS) {
    const fig = document.createElement('figure');
    const box = document.createElement('div'); box.className = 'g';
    const cap = document.createElement('figcaption'); cap.textContent = v.name;
    fig.append(box, cap); document.getElementById('grid').append(fig);
    all.push(Glyph.mount(box, { variant: v.id }));
  }
  const bar = document.getElementById('states');
  for (const s of Glyph.STATES) {
    const b = document.createElement('button'); b.textContent = s; b.setAttribute('aria-pressed', s === 'idle');
    b.onclick = () => { all.forEach(g => g.setState(s)); bar.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); };
    bar.append(b);
  }
