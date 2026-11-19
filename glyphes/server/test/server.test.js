'use strict';
// End-to-end check of the Glyphes server with a fake OpenAI-compatible model:
// accounts stay separate, supervised actions wait for a click, autonomous
// actions run, permanent deletions always wait, decisions resume the Glyph.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphes-test-'));
process.env.GLYPHES_DATA = dir;
process.env.PUBLIC_URL = 'http://localhost:0';

// Fake model: scripted replies keyed by the last user text.
let script = [];
const calls = [];
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const request = JSON.parse(body);
    calls.push(request);
    const next = script.shift() || { content: 'ok' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: next.content || '', tool_calls: next.tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});

const { server, createSession, upsertUser } = require('../index.js');
const db = require('../db');
const models = require('../models');
const google = require('../google');
const web = require('../web');
let base, alice, bob, aliceToken, bobToken;

function call(token, method, url, body) {
  return fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const settle = async (glyphId) => {
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 20));
    if (!require('../agent').busy(glyphId)) return;
  }
};
const toolCall = (name, args) => ({ tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test.before(async () => {
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  alice = upsertUser({ id: 'galice', email: 'alice@example.com', name: 'Alice', picture: '' }).user;
  bob = upsertUser({ id: 'gbob', email: 'bob@example.com', name: 'Bob', picture: '' }).user;
  aliceToken = createSession(alice.id, 'device', 'test');
  bobToken = createSession(bob.id, 'device', 'test');
  // The fake model is on loopback; bypass the https/public checks used for real providers.
  for (const u of [alice, bob]) db.run(`INSERT INTO model_creds (user_id, provider, label, data_enc, models, updated_at) VALUES (?, 'fake', 'Fake', ?, '["m1"]', 0)`,
    u.id, require('../secrets').seal(JSON.stringify({ baseUrl: 'https://placeholder', key: 'k' }), `model:${u.id}:fake`));
  // Route the placeholder to the fake model.
  const realFetch = global.fetch;
  global.fetch = (url, opts) => realFetch(String(url).replace('https://placeholder', `http://127.0.0.1:${model.address().port}`), opts);
  // Pretend Google Tasks + Calendar are connected for Alice, with fake API calls.
  db.run("INSERT INTO google_tokens (user_id, refresh_enc, access_enc, expires_at, scopes) VALUES (?, NULL, NULL, 0, ?)", alice.id,
    'https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly');
  google.tasksCreate = async (u, a) => ({ id: 't1', title: a.title });
  google.calendarDelete = async () => ({ deleted: true });
});
test.after(() => { server.close(); model.close(); });

test('a new account gets its first Glyph, and accounts are isolated', async () => {
  const a = await call(aliceToken, 'GET', '/api/glyphs');
  assert.equal(a.status, 200);
  assert.equal(a.body.glyphs.length, 1);
  assert.equal(a.body.glyphs[0].name, 'Nova');
  const b = await call(bobToken, 'GET', `/api/glyphs/${a.body.glyphs[0].id}/messages`);
  assert.equal(b.status, 404, 'Bob cannot read Alice’s Glyph');
  const anon = await fetch(base + '/api/glyphs').then(r => r.status);
  assert.equal(anon, 401);
});

test('cookie sessions need the app header for writes (CSRF)', async () => {
  const token = createSession(alice.id, 'web');
  const r = await fetch(base + '/api/glyphs', { method: 'POST', headers: { Cookie: `glyphes=${token}`, 'Content-Type': 'application/json' }, body: '{"name":"X"}' });
  assert.equal(r.status, 403);
});

test('supervised: a write waits for Confirmer, then runs and the Glyph resumes', async () => {
  const g = (await call(aliceToken, 'POST', '/api/glyphs', { name: 'Coach', variant: 'jade', mode: 'supervised', model: 'fake::m1' })).body.glyph;
  script = [toolCall('tasks_create', { title: 'Séance de sport' }), { content: 'Je te prépare la tâche, confirme-la.' }];
  await call(aliceToken, 'POST', `/api/glyphs/${g.id}/messages`, { text: 'Ajoute une tâche séance de sport' });
  await settle(g.id);
  let state = (await call(aliceToken, 'GET', `/api/glyphs/${g.id}/messages`)).body;
  assert.equal(state.actions.length, 1, 'one pending action');
  assert.equal(state.actions[0].card.title, 'Créer cette tâche ?');
  const glyph = (await call(aliceToken, 'GET', '/api/glyphs')).body.glyphs.find(x => x.id === g.id);
  assert.equal(glyph.status, 'waiting');
  assert.equal(glyph.taskLabel, 'Création tâche');

  // Bob cannot decide Alice's action.
  assert.equal((await call(bobToken, 'POST', `/api/actions/${state.actions[0].id}`, { approve: true })).status, 404);

  script = [{ content: 'C’est fait ✅' }];
  const decided = await call(aliceToken, 'POST', `/api/actions/${state.actions[0].id}`, { approve: true });
  assert.equal(decided.body.action.status, 'done');
  assert.equal((await call(aliceToken, 'POST', `/api/actions/${state.actions[0].id}`, { approve: true })).status, 409, 'no double run');
  await settle(g.id);
  state = (await call(aliceToken, 'GET', `/api/glyphs/${g.id}/messages`)).body;
  assert.equal(state.actions.length, 0);
  assert.equal(state.messages.at(-1).content, 'C’est fait ✅');
  assert.ok(state.messages.some(m => m.data.event && m.data.label.startsWith('Confirmé')));
});

test('autonomous: a write runs at once, a permanent deletion still waits', async () => {
  const g = (await call(aliceToken, 'POST', '/api/glyphs', { name: 'Auto', mode: 'autonomous', model: 'fake::m1' })).body.glyph;
  script = [toolCall('tasks_create', { title: 'Courses' }), { content: 'Ajouté.' }];
  await call(aliceToken, 'POST', `/api/glyphs/${g.id}/messages`, { text: 'ajoute courses' });
  await settle(g.id);
  let state = (await call(aliceToken, 'GET', `/api/glyphs/${g.id}/messages`)).body;
  assert.equal(state.actions.length, 0, 'autonomous write ran without a card');
  const toolRow = db.get("SELECT content FROM messages WHERE glyph_id = ? AND role = 'tool'", g.id);
  assert.match(toolRow.content, /Courses/);

  script = [toolCall('calendar_delete', { id: 'ev1', title: 'Réunion' }), { content: 'Confirme la suppression.' }];
  await call(aliceToken, 'POST', `/api/glyphs/${g.id}/messages`, { text: 'supprime la réunion' });
  await settle(g.id);
  state = (await call(aliceToken, 'GET', `/api/glyphs/${g.id}/messages`)).body;
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].irreversible, true);
  script = [{ content: 'Très bien, je ne supprime rien.' }];
  await call(aliceToken, 'POST', `/api/actions/${state.actions[0].id}`, { approve: false });
  await settle(g.id);
  const refused = db.get('SELECT status FROM actions WHERE id = ?', state.actions[0].id);
  assert.equal(refused.status, 'refused');
});

