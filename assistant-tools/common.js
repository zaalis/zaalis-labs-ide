'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitize } = require('../src/agent/secrets-mask');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const fail = (message, code = 'invalid_input', status = 400) => Object.assign(new Error(message), { code, status });
function text(value, name, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} is required (maximum ${max} characters).`);
  return value;
}
function within(root, relative, mustExist = false) {
  root = fs.realpathSync(root);
  const target = path.resolve(root, String(relative || '.'));
  const inside = candidate => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(target)) throw fail('Path outside the selected workspace.', 'path_denied', 403);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw fail('Invalid path.');
    probe = parent;
  }
  if (!inside(fs.realpathSync(probe))) throw fail('Symbolic link outside the selected workspace.', 'path_denied', 403);
  if (mustExist && !fs.existsSync(target)) throw fail('File not found.', 'not_found', 404);
  return target;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
class Store {
  constructor(dataDir) { this.root = path.join(dataDir, 'assistant'); }
  file(user, collection) {
    if (!/^[a-z][a-z0-9-]*$/.test(collection)) throw fail('Invalid collection.');
    return path.join(this.root, hash(user), collection + '.json');
  }
  read(user, collection, fallback = []) {
    const file = this.file(user, collection);
    if (!fs.existsSync(file)) return structuredClone(fallback);
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw fail('Store exceeds its size limit.', 'store_limit');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  write(user, collection, data) {
    if (Buffer.byteLength(JSON.stringify(data)) > 16 * 1024 * 1024) throw fail('Store exceeds its size limit.', 'store_limit');
    atomic(this.file(user, collection), data); return data;
  }
}
function publicData(value) { return JSON.parse(sanitize(JSON.stringify(value))); }
function readonly(action = '') { return /^(list|show|read|search|status|history|inspect|view|browse|get|query|catalog|targets|devices|albums|services|state|poll|log|wait)$/.test(action); }
module.exports = { fs, path, crypto, hash, fail, text, within, atomic, Store, publicData, readonly };
