#!/usr/bin/env node
'use strict';

// Reproducible visual QA against real server/daemon code. All model traffic
// terminates at this loopback fixture; accounts and workspaces are temporary.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { findAgentd } = require('../../src/agent/rust-agent-bridge');

const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, '.tmp', 'parity-qa');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-parity-qa-'));
const project = path.join(temporary, 'project'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'fixture.js'), 'export const answer = 41;\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});
let child, fixture, log, stopping = false;

async function stop() {
  if (stopping) return; stopping = true;
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
  log?.end();
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fs.rmSync(temporary, { recursive: true, force: true }); break; } catch { await pause(100); }
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  log = fs.createWriteStream(path.join(output, 'server.log'), { flags: 'a' });
  fixture = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url === '/health') return res.end('ok');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qa-fixture' }] }));
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
      const body = JSON.parse(raw), messages = body.messages || [];
      let lastUser = messages.length - 1;
      while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
      const prompt = String(messages[lastUser]?.content || '');
      const answered = messages.slice(lastUser + 1).some(message => message.role === 'tool');
      if (prompt.includes('QA_ERROR')) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'Erreur volontaire de la fixture QA.' } })); }
      res.setHeader('Content-Type', 'text/event-stream');
      const send = payload => { if (!res.destroyed) res.write('data: ' + JSON.stringify(payload) + '\n\n'); };
      let name, input;
      if (!answered && prompt.includes('QA_AGENTS')) {
        name = 'spawn_agent'; input = { objective: 'Vérifie le projet et rends un bref rapport.', background: true, role: {name:'review',label:'Vérification du projet',instructions:'Rends un bref rapport.'} };
      } else if (!answered && prompt.includes('QA_CLARIFY')) {
        name = 'request_user_input'; input = { questions: [{ id: 'format', prompt: 'Quel format de rapport souhaites-tu ?',
          options: [{ label: 'Court', description: 'Quelques phrases' }, { label: 'Détaillé', description: 'Avec les étapes' }], allow_free_text: true }] };
      } else if (!answered && prompt.includes('QA_DIFF')) {
        name = 'write'; input = { path: 'fixture.js', content: 'export const answer = 42;\n' };
      } else if (!answered && prompt.includes('QA_TOOLS')) { name = 'read'; input = { path: 'fixture.js' }; }
      if (name) {
        const content = prompt.includes('QA_AGENTS') ? 'Je vérifie le projet avec un sous-agent. '.repeat(35) : 'Je vérifie la demande avec un outil.\n\n';
        send({ choices: [{ index: 0, delta: { content, tool_calls: [{ index: 0, id: 'qa-tool-call', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return res.end('data: [DONE]\n\n');
      }
      const result = [
        'La réponse arrive progressivement depuis le fournisseur local de validation.\n\n',
        '## Vérification\n\n',
        '- Le chat utilise le vrai serveur et le vrai moteur Rust.\n',
        '- Les conversations peuvent être reprises et forkées.\n',
        '- Les détails des outils sont disponibles dans la timeline.\n\n',
        '| Élément | État |\n|---|---|\n| Flux | Actif |\n| Historique | Persisté |\n\n',
        '```javascript\nexport const answer = 42;\n```\n\n',
        answered ? 'La réponse de l’outil a été reçue. Le tour est terminé.' : 'Tu peux utiliser `QA_CLARIFY`, `QA_TOOLS`, `QA_DIFF`, `QA_SLOW` ou `QA_ERROR` pour les autres parcours.',
      ].join('');
      send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Je vérifie les événements, la continuité de session et le rendu des éléments.' } }] });
      const fragments = result.match(/.{1,28}(?:\n|$)?/gs) || [result];
      for (const content of fragments) {
        if (res.destroyed) break;
        send({ choices: [{ index: 0, delta: { content } }] });
        await pause(prompt.includes('QA_SLOW') ? 400 : 60);
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 120 } });
      res.end('data: [DONE]\n\n');
    } catch (error) { if (!res.headersSent) res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  const providerPort = await listen(fixture);
  const port = Number(process.env.ZAALIS_QA_PORT || 3335), baseUrl = `http://127.0.0.1:${port}`;
  // Refuse an occupied port before any registration/configuration request.
  const reservation = http.createServer(); await listen(reservation, port);
  await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, ['src/app/server.js'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: path.join(temporary, 'data'), ZAALIS_RUST_CORE: 'on', ZAALIS_AGENTD_PATH: findAgentd(repo) } });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('QA server exited; inspect .tmp/parity-qa/server.log');
    try { if ((await fetch(baseUrl + '/api/auth/me')).ok) break; } catch {}
    await pause(100);
  }
  const email = 'visual-qa@zaalis.local', password = 'local-visual-fixture-123';
  const registration = await fetch(baseUrl + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!registration.ok) throw new Error('QA registration failed: ' + await registration.text());
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const configured = await fetch(baseUrl + '/api/compat/keys', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: { custom: 'fake-local-qa-key' }, baseUrls: { custom: `http://127.0.0.1:${providerPort}/v1` } }) });
  if (!configured.ok) throw new Error('QA provider configuration failed');
  const info = { baseUrl, email, password, project, provider: 'compat:custom', model: 'qa-fixture', providerPort,
    markers: ['QA_CLARIFY', 'QA_TOOLS', 'QA_DIFF', 'QA_SLOW', 'QA_ERROR'], pid: process.pid };
  fs.writeFileSync(path.join(output, 'info.json'), JSON.stringify(info, null, 2));
  process.stdout.write(JSON.stringify(info, null, 2) + '\n');
}

process.on('SIGINT', () => stop().then(() => process.exit(0)));
process.on('SIGTERM', () => stop().then(() => process.exit(0)));
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => { if (text.trim() === 'stop') stop().then(() => process.exit(0)); });
main().catch(async error => { console.error(error.message); await stop(); process.exitCode = 1; });
