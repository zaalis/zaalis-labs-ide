// Bulle « Code QR » (voir src/features/qrcode.js).
(function () {
  'use strict';
  const $ = zx.$;
  let timer = 0;
  function show(r) {
    $('box').innerHTML = '';
    if (r.svg) {
      const img = document.createElement('img');
      img.alt = 'Code QR';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg);
      $('box').appendChild(img);
    }
    $('status').textContent = r.error || (r.version ? 'Version ' + r.version + ' · ' + r.size + '×' + r.size + ' modules' : '');
    $('status').classList.toggle('err', !!r.error);
    $('save').disabled = !r.svg;
  }
  $('text').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => zx.call('qrMake', { text: $('text').value }).then(show), 120);
  });
  $('save').onclick = () => zx.call('qrSave', { text: $('text').value }).catch(e => zx.toast(e.message));
  $('copy').onclick = () => zx.call('qrCopy', { text: $('text').value }).then(() => zx.toast('Copié dans le presse-papiers'));
  $('close').onclick = () => zx.post('popupClose');
  zx.call('qrInit').then(r => { $('text').value = r.text || ''; show(r); $('text').select(); });
})();
