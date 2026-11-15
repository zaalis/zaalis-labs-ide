// Page zaalis://sync (src/features/sync.js).
(function () {
  'use strict';
  const $ = zx.$, esc = zx.esc;
  let st = null, nameTimer = 0;

  function render(s) {
    if (!s) return;
    st = s;
    $('setup').style.display = s.enabled ? 'none' : '';
    $('active').style.display = s.enabled ? '' : 'none';
    if (!s.enabled) {
      if (!$('folder').value) $('folder').value = s.folder || s.suggestedFolder || '';
      if (!$('name').value) $('name').value = s.deviceName || '';
      return;
    }
    const stt = s.status || {};
    $('st-t').textContent = stt.state === 'error' ? 'Problème de synchronisation' : 'La synchronisation est activée';
    $('st-t').style.color = stt.state === 'error' ? 'var(--danger)' : '';
    $('st-s').textContent = stt.state === 'error' ? stt.error : (stt.lastSync ? 'Dernière synchronisation : ' + zx.fmtDate(stt.lastSync) : 'En attente…');
    $('cur-folder').textContent = s.folder;
    if (document.activeElement !== $('dev-name')) $('dev-name').value = s.deviceName;
    $('colls').innerHTML = s.collections.map(c => '<div class="zx-row"><div class="grow"><div class="t">' + esc(c.label) + '</div>' +
      (c.available ? '' : '<div class="s">Disponible quand ce module est installé.</div>') + '</div>' +
      '<div class="zx-switch' + (c.on ? ' on' : '') + '" data-coll="' + esc(c.key) + '"' + (c.available ? '' : ' style="opacity:.4;pointer-events:none"') + '></div></div>').join('');
    const devs = s.devices || [];
    $('devices').innerHTML = devs.length ? devs.map(d => '<div class="zx-row" style="align-items:flex-start"><div class="grow">' +
      '<div class="t">' + esc(d.name) + (d.error ? ' <span class="zx-badge err">illisible</span>' : '') + '</div>' +
      '<div class="s">' + (d.updatedAt ? 'Mis à jour ' + esc(zx.fmtDate(d.updatedAt)) : '') + (d.platform ? ' · ' + esc(d.platform) : '') + '</div>' +
      '<div class="dev-tabs">' + (d.tabs.length ? d.tabs.map(t => '<a data-url="' + esc(t.url) + '" title="' + esc(t.url) + '">' + esc(t.title || t.url) + '</a>').join('') : '<span class="zx-muted">Aucun onglet ouvert</span>') + '</div>' +
      '</div></div>').join('') : '<div class="zx-empty">Aucun autre appareil ne s\'est encore synchronisé avec ce dossier.</div>';
  }
  const call = (n, p) => zx.call(n, p).then(render).catch(e => zx.toast(e.message));

  $('browse').onclick = () => zx.call('syncChooseFolder').then(f => { if (f) $('folder').value = f; });
  $('enable').onclick = () => {
    $('enable').disabled = true;
    zx.call('syncEnable', { folder: $('folder').value, passphrase: $('pass').value, deviceName: $('name').value })
      .then(r => { $('pass').value = ''; render(r); zx.toast(r.created ? 'Coffre de synchronisation créé.' : 'Appareil ajouté au coffre existant.'); })
      .catch(e => zx.toast(e.message)).finally(() => { $('enable').disabled = false; });
  };
  $('now').onclick = () => call('syncNow');
  $('dev-name').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(() => call('syncSet', { deviceName: $('dev-name').value }), 600); });
  $('disable').onclick = async () => { if (await zx.confirm('Arrêter la synchronisation ?', 'Cet appareil ne recevra plus les modifications des autres appareils.', { ok: 'Désactiver' })) call('syncDisable'); };
  $('erase').onclick = async () => { if (await zx.confirm('Effacer les données de synchronisation ?', 'Le coffre chiffré sera supprimé du dossier partagé pour tous les appareils. Cette action est irréversible.', { ok: 'Effacer', danger: true })) call('syncErase'); };
  document.addEventListener('click', (e) => {
    const sw = e.target.closest && e.target.closest('[data-coll]');
    if (sw) call('syncSet', { collections: { [sw.dataset.coll]: !sw.classList.contains('on') } });
    const a = e.target.closest && e.target.closest('a[data-url]');
    if (a) zx.call('syncOpenTab', { url: a.dataset.url });
  });
  zx.on('syncState', d => render(d.state));
  call('syncState');
})();
