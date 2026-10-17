'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationStore } = require('../src/services/conversation-store');
const { MemoryStore } = require('../src/services/memory-store');
const { TaskService } = require('../src/services/task-service');
const { safeKey } = require('../src/services/json-store');
const { workspaceServiceAction } = require('../src/services/workspace-services');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-parity-'));
  const close = [];
  const root = path.join(directory, 'project-a'), otherRoot = path.join(directory, 'project-b');
  fs.mkdirSync(root); fs.mkdirSync(otherRoot);
  const conversations = new ConversationStore({ directory: path.join(directory, 'chats'),
    file: (user, kind) => path.join(directory, 'chats', `${safeKey(user)}-${kind}.json`) });
  const memory = new MemoryStore(path.join(directory, 'memories'));
  t.after(async () => { for (const fn of close) await fn(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, otherRoot, conversations, memory, close };
}

function taskFixture(t, concurrency = 2) {
  const f = fixture(t), calls = [];
  let now = 1700000000000;
  const run = (user, task, emit, signal) => new Promise((resolve, reject) => {
    calls.push({ user, task, emit, signal, resolve, reject });
    signal.addEventListener('abort', () => reject(new Error('Arrêt demandé')), { once: true });
  });
  const options = { directory: path.join(f.directory, 'tasks'), run, concurrency, clock: () => now };
  const tasks = new TaskService(options);
  f.close.push(() => tasks.shutdown());
  return { ...f, tasks, calls, options, advance: milliseconds => { now += milliseconds; },
    now: () => now, create: (user = 'alice', extra = {}) => tasks.create(user, { prompt: 'Inspecte le projet', root: f.root, ...extra }),
    done: (user, id) => tasks.active.get(`${user}:${id}`).done };
}

test('legacy saves preserve canonical metadata and conversations from another window', t => {
  const { conversations: store, root } = fixture(t);
  const chat = store.create('alice', { root, source: 'cli' }, 'chat-a');
  store.update('alice', chat.id, { title: 'Titre renommé', archived: true });
  store.create('alice', { root }, 'chat-b');
  store.mergeLegacy('alice', 'chat', [{ ...chat, title: 'Ancien titre', archived: false,
    contentUpdatedAt: chat.contentUpdatedAt - 1, messages: [{ type: 'user', text: 'Ancien texte' }] }]);
  const result = store.find('alice', chat.id);
  assert.equal(result.title, 'Titre renommé'); assert.equal(result.archived, true);
  assert.deepEqual(result.messages, []); assert.equal(result.source, 'cli');
  assert.equal(store.list('alice', { archived: 'all' }).total, 2);
  store.mergeLegacy('alice', 'chat', [{ ...chat, contentUpdatedAt: chat.contentUpdatedAt + 1000,
    messages: [{ type: 'user', text: 'Nouveau texte' }] }]);
  assert.equal(store.find('alice', chat.id).messages[0].text, 'Nouveau texte');
  assert.equal(store.find('alice', chat.id).title, 'Titre renommé');
});

test('deleted conversations cannot be resurrected and tombstones are account scoped', t => {
  const { conversations: store } = fixture(t);
  const chat = store.create('alice', {}, 'shared-id');
  store.create('bob', {}, 'shared-id'); store.remove('alice', chat.id);
  store.create('bob', {}, 'bob-only');
  store.mergeLegacy('alice', 'chat', [chat]);
  assert.equal(store.list('alice').total, 0);
  assert.throws(() => store.ensure('alice', chat.id), { status: 404 });
  assert.equal(store.find('bob', chat.id).id, chat.id);
  assert.throws(() => store.find('alice', 'bob-only'), { status: 404 });
});

test('fork owns copied context and a fresh runtime identity in the authenticated account', t => {
  const { conversations: store, root } = fixture(t);
  const chat = store.create('alice', { root }, 'original');
  store.beginTurn('alice', chat.id, 'chat', { message: 'Question', persistTurn: true }, 'turn-1');
  store.finishTurn('alice', chat.id, 'chat', { persistTurn: true }, { response: 'Réponse', sessionId: 'ses-parent' });
  const fork = store.fork('alice', chat.id);
  assert.notEqual(fork.id, chat.id); assert.equal(fork.parentId, chat.id);
  assert.equal(fork.sessionId, undefined); assert.equal(fork.activeTurnId, undefined);
  assert.equal(fork.projectPath, root); assert.equal(fork.apiHistory.length, 2);
  fork.messages[0].text = 'Local mutation';
  assert.equal(store.find('alice', chat.id).messages[0].text, 'Question');
  assert.throws(() => store.fork('bob', chat.id), { status: 404 });
});

test('legacy content cannot overwrite the server runtime session or active turn', t => {
  const { conversations: store } = fixture(t);
  const chat = store.create('alice', {}, 'canonical');
  store.finishTurn('alice', chat.id, 'chat', {}, { sessionId: 'ses-canonical' });
  store.beginTurn('alice', chat.id, 'chat', { message: 'Travaille' }, 'turn-active');
  store.mergeLegacy('alice', 'chat', [{ ...chat, sessionId: 'ses-stale', status: 'completed',
    activeTurnId: null, contentUpdatedAt: Date.now() + 100000 }]);
  const result = store.find('alice', chat.id);
  assert.equal(result.sessionId, 'ses-canonical'); assert.equal(result.activeTurnId, 'turn-active');
  assert.equal(result.status, 'running');
});

test('memory search and recall respect project and account boundaries including global notes', t => {
  const { memory, root, otherRoot } = fixture(t);
  const local = memory.save('alice', { title: 'Conventions', content: 'Utiliser rust pour le runtime', tags: ['architecture'], root });
  memory.save('alice', { content: 'rust global', root: null });
  memory.save('alice', { content: 'rust secret autre projet', root: otherRoot });
  memory.save('bob', { content: 'rust secret autre compte', root });
  assert.equal(memory.list('alice', { root }).length, 2);
  assert.equal(memory.list('alice', { root, q: 'ARCHITECTURE' })[0].id, local.id);
  const recalled = memory.recall('alice', root, 'architecture rust');
  assert.match(recalled, /runtime/); assert.doesNotMatch(recalled, /secret/);
  assert.equal(memory.recall('alice', root, 'inexistant'), '');
  assert.throws(() => memory.update('bob', local.id, { content: 'steal' }), { status: 404 });
  assert.throws(() => memory.save('alice', { content: ' ' }), { status: 400 });
});

test('recurring tasks use the injected clock and reschedule from completion', async t => {
  const f = taskFixture(t), task = f.create('alice', { intervalMinutes: 2 });
  assert.equal(task.nextRunAt, f.now() + 120000);
  await f.tasks.tick(); assert.equal(f.calls.length, 0);
  f.advance(120000); await f.tasks.tick(); assert.equal(f.calls.length, 1);
  const done = f.done('alice', task.id);
  f.advance(30000); f.calls[0].resolve({ response: 'Rapport', sessionId: 'ses-task' }); await done;
  const completed = f.tasks.find('alice', task.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.lastResult, 'Rapport');
  assert.equal(completed.sessionId, 'ses-task'); assert.equal(completed.nextRunAt, f.now() + 120000);
  assert.equal(completed.history[0].startedAt, task.nextRunAt);
  assert.equal(completed.history[0].finishedAt, f.now());
});

test('task concurrency limits overlap and release slots after cancellation', async t => {
  const f = taskFixture(t, 1), first = f.create(), second = f.create();
  await f.tasks.startRun('alice', first.id); const firstDone = f.done('alice', first.id);
  await assert.rejects(f.tasks.startRun('alice', first.id), { status: 409 });
  await assert.rejects(f.tasks.startRun('alice', second.id), { status: 409 });
  assert.throws(() => f.tasks.remove('alice', first.id), { status: 409 });
  assert.throws(() => f.tasks.update('alice', first.id, { prompt: 'Changed' }), { status: 409 });
  assert.throws(() => f.tasks.cancel('bob', first.id), { status: 404 });
  assert.deepEqual(f.tasks.cancel('alice', first.id), { cancelled: true }); await firstDone;
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.tasks.find('alice', first.id).status, 'cancelled');
  await f.tasks.startRun('alice', second.id); const secondDone = f.done('alice', second.id);
  f.calls[1].resolve({ response: 'OK' }); await secondDone;
  assert.equal(f.tasks.active.size, 0);
});

