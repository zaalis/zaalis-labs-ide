'use strict';
// zaalis Labs IDE <-> Glyphes server: linking through the browser approval,
// then the relay (JSON, uploads, live stream) with the sealed device token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.GLYPHES_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphes-link-'));
process.env.PUBLIC_URL = 'http://127.0.0.1:0';
const glyphes = require('../glyphes/server/index.js');
const glyphesLink = require('../src/integrations/glyphes-link');

let base, ide, opened = [], sessionCookie;
const users = [{ id: 'u1', apiKeys: { google: 'enc:AIza-test' } }];

test.before(async () => {
  await new Promise(r => glyphes.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${glyphes.server.address().port}`;
  process.env.ZAALIS_GLYPHES_URL = base;
  process.env.PUBLIC_URL = base; // the server builds its approval links from its public address
  const { user } = glyphes.upsertUser({ id: 'gtest', email: 'test@example.com', name: 'Test', picture: '' });
  sessionCookie = `glyphes=${glyphes.createSession(user.id, 'web')}`;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = users[0]; next(); });
  glyphesLink.register(app, {
    loadUsers: () => users, saveUsers: () => {},
    encryptSecret: v => 'enc:' + v, decryptSecret: v => String(v).replace(/^enc:/, ''),
    userApiKeys: () => ({ google: 'AIza-test' }), compatProviders: { PROVIDERS: [] }, compatKey: () => '', compatBaseUrl: p => p.baseUrl,
    openExternal: url => { opened.push(url); return true; }, SUBMODELS: { gemini: ['gemini-test'] },
  });
  await new Promise(r => { ide = app.listen(0, '127.0.0.1', r); });
});
test.after(() => { glyphes.server.close(); ide.close(); });
const ideUrl = p => `http://127.0.0.1:${ide.address().port}${p}`;

test('unlinked IDE gets a 401 asking to link', async () => {
  const r = await fetch(ideUrl('/api/glyphes/proxy/glyphs'));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).link, true);
});

test('link: browser approval gives the IDE a device token', async () => {
  const start = await fetch(ideUrl('/api/glyphes/link/start'), { method: 'POST' }).then(r => r.json());
  assert.match(start.code, /^[A-Z0-9]{8}$/);
  assert.equal(opened.at(-1), `${base}/link?code=${start.code}`, 'the approval page opens in the browser');
  // The user, signed in on the Glyphes site, approves.
  const page = await fetch(opened.at(-1), { headers: { Cookie: sessionCookie } }).then(r => r.text());
  const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await fetch(ideUrl('/api/glyphes/link/poll'), { method: 'POST' }).then(r => r.json())).status, 'pending');
  const forged = await fetch(`${base}/link`, { method: 'POST', headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${start.code}&csrf=bad&decision=allow` });
  assert.equal(forged.status, 403, 'approval needs the page token');
  await fetch(`${base}/link`, { method: 'POST', headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${start.code}&csrf=${encodeURIComponent(csrf)}&decision=allow` });
  const poll = await fetch(ideUrl('/api/glyphes/link/poll'), { method: 'POST' }).then(r => r.json());
  assert.equal(poll.status, 'approved');
  assert.match(users[0].glyphesToken, /^enc:gly_/);
});

test('relay: JSON, models push, uploads and the live stream go through', async () => {
  const list = await fetch(ideUrl('/api/glyphes/proxy/glyphs')).then(r => r.json());
  assert.equal(list.glyphs[0].name, 'Nova');
  const created = await fetch(ideUrl('/api/glyphes/proxy/glyphs'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Iris', variant: 'iris' }) });
  assert.equal(created.status, 201);
  const pushed = await fetch(ideUrl('/api/glyphes/push-models'), { method: 'POST' }).then(r => r.json());
  assert.equal(pushed.sent, 1);
  const models = await fetch(ideUrl('/api/glyphes/proxy/models')).then(r => r.json());
  assert.deepEqual(models.providers.map(p => p.provider), ['google']);
  assert.equal(models.defaultModel, 'google::gemini-test');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await fetch(ideUrl('/api/glyphes/proxy/files'), { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-File-Name': 'a.png' }, body: png }).then(r => r.json());
  assert.equal(up.file.size, png.length);
  const back = await fetch(ideUrl(`/api/glyphes/proxy/files/${up.file.id}`));
  assert.equal(Buffer.compare(Buffer.from(await back.arrayBuffer()), png), 0);
  // Live stream: an event emitted on the server reaches the IDE.
  const controller = new AbortController();
  const stream = await fetch(ideUrl('/api/glyphes/proxy/events'), { signal: controller.signal });
  assert.match(stream.headers.get('content-type'), /event-stream/);
  const reader = stream.body.getReader();
  await reader.read();
  await fetch(ideUrl(`/api/glyphes/proxy/glyphs/${list.glyphs[0].id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nova 2' }) });
  let text = '';
  while (!text.includes('Nova 2')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: glyph/);
  controller.abort();
});

test('relay refuses path tricks and only opens Google sign-in pages', async () => {
  assert.equal((await fetch(ideUrl('/api/glyphes/proxy/..%2F..%2Fetc'))).status, 400);
  const bad = await fetch(ideUrl('/api/glyphes/open'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'https://evil.example' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(ideUrl('/api/glyphes/open'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/auth/google/start?plugins=gmail&return=%2F' }) });
  assert.equal(ok.status, 200);
  assert.equal(opened.at(-1), `${base}/auth/google/start?plugins=gmail&return=%2F`);
});

test('unlinking forgets the token', async () => {
  await fetch(ideUrl('/api/glyphes/unlink'), { method: 'POST' });
  assert.equal(users[0].glyphesToken, undefined);
  assert.equal((await fetch(ideUrl('/api/glyphes/proxy/glyphs'))).status, 401);
});
