'use strict';
/* =============================================================================
 *  Lecture des paquets d'extension Chrome (.crx), sans dépendance.
 *
 *  CRX3 : "Cr24" | uint32 version=3 | uint32 taille d'en-tête | en-tête
 *         (protobuf CrxFileHeader) | archive ZIP
 *    CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *                    repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
 *                    bytes signed_header_data = 10000; }
 *    AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
 *    SignedData { bytes crx_id = 1; }
 *    Données signées : "CRX3 SignedData\0" | uint32le(len(signed_header_data))
 *                      | signed_header_data | archive ZIP
 *  CRX2 : "Cr24" | uint32 version=2 | uint32 len(clé) | uint32 len(signature)
 *         | clé | signature (SHA1withRSA de l'archive) | archive ZIP
 *
 *  L'identifiant d'extension = 16 premiers octets de SHA-256(clé publique
 *  DER), chaque demi-octet écrit avec les lettres a..p.
 * =========================================================================== */

const crypto = require('crypto');

function idFromBytes(bytes) {
  let s = '';
  for (const b of bytes.subarray(0, 16)) s += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
  return s;
}
function idFromPublicKey(der) { return idFromBytes(crypto.createHash('sha256').update(der).digest()); }
function isExtensionId(id) { return /^[a-p]{32}$/.test(String(id || '')); }

// Lecteur protobuf minimal (varints + champs « length-delimited »).
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos >= buf.length) throw new Error('protobuf tronqué');
    b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (shift > 63) throw new Error('varint invalide');
  } while (b & 0x80);
  return [result, pos];
}
function parseProto(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let key; [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); fields.push({ field, value: v }); }
    else if (wire === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new Error('protobuf tronqué');
      fields.push({ field, bytes: buf.subarray(pos, pos + len) }); pos += len;
    }
    else if (wire === 5) { pos += 4; }
    else if (wire === 1) { pos += 8; }
    else throw new Error('type protobuf non pris en charge : ' + wire);
  }
  return fields;
}

function derKey(der) { return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }

// Analyse et vérifie un .crx. Renvoie { version, id, publicKey (DER), zip }.
// expectedId (facultatif) : l'identifiant demandé au Web Store doit correspondre.
function parseCrx(buf, expectedId) {
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('ce fichier n\'est pas une extension Chrome (.crx)');
  const version = buf.readUInt32LE(4);
  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    if (12 + headerSize > buf.length) throw new Error('en-tête CRX3 tronqué');
    const header = buf.subarray(12, 12 + headerSize);
    const zip = buf.subarray(12 + headerSize);
    const fields = parseProto(header);
    const signedHeader = (fields.find(f => f.field === 10000) || {}).bytes;
    if (!signedHeader) throw new Error('CRX3 sans données signées');
    const crxIdBytes = (parseProto(signedHeader).find(f => f.field === 1) || {}).bytes;
    if (!crxIdBytes || crxIdBytes.length !== 16) throw new Error('identifiant CRX3 absent');
    const crxId = idFromBytes(crxIdBytes);
    const lenLE = Buffer.alloc(4); lenLE.writeUInt32LE(signedHeader.length, 0);
    const signedData = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), lenLE, signedHeader, zip]);
    let developerKey = null;
    let verifiedAny = false;
    for (const f of fields) {
      if (f.field !== 2 && f.field !== 3) continue;
      const proof = parseProto(f.bytes);
      const pub = (proof.find(p => p.field === 1) || {}).bytes;
      const sig = (proof.find(p => p.field === 2) || {}).bytes;
      if (!pub || !sig) continue;
      let ok = false;
      try { ok = crypto.verify('sha256', signedData, derKey(pub), sig); } catch { ok = false; }
      if (!ok) throw new Error('signature du paquet CRX invalide');
      verifiedAny = true;
      if (idFromPublicKey(pub) === crxId) developerKey = Buffer.from(pub);
    }
    if (!verifiedAny) throw new Error('paquet CRX non signé');
    if (!developerKey) throw new Error('aucune clé du paquet ne correspond à son identifiant');
    if (expectedId && crxId !== expectedId) throw new Error('le paquet reçu ne correspond pas à l\'extension demandée');
    return { version: 3, id: crxId, publicKey: developerKey, zip: Buffer.from(zip) };
  }
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8), sigLen = buf.readUInt32LE(12);
    if (16 + keyLen + sigLen > buf.length) throw new Error('en-tête CRX2 tronqué');
    const pub = buf.subarray(16, 16 + keyLen);
    const sig = buf.subarray(16 + keyLen, 16 + keyLen + sigLen);
    const zip = buf.subarray(16 + keyLen + sigLen);
    let ok = false;
    try { ok = crypto.verify('sha1', zip, derKey(pub), sig); } catch { ok = false; }
    if (!ok) throw new Error('signature du paquet CRX invalide');
    const id = idFromPublicKey(pub);
    if (expectedId && id !== expectedId) throw new Error('le paquet reçu ne correspond pas à l\'extension demandée');
    return { version: 2, id, publicKey: Buffer.from(pub), zip: Buffer.from(zip) };
  }
  throw new Error('version CRX non prise en charge : ' + version);
}

// Construit un CRX3 signé (tests et outils de développement).
function buildCrx3(zip, privateKey) {
  const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const idBytes = crypto.createHash('sha256').update(pub).digest().subarray(0, 16);
  const ld = (field, bytes) => Buffer.concat([encVarint(field * 8 + 2), encVarint(bytes.length), bytes]);
  const signedHeader = ld(1, idBytes);
  const lenLE = Buffer.alloc(4); lenLE.writeUInt32LE(signedHeader.length, 0);
  const sig = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), lenLE, signedHeader, zip]), privateKey);
  const header = Buffer.concat([ld(2, Buffer.concat([ld(1, pub), ld(2, sig)])), ld(10000, signedHeader)]);
  const head = Buffer.alloc(12); head.write('Cr24', 0, 'latin1'); head.writeUInt32LE(3, 4); head.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([head, header, zip]), id: idFromBytes(idBytes), publicKey: pub };
}
function encVarint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}

module.exports = { parseCrx, buildCrx3, idFromPublicKey, isExtensionId };
