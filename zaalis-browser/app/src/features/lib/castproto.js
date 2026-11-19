'use strict';
/* =============================================================================
 *  Protocoles de diffusion, écrits à la main (aucune dépendance)
 *   - SSDP (UPnP / DLNA) : requête M-SEARCH, analyse des réponses, description
 *     XML du MediaRenderer, commandes SOAP AVTransport.
 *   - mDNS / DNS-SD : requête PTR _googlecast._tcp.local, analyse des
 *     enregistrements PTR / SRV / TXT / A (compression de noms comprise).
 *   - Cast v2 : messages CastMessage (protobuf encodé à la main), trames
 *     préfixées par leur longueur sur TLS 8009.
 * =========================================================================== */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const tls = require('tls');
const os = require('os');
const { EventEmitter } = require('events');

// ----- SSDP --------------------------------------------------------------------
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const MEDIA_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const AVTRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';

function ssdpSearchMessage(st, mx) {
  return Buffer.from('M-SEARCH * HTTP/1.1\r\n' + 'HOST: ' + SSDP_ADDR + ':' + SSDP_PORT + '\r\n' +
    'MAN: "ssdp:discover"\r\n' + 'MX: ' + (mx || 2) + '\r\n' + 'ST: ' + (st || MEDIA_RENDERER) + '\r\n' +
    'USER-AGENT: Windows/10 UPnP/1.1 zaalisBrowser/1.0\r\n\r\n', 'ascii');
}
function parseSsdpResponse(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const lines = text.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200|^NOTIFY /i.test(lines[0] || '')) return null;
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  if (!headers.location) return null;
  return { location: headers.location, st: headers.st || headers.nt || '', usn: headers.usn || '', server: headers.server || '' };
}
const xmlText = (xml, tag) => { const m = new RegExp('<(?:[a-z0-9]+:)?' + tag + '[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?' + tag + '>', 'i').exec(xml); return m ? decodeXml(m[1].trim()) : ''; };
function decodeXml(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&'); }
function escapeXml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

// Description d'appareil UPnP -> { name, model, avTransportUrl }
function parseDeviceDescription(xml, location) {
  const name = xmlText(xml, 'friendlyName');
  const model = xmlText(xml, 'modelName');
  const base = xmlText(xml, 'URLBase') || location;
  let control = '';
  const re = /<service>([\s\S]*?)<\/service>/gi;
  let m;
  while ((m = re.exec(xml))) {
    if (/AVTransport/i.test(xmlText(m[1], 'serviceType'))) { control = xmlText(m[1], 'controlURL'); break; }
  }
  let avTransportUrl = '';
  try { if (control) avTransportUrl = new URL(control, base).toString(); } catch {}
  return { name, model, avTransportUrl };
}

function httpRequest(u, opts, body) {
  return new Promise((resolve, reject) => {
    const mod = u.startsWith('https:') ? https : http;
    const req = mod.request(u, { method: opts.method || 'GET', headers: opts.headers || {}, timeout: opts.timeout || 5000 }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 2 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function soapEnvelope(action, args) {
  const inner = Object.entries(args).map(([k, v]) => '<' + k + '>' + escapeXml(v) + '</' + k + '>').join('');
  return '<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + AVTRANSPORT + '">' + inner + '</u:' + action + '></s:Body></s:Envelope>';
}
async function soapCall(controlUrl, action, args) {
  const body = soapEnvelope(action, args);
  const r = await httpRequest(controlUrl, {
    method: 'POST', timeout: 8000,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPACTION': '"' + AVTRANSPORT + '#' + action + '"', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (r.status !== 200) throw new Error('Le téléviseur a refusé « ' + action + ' » (HTTP ' + r.status + ')');
  return r.body;
}
function didlMetadata(title, url, mime) {
  const cls = /^audio/.test(mime) ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1"><dc:title>' + escapeXml(title || 'zaalis Browser') + '</dc:title><upnp:class>' + cls + '</upnp:class>' +
    '<res protocolInfo="http-get:*:' + escapeXml(mime) + ':*">' + escapeXml(url) + '</res></item></DIDL-Lite>';
}
function hms(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const p = (n) => String(n).padStart(2, '0');
  return p(Math.floor(sec / 3600)) + ':' + p(Math.floor(sec / 60) % 60) + ':' + p(sec % 60);
}
const dlna = {
  async load(dev, media) {
    await soapCall(dev.avTransportUrl, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: media.url, CurrentURIMetaData: didlMetadata(media.title, media.url, media.contentType) });
    await soapCall(dev.avTransportUrl, 'Play', { InstanceID: 0, Speed: 1 });
    if (media.currentTime > 2) { try { await dlna.seek(dev, media.currentTime); } catch {} }
  },
  play: (dev) => soapCall(dev.avTransportUrl, 'Play', { InstanceID: 0, Speed: 1 }),
  pause: (dev) => soapCall(dev.avTransportUrl, 'Pause', { InstanceID: 0 }),
  stop: (dev) => soapCall(dev.avTransportUrl, 'Stop', { InstanceID: 0 }),
  seek: (dev, sec) => soapCall(dev.avTransportUrl, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(sec) }),
  async status(dev) {
    const t = await soapCall(dev.avTransportUrl, 'GetTransportInfo', { InstanceID: 0 });
    const p = await soapCall(dev.avTransportUrl, 'GetPositionInfo', { InstanceID: 0 }).catch(() => '');
    const toSec = (s) => { const m = /(\d+):(\d+):(\d+)/.exec(s || ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };
    const st = xmlText(t, 'CurrentTransportState');
    return { state: st === 'PLAYING' ? 'PLAYING' : st === 'PAUSED_PLAYBACK' ? 'PAUSED' : st === 'STOPPED' || st === 'NO_MEDIA_PRESENT' ? 'IDLE' : 'BUFFERING',
      currentTime: toSec(xmlText(p, 'RelTime')), duration: toSec(xmlText(p, 'TrackDuration')) };
  },
};

// ----- mDNS / DNS-SD -----------------------------------------------------------
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 };

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.');
  const bufs = parts.map(p => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}
function mdnsQuery(name, type, unicast) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(0, 0); h.writeUInt16BE(0, 2); h.writeUInt16BE(1, 4);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type || TYPE.PTR, 0); q.writeUInt16BE((unicast ? 0x8000 : 0) | 1, 2);
  return Buffer.concat([h, encodeName(name), q]);
}
function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  for (;;) {
    if (off >= buf.length || guard++ > 128) throw new Error('nom DNS invalide');
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}
function parseDns(buf) {
  if (buf.length < 12) throw new Error('paquet DNS trop court');
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { off = readName(buf, off).end + 4; }
  const records = [];
  for (let i = 0; i < an + ns + ar; i++) {
    const n = readName(buf, off); off = n.end;
    const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2), ttl = buf.readUInt32BE(off + 4), len = buf.readUInt16BE(off + 8);
    off += 10;
    const rd = off, rec = { name: n.name, type, cls: cls & 0x7fff, ttl };
    if (type === TYPE.PTR) rec.data = readName(buf, rd).name;
    else if (type === TYPE.SRV) rec.data = { priority: buf.readUInt16BE(rd), weight: buf.readUInt16BE(rd + 2), port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name };
    else if (type === TYPE.A) rec.data = [buf[rd], buf[rd + 1], buf[rd + 2], buf[rd + 3]].join('.');
    else if (type === TYPE.TXT) {
      const kv = {}; let p = rd;
      while (p < rd + len) { const l = buf[p]; const s = buf.toString('utf8', p + 1, p + 1 + l); const eq = s.indexOf('='); if (eq > 0) kv[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1); else if (s) kv[s.toLowerCase()] = ''; p += 1 + l; }
      rec.data = kv;
    } else rec.data = buf.subarray(rd, rd + len);
    records.push(rec);
    off = rd + len;
  }
  return records;
}
// Construit une réponse mDNS (pour les tests) : records = [{ name, type, ttl, data }]
function buildDnsResponse(records) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(0, 0); h.writeUInt16BE(0x8400, 2); h.writeUInt16BE(0, 4); h.writeUInt16BE(records.length, 6);
  const parts = [h];
  for (const r of records) {
    let rd;
    if (r.type === TYPE.PTR) rd = encodeName(r.data);
    else if (r.type === TYPE.SRV) { const a = Buffer.alloc(6); a.writeUInt16BE(r.data.priority || 0); a.writeUInt16BE(r.data.weight || 0, 2); a.writeUInt16BE(r.data.port, 4); rd = Buffer.concat([a, encodeName(r.data.target)]); }
    else if (r.type === TYPE.A) rd = Buffer.from(r.data.split('.').map(Number));
    else if (r.type === TYPE.TXT) rd = Buffer.concat(Object.entries(r.data).map(([k, v]) => { const b = Buffer.from(k + '=' + v, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); }));
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(r.type, 0); meta.writeUInt16BE(1, 2); meta.writeUInt32BE(r.ttl || 120, 4); meta.writeUInt16BE(rd.length, 8);
    parts.push(encodeName(r.name), meta, rd);
  }
  return Buffer.concat(parts);
}
// Regroupe les enregistrements en appareils Chromecast.
function castDevicesFromRecords(records) {
  const out = [];
  const ptrs = records.filter(r => r.type === TYPE.PTR && /_googlecast\._tcp\.local$/i.test(r.name));
  for (const p of ptrs) {
    const srv = records.find(r => r.type === TYPE.SRV && r.name === p.data);
    const txt = records.find(r => r.type === TYPE.TXT && r.name === p.data);
    if (!srv) continue;
    const a = records.find(r => r.type === TYPE.A && r.name === srv.data.target);
    out.push({
      kind: 'chromecast', id: (txt && txt.data.id) || p.data, name: (txt && txt.data.fn) || p.data.split('._googlecast')[0],
      model: (txt && txt.data.md) || 'Chromecast', host: a ? a.data : srv.data.target.replace(/\.$/, ''), port: srv.data.port, target: srv.data.target,
    });
  }
  return out;
}

// ----- Protobuf CastMessage ----------------------------------------------------
function varint(n) {
  const out = [];
  n = Number(n);
  while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
function readVarint(buf, off) {
  let res = 0, shift = 0, b;
  do { if (off >= buf.length) throw new Error('varint tronqué'); b = buf[off++]; res += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
  return { value: res, end: off };
}
const field = (num, wire) => varint((num << 3) | wire);
const strField = (num, s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'); return Buffer.concat([field(num, 2), varint(b.length), b]); };
function encodeCastMessage(m) {
  const parts = [field(1, 0), varint(0), strField(2, m.sourceId), strField(3, m.destinationId), strField(4, m.namespace)];
  if (m.payloadBinary) parts.push(field(5, 0), varint(1), strField(7, m.payloadBinary));
  else parts.push(field(5, 0), varint(0), strField(6, typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)));
  return Buffer.concat(parts);
}
function decodeCastMessage(buf) {
  const m = {};
  let off = 0;
  while (off < buf.length) {
    const k = readVarint(buf, off); off = k.end;
    const num = Math.floor(k.value / 8), wire = k.value & 7;
    if (wire === 0) { const v = readVarint(buf, off); off = v.end; if (num === 1) m.protocolVersion = v.value; if (num === 5) m.payloadType = v.value; }
    else if (wire === 2) {
      const l = readVarint(buf, off); off = l.end;
      const data = buf.subarray(off, off + l.value); off += l.value;
      if (num === 2) m.sourceId = data.toString('utf8');
      else if (num === 3) m.destinationId = data.toString('utf8');
      else if (num === 4) m.namespace = data.toString('utf8');
      else if (num === 6) m.payload = data.toString('utf8');
      else if (num === 7) m.payloadBinary = Buffer.from(data);
    } else throw new Error('type protobuf inattendu ' + wire);
  }
  return m;
}
function frame(msg) { const body = encodeCastMessage(msg); const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, body]); }

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';

// Session Cast v2 : connexion TLS, battement de cœur, lancement du Default
// Media Receiver, chargement et contrôle du média.
class CastClient extends EventEmitter {
  constructor(host, port) {
    super();
    this.host = host; this.port = port || 8009;
    this.sender = 'sender-zaalis'; this.reqId = 1; this.pending = new Map();
    this.transportId = ''; this.sessionId = ''; this.mediaSessionId = 0; this.buf = Buffer.alloc(0); this.closed = false;
  }
  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      // Les Chromecast présentent un certificat auto-signé propre à l'appareil
      // (réseau local) : pas de chaîne de confiance publique à vérifier.
      const sock = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false, timeout: timeoutMs || 6000 }, () => {
        sock.setTimeout(0);
        this.send(NS.connection, 'receiver-0', { type: 'CONNECT' });
        this.hb = setInterval(() => { try { this.send(NS.heartbeat, 'receiver-0', { type: 'PING' }); } catch {} }, 5000);
        resolve(this);
      });
      this.sock = sock;
      sock.on('data', (d) => this.onData(d));
      sock.on('timeout', () => { sock.destroy(new Error('Délai de connexion dépassé')); });
      sock.on('error', (e) => { if (!this.closed) { this.emit('error', e); reject(e); } });
      sock.on('close', () => this.cleanup());
    });
  }
  cleanup() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.hb);
    for (const p of this.pending.values()) p.reject(new Error('Connexion fermée'));
    this.pending.clear();
    this.emit('close');
  }
  close() { try { this.send(NS.connection, this.transportId || 'receiver-0', { type: 'CLOSE' }); } catch {} try { this.sock.end(); } catch {} this.cleanup(); }
  send(ns, dest, payload) { this.sock.write(frame({ sourceId: this.sender, destinationId: dest, namespace: ns, payload })); }
  request(ns, dest, payload, timeoutMs) {
    const requestId = this.reqId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Pas de réponse du Chromecast')); }, timeoutMs || 15000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send(ns, dest, { ...payload, requestId });
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 1024 * 1024) { this.sock.destroy(new Error('trame trop grande')); return; }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg, payload;
      try { msg = decodeCastMessage(body); payload = msg.payload ? JSON.parse(msg.payload) : null; } catch { continue; }
      if (!payload) continue;
      if (msg.namespace === NS.heartbeat && payload.type === 'PING') { try { this.send(NS.heartbeat, msg.sourceId, { type: 'PONG' }); } catch {} continue; }
      if (payload.type === 'CLOSE' && msg.namespace === NS.connection) { this.close(); continue; }
      if (payload.type === 'MEDIA_STATUS' && payload.status && payload.status[0]) {
        this.mediaSessionId = payload.status[0].mediaSessionId || this.mediaSessionId;
        this.emit('media', payload.status[0]);
      }
      if (payload.requestId && this.pending.has(payload.requestId)) {
        const p = this.pending.get(payload.requestId); this.pending.delete(payload.requestId);
        if (/^(LOAD_FAILED|LOAD_CANCELLED|INVALID_REQUEST|LAUNCH_ERROR)$/.test(payload.type)) p.reject(new Error('Le Chromecast a refusé la demande (' + payload.type + (payload.reason ? ', ' + payload.reason : '') + ')'));
        else p.resolve(payload);
      }
    }
  }
  async launch(appId) {
    const st = await this.request(NS.receiver, 'receiver-0', { type: 'LAUNCH', appId: appId || DEFAULT_MEDIA_RECEIVER }, 20000);
    const app = (st.status && st.status.applications || []).find(a => a.appId === (appId || DEFAULT_MEDIA_RECEIVER));
    if (!app) throw new Error('Impossible de lancer le lecteur sur le Chromecast');
    this.transportId = app.transportId; this.sessionId = app.sessionId;
    this.send(NS.connection, this.transportId, { type: 'CONNECT' });
    return app;
  }
  async load(media) {
    if (!this.transportId) await this.launch();
    const st = await this.request(NS.media, this.transportId, {
      type: 'LOAD', autoplay: true, currentTime: media.currentTime || 0,
      media: { contentId: media.url, contentType: media.contentType, streamType: media.live ? 'LIVE' : 'BUFFERED',
        metadata: { metadataType: 0, title: media.title || '', images: media.poster ? [{ url: media.poster }] : [] } },
    }, 30000);
    const s = st.status && st.status[0];
    if (s) { this.mediaSessionId = s.mediaSessionId; this.emit('media', s); }
    return s;
  }
  mediaCmd(type, extra) {
    if (!this.mediaSessionId) return Promise.reject(new Error('Aucun média en cours'));
    return this.request(NS.media, this.transportId, { type, mediaSessionId: this.mediaSessionId, ...(extra || {}) });
  }
  play() { return this.mediaCmd('PLAY'); }
  pause() { return this.mediaCmd('PAUSE'); }
  seek(t) { return this.mediaCmd('SEEK', { currentTime: t }); }
  async stop() {
    try { await this.mediaCmd('STOP'); } catch {}
    try { if (this.sessionId) await this.request(NS.receiver, 'receiver-0', { type: 'STOP', sessionId: this.sessionId }, 5000); } catch {}
  }
}