test('task approvals wait and clear only for the matching account and request', async t => {
  const f = taskFixture(t), task = f.create();
  await f.tasks.startRun('alice', task.id); const done = f.done('alice', task.id);
  f.calls[0].emit({ type: 'run_started', sessionId: 'ses-await' });
  f.calls[0].emit({ type: 'clarification_required', requestId: 'req-choice', questions: [{ id: 'choice', prompt: 'Choix ?' }] });
  assert.equal(f.tasks.find('alice', task.id).status, 'waiting');
  f.tasks.clearPending('bob', 'req-choice'); f.tasks.clearPending('alice', 'wrong');
  assert.equal(f.tasks.find('alice', task.id).pending.requestId, 'req-choice');
  f.calls[0].emit({ type: 'rust_event', event: { type: 'clarification_resolved', request_id: 'req-choice' } });
  assert.equal(f.tasks.find('alice', task.id).pending, null); assert.equal(f.tasks.find('alice', task.id).status, 'running');
  f.calls[0].resolve({ response: 'Repris', sessionId: 'ses-await' }); await done;
});

test('restart marks in-flight tasks interrupted and retains schedules and history', t => {
  const f = taskFixture(t), waiting = f.create('alice', { intervalMinutes: 3 }), running = f.create('alice');
  f.tasks.mutate('alice', waiting.id, task => { task.status = 'waiting'; task.pending = { requestId: 'orphan' }; task.history = [{ status: 'completed' }]; });
  f.tasks.mutate('alice', running.id, task => { task.status = 'running'; });
  const restored = new TaskService(f.options); f.close.push(() => restored.shutdown());
  for (const task of restored.list('alice')) { assert.equal(task.status, 'interrupted'); assert.equal(task.pending, null); assert.match(task.lastError, /redémarrage/); }
  assert.equal(restored.find('alice', waiting.id).nextRunAt, waiting.nextRunAt);
  assert.equal(restored.find('alice', waiting.id).history.length, 1);
});

