'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// A replacement is atomic on the same volume. Readers see the old or new file,
// never a partially written JSON document. All store mutations are synchronous.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function safeKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
}
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function copy(value) { return structuredClone(value); }

module.exports = { readJson, writeJson, safeKey, fail, copy };
