'use strict';

// IDE error journal: one JSON object per line in <data>/logs/ide-errors.log.
// Every entry keeps the clear message shown to the user apart from the
// technical detail used for diagnosis. Secrets never belong here: the detail
// is masked and bounded before it is written. The file rotates at 1 MB
// (one previous generation kept as ide-errors.1.log).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
const FIELD_LIMIT = 2000;

function bounded(value, limit = FIELD_LIMIT) {
  const text = String(value == null ? '' : value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

// Bearer tokens, API keys and credentials in URLs are masked; the journal is a
// support aid, it must stay safe to share.
function mask(value) {
  return bounded(value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[masqué]')
    .replace(/\b(sk|xai|ghp|gho|github_pat|AIza)[-_A-Za-z0-9]{12,}/g, '[clé masquée]')
    .replace(/([?&](?:key|token|api_key|access_token)=)[^&\s]+/gi, '$1[masqué]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[identifiants masqués]@');
}

class ErrorJournal {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'logs');
    this.file = path.join(this.dir, 'ide-errors.log');
  }

  // source: where it happened (browser, web-search, interface…); code: a short
  // stable identifier; message: what the user reads; detail: technical cause.
  record({ source = 'ide', code = 'error', message = '', detail = '', context = null, userId = '' } = {}) {
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: bounded(source, 60),
      code: bounded(code, 80),
      message: bounded(message, 500),
      detail: mask(detail),
      ...(context && typeof context === 'object' ? { context: JSON.parse(mask(JSON.stringify(context))) } : {}),
      ...(userId ? { user: crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12) } : {}),
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, path.join(this.dir, 'ide-errors.1.log'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      // The journal must never turn an error into a second one.
    }
    return entry;
  }

  // Most recent entries first.
  recent(limit = 100) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const entries = [];
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { continue; }
      if (entries.length >= limit) break;
    }
    return entries;
  }
}

module.exports = { ErrorJournal, mask };
