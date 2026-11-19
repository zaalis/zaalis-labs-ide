'use strict';
// Secrets at rest (Google tokens, model keys, subscription sessions) are sealed
// with AES-256-GCM under a master key that lives only in the server's data
// directory (mode 600) or GLYPHES_MASTER_KEY. Each record is bound to its
// owner and purpose through the GCM additional data, so a sealed value copied
// to another user's row does not open.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let master;
function init(dataDir) {
  const fromEnv = process.env.GLYPHES_MASTER_KEY;
  if (fromEnv) { master = Buffer.from(fromEnv, 'base64'); if (master.length !== 32) throw new Error('GLYPHES_MASTER_KEY doit faire 32 octets (base64).'); return; }
  const file = path.join(dataDir, 'master.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  master = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}
function seal(plain, context) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  c.setAAD(Buffer.from(String(context)));
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function open(sealed, context) {
  if (!sealed) return null;
  try {
    const [v, iv, tag, data] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(String(context)));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
function hmac(value, purpose) { return crypto.createHmac('sha256', master).update(purpose + ':' + value).digest('base64url'); }

module.exports = { init, seal, open, hash, token, hmac };
