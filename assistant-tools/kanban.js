'use strict';
const { crypto, hash, text, fail, publicData, within, fs } = require('./common');
class KanbanTools {
  constructor(store) { this.store = store; }
  run(name, input, ctx) {
    const rows = this.store.read(ctx.userId, 'kanban'), project = hash(ctx.root), action = name.replace('kanban_', '');
    const own = row => row.project === project;
    if (action === 'list') return { tasks: rows.filter(own).filter(row => !input.status || row.status === input.status) };
    if (action === 'create') {
      const row = { id: crypto.randomUUID(), project, title: text(input.title || input.content, 'title', 300), description: String(input.description || ''), status: 'pending', comments: [], attachments: [], links: [], createdAt: new Date().toISOString() };
      rows.push(publicData(row)); this.store.write(ctx.userId, 'kanban', rows); return row;
    }
    const row = rows.find(row => own(row) && row.id === (input.task_id || input.id));
    if (!row) throw fail('Task not found in this project.', 'not_found', 404);
    if (action === 'show') return row;
    if (action === 'attachments') return { attachments: row.attachments };
    if (action === 'comment') row.comments.push(publicData({ text: text(input.text || input.comment, 'comment', 8000), at: new Date().toISOString() }));
    else if (action === 'attach') { const file = within(ctx.root, text(input.path, 'path'), true); if (!fs.statSync(file).isFile()) throw fail('Attachment must be a file.'); row.attachments.push({ path: file, name: input.name || require('node:path').basename(file) }); }
    else if (action === 'attach_url') { const url = new URL(text(input.url, 'url', 4000)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('Invalid attachment URL.'); row.attachments.push({ url: url.href, name: String(input.name || '') }); }
    else if (action === 'link') { const id = text(input.linked_task_id || input.target_id, 'linked_task_id', 100); if (!rows.some(r => own(r) && r.id === id)) throw fail('Linked task not found.'); if (!row.links.includes(id)) row.links.push(id); }
    else if (action === 'heartbeat') row.heartbeatAt = new Date().toISOString();
    else if (['complete', 'block', 'unblock', 'request_review', 'request_changes'].includes(action)) { row.status = { complete: 'completed', block: 'blocked', unblock: 'pending', request_review: 'review', request_changes: 'changes_requested' }[action]; row.reason = String(input.reason || ''); }
    else throw fail('Unknown kanban action.');
    row.updatedAt = new Date().toISOString(); this.store.write(ctx.userId, 'kanban', rows); return publicData(row);
  }
}
module.exports = { KanbanTools };
