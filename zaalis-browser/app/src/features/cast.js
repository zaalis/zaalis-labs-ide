'use strict';
/* =============================================================================
 *  Caster… (Chromecast et téléviseurs DLNA / UPnP), 100 % maison
 * -----------------------------------------------------------------------------
 *  Découverte locale (mDNS _googlecast._tcp + SSDP MediaRenderer), puis envoi
 *  de la vidéo ou de la musique de la page : le téléviseur lit lui-même
 *  l'adresse du média (Default Media Receiver sur Chromecast, AVTransport sur
 *  DLNA). La recopie d'onglet ou d'écran n'est pas prise en charge.
 * =========================================================================== */

const proto = require('./lib/castproto');
const { popupManager, POPUP_VIEW } = require('./lib/popup');

const WORLD = 1015;
const ICON = '<svg viewBox="0 0 24 24"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><path d="M2 20h.01"/></svg>';
const DISCOVERY_EVERY_MS = 5 * 60 * 1000;
const DEVICE_TTL_MS = 15 * 60 * 1000;

// Média principal de la page (élément en lecture ou le plus grand).
const FIND_MEDIA_JS = `(() => {
  const els = [...document.querySelectorAll('video, audio')];
  const score = (m) => (m.paused ? 0 : 1e9) + (m.tagName === 'VIDEO' ? (m.clientWidth * m.clientHeight) : 1);
  els.sort((a, b) => score(b) - score(a));
  const m = els[0];
  const og = (p) => { const e = document.querySelector('meta[property="' + p + '"]'); return e ? e.content : ''; };
  const pick = (u) => (u && /^https?:/i.test(u)) ? u : '';
  if (!m) {
    const v = pick(og('og:video:secure_url') || og('og:video:url') || og('og:video'));
    return v ? { url: v, title: og('og:title') || document.title, poster: pick(og('og:image')), kind: 'video', currentTime: 0, fromMeta: true } : null;
  }
  let src = m.currentSrc || m.src || '';
  if (!/^https?:/i.test(src)) { const s = m.querySelector('source[src^="http"]'); if (s) src = s.src; }
  return { url: src, blob: /^blob:|^mediasource:/i.test(src), kind: m.tagName === 'VIDEO' ? 'video' : 'audio',
    title: og('og:title') || document.title, poster: pick(m.poster || og('og:image')), currentTime: m.currentTime || 0,
    duration: isFinite(m.duration) ? m.duration : 0, paused: m.paused };
})()`;
const PAUSE_LOCAL_JS = `(() => { document.querySelectorAll('video, audio').forEach(m => { try { m.pause(); } catch (e) {} }); })()`;

function contentTypeFor(url, kind) {
  const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (/\.m3u8$/.test(p)) return 'application/x-mpegURL';
  if (/\.mpd$/.test(p)) return 'application/dash+xml';
  if (/\.webm$/.test(p)) return kind === 'audio' ? 'audio/webm' : 'video/webm';
  if (/\.mp3$/.test(p)) return 'audio/mpeg';
  if (/\.(m4a|aac)$/.test(p)) return 'audio/mp4';
  if (/\.ogg|\.oga$/.test(p)) return 'audio/ogg';
  if (/\.wav$/.test(p)) return 'audio/wav';
  if (/\.flac$/.test(p)) return 'audio/flac';
  if (/\.mkv$/.test(p)) return 'video/x-matroska';
  return kind === 'audio' ? 'audio/mpeg' : 'video/mp4';
}

