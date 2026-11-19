// Page de lecture (src/features/reader.js) : assainissement par liste blanche,
// préférences d'affichage, lecture à voix haute (speechSynthesis).
(function () {
  'use strict';
  const $ = zx.$;
  let prefs = { theme: 'light', font: 'sans', size: 19, width: 680, line: 1.6 };
  let article = null;

  const ALLOWED = new Set(['P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'CODE',
    'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK', 'Q', 'CITE', 'ABBR', 'TIME', 'SPAN', 'DIV', 'SECTION', 'ARTICLE',
    'FIGURE', 'FIGCAPTION', 'IMG', 'PICTURE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'DEL', 'INS', 'KBD', 'SAMP', 'VAR']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'TEMPLATE', 'LINK', 'META', 'BASE', 'NOSCRIPT', 'VIDEO', 'AUDIO', 'SOURCE', 'CANVAS']);
  const okUrl = (u) => /^https?:\/\//i.test(String(u || '').trim());

  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const src = doc.body.firstChild;
    const clean = (node) => {
      const frag = document.createDocumentFragment();
      for (const ch of [...node.childNodes]) {
        if (ch.nodeType === 3) { frag.appendChild(document.createTextNode(ch.nodeValue)); continue; }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName.toUpperCase();
        if (DROP.has(tag)) continue;
        if (!ALLOWED.has(tag)) { frag.appendChild(clean(ch)); continue; }   // on garde le texte
        if (tag === 'PICTURE') { frag.appendChild(clean(ch)); continue; }
        const el = document.createElement(tag);
        if (tag === 'A') {
          const h = ch.getAttribute('href');
          if (okUrl(h)) { el.setAttribute('href', h); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
        } else if (tag === 'IMG') {
          const s = ch.getAttribute('src');
          if (!okUrl(s)) continue;
          el.setAttribute('src', s); el.setAttribute('loading', 'lazy'); el.setAttribute('referrerpolicy', 'no-referrer');
          const alt = ch.getAttribute('alt'); if (alt) el.setAttribute('alt', alt.slice(0, 300));
        } else if (tag === 'TD' || tag === 'TH') {
          for (const a of ['colspan', 'rowspan']) { const v = parseInt(ch.getAttribute(a), 10); if (v > 1 && v < 50) el.setAttribute(a, String(v)); }
        } else if (tag === 'TIME') {
          const d = ch.getAttribute('datetime'); if (d) el.setAttribute('datetime', d.slice(0, 60));
        }
        el.appendChild(clean(ch));
        frag.appendChild(el);
      }
      return frag;
    };
    const out = document.createElement('div');
    out.className = 'content';
    out.appendChild(clean(src));
    // Retire les blocs devenus vides.
    out.querySelectorAll('div, section, span, p').forEach(e => { if (!e.textContent.trim() && !e.querySelector('img')) e.remove(); });
    return out;
  }

  function applyPrefs() {
    document.body.className = 'r-' + prefs.theme + (prefs.theme === 'dark' ? ' dark' : '');
    const art = $('art');
    art.className = 'f-' + prefs.font;
    art.style.fontSize = prefs.size + 'px';
    art.style.maxWidth = prefs.width + 'px';
    art.style.lineHeight = String(prefs.line);
    $('font').value = prefs.font;
    ['light', 'sepia', 'dark'].forEach(t => $('t-' + t).classList.toggle('on', prefs.theme === t));
  }
  const save = (patch) => { Object.assign(prefs, patch); applyPrefs(); zx.call('readerPrefs', prefs).catch(() => {}); };

  function render() {
    const art = $('art');
    art.innerHTML = '';
    if (!article) { art.innerHTML = '<div class="empty">Cet article n\'est plus disponible. Rouvrez le mode Lecture depuis la page d\'origine.</div>'; return; }
    document.title = article.title || 'Mode Lecture';
    if (article.lang) document.documentElement.lang = article.lang;
    const site = document.createElement('div'); site.className = 'site'; site.textContent = article.siteName || '';
    const h = document.createElement('h1'); h.className = 'title'; h.textContent = article.title || '';
    const meta = document.createElement('div'); meta.className = 'meta';
    const bits = [];
    if (article.byline) bits.push(article.byline);
    if (article.date) { const d = new Date(article.date); bits.push(isNaN(d) ? article.date : d.toLocaleDateString('fr-FR', { dateStyle: 'long' })); }
    bits.push(article.minutes + ' min de lecture');
    meta.textContent = bits.join(' · ');
    art.append(site, h, meta);
    const content = sanitize(article.html || '');
    if (article.leadImage && okUrl(article.leadImage) && !content.querySelector('img')) {
      const img = document.createElement('img'); img.src = article.leadImage; img.referrerPolicy = 'no-referrer';
      content.prepend(img);
    }
    art.appendChild(content);
  }

  // ----- Lecture à voix haute -------------------------------------------------
  let speaking = false;
  function ttsBlocks() { return [...document.querySelectorAll('.content p, .content li, .content h2, .content h3, .content blockquote')].filter(e => e.textContent.trim()); }
  function speak() {
    if (!('speechSynthesis' in window)) { zx.toast('Lecture à voix haute indisponible sur ce système.'); return; }
    const synth = window.speechSynthesis;
    if (speaking && synth.paused) { synth.resume(); setTtsUi(true, false); return; }
    if (speaking) { synth.pause(); setTtsUi(true, true); return; }
    const blocks = [$('art').querySelector('h1.title'), ...ttsBlocks()].filter(Boolean);
    const voices = synth.getVoices();
    const lang = (article && article.lang) || document.documentElement.lang || 'fr';
    const voice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    speaking = true; setTtsUi(true, false);
    blocks.forEach((b, i) => {
      const u = new SpeechSynthesisUtterance(b.textContent.trim());
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : lang;
      u.onstart = () => { document.querySelectorAll('.tts-on').forEach(e => e.classList.remove('tts-on')); b.classList.add('tts-on'); b.style.background = 'rgba(255,213,79,.35)'; b.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      u.onend = () => { b.style.background = ''; if (i === blocks.length - 1) stop(); };
      synth.speak(u);
    });
  }
  function stop() {
    try { window.speechSynthesis.cancel(); } catch (e) {}
    speaking = false; setTtsUi(false, false);
    document.querySelectorAll('.content [style]').forEach(e => { e.style.background = ''; });
  }
  function setTtsUi(on, paused) {
    $('tts').textContent = on ? (paused ? '▶ Reprendre' : '❚❚ Pause') : '▶ Écouter';
    $('tts-stop').style.display = on ? '' : 'none';
  }

  $('font').onchange = (e) => save({ font: e.target.value });
  $('smaller').onclick = () => save({ size: Math.max(12, prefs.size - 1) });
  $('bigger').onclick = () => save({ size: Math.min(36, prefs.size + 1) });
  $('narrow').onclick = () => save({ width: Math.max(480, prefs.width - 80) });
  $('wide').onclick = () => save({ width: Math.min(1100, prefs.width + 80) });
  ['light', 'sepia', 'dark'].forEach(t => { $('t-' + t).onclick = () => save({ theme: t }); });
  $('tts').onclick = speak;
  $('tts-stop').onclick = stop;
  $('src').onclick = () => { if (article && okUrl(article.url)) location.href = article.url; };
  window.addEventListener('beforeunload', stop);

  applyPrefs();
  zx.call('readerGet', { id: location.hash.slice(1) }).then(r => {
    if (r.prefs) prefs = Object.assign(prefs, r.prefs);
    article = r.article; applyPrefs(); render();
  }).catch(() => { article = null; render(); });
})();
