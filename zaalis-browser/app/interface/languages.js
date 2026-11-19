// Page zaalis://languages : préférences de traduction + correcteur orthographique.
(function () {
  'use strict';
  const $ = zx.$, esc = zx.esc;
  let tr = null, sp = null;
  const LABELS = { fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien', pt: 'Portugais', nl: 'Néerlandais',
    pl: 'Polonais', ru: 'Russe', ja: 'Japonais', zh: 'Chinois', ko: 'Coréen', ar: 'Arabe', tr: 'Turc', sv: 'Suédois', da: 'Danois',
    no: 'Norvégien', nb: 'Norvégien', fi: 'Finnois', cs: 'Tchèque', ro: 'Roumain', hu: 'Hongrois', el: 'Grec', he: 'Hébreu', uk: 'Ukrainien',
    hi: 'Hindi', th: 'Thaï', vi: 'Vietnamien', id: 'Indonésien', ca: 'Catalan', hr: 'Croate', bg: 'Bulgare', sk: 'Slovaque', sl: 'Slovène',
    lt: 'Lituanien', lv: 'Letton', et: 'Estonien', af: 'Afrikaans', sq: 'Albanais', hy: 'Arménien', fa: 'Persan', sr: 'Serbe', ta: 'Tamoul', cy: 'Gallois', fo: 'Féroïen', sh: 'Serbo-croate', tg: 'Tadjik', tk: 'Turkmène' };
  const label = (code) => { const [l, r] = String(code).split('-'); return (LABELS[l] || code) + (r ? ' (' + r + ')' : ''); };

  function chips(list, kind, nameOf) {
    if (!list.length) return '<span class="zx-muted">Aucun</span>';
    return list.map(v => '<span class="zx-badge" style="margin:2px 4px 2px 0">' + esc(nameOf(v)) +
      ' <a href="#" data-k="' + kind + '" data-v="' + esc(v) + '" title="Retirer">✕</a></span>').join('');
  }
  function renderTr() {
    $('offer').classList.toggle('on', !!tr.offer);
    const sel = $('target');
    if (!sel.options.length) tr.targets.forEach(t => { const o = document.createElement('option'); o.value = t.code; o.textContent = label(t.code); sel.appendChild(o); });
    sel.value = tr.target;
    $('always').innerHTML = chips(tr.always, 'always', label);
    $('never').innerHTML = chips(tr.never, 'never', label);
    $('sites').innerHTML = chips(tr.neverSites, 'neverSites', v => v);
  }
  function renderSp() {
    $('spell-on').classList.toggle('on', !!sp.enabled);
    $('spell-hint').textContent = sp.platform === 'darwin'
      ? 'macOS : le correcteur du système choisit automatiquement la langue.'
      : 'Langues actives : ' + (sp.active.map(label).join(', ') || 'aucune');
    const box = $('spell-langs');
    if (sp.platform === 'darwin' || !sp.available.length) { box.innerHTML = ''; return; }
    const chosen = new Set(sp.languages.map(c => c.toLowerCase()));
    const activeSet = new Set(sp.active.map(c => c.toLowerCase()));
    const list = sp.available.slice().sort((a, b) => label(a).localeCompare(label(b), 'fr'));
    box.innerHTML = '<div class="zx-row" style="flex-wrap:wrap;gap:6px 18px">' + list.map(c => {
      const on = activeSet.has(c.toLowerCase()) || chosen.has(c.toLowerCase());
      return '<label style="display:flex;align-items:center;gap:6px;min-width:190px"><input type="checkbox" data-lang="' + esc(c) + '"' + (on ? ' checked' : '') + '>' + esc(label(c)) + '</label>';
    }).join('') + '</div>';
  }
  async function loadWords() {
    const words = await zx.call('spellWords');
    $('words').innerHTML = words.length ? words.map(w => '<div class="zx-row"><div class="grow">' + esc(w) +
      '</div><button class="zx-icon-btn" data-word="' + esc(w) + '" title="Supprimer">✕</button></div>').join('')
      : '<div class="zx-empty">Aucun mot ajouté. Les mots ajoutés depuis le menu clic droit apparaissent ici.</div>';
  }
  const saveTr = (patch) => zx.call('trPrefsSet', patch).then(p => { tr = Object.assign(tr, p); renderTr(); });

  $('offer').onclick = () => saveTr({ offer: !tr.offer });
  $('target').onchange = (e) => saveTr({ target: e.target.value });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-k]');
    if (a) { e.preventDefault(); const k = a.dataset.k; saveTr({ [k]: tr[k].filter(v => v !== a.dataset.v) }); }
    const w = e.target.closest && e.target.closest('[data-word]');
    if (w) zx.call('spellRemoveWord', { word: w.dataset.word }).then(loadWords);
  });
  $('spell-on').onclick = () => zx.call('spellSet', { enabled: !sp.enabled }).then(s => { sp = s; renderSp(); });
  $('spell-langs').addEventListener('change', () => {
    const langs = [...document.querySelectorAll('[data-lang]')].filter(i => i.checked).map(i => i.dataset.lang);
    zx.call('spellSet', { languages: langs }).then(s => { sp = s; renderSp(); });
  });
  const addWord = () => { const v = $('word').value.trim(); if (!v) return;
    zx.call('spellAddWord', { word: v }).then(() => { $('word').value = ''; setTimeout(loadWords, 150); }).catch(e => zx.toast(e.message)); };
  $('add-word').onclick = addWord;
  $('word').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });

  zx.call('trPrefsGet').then(p => { tr = p; renderTr(); });
  zx.call('spellState').then(s => { sp = s; renderSp(); });
  loadWords();
})();
