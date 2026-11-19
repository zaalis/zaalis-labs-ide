// Bulle « Traduire cette page ? » (voir src/features/translate.js).
(function () {
  'use strict';
  let st = null;
  const { $, text, languageName } = zx;
  function render(s) {
    if (!s) return;
    st = s;
    const source = languageName(s.source, s.sourceName);
    const target = languageName(s.target, s.targetName);
    $('tab-src').textContent = source || text('Langue détectée', 'Detected language');
    $('tab-dst').textContent = target;
    $('tab-src').classList.toggle('on', !s.translated);
    $('tab-dst').classList.toggle('on', !!s.translated);
    $('title').textContent = s.translated ? text('Page traduite en ', 'Page translated into ') + target : text('Traduire cette page ?', 'Translate this page?');
    const status = $('status');
    status.classList.toggle('err', !!s.error);
    status.textContent = s.busy ? text('Traduction en cours… ', 'Translating… ') + (s.progress || 0) + text(' %', '%')
      : s.error ? s.error
      : s.translated ? text('Cliquez sur « ' + (source || 'original') + ' » pour afficher l\'original.', 'Select “' + (source || 'original') + '” to see the original.')
      : (s.ideConnected ? text('Traduction par votre modèle IA local (zaalis labs ide).', 'Translated by your local AI model in zaalis labs ide.') : text('zaalis labs ide est requis pour traduire (modèle IA local).', 'Translation requires a local AI model in zaalis labs ide.'));
    $('prog').style.display = s.busy ? '' : 'none';
    $('prog-fill').style.width = (s.progress || 0) + '%';
    const sel = $('target');
    if (!sel.options.length) s.targets.forEach(t => { const o = document.createElement('option'); o.value = t.code; o.textContent = languageName(t.code, t.name); sel.appendChild(o); });
    sel.value = s.target;
    const chk = (id, on) => { $(id).querySelector('.chk').textContent = on ? '✓' : ''; };
    $('m-always-t').textContent = text('Toujours traduire : ', 'Always translate: ') + (source || '—');
    $('m-never-t').textContent = text('Ne jamais traduire : ', 'Never translate: ') + (source || '—');
    $('m-site-t').textContent = text('Ne jamais traduire ce site', 'Never translate this site') + (s.host ? ' (' + s.host + ')' : '');
    chk('m-always', s.always); chk('m-never', s.never); chk('m-site', s.neverSite);
    if (window.bubbleReport) bubbleReport();
  }
  const call = (name, p) => zx.call(name, p).then(render).catch(e => zx.toast(e.message));
  $('tab-dst').onclick = () => { if (!st || st.busy) return; call('trDo', { target: st.target }); };
  $('tab-src').onclick = () => { if (st && st.translated) call('trOriginal'); };
  $('close').onclick = () => zx.post('popupClose');
  $('more').onclick = () => { const m = $('menu'); m.style.display = m.style.display === 'none' ? '' : 'none'; if (window.bubbleReport) bubbleReport(); };
  $('target').onchange = (e) => call('trPref', { target: e.target.value });
  $('target').onclick = (e) => e.stopPropagation();
  $('m-always').onclick = () => call('trPref', { always: !(st && st.always) });
  $('m-never').onclick = () => call('trPref', { never: !(st && st.never) });
  $('m-site').onclick = () => call('trPref', { neverSite: !(st && st.neverSite) });
  $('m-settings').onclick = () => zx.post('popupOpenInternal', 'languages');
  zx.on('trUpdate', d => render(d.state));
  call('trState');
})();
