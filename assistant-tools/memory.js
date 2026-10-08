'use strict';
const { hash, crypto, text, fail, publicData } = require('./common');
class MemoryTools {
  constructor(store) { this.store = store; }
  run(input, ctx) {
    const action = input.action || 'search', scope = input.scope || 'project';
    if (!['project', 'personal', 'profile'].includes(scope)) throw fail('Unknown memory scope.');
    const project = hash(ctx.root), rows = this.store.read(ctx.userId, 'memory');
    const visible = row => row.scope !== 'project' || row.project === project;
    if (['list', 'read', 'search'].includes(action)) {
      const query = String(input.query || '').toLocaleLowerCase();
      return { records: rows.filter(r => visible(r) && (!input.id || r.id === input.id) && (!query || (r.title + '\n' + r.text).toLocaleLowerCase().includes(query))).slice(0, Math.min(100, Number(input.limit) || 30)), historical: true };
    }
    if (action === 'settings') {
      const settings = this.store.read(ctx.userId, 'memory-settings', { enabled: true });
      if (input.enabled !== undefined) { settings.enabled = !!input.enabled; this.store.write(ctx.userId, 'memory-settings', settings); }
      return settings;
    }
    if (['add', 'replace', 'update'].includes(action)) {
      const content = publicData({ text: text(input.text || input.content, 'text', 16000), title: String(input.title || '').slice(0, 180) });
      let row = input.id && rows.find(r => r.id === input.id && visible(r));
      if (input.id && !row) throw fail('Memory not found.', 'not_found', 404);
      if (!row) { if (rows.length >= 2000) throw fail('Memory limit reached.'); row = { id: crypto.randomUUID(), createdAt: new Date().toISOString() }; rows.push(row); }
      Object.assign(row, content, { scope, project: scope === 'project' ? project : null, updatedAt: new Date().toISOString(), source: 'explicit-tool', status: 'note' });
      this.store.write(ctx.userId, 'memory', rows); return { record: row, historical: true };
    }
    if (['delete', 'remove'].includes(action)) {
      const id = text(input.id, 'id', 100), row = rows.find(r => r.id === id && visible(r));
      if (!row) throw fail('Memory not found.', 'not_found', 404);
      this.store.write(ctx.userId, 'memory', rows.filter(r => r !== row)); return { deleted: id };
    }
    throw fail('Unknown memory action.');
  }
  recall(ctx) {
    if (!this.store.read(ctx.userId, 'memory-settings', { enabled: true }).enabled) return '';
    const rows = this.run({ action: 'list', limit: 12 }, ctx).records;
    return rows.length ? '\nPERSONAL AND PROJECT MEMORY (historical notes to revalidate):\n' + rows.map(r => `[${r.scope}] ${r.title}: ${r.text}`).join('\n').slice(0, 16000) : '';
  }
}
module.exports = { MemoryTools };
