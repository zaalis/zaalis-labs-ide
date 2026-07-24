'use strict';

// Durable conversation storage: SQLite is the index, JSONL is the immutable
// event log. A JSON fallback keeps source/dev builds usable on runtimes where
// node:sqlite is not bundled, while preserving the exact same API.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function writeAtomic(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, value, { mode });
  let fd = null;
  try { fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); } catch {} finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch {}
}

function normalizeText(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }

class SessionStore {
  constructor({ dataDir }) {
    this.root = path.join(path.resolve(dataDir), 'agent-sessions');
    this.logsDir = path.join(this.root, 'logs');
    mkdirPrivate(this.root); mkdirPrivate(this.logsDir);
    this.db = null; this.fallbackFile = path.join(this.root, 'index.json');
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(path.join(this.root, 'sessions.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, cwd TEXT NOT NULL,
          title TEXT NOT NULL, model TEXT, submodel TEXT, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, parent_id TEXT,
          archived_at INTEGER, event_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS sessions_user_cwd ON sessions(user_id, cwd, updated_at DESC);
        CREATE INDEX IF NOT EXISTS sessions_user_status ON sessions(user_id, status, updated_at DESC);`);
    } catch { this.ensureFallback(); }
  }

  ensureFallback() {
    if (!fs.existsSync(this.fallbackFile)) writeAtomic(this.fallbackFile, JSON.stringify({ sessions: [] }, null, 2));
  }

  fallback() { this.ensureFallback(); try { return JSON.parse(fs.readFileSync(this.fallbackFile, 'utf8')); } catch { return { sessions: [] }; } }
  saveFallback(data) { writeAtomic(this.fallbackFile, JSON.stringify(data, null, 2)); }
  logFile(id) { return path.join(this.logsDir, `${id}.jsonl`); }

  create({ userId, cwd, title, model, submodel, parentId } = {}) {
    const now = Date.now();
    const row = {
      id: `session_${crypto.randomUUID()}`,
      userId: normalizeText(userId, 128), cwd: path.resolve(cwd || process.cwd()),
      title: normalizeText(title, 160) || 'Nouvelle conversation', model: normalizeText(model, 160), submodel: normalizeText(submodel, 160),
      status: 'active', createdAt: now, updatedAt: now, parentId: normalizeText(parentId, 128) || null, archivedAt: null, eventCount: 0,
    };
    if (this.db) {
      this.db.prepare('INSERT INTO sessions (id,user_id,cwd,title,model,submodel,status,created_at,updated_at,parent_id,archived_at,event_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.userId, row.cwd, row.title, row.model, row.submodel, row.status, now, now, row.parentId, null, 0);
    } else { const db = this.fallback(); db.sessions.push(row); this.saveFallback(db); }
    this.append(row.id, { type: 'session_created', sessionId: row.id, userId: row.userId, cwd: row.cwd, title: row.title, ts: now });
    return row;
  }

  map(row) {
    if (!row) return null;
    return { id: row.id, userId: row.user_id ?? row.userId, cwd: row.cwd, title: row.title, model: row.model || '', submodel: row.submodel || '', status: row.status, createdAt: Number(row.created_at ?? row.createdAt), updatedAt: Number(row.updated_at ?? row.updatedAt), parentId: row.parent_id ?? row.parentId ?? null, archivedAt: row.archived_at ?? row.archivedAt ?? null, eventCount: Number(row.event_count ?? row.eventCount ?? 0) };
  }

  get(id, userId) {
    const row = this.db
      ? this.db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(String(id), String(userId))
      : this.fallback().sessions.find((item) => item.id === id && item.userId === userId);
    return this.map(row);
  }

  list({ userId, cwd, includeArchived = false, query = '', limit = 100 } = {}) {
    const wantedCwd = cwd ? path.resolve(cwd) : '';
    const max = Math.max(1, Math.min(Number(limit) || 100, 500));
    const needle = normalizeText(query, 160).toLowerCase();
    if (this.db) {
      let sql = 'SELECT * FROM sessions WHERE user_id = ?'; const params = [String(userId)];
      if (wantedCwd) { sql += ' AND cwd = ?'; params.push(wantedCwd); }
      if (!includeArchived) sql += " AND status != 'archived'";
      if (needle) { sql += ' AND lower(title) LIKE ?'; params.push(`%${needle}%`); }
      sql += ' ORDER BY updated_at DESC LIMIT ?'; params.push(max);
      return this.db.prepare(sql).all(...params).map((row) => this.map(row));
    }
    return this.fallback().sessions.filter((row) => row.userId === userId && (!wantedCwd || row.cwd === wantedCwd) && (includeArchived || row.status !== 'archived') && (!needle || row.title.toLowerCase().includes(needle))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max).map((row) => this.map(row));
  }

  update(id, userId, patch) {
    const current = this.get(id, userId); if (!current) return null;
    const now = Date.now();
    const next = {
      title: patch.title === undefined ? current.title : (normalizeText(patch.title, 160) || current.title),
      status: patch.status === undefined ? current.status : (patch.status === 'archived' ? 'archived' : 'active'),
      model: patch.model === undefined ? current.model : normalizeText(patch.model, 160),
      submodel: patch.submodel === undefined ? current.submodel : normalizeText(patch.submodel, 160),
      archivedAt: patch.status === 'archived' ? now : (patch.status === 'active' ? null : current.archivedAt),
    };
    if (this.db) this.db.prepare('UPDATE sessions SET title=?, model=?, submodel=?, status=?, updated_at=?, archived_at=? WHERE id=? AND user_id=?').run(next.title, next.model, next.submodel, next.status, now, next.archivedAt, id, userId);
    else { const db = this.fallback(); const index = db.sessions.findIndex((row) => row.id === id && row.userId === userId); Object.assign(db.sessions[index], next, { updatedAt: now }); this.saveFallback(db); }
    this.append(id, { type: 'session_updated', patch: next, ts: now });
    return this.get(id, userId);
  }

  append(id, event) {
    const line = JSON.stringify({ id: `event_${crypto.randomUUID()}`, ts: Date.now(), ...event }) + '\n';
    fs.appendFileSync(this.logFile(id), line, { mode: 0o600 });
    try { fs.chmodSync(this.logFile(id), 0o600); } catch {}
    const now = Date.now();
    if (this.db) this.db.prepare('UPDATE sessions SET updated_at=?, event_count=event_count+1 WHERE id=?').run(now, id);
    else { const db = this.fallback(); const row = db.sessions.find((item) => item.id === id); if (row) { row.updatedAt = now; row.eventCount = Number(row.eventCount || 0) + 1; this.saveFallback(db); } }
  }

  events(id, userId, { limit = 10000 } = {}) {
    if (!this.get(id, userId)) return null;
    try {
      const rows = fs.readFileSync(this.logFile(id), 'utf8').trim().split('\n').filter(Boolean).slice(-Math.max(1, Math.min(Number(limit) || 10000, 100000)));
      // A crash can leave only the final JSONL line torn. Preserve every
      // complete event before it instead of hiding an otherwise recoverable
      // conversation behind a single parse failure.
      const events = [];
      for (const line of rows) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      return events;
    } catch { return []; }
  }

  fork(id, userId, { title } = {}) {
    const source = this.get(id, userId); if (!source) return null;
    const child = this.create({ userId, cwd: source.cwd, title: title || `${source.title} — branche`, model: source.model, submodel: source.submodel, parentId: source.id });
    for (const event of this.events(source.id, userId) || []) this.append(child.id, { type: 'forked_event', sourceSessionId: source.id, event });
    return child;
  }

  export(id, userId) {
    const session = this.get(id, userId); if (!session) return null;
    return { session, events: this.events(id, userId) || [] };
  }
}

module.exports = { SessionStore, writeAtomic };