function init(ctx) {
  const popup = popupManager(ctx);
  const devices = new Map();   // id -> { ...device, seenAt }
  let scanning = null, lastScan = 0;
  let session = null;          // { device, client?, media, state, currentTime, duration, error }
  let pollTimer = null;

  async function discover() {
    if (scanning) return scanning;
    scanning = (async () => {
      const [a, b] = await Promise.all([proto.discoverMdns(2500).catch(() => []), proto.discoverSsdp(2500).catch(() => [])]);
      const now = Date.now();
      for (const d of [...a, ...b]) devices.set(d.id, { ...d, seenAt: now });
      for (const [id, d] of devices) if (now - d.seenAt > DEVICE_TTL_MS && (!session || session.device.id !== id)) devices.delete(id);
      lastScan = now;
      ctx.pushState(); pushBubble();
      return list();
    })();
    try { return await scanning; } finally { scanning = null; }
  }
  function list() { return [...devices.values()].map(d => ({ id: d.id, name: d.name, model: d.model || '', kind: d.kind })); }

  async function detectMedia(tab) {
    if (!tab) return null;
    try { return await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: FIND_MEDIA_JS }], true); } catch { return null; }
  }

  function sessionState() {
    if (!session) return null;
    return { deviceId: session.device.id, deviceName: session.device.name, kind: session.device.kind, title: session.media.title,
      state: session.state, currentTime: session.currentTime || 0, duration: session.duration || 0, error: session.error || '' };
  }
  function pushBubble() { popup.send('cast', { type: 'castUpdate', state: bubbleState() }); }
  function bubbleState() { return { devices: list(), scanning: !!scanning, lastScan, session: sessionState(), media: pendingMedia }; }

  let pendingMedia = null;
  async function startCast(deviceId, tab) {
    const dev = devices.get(deviceId);
    if (!dev) throw new Error('Appareil introuvable : relancez la recherche.');
    const m = pendingMedia && pendingMedia.url ? pendingMedia : await detectMedia(tab || ctx.activeTab());
    if (!m || !m.url) throw new Error('Aucune vidéo ni musique à diffuser sur cette page. La recopie d\'onglet ou d\'écran n\'est pas prise en charge.');
    if (m.blob || !/^https?:/i.test(m.url)) throw new Error('Ce média est protégé ou diffusé en flux interne (MSE/DRM, ex. YouTube, Netflix) : il ne peut pas être envoyé tel quel au téléviseur.');
    await stopCast();
    const media = { url: m.url, title: m.title || '', poster: m.poster || '', contentType: contentTypeFor(m.url, m.kind), currentTime: m.currentTime || 0, live: !m.duration && /m3u8/.test(m.url) };
    session = { device: dev, media, state: 'CONNECTING', currentTime: media.currentTime, duration: m.duration || 0 };
    pushBubble(); ctx.pushState();
    try {
      if (dev.kind === 'chromecast') {
        const c = new proto.CastClient(dev.host, dev.port);
        session.client = c;
        c.on('media', (s) => { if (!session || session.client !== c) return; session.state = s.playerState || session.state; if (typeof s.currentTime === 'number') session.currentTime = s.currentTime; if (s.media && s.media.duration) session.duration = s.media.duration; pushBubble(); });
        c.on('close', () => { if (session && session.client === c) { session = null; stopPoll(); pushBubble(); ctx.pushState(); } });
        c.on('error', () => {});
        await c.connect();
        await c.launch();
        await c.load(media);
      } else {
        await proto.dlna.load(dev, media);
        session.state = 'PLAYING';
      }
      try { await (tab || ctx.activeTab()).view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: PAUSE_LOCAL_JS }], true); } catch {}
      startPoll();
      ctx.toast('Diffusion sur ' + dev.name);
    } catch (e) {
      const err = String(e && e.message || e);
      if (session && session.client) { try { session.client.close(); } catch {} }
      session = null;
      pushBubble(); ctx.pushState();
      throw new Error('Diffusion impossible sur ' + dev.name + ' : ' + err);
    }
    pushBubble(); ctx.pushState();
    return sessionState();
  }
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      if (!session) return stopPoll();
      try {
        if (session.device.kind === 'chromecast') { if (session.client && session.client.mediaSessionId) await session.client.mediaCmd('GET_STATUS').catch(() => {}); }
        else { const s = await proto.dlna.status(session.device); Object.assign(session, { state: s.state, currentTime: s.currentTime, duration: s.duration || session.duration }); }
        pushBubble();
      } catch {}
    }, 2000);
    if (pollTimer.unref) pollTimer.unref();
  }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
  async function control(cmd, value) {
    if (!session) throw new Error('Aucune diffusion en cours');
    const d = session.device;
    if (d.kind === 'chromecast') {
      const c = session.client;
      if (cmd === 'play') await c.play(); else if (cmd === 'pause') await c.pause();
      else if (cmd === 'seek') await c.seek(Math.max(0, (session.currentTime || 0) + Number(value || 0)));
      else if (cmd === 'stop') return stopCast();
    } else {
      if (cmd === 'play') { await proto.dlna.play(d); session.state = 'PLAYING'; }
      else if (cmd === 'pause') { await proto.dlna.pause(d); session.state = 'PAUSED'; }
      else if (cmd === 'seek') await proto.dlna.seek(d, Math.max(0, (session.currentTime || 0) + Number(value || 0)));
      else if (cmd === 'stop') return stopCast();
    }
    pushBubble();
    return sessionState();
  }
  async function stopCast() {
    if (!session) return null;
    const s = session; session = null; stopPoll();
    try {
      if (s.device.kind === 'chromecast' && s.client) { await s.client.stop(); s.client.close(); }
      else await proto.dlna.stop(s.device);
    } catch {}
    pushBubble(); ctx.pushState();
    return null;
  }

  function openBubble(anchor, media) {
    pendingMedia = media || null;
    const w = ctx.mainWin ? ctx.mainWin.getContentSize()[0] : 1200;
    popup.open('cast', 'cast-bubble.html', anchor || { x: w - 140, y: 48, w: 34, h: 34 }, {}, { width: 340, height: 260 });
    if (Date.now() - lastScan > 20000) discover();
  }

  ctx.toolbarAction('cast', () => (devices.size || session)
    ? { title: session ? 'Diffusion en cours sur ' + session.device.name : 'Caster…', svg: ICON, active: !!session } : null,
  (anchor) => openBubble(anchor));

  ctx.on('contextMenu', (items, c) => {
    if (c.internal) return;
    const p = c.params;
    if ((p.mediaType === 'video' || p.mediaType === 'audio') && /^https?:/i.test(p.srcURL || '')) {
      items.push({ label: 'Caster ' + (p.mediaType === 'video' ? 'cette vidéo' : 'ce son') + '…', click: () => openBubble(null, { url: p.srcURL, kind: p.mediaType, title: c.wc.getTitle(), currentTime: 0 }) });
    } else if (c.onPageArea) items.push({ label: 'Caster…', click: () => openBubble(null) });
  });

  ctx.on('ready', () => {
    const t = setTimeout(() => discover(), 8000); if (t.unref) t.unref();
    const i = setInterval(() => discover(), DISCOVERY_EVERY_MS); if (i.unref) i.unref();
  });
  ctx.on('quit', () => { if (session && session.client) { try { session.client.close(); } catch {} } });

  const opts = { views: [POPUP_VIEW] };
  ctx.rpc('castState', async () => {
    if (!pendingMedia) { const m = await detectMedia(ctx.activeTab()); if (m && m.url && !m.blob) pendingMedia = m; else if (m && m.blob) pendingMedia = { blocked: true, title: m.title }; }
    return bubbleState();
  }, opts);
  ctx.rpc('castScan', async () => { await discover(); return bubbleState(); }, opts);
  ctx.rpc('castStart', async (p) => { await startCast(String(p.id || '')); return bubbleState(); }, opts);
  ctx.rpc('castControl', async (p) => { await control(String(p.cmd || ''), p.value); return bubbleState(); }, opts);
  ctx.on('tabActivated', () => { pendingMedia = null; });

  return { discover, startCast, control, stopCast, devices, list, contentTypeFor, _addDevice: (d) => { devices.set(d.id, { ...d, seenAt: Date.now() }); ctx.pushState(); } };
}

module.exports = { init, contentTypeFor };
