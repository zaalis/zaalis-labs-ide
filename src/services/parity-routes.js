'use strict';

// This module must be mounted after the server's account/loopback/mobile guard.
// Services receive only the authenticated account id, never an id from a body.
function registerParityRoutes(app, { conversations, events, memory, tasks, tools }) {
  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { if (!res.headersSent) res.status(error.status || 500).json({ error: error.message }); }
  };
  const kind = req => req.body?.kind || req.query.kind || 'chat';
  app.get('/api/conversations', route((req, res) => res.json(conversations.list(req.user.id, req.query))));
  app.post('/api/conversations', route((req, res) => res.json({ conversation: conversations.create(req.user.id, req.body || {}) })));
  app.delete('/api/conversations', route((req, res) => { conversations.clear(req.user.id, kind(req)); res.json({ ok: true }); }));
  app.get('/api/conversations/:id', route((req, res) => res.json({ conversation: conversations.find(req.user.id, req.params.id, kind(req)) })));
  app.patch('/api/conversations/:id', route((req, res) => res.json({ conversation: conversations.update(req.user.id, req.params.id, { ...req.body, kind: kind(req) }) })));
  app.post('/api/conversations/:id/fork', route((req, res) => res.json({ conversation: conversations.fork(req.user.id, req.params.id, { ...req.body, kind: kind(req) }) })));
  app.delete('/api/conversations/:id', route((req, res) => { conversations.remove(req.user.id, req.params.id, kind(req)); res.json({ ok: true }); }));
  app.get('/api/conversations/:id/events', route((req, res) => {
    conversations.find(req.user.id, req.params.id, kind(req));
    res.json(events.list(req.user.id, kind(req), req.params.id, req.query.fromSeq, req.query.limit));
  }));
  app.get('/api/knowledge', route((req, res) => res.json({ records: memory.list(req.user.id, req.query) })));
  app.post('/api/knowledge', route((req, res) => res.json({ record: memory.save(req.user.id, req.body || {}) })));
  app.patch('/api/knowledge/:id', route((req, res) => res.json({ record: memory.update(req.user.id, req.params.id, req.body || {}) })));
  app.delete('/api/knowledge/:id', route((req, res) => { memory.remove(req.user.id, req.params.id); res.json({ ok: true }); }));
  app.get('/api/tasks', route((req, res) => res.json({ tasks: tasks.list(req.user.id) })));
  app.post('/api/tasks', route((req, res) => res.json({ task: tasks.create(req.user.id, req.body || {}) })));
  app.patch('/api/tasks/:id', route((req, res) => res.json({ task: tasks.update(req.user.id, req.params.id, req.body || {}) })));
  app.post('/api/tasks/:id/run', route(async (req, res) => res.json({ task: await tasks.startRun(req.user.id, req.params.id) })));
  app.post('/api/tasks/:id/cancel', route((req, res) => res.json(tasks.cancel(req.user.id, req.params.id))));
  app.delete('/api/tasks/:id', route((req, res) => { tasks.remove(req.user.id, req.params.id); res.json({ ok: true }); }));
  app.get('/api/tools', route(async (req, res) => res.json({ tools: await tools(req.user, req.query) })));
  app.post('/api/tools/describe', route(async (req, res) => {
    const found = (await tools(req.user, req.body || {})).find(tool => tool.name === req.body?.name);
    if (!found) return res.status(404).json({ error: 'Outil introuvable dans le registre actif.' });
    res.json({ tool: found });
  }));
}
module.exports = { registerParityRoutes };
