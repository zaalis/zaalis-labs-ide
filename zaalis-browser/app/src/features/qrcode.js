'use strict';
// « Créer un code QR pour cette page », comme Chrome : bulle depuis l'omnibox
// ou le menu contextuel, texte modifiable, aperçu, export PNG (encodeur QR et
// encodeur PNG maison, voir lib/qr.js).

const zlib = require('zlib');
const qr = require('./lib/qr');
const { popupManager, POPUP_VIEW } = require('./lib/popup');

const ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v.01M14 20h.01M17 20h4v-3"/></svg>';

// ----- PNG maison (niveaux de gris 8 bits) ------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function qrToPng(code, scale, border) {
  scale = scale || 10; border = border == null ? 4 : border;
  const dim = (code.size + border * 2) * scale;
  const raw = Buffer.alloc((dim + 1) * dim, 255);
  for (let y = 0; y < dim; y++) {
    raw[y * (dim + 1)] = 0;   // filtre « None »
    const my = Math.floor(y / scale) - border;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - border;
      if (my >= 0 && my < code.size && mx >= 0 && mx < code.size && code.modules[my][mx]) raw[y * (dim + 1) + 1 + x] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function init(ctx) {
  const { electron, app, path, fs } = ctx;
  const popup = popupManager(ctx);
  let pendingText = '';

  function make(text) {
    text = String(text || '').slice(0, 2000);
    if (!text) return { svg: '', version: 0, error: 'Saisissez un texte ou une adresse.' };
    try {
      const code = qr.encode(text, { ecl: 'M' });
      return { svg: qr.toSvg(code), version: code.version, size: code.size };
    } catch (e) { return { svg: '', version: 0, error: 'Texte trop long pour un code QR (2 000 caractères environ au maximum).' }; }
  }
  function open(anchor, text) {
    pendingText = text || '';
    popup.open('qrcode', 'qr-bubble.html', anchor || { x: (ctx.mainWin ? ctx.mainWin.getContentSize()[0] : 1200) - 260, y: 48, w: 28, h: 28 }, {}, { width: 330, height: 420 });
  }

  ctx.omniAction('qrcode', (tab) => {
    const u = tab ? tab.view.webContents.getURL() : '';
    return /^https?:/i.test(u) ? { title: 'Créer un code QR pour cette page', svg: ICON } : null;
  }, (anchor, tab) => open(anchor, tab ? tab.view.webContents.getURL() : ''));

  ctx.on('contextMenu', (items, c) => {
    if (c.internal) return;
    if (c.params.linkURL && /^https?:/i.test(c.params.linkURL)) items.push({ label: 'Créer un code QR pour ce lien', click: () => open(null, c.params.linkURL) });
    else if (c.params.srcURL && c.params.mediaType === 'image' && /^https?:/i.test(c.params.srcURL)) items.push({ label: 'Créer un code QR pour cette image', click: () => open(null, c.params.srcURL) });
    else if (c.onPageArea) items.push({ label: 'Créer un code QR pour cette page', click: () => open(null, c.pageUrl) });
  });

  const opts = { views: [POPUP_VIEW] };
  ctx.rpc('qrInit', () => ({ text: pendingText, ...make(pendingText) }), opts);
  ctx.rpc('qrMake', (p) => make(p.text), opts);
  ctx.rpc('qrCopy', (p) => { electron.clipboard.writeText(String(p.text || '').slice(0, 2000)); return true; }, opts);
  ctx.rpc('qrSave', async (p) => {
    const text = String(p.text || '').slice(0, 2000);
    const code = qr.encode(text, { ecl: 'M' });
    let host = 'page';
    try { host = new URL(text).hostname.replace(/^www\./, '') || host; } catch {}
    popup.close('qrcode');
    const r = await electron.dialog.showSaveDialog(ctx.mainWin, {
      title: 'Enregistrer le code QR',
      defaultPath: path.join(app.getPath('downloads'), ('qrcode_' + host).replace(/[^a-z0-9._-]+/gi, '_') + '.png'),
      filters: [{ name: 'Image PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, qrToPng(code, 10, 4));
    ctx.toast('Code QR enregistré.');
    return true;
  }, opts);

  return { make, open, qrToPng, encode: qr.encode };
}

module.exports = { init, qrToPng };