test('tools of unconnected plugins are not offered; the system prompt carries the rules', async () => {
  const g = (await call(bobToken, 'GET', '/api/glyphs')).body.glyphs[0];
  await call(bobToken, 'PATCH', `/api/glyphs/${g.id}`, { model: 'fake::m1' });
  calls.length = 0; script = [{ content: 'Salut' }];
  await call(bobToken, 'POST', `/api/glyphs/${g.id}/messages`, { text: 'salut' });
  await settle(g.id);
  const names = calls[0].tools.map(t => t.function.name);
  assert.ok(!names.includes('gmail_send') && !names.includes('tasks_create'));
  assert.ok(names.includes('web_search') && names.includes('maps_route') && names.includes('schedule_message'));
  assert.match(calls[0].messages[0].content, /SUPERVISÉ/);
});

test('scheduled messages fire once and repeat correctly', async () => {
  const scheduler = require('../scheduler');
  const g = (await call(bobToken, 'GET', '/api/glyphs')).body.glyphs[0];
  db.run("INSERT INTO jobs (id, user_id, glyph_id, kind, payload, due_at, repeat, created_at) VALUES ('j_t1', ?, ?, 'message', ?, ?, 'daily', 0)", bob.id, g.id, JSON.stringify({ text: 'C’est l’heure de ta séance' }), Date.now() - 1000);
  scheduler.tick(); scheduler.tick();
  const msgs = db.all("SELECT * FROM messages WHERE glyph_id = ? AND content = 'C’est l’heure de ta séance'", g.id);
  assert.equal(msgs.length, 1);
  const job = db.get("SELECT * FROM jobs WHERE id = 'j_t1'");
  assert.ok(job.due_at > Date.now() + 23 * 3600000);
  const fri = new Date('2026-11-20T08:00:00'); // a Friday
  assert.equal(new Date(scheduler.nextDue(fri.getTime(), 'weekdays')).getDay(), 1);
});

test('web reader refuses internal addresses (metadata server, loopback)', async () => {
  await assert.rejects(web.assertPublic('http://169.254.169.254/computeMetadata/v1/'));
  await assert.rejects(web.assertPublic('http://metadata.google.internal/'));
  await assert.rejects(web.assertPublic('http://127.0.0.1:8787/'));
  assert.equal(web.privateAddress('8.8.8.8'), false);
});

test('model keys are sealed per user', () => {
  const row = db.get("SELECT data_enc FROM model_creds WHERE user_id = ? AND provider = 'fake'", alice.id);
  assert.ok(!row.data_enc.includes('placeholder'));
  assert.equal(require('../secrets').open(row.data_enc, `model:${bob.id}:fake`), null, 'Bob’s context cannot open Alice’s key');
  assert.ok(models.credentials(alice.id, 'fake'));
});
