'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'interface');
const port = Number(process.env.ZAALIS_UI_FIXTURE_PORT || 31881);
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const values = {
      '/api/auth/me': { authenticated: true, email: 'test@local.invalid', profile: { pseudo: 'Test' } },
      '/api/chats': [],
      '/api/gguf-models': { models: [] },
      '/api/ollama-models': { models: [] },
      '/api/model-capabilities': { provider: url.searchParams.get('provider'), model: url.searchParams.get('model'), reasoning: { mode: 'none', supported: false, levels: [] }, contextWindow: 8192, tools: true, vision: false, ready: true },
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
