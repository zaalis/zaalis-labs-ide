'use strict';
/* =============================================================================
 *  Lecteur / extracteur ZIP minimal (stocké + deflate), sans dépendance.
 *  Protections : chemins absolus, « .. », lecteurs Windows, noms réservés et
 *  liens refusés (zip-slip) ; plafond du nombre d'entrées et de la taille
 *  décompressée (bombes zip) ; CRC-32 vérifié.
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_ENTRIES = 20000;
const MAX_TOTAL = 512 * 1024 * 1024;

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function readEntries(zip) {
  // Fin du répertoire central (cherchée depuis la fin, commentaire ≤ 64 Ko).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('archive ZIP invalide');
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('archive ZIP64 non prise en charge');
  if (count > MAX_ENTRIES) throw new Error('archive trop volumineuse');
  if (cdOffset + cdSize > zip.length) throw new Error('répertoire ZIP tronqué');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('entrée ZIP invalide');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28), elen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32);
    const attrs = zip.readUInt32LE(p + 38);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, method, crc, csize, usize, local, flags, attrs });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

function safeRelative(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) return null;
  const parts = n.split('/').filter(x => x !== '' && x !== '.');
  if (parts.some(x => x === '..' || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(x) || /[<>:"|?*]/.test(x))) return null;
  return parts.join('/');
}

function entryData(zip, e) {
  const p = e.local;
  if (zip.readUInt32LE(p) !== 0x04034b50) throw new Error('en-tête local ZIP invalide');
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
  const raw = zip.subarray(start, start + e.csize);
  if (raw.length !== e.csize) throw new Error('données ZIP tronquées');
  if (e.flags & 1) throw new Error('archive chiffrée non prise en charge');
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
  else throw new Error('méthode de compression non prise en charge : ' + e.method);
  if (data.length !== e.usize) throw new Error('taille décompressée incorrecte : ' + e.name);
  if (crc32(data) !== e.crc) throw new Error('somme de contrôle incorrecte : ' + e.name);
  return data;
}

// Lit tous les fichiers en mémoire : Map(chemin relatif -> Buffer).
function readZip(zip) {
  const out = new Map();
  let total = 0;
  for (const e of readEntries(zip)) {
    const rel = safeRelative(e.name);
    if (rel === null) throw new Error('chemin dangereux dans l\'archive : ' + e.name);
    if (!rel || e.name.endsWith('/')) continue;
    // Lien symbolique Unix (attributs externes S_IFLNK) : refusé.
    if (((e.attrs >>> 16) & 0o170000) === 0o120000) throw new Error('lien symbolique refusé : ' + e.name);
    total += e.usize;
    if (total > MAX_TOTAL) throw new Error('archive décompressée trop volumineuse');
    out.set(rel, entryData(zip, e));
  }
  return out;
}

function extractZip(zip, destDir) {
  const files = readZip(zip);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, data] of files) {
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('chemin hors du dossier : ' + rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return files.size;
}

// Écrit une archive ZIP (deflate) — tests et outils.
function buildZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const n = Object.keys(files).length;
  end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { readZip, extractZip, buildZip, safeRelative, crc32 };
