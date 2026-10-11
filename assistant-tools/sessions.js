'use strict';
const { fs, path, hash, crypto, fail, publicData } = require('./common');
class SessionTools {
  constructor(store, dataDir) { this.store = store; this.dataDir = dataDir; }
  record(ctx, message, result) {
    const rows = this.store.read(ctx.userId, 'sessions');
    const id = ctx.conversationId || result.sessionId || crypto.randomUUID();
    let row = rows.find(r => r.id === id);
    if (!row) { row = { id, root: ctx.root, title: String(message).slice(0, 160), createdAt: new Date().toISOString(), messages: [] }; rows.push(row); }
    row.updatedAt = new Date().toISOString();
    row.messages.push({ id: crypto.randomUUID(), role: 'user', content: String(message), time: row.updatedAt }, { id: crypto.randomUUID(), role: 'assistant', content: String(result.response || ''), time: row.updatedAt });
    row.messages = publicData(row.messages.slice(-500));
    this.store.write(ctx.userId, 'sessions', rows.slice(-500)); return id;
  }
  rows(ctx) {
    const rows = this.store.read(ctx.userId, 'sessions');
    // The account's IDE history is read without importing or rewriting it.
    for (const kind of ['chat', 'agents']) {
      const file = path.join(this.dataDir, 'chats', ctx.userId + '__' + kind + '.json');
      try {
        if (fs.statSync(file).size > 16 * 1024 * 1024) continue;
        for (const item of JSON.parse(fs.readFileSync(file, 'utf8'))) {
          if (!item.id || rows.some(row => row.id === item.id)) continue;
          const messages = (item.messages || item.history || []).map((m, index) => ({ id: m.id || `${item.id}:${index}`, role: m.role || m.type || 'unknown', content: String(m.content || m.text || '').slice(0, 100000) }));
          rows.push({ id: item.id, title: item.title || item.name || '', root: item.projectPath || '', messages, updatedAt: item.updatedAt || item.timestamp });
        }
      } catch (error) { if (error.code !== 'ENOENT') ctx.warn?.('History could not be read: ' + error.message); }
    }
    return rows;
  }
  run(input, ctx) {
    const rows = this.rows(ctx).filter(row => input.scope === 'account' || row.root === ctx.root);
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
    if (input.session_id) {
      const row = rows.find(r => r.id === input.session_id); if (!row) throw fail('Session not found in this scope.', 'not_found', 404);
      let start = Math.max(0, Number(input.offset) || 0);
      if (input.around_message_id) { const index = row.messages.findIndex(m => m.id === input.around_message_id); if (index < 0) throw fail('Message not found.'); start = Math.max(0, index - Math.floor(limit / 2)); }
      return publicData({ ...row, total: row.messages.length, messages: row.messages.slice(start, start + limit), offset: start });
    }
    const terms = String(input.query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean), excluded = new Set(input.exclude_session_ids || []);
    const after = date(input.after), before = date(input.before);
    const hits = [];
    for (const row of rows) {
      if (excluded.has(row.id) || (after && Date.parse(row.updatedAt) < after) || (before && Date.parse(row.updatedAt) > before)) continue;
      const messages = row.messages.filter(m => terms.every(term => String(m.content).toLocaleLowerCase().includes(term)));
      if (!terms.length || messages.length || terms.every(term => String(row.title).toLocaleLowerCase().includes(term))) hits.push({ id: row.id, root: row.root, title: row.title, updatedAt: row.updatedAt, matches: terms.length ? messages.slice(0, 5) : [] });
    }
    return publicData({ sessions: hits.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit), total: hits.length });
  }
}
function date(value) { if (!value) return 0; const m = /^(\d+)(h|d|w)$/.exec(value); const result = m ? Date.now() - Number(m[1]) * ({ h: 3600000, d: 86400000, w: 604800000 }[m[2]]) : Date.parse(value); if (!Number.isFinite(result)) throw fail('Invalid time bound.'); return result; }
module.exports = { SessionTools };
