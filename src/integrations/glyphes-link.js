'use strict';
// zaalis Glyphes inside zaalis Labs IDE.
//
// The Glyphes app (interface/glyphes/) is shown in the IDE at /glyphes/. The
// IDE never talks to Google itself: it relays the app's calls to the Glyphes
// server with a device token obtained once through a browser approval
// (POST /api/link/start -> the user approves in the browser -> poll). The token
// is sealed in the IDE's encrypted vault, like the API keys.
//
// "Envoyer mes modèles" copies the IDE's API keys (and the base URL of the
// OpenAI-compatible providers) to the user's account on the Glyphes server so
// the Glyphs use the same models as the IDE.
const { Readable } = require('node:stream');

// The shared Glyphes server (free Google Cloud VM). Overridable for testing.
const DEFAULT_URL = 'https://34-63-15-174.sslip.io';

const KEY_MAP = {
  openai:    { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', catalog: 'codex' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', catalog: 'claude' },
  google:    { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', catalog: 'gemini' },
  grok:      { label: 'xAI', baseUrl: 'https://api.x.ai/v1', catalog: 'grok' },
  mistral:   { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', catalog: 'mistral' },
  moonshot:  { label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1', catalog: 'kimi' },
};

function register(app, deps) {
  const { loadUsers, saveUsers, encryptSecret, decryptSecret, userApiKeys, compatProviders, compatKey, compatBaseUrl, openExternal, SUBMODELS } = deps;
  const pending = new Map(); // userId -> { code, poll, url }

  const serverUrl = (user) => String(process.env.ZAALIS_GLYPHES_URL || (user && user.glyphesUrl) || DEFAULT_URL).replace(/\/+$/, '');
  const tokenOf = (user) => (user && user.glyphesToken ? decryptSecret(user.glyphesToken) : '');
  function saveUser(id, patch) {
    const users = loadUsers();
    const user = users.find((u) => u.id === id);
    if (!user) return;
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete user[k]; else user[k] = v; }
    saveUsers(users);
  }
  const guard = (req, res, next) => {
    if (req.isTunnel || req.isMobile || req.isBrowser || req.isCodestrale) return res.status(403).json({ error: 'Glyphes est réservé à zaalis Labs IDE sur ce PC.' });
    return next();
  };
  const reach = (error) => ({ error: `Serveur Glyphes injoignable (${error.cause && error.cause.code || error.message}).` });

  app.get('/api/glyphes/status', guard, (req, res) => res.json({ url: serverUrl(req.user), linked: !!tokenOf(req.user) }));

  app.post('/api/glyphes/link/start', guard, async (req, res) => {
    try {
      const response = await fetch(serverUrl(req.user) + '/api/link/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ label: `zaalis Labs IDE (${require('node:os').hostname()})` }),
      });
      const data = await response.json();
      if (!response.ok) return res.status(502).json({ error: data.error || 'Le serveur Glyphes a refusé la connexion.' });
      if (!String(data.url || '').startsWith(serverUrl(req.user) + '/link?')) return res.status(502).json({ error: 'Réponse inattendue du serveur Glyphes.' });
      pending.set(req.user.id, data);
      openExternal(data.url);
      res.json({ code: data.code, url: data.url });
    } catch (error) { res.status(502).json(reach(error)); }
  });

  app.post('/api/glyphes/link/poll', guard, async (req, res) => {
    const flow = pending.get(req.user.id);
    if (!flow) return res.json({ status: 'none' });
    try {
      const response = await fetch(serverUrl(req.user) + '/api/link/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ code: flow.code, poll: flow.poll }),
      });
      const data = await response.json();
      if (data.status === 'approved' && data.token) {
        pending.delete(req.user.id);
        saveUser(req.user.id, { glyphesToken: encryptSecret(data.token), glyphesAccount: data.user && data.user.email });
        return res.json({ status: 'approved' });
      }
      if (['denied', 'expired'].includes(data.status)) pending.delete(req.user.id);
      res.json({ status: data.status || 'pending' });
    } catch (error) { res.status(502).json(reach(error)); }
  });

  app.post('/api/glyphes/unlink', guard, async (req, res) => {
    const token = tokenOf(req.user);
    if (token) await fetch(serverUrl(req.user) + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }).catch(() => {});
    saveUser(req.user.id, { glyphesToken: undefined, glyphesAccount: undefined });
    res.json({ ok: true });
  });

  // Google sign-in pages open in the default browser (never inside the IDE).
  app.post('/api/glyphes/open', guard, (req, res) => {
    const path = String((req.body && req.body.path) || '');
    if (!/^\/auth\/google\/start\?[\w=&%.,/-]*$/.test(path)) return res.status(400).json({ error: 'Adresse refusée.' });
    if (!openExternal(serverUrl(req.user) + path)) return res.status(500).json({ error: 'Impossible d’ouvrir le navigateur.' });
    res.json({ ok: true });
  });

  app.post('/api/glyphes/push-models', guard, async (req, res) => {
    const token = tokenOf(req.user);
    if (!token) return res.status(401).json({ error: 'Relie d’abord ton compte Glyphes.' });
    const jobs = [];
    const keys = userApiKeys(req.user);
    for (const [provider, key] of Object.entries(keys)) {
      const info = KEY_MAP[provider];
      if (!info || !key) continue;
      const models = (SUBMODELS[info.catalog] || []).filter((m) => !/imagine|image/.test(m));
      jobs.push([provider, { label: info.label, baseUrl: info.baseUrl, key, models }]);
    }
    for (const provider of compatProviders.PROVIDERS) {
      if (provider.oauth || provider.vertex || provider.keyless) continue;
      const key = compatKey(req.user, provider);
      if (!key) continue;
      const baseUrl = compatBaseUrl(req.user, provider);
      if (!/^https:\/\//.test(baseUrl)) continue;
      jobs.push([`compat-${provider.id}`, { label: provider.label, baseUrl, key, models: provider.models || [] }]);
    }
    let sent = 0;
    const errors = [];
    for (const [provider, body] of jobs) {
      try {
        const response = await fetch(`${serverUrl(req.user)}/api/models/${encodeURIComponent(provider)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
        });
        if (response.ok) sent++; else errors.push(`${body.label} : ${(await response.json().catch(() => ({}))).error || response.status}`);
      } catch (error) { errors.push(`${body.label} : ${error.message}`); }
    }
    res.json({ sent, total: jobs.length, errors });
  });

  // Relay: /api/glyphes/proxy/<path> -> <server>/api/<path>, with the device token.
  app.all(/^\/api\/glyphes\/proxy\/(.+)$/, guard, async (req, res) => {
    const token = tokenOf(req.user);
    if (!token) return res.status(401).json({ error: 'Compte Glyphes non relié.', link: true });
    const rest = req.originalUrl.replace(/^\/api\/glyphes\/proxy\//, '');
    if (!/^[\w\-./?=&%]+$/.test(rest) || rest.includes('..')) return res.status(400).json({ error: 'Chemin refusé.' });
    const controller = new AbortController();
    // Abort upstream only when the client goes away ("close" on req fires as soon as its body is read).
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const headers = { Authorization: `Bearer ${token}`, Accept: req.headers.accept || '*/*' };
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.body && typeof req.body === 'object' && String(req.headers['content-type'] || '').includes('application/json')) {
        headers['Content-Type'] = 'application/json'; body = JSON.stringify(req.body);
      } else {
        headers['Content-Type'] = req.headers['content-type'] || 'application/octet-stream';
        if (req.headers['x-file-name']) headers['X-File-Name'] = req.headers['x-file-name'];
        body = Readable.toWeb(req);
      }
    }
    try {
      const upstream = await fetch(`${serverUrl(req.user)}/api/${rest}`, { method: req.method, headers, body, duplex: body ? 'half' : undefined, signal: controller.signal, redirect: 'error' });
      if (upstream.status === 401) {
        // The device was unlinked on the server (or the account deleted).
        saveUser(req.user.id, { glyphesToken: undefined });
        return res.status(401).json({ error: 'Le lien avec Glyphes a expiré. Relie à nouveau ton compte.', link: true });
      }
      res.status(upstream.status);
      for (const h of ['content-type', 'content-disposition', 'cache-control']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
      if (String(upstream.headers.get('content-type') || '').includes('text/event-stream')) { res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders(); }
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    } catch (error) {
      if (controller.signal.aborted) return;
      res.status(502).json(reach(error));
    }
  });
}

module.exports = { register, DEFAULT_URL, KEY_MAP };
