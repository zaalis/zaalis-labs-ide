'use strict';
/* =============================================================================
 *  Moteur de synchronisation sans serveur (chiffré de bout en bout)
 * -----------------------------------------------------------------------------
 *  Un « coffre » est un dossier partagé (OneDrive, Drive, Dropbox, clé USB,
 *  partage réseau…) :
 *    zaalis-sync/vault.json            sel + paramètres scrypt + vérificateur
 *    zaalis-sync/devices/<id>.zsync    un fichier chiffré par appareil
 *  Chaque appareil n'écrit QUE son propre fichier : aucun conflit d'écriture
 *  entre clients de stockage en ligne. Le contenu est un ensemble
 *  d'enregistrements { v, ts } ou { del:1, ts } par collection ; la fusion
 *  garde l'horodatage le plus récent (last-writer-wins, suppressions par
 *  pierres tombales conservées 90 jours).
 *  Chiffrement : clé dérivée de la phrase secrète (scrypt N=2^15, r=8, p=1,
 *  sel aléatoire du coffre), AES-256-GCM avec l'identifiant d'appareil en
 *  données authentifiées.
 * =========================================================================== */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const CHECK_TEXT = 'zaalis-sync-ok';
const KDF = { N: 32768, r: 8, p: 1 };
const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;

function vaultDir(folder) { return path.join(folder, 'zaalis-sync'); }
function seal(key, obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}
function deriveKey(passphrase, saltB64, kdf) {
  const k = kdf || KDF;
  return crypto.scryptSync(String(passphrase).normalize('NFKC'), Buffer.from(saltB64, 'base64'), 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 });
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// Ouvre (ou crée) le coffre et renvoie la clé. Erreur explicite si la phrase
// secrète ne correspond pas à celle du coffre existant.
function unlockVault(folder, passphrase, opts) {
  opts = opts || {};
  if (String(passphrase || '').length < 8) throw new Error('La phrase secrète doit contenir au moins 8 caractères.');
  const dir = vaultDir(folder);
  const vf = path.join(dir, 'vault.json');
  if (fs.existsSync(vf)) {
    const v = JSON.parse(fs.readFileSync(vf, 'utf8'));
    if (v.format !== FORMAT) throw new Error('Coffre de synchronisation d\'une version incompatible.');
    const key = deriveKey(passphrase, v.salt, v.kdf);
    let ok = false;
    try { ok = open(key, v.check, 'vault') === CHECK_TEXT; } catch { ok = false; }
    if (!ok) throw new Error('Phrase secrète incorrecte pour ce dossier de synchronisation.');
    return { key, created: false };
  }
  if (opts.mustExist) throw new Error('Aucun coffre de synchronisation dans ce dossier.');
  const salt = crypto.randomBytes(16).toString('base64');
  const kdf = opts.kdf || KDF;
  const key = deriveKey(passphrase, salt, kdf);
  writeAtomic(vf, JSON.stringify({ format: FORMAT, salt, kdf, check: seal(key, CHECK_TEXT, 'vault'), createdAt: Date.now() }, null, 2));
  fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
  return { key, created: true };
}
function vaultExists(folder) { return fs.existsSync(path.join(vaultDir(folder), 'vault.json')); }

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// adapters : { [collection]: { collect() -> {key: value}, exists?(key) -> bool, apply(recordsMap, changedKeys) } }
// state : { load() -> {records}, save(state) }
class SyncEngine {
  constructor(o) {
    this.folder = o.folder; this.key = o.key; this.deviceId = o.deviceId;
    this.deviceName = o.deviceName || 'Appareil'; this.platform = o.platform || process.platform;
    this.adapters = o.adapters || {}; this.stateStore = o.state; this.getTabs = o.getTabs || (() => []);
    this.now = o.now || (() => Date.now());
    this.lastWritten = '';
    this.remotes = [];
  }
  get devicesDir() { return path.join(vaultDir(this.folder), 'devices'); }
  deviceFile(id) { return path.join(this.devicesDir, id.replace(/[^a-z0-9-]/gi, '') + '.zsync'); }

