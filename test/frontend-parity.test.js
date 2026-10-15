'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { frontend, settle } = require('./helpers/frontend-dom');

test('memory edit submits one PATCH, preserving the global scope of a global memory', async () => {
  const ui = frontend(['task-center.js'], ({ path }) => path.startsWith('/api/knowledge')
    ? { records: [{ id: 'memory-1', title: 'Convention', content: 'Before', tags: ['team'], root: null }] }
    : { tasks: [] });
  await ui.button('Tâches et mémoire').emit('click');
  await ui.button('Mémoire générale').emit('click');
  await ui.button('Modifier').emit('click');
  ui.input('Information durable').value = 'After';
  await ui.form().emit('submit');
  const writes = ui.requests.filter(request => request.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH'); assert.equal(writes[0].path, '/api/knowledge/memory-1');
  assert.equal(writes[0].body.content, 'After'); assert.equal(writes[0].body.root, '');
});
test('editing a task preserves its saved provider and permissions rather than the current composer', async () => {
  const task = { id: 'task-1', title: 'Review', prompt: 'Read only', root: 'C:\\other', model: 'saved-provider', submodel: 'saved-model', permissionMode: 'read-only', enabled: false };
  const ui = frontend(['task-center.js'], () => ({ tasks: [task] }));
  await ui.button('Tâches et mémoire').emit('click'); await ui.button('Modifier').emit('click');
  ui.input('Instruction').value = 'Changed instruction'; await ui.form().emit('submit');
  const write = ui.requests.find(request => request.method === 'PATCH');
  assert.equal(write.path, '/api/tasks/task-1'); assert.equal(write.body.prompt, 'Changed instruction');
  assert.equal(write.body.model, 'saved-provider'); assert.equal(write.body.permissionMode, 'read-only'); assert.equal(write.body.enabled, false);
});
test('agents history actions send the kind and hydrate a fork into the correct store', async () => {
  const original = { id: 'parent', title: 'Agent chat', kind: 'agents', messages: [] };
  const branch = { id: 'branch', title: 'Branch', kind: 'agents', messages: [{ type: 'user', text: 'Context' }] };
  const ui = frontend(['conversation-actions.js'], ({ path, method }) => {
    if (method === 'POST') return { conversation: branch };
    if (path.startsWith('/api/conversations/branch')) return { conversation: branch };
    return { conversations: [original], total: 1 };
  });
  await ui.button('Historique').emit('click'); await ui.button('Créer une branche').emit('click');
  const fork = ui.requests.find(request => request.method === 'POST');
  assert.equal(fork.body.kind, 'agents'); assert.equal(ui.context.state.agentConversations[0].id, 'branch');
  assert.equal(ui.opened[0].kind, 'agents'); assert.equal(ui.opened[0].id, 'branch');
});
test('task decisions remain reachable and show the task center again after resolution', async () => {
  const pending = { type: 'clarification_required', requestId: 'ask-1', sessionId: 'session-1', questions: [{ id: 'choice', prompt: 'Which branch?' }] };
  const ui = frontend(['task-center.js'], () => ({ tasks: [{ id: 'task-1', title: 'Waiting', prompt: 'Work', pending }] }));
  await ui.button('Tâches et mémoire').emit('click'); await ui.button('Répondre à la demande').emit('click');
  assert.equal(ui.decisions.length, 1); assert.equal(ui.decisions[0].requestId, 'ask-1');
  assert.equal(ui.all().find(el => el.tagName === 'DIALOG').open, true);
});
test('archiving a legacy agents conversation updates the agents store even without kind in PATCH result', async () => {
  const conversation = { id: 'legacy-agents', title: 'Existing team', messages: [] };
  const ui = frontend(['conversation-actions.js'], ({ method }) => method === 'PATCH'
    ? { conversation: { ...conversation, archived: true, metadataRevision: 1 } }
    : { conversations: [{ ...conversation, kind: 'agents' }], total: 1 });
  ui.context.state.agentConversations.push(conversation);
  await ui.button('Historique').emit('click'); await ui.button('Archiver').emit('click');
  const write = ui.requests.find(request => request.method === 'PATCH');
  assert.equal(write.body.kind, 'agents'); assert.equal(write.body.archived, true);
  assert.equal(ui.context.state.agentConversations[0].archived, true);
  assert.equal(ui.context.state.conversations.length, 0);
});
test('queue edits affect the draft delivered after reordering, preserving attachments', async () => {
  const ui = frontend(['pending-queue.js'], () => ({}));
  const queue = new ui.context.window.ZaalisPendingQueue('chat-input');
  queue.push({ message: 'One', attachments: [{ name: 'context.txt' }] }, 'chat-1');
  queue.push({ message: 'Two' }, 'chat-1');
  const editor = ui.all().find(el => el.getAttribute('aria-label') === 'Message en attente 2');
  editor.value = 'Edited'; await editor.emit('input');
  await ui.all().find(el => el.tagName === 'BUTTON' && el.textContent === '↑' && !el.disabled).emit('click');
  assert.equal(queue.take().message, 'Edited');
  assert.equal(queue.take().attachments[0].name, 'context.txt'); await settle();
});
test('tool inventory renders the native Rust input_schema', async () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const ui = frontend(['task-center.js'], ({ path }) => path.startsWith('/api/tools')
    ? { tools: [{ name: 'read_file', description: 'Read a project file', input_schema: schema }] }
    : { tasks: [] });
  await ui.button('Tâches et mémoire').emit('click'); await ui.button('Outils').emit('click');
  const rendered = ui.all().find(el => el.tagName === 'PRE');
  assert.deepEqual(JSON.parse(rendered.textContent), schema);
});
test('structured questions return chosen answers and serialize concurrent agent requests', async () => {
  const ui = frontend(['clarification.js'], () => ({}));
  const first = ui.context.window.ZaalisClarification.request([{ id: 'branch', prompt: 'Choose a branch', options: [{ label: 'main' }], allow_free_text: false }]);
  const second = ui.context.window.ZaalisClarification.request([{ id: 'scope', prompt: 'Choose scope', options: [{ label: 'Project' }] }]);
  assert.equal(ui.all().filter(el => el.tagName === 'DIALOG' && el.open).length, 1);
  await ui.button('main').emit('click'); await ui.form().emit('submit');
  assert.equal((await first).branch, 'main');
  assert.ok(ui.button('Project')); await ui.button('Fermer').emit('click');
  assert.equal(Object.keys(await second).length, 0);
});
