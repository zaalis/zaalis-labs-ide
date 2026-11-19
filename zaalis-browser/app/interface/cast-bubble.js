// Bulle « Caster » (voir src/features/cast.js).
(function () {
  'use strict';
  const $ = zx.$, esc = zx.esc;
  const TV = '<svg class="i" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>';
  const SPK = '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/></svg>';
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  let st = null, busy = false;

  function render(s) {
    if (!s) return;
    st = s;
    const m = s.media;
    $('media').textContent = m && m.blocked ? 'Le média de cette page est protégé ou en flux interne : il ne peut pas être diffusé.'
      : m && m.url ? 'À diffuser : ' + (m.title || m.url) : 'Aucune vidéo ni musique détectée sur cette page.';
    const ss = s.session;
    $('session').innerHTML = ss ? '<div class="dev" style="cursor:default"><span style="color:var(--accent)">' + TV + '</span><div class="grow"><div class="n">' + esc(ss.deviceName) + '</div>' +
      '<div class="m">' + esc(ss.error || ({ PLAYING: 'Lecture', PAUSED: 'Pause', BUFFERING: 'Chargement…', IDLE: 'Arrêté', CONNECTING: 'Connexion…' }[ss.state] || ss.state)) +
      (ss.duration ? ' · ' + fmt(ss.currentTime) + ' / ' + fmt(ss.duration) : '') + '</div></div></div>' +
      '<div class="ctl"><button class="zx-btn" data-c="seek" data-v="-10">−10 s</button>' +
      '<button class="zx-btn primary" data-c="' + (ss.state === 'PLAYING' ? 'pause' : 'play') + '">' + (ss.state === 'PLAYING' ? 'Pause' : 'Lecture') + '</button>' +
      '<button class="zx-btn" data-c="seek" data-v="10">+10 s</button><button class="zx-btn danger" data-c="stop">Arrêter</button></div>' : '';
    const devs = s.devices || [];
    $('list').innerHTML = devs.length ? devs.map(d => '<div class="dev" data-id="' + esc(d.id) + '">' + (d.kind === 'chromecast' && /audio|speaker|home|nest mini/i.test(d.model) ? SPK : TV) +
      '<div class="grow"><div class="n">' + esc(d.name) + '</div><div class="m">' + esc(d.kind === 'chromecast' ? (d.model || 'Chromecast') : 'DLNA / UPnP' + (d.model ? ' · ' + d.model : '')) + '</div></div></div>').join('')
      : '<div class="b-status" style="padding:6px 16px">' + (s.scanning ? 'Recherche des appareils sur le réseau…' : 'Aucun appareil trouvé sur ce réseau.') + '</div>';
    if (window.bubbleReport) bubbleReport();
  }
  const call = (n, p) => { busy = true; return zx.call(n, p).then(render).catch(e => zx.toast(e.message)).finally(() => { busy = false; }); };
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-id]'); if (d && !busy) { $('media').textContent = 'Connexion…'; call('castStart', { id: d.dataset.id }); return; }
    const c = e.target.closest('[data-c]'); if (c) call('castControl', { cmd: c.dataset.c, value: Number(c.dataset.v || 0) });
  });
  $('scan').onclick = () => { render(Object.assign({}, st, { scanning: true, devices: [] })); call('castScan'); };
  $('close').onclick = () => zx.post('popupClose');
  zx.on('castUpdate', d => render(d.state));
  call('castState');
})();