test('workspace token cannot mutate memory or run tasks belonging to another project', async t => {
  const f = taskFixture(t), note = f.memory.save('alice', { content: 'Projet B', root: f.otherRoot });
  const global = f.memory.save('alice', { content: 'Global', root: null });
  const task = f.create('alice', { root: f.otherRoot });
  const context = { user: { id: 'alice' }, projectRoot: f.root, permissionMode: 'read-only' };
  const services = { memory: f.memory, conversations: f.conversations, tasks: f.tasks };
  assert.throws(() => workspaceServiceAction(context, { action: 'memory', input: { action: 'delete', id: note.id } }, services), { status: 403 });
  assert.throws(() => workspaceServiceAction(context, { action: 'memory', input: { action: 'save', id: note.id, content: 'Overwrite' } }, services), { status: 403 });
  assert.throws(() => workspaceServiceAction(context, { action: 'memory', input: { action: 'delete', id: global.id } }, services), { status: 403 });
  await assert.rejects(async () => workspaceServiceAction(context, { action: 'tasks', input: { action: 'run', id: task.id } }, services), { status: 403 });
  assert.equal(f.memory.list('alice').find(item => item.id === note.id).content, 'Projet B');
  assert.equal(workspaceServiceAction(context, { action: 'tasks', input: { action: 'list' } }, services).tasks.length, 0);
  const created = workspaceServiceAction(context, { action: 'tasks', input: { action: 'create',
    prompt: 'Lecture', root: f.otherRoot, permissionMode: 'auto', id: task.id, status: 'running', pending: { requestId: 'forged' } } }, services).task;
  assert.equal(created.root, f.root); assert.equal(created.permissionMode, 'read-only');
  assert.notEqual(created.id, task.id); assert.equal(created.status, 'idle'); assert.equal(created.pending, undefined);
  const remembered = workspaceServiceAction(context, { action: 'memory', input: { action: 'save', content: 'Mémoire A', root: f.otherRoot } }, services).record;
  assert.equal(remembered.root, f.root);
});