  readRemotes() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.devicesDir).filter(f => f.endsWith('.zsync')); } catch { return out; }
    for (const f of files) {
      const id = f.slice(0, -6);
      if (id === this.deviceId) continue;
      try {
        const box = JSON.parse(fs.readFileSync(path.join(this.devicesDir, f), 'utf8'));
        if (box.format !== FORMAT || box.deviceId !== id) continue;
        const p = open(this.key, box, id);
        if (p.deviceId !== id) continue;
        out.push(p);
      } catch (e) { out.push({ deviceId: id, error: 'illisible (' + (e.message || e) + ')' }); }
    }
    return out;
  }

  // Une passe complète : détecte les changements locaux, fusionne les autres
  // appareils, applique localement, écrit le fichier de cet appareil.
  run() {
    const now = this.now();
    const st = this.stateStore.load() || {};
    const records = st.records || {};
    const report = { changedLocal: 0, applied: 0, devices: 0 };
    for (const [coll, ad] of Object.entries(this.adapters)) {
      const rec = records[coll] || (records[coll] = {});
      let cur = {};
      try { cur = ad.collect() || {}; } catch (e) { continue; }
      for (const [k, v] of Object.entries(cur)) {
        if (!rec[k] || rec[k].del || !same(rec[k].v, v)) { rec[k] = { v, ts: now }; report.changedLocal++; }
      }
      for (const [k, r] of Object.entries(rec)) {
        if (!r.del && !(k in cur) && !(ad.exists && ad.exists(k))) { rec[k] = { del: 1, ts: now }; report.changedLocal++; }
      }
    }
    const remotes = this.readRemotes();
    this.remotes = remotes;
    const changed = {};
    for (const r of remotes) {
      if (r.error || !r.records) continue;
      report.devices++;
      for (const [coll, map] of Object.entries(r.records)) {
        if (!this.adapters[coll]) continue;
        const rec = records[coll] || (records[coll] = {});
        for (const [k, rr] of Object.entries(map || {})) {
          if (!rr || typeof rr.ts !== 'number') continue;
          const mine = rec[k];
          if (!mine || rr.ts > mine.ts || (rr.ts === mine.ts && r.deviceId > this.deviceId && !same(rr, mine))) {
            if (mine && same(mine.v, rr.v) && !!mine.del === !!rr.del) { rec[k] = rr; continue; }
            rec[k] = rr;
            (changed[coll] || (changed[coll] = new Set())).add(k);
          }
        }
      }
    }
    for (const [coll, keys] of Object.entries(changed)) {
      try { this.adapters[coll].apply(records[coll], keys); report.applied += keys.size; } catch (e) { console.error('[sync] application', coll, e); }
    }
    // Purge des pierres tombales anciennes + bornes par collection.
    for (const [coll, rec] of Object.entries(records)) {
      for (const [k, r] of Object.entries(rec)) if (r.del && now - r.ts > TOMBSTONE_TTL) delete rec[k];
      const ad = this.adapters[coll];
      if (ad && ad.maxRecords && Object.keys(rec).length > ad.maxRecords) {
        const keys = Object.keys(rec).sort((a, b) => rec[b].ts - rec[a].ts);
        for (const k of keys.slice(ad.maxRecords)) delete rec[k];
      }
    }
    this.stateStore.save({ records });
    // Fichier de l'appareil : réécrit seulement s'il change.
    let tabs = [];
    try { tabs = this.getTabs() || []; } catch {}
    const payload = { deviceId: this.deviceId, name: this.deviceName, platform: this.platform, records, tabs };
    const sig = JSON.stringify(payload);
    if (sig !== this.lastWritten || !fs.existsSync(this.deviceFile(this.deviceId))) {
      const box = seal(this.key, { ...payload, updatedAt: now }, this.deviceId);
      writeAtomic(this.deviceFile(this.deviceId), JSON.stringify({ format: FORMAT, deviceId: this.deviceId, ...box }));
      this.lastWritten = sig;
    }
    return report;
  }

  devices() {
    return this.remotes.map(r => ({ deviceId: r.deviceId, name: r.name || r.deviceId, platform: r.platform || '', updatedAt: r.updatedAt || 0,
      tabs: Array.isArray(r.tabs) ? r.tabs.slice(0, 100) : [], error: r.error || '' }));
  }
  removeOwnFile() { try { fs.unlinkSync(this.deviceFile(this.deviceId)); } catch {} }
}

function eraseVault(folder) { fs.rmSync(vaultDir(folder), { recursive: true, force: true }); }

module.exports = { SyncEngine, unlockVault, vaultExists, eraseVault, vaultDir, deriveKey, seal, open, KDF };
