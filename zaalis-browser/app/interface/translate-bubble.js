// Bulle « Traduire cette page ? » (voir src/features/translate.js).
(function () {
  'use strict';
  let st = null;
  const $ = zx.$;
  function render(s) {
    if (!s) return;
    st = s;
    $('tab-src').textContent = s.sourceName || 'Langue détectée';
    $('tab-dst').textContent = s.targetName;
    $('tab-src').classList.toggle('on', !s.translated);
    $('tab-dst').classList.toggle('on', !!s.translated);
    $('title').textContent = s.translated ? 'Page traduite en ' + s.targetName : 'Traduire cette page ?';
    const status = $('status');
    status.classList.toggle('err', !!s.error);
    status.textContent = s.busy ? 'Traduction en cours… ' + (s.progress || 0) + ' %'
      : s.error ? s.error
      : s.translated ? 'Cliquez sur « ' + (s.sourceName || 'original') + ' » pour afficher l\'original.'
      : (s.ideConnected ? 'Traduction par votre modèle IA local (zaalis labs ide).' : 'zaalis labs ide est requis pour traduire (modèle IA local).');
    $('prog').style.display = s.busy ? '' : 'none';
    $('prog-fill').style.width = (s.progress || 0) + '%';
    const sel = $('target');
    if (!sel.options.length) s.targets.forEach(t => { const o = document.createElement('option'); o.value = t.code; o.textContent = t.name; sel.appendChild(o); });
    sel.value = s.target;
    const chk = (id, on) => { $(id).querySelector('.chk').textContent = on ? '✓' : ''; };
    $('m-always-t').textContent = 'Toujours traduire : ' + (s.sourceName || '—');
    $('m-never-t').textContent = 'Ne jamais traduire : ' + (s.sourceName || '—');
    $('m-site-t').textContent = 'Ne jamais traduire ce site' + (s.host ? ' (' + s.host + ')' : '');
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
