'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'interface');
const port = Number(process.env.ZAALIS_UI_FIXTURE_PORT || 31881);
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
let fixturePermissionMode = 'supervised';
const fixtureHistories = { chat: [], agents: [] };
if (process.env.ZAALIS_UI_FIXTURE_HISTORY) fixtureHistories.chat.push({
  id: 'fixture-chat', title: 'Conversation restaurée', project: 'connexion ide', projectPath: path.resolve(__dirname, '..'),
  messages: [
    { type: 'user', label: 'Vous', text: 'Vérifie mon projet.' },
    { type: 'ai', label: null, activity: true, bodyClasses: ['live-agent-body'], text: 'Analyse terminée en 2s 1 étape Lecture du projet', html: '<details class="ghost-tool-group live-agent-activity"><summary><span class="live-agent-title">Analyse terminée en 2s</span><span class="live-agent-status">1 étape</span></summary><div class="ghost-tool-body live-agent-tools"><details class="ghost-tool-group"><summary>Lecture du projet</summary><pre class="ghost-tool-pre">Résultat lisible\nDeuxième ligne</pre></details></div></details>' },
    { type: 'ai', label: 'ChatGPT', text: '## Projet prêt\n\n- Historique restauré\n- Dossier conservé' }
  ]
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/chats') {
      let kind = url.searchParams.get('kind') || 'chat';
      if (req.method === 'PUT') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString());
        kind = data.kind || 'chat'; fixtureHistories[kind] = data.conversations;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtureHistories[kind] || [])); return;
    }
    if (url.pathname === '/api/remote/start') {
      const qr = await require('qrcode').toDataURL('https://example.com/zaalis-fixture', { margin: 4, width: 320 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ qr, url: 'https://example.com/zaalis-fixture', active: true })); return;
    }
    if (url.pathname === '/api/preferences') {
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const mode = JSON.parse(Buffer.concat(chunks).toString('utf8')).permissionMode;
        if (['supervised', 'semi', 'auto'].includes(mode)) fixturePermissionMode = mode;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ permissionMode: fixturePermissionMode }));
      return;
    }
    const values = {
      '/api/auth/me': { authenticated: true, email: 'test@local.invalid', profile: { pseudo: 'Test' } },
      '/api/chats': [],
      '/api/files': [],
      '/api/gguf-models': { models: process.env.ZAALIS_UI_FIXTURE_GGUF ? [{ name: process.env.ZAALIS_UI_FIXTURE_GGUF, size: 105454432 }] : [] },
      '/api/ollama-models': { models: [] },
      '/api/model-capabilities': { provider: url.searchParams.get('provider'), model: url.searchParams.get('model'), reasoning: url.searchParams.get('provider') === 'codex' ? { mode: 'effort', supported: true, levels: [{ id: 'off', label: 'Désactivé', value: 0 }, { id: 'low', label: 'Faible', value: 1 }, { id: 'medium', label: 'Moyen', value: 2 }, { id: 'high', label: 'Élevé', value: 3 }, { id: 'max', label: 'Maximum', value: 4 }] } : { mode: 'none', supported: false, levels: [] }, contextWindow: 8192, tools: true, vision: false, ready: true },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(values[url.pathname] ?? {}));
    return;
  }
  const target = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  if (target === path.join(root, 'index.html') && url.searchParams.has('mode')) {
    const layout = JSON.stringify({ mode: url.searchParams.get('mode'), panel: url.searchParams.get('panel'), width: 420 });
    const html = fs.readFileSync(target, 'utf8').replace('</head>', `<script>localStorage.setItem('zaalis-workspace', ${JSON.stringify(layout)})</script></head>`);
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}).listen(port, '127.0.0.1', () => process.stdout.write(`UI fixture on ${port}\n`));
