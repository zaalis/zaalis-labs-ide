// Aide commune des bulles (translate-bubble, qr, cast) : thème passé dans
// l'URL, hauteur reportée automatiquement, Échap pour fermer.
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  window.bubbleParams = q;
  if (q.get('theme') === 'dark') document.documentElement.classList.add('dark');
  function report() {
    const el = document.querySelector('.bubble') || document.body;
    const h = Math.ceil(el.getBoundingClientRect().height) + 2;
    if (window.zx) zx.post('popupResize', h);
  }
  window.bubbleReport = report;
  document.addEventListener('DOMContentLoaded', () => {
    if (document.documentElement.classList.contains('dark')) document.body.classList.add('dark');
    try { new ResizeObserver(report).observe(document.querySelector('.bubble') || document.body); } catch (e) {}
    report();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.zx) zx.post('popupClose'); });
})();