// ----- Découverte --------------------------------------------------------------
function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
function discoverSsdp(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map();
    const socks = [];
    const ifaces = localIPv4s();
    for (const addr of ifaces.length ? ifaces : [undefined]) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('message', (m) => { const r = parseSsdpResponse(m); if (r && !found.has(r.location)) found.set(r.location, r); });
        s.on('error', () => {});
        s.bind(0, addr, () => {
          try { s.setMulticastTTL(2); } catch {}
          const msg = ssdpSearchMessage(MEDIA_RENDERER, 2);
          s.send(msg, SSDP_PORT, SSDP_ADDR); setTimeout(() => { try { s.send(msg, SSDP_PORT, SSDP_ADDR); } catch {} }, 400);
        });
        socks.push(s);
      } catch {}
    }
    setTimeout(async () => {
      socks.forEach(s => { try { s.close(); } catch {} });
      const devices = [];
      await Promise.all([...found.values()].map(async (r) => {
        try {
          const d = await httpRequest(r.location, { timeout: 3000 });
          const desc = parseDeviceDescription(d.body, r.location);
          if (desc.avTransportUrl) devices.push({ kind: 'dlna', id: r.usn || r.location, name: desc.name || new URL(r.location).hostname, model: desc.model, avTransportUrl: desc.avTransportUrl, location: r.location });
        } catch {}
      }));
      resolve(devices);
    }, timeoutMs || 2500);
  });
}
function discoverMdns(timeoutMs) {
  return new Promise((resolve) => {
    const records = [];
    const socks = [];
    const ifaces = localIPv4s();
    for (const addr of ifaces.length ? ifaces : [undefined]) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('message', (m) => { try { records.push(...parseDns(m)); } catch {} });
        s.on('error', () => {});
        s.bind(0, addr, () => {
          try { if (addr) s.setMulticastInterface(addr); } catch {}
          const q = mdnsQuery('_googlecast._tcp.local', TYPE.PTR, true);
          s.send(q, MDNS_PORT, MDNS_ADDR); setTimeout(() => { try { s.send(q, MDNS_PORT, MDNS_ADDR); } catch {} }, 500);
        });
        socks.push(s);
      } catch {}
    }
    setTimeout(() => {
      socks.forEach(s => { try { s.close(); } catch {} });
      const devs = castDevicesFromRecords(records);
      const uniq = new Map(); devs.forEach(d => uniq.set(d.id, d));
      resolve([...uniq.values()]);
    }, timeoutMs || 2500);
  });
}

module.exports = {
  ssdpSearchMessage, parseSsdpResponse, parseDeviceDescription, soapEnvelope, soapCall, didlMetadata, hms, dlna, httpRequest,
  mdnsQuery, parseDns, buildDnsResponse, castDevicesFromRecords, encodeName, TYPE,
  encodeCastMessage, decodeCastMessage, frame, varint, readVarint, CastClient, NS, DEFAULT_MEDIA_RECEIVER,
  discoverSsdp, discoverMdns, escapeXml,
};
