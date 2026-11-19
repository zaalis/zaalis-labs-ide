#!/usr/bin/env node
'use strict';
// Local preview of the Glyphes app without Google or a real model:
//   node glyphes/server/dev/dev.js   -> http://localhost:8787/dev-login
// A scripted fake model answers so every screen can be exercised (link cards,
// several messages in a row, confirmation cards, errors).
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
process.env.GLYPHES_DATA = process.env.GLYPHES_DATA || path.join(os.tmpdir(), 'glyphes-dev');
process.env.PORT = process.env.PORT || '8787';
process.env.PUBLIC_URL = `http://localhost:${process.env.PORT}`;

const tc = (name, args) => ({ tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function reply(messages) {
    const last = [...messages].reverse().find(m => m.role === 'user' || m.role === 'tool');
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    if (last.role === 'tool') {
        if (/awaiting_confirmation/.test(text)) return { content: 'Je t’ai tout préparé : il ne manque que ta confirmation.' };
        if (/"shown":true/.test(text)) return { content: 'Voilà l’itinéraire le plus rapide. Bonne route !' };
        if (/"scheduled":true/.test(text)) return { content: 'C’est noté, je te préviens à l’heure.' };
        if (/"sent":true/.test(text)) return { content: 'Et je reste dispo si tu veux autre chose.' };
        if (/"asked":true/.test(text)) return { content: '' };
        return { content: 'C’est fait.' };
    }
    if (/Tu viens d’être créé/.test(text)) {
        const r = tc('ask_user', { question: 'En quoi puis-je t’aider aujourd’hui ?', options: ['Trier mes mails', 'Ajouter des alertes', 'Planifier mes rendez-vous'] });
        return { content: 'Salut Bryan ! Moi c’est ton nouveau Glyphe. En quoi puis-je t’aider aujourd’hui ?', ...r };
    }
    if (/Plus tard/.test(text)) return { content: 'Pas de souci, dis-moi quand tu seras prêt 🙂' };
    if (/Réponse à ta question/.test(text)) return { content: 'Parfait, je commence par ça !' };
    if (/Note système/.test(text)) return { content: /confirmé/.test(text) ? 'Parfait, c’est fait ✅' : 'Très bien, je n’envoie rien.' };
    if (/chemin|itin|aller/i.test(text)) return tc('maps_route', { destination: 'Tour Eiffel, Paris', mode: 'driving' });
    if (/séance|sport|rappel/i.test(text)) return tc('schedule_message', { at: new Date(Date.now() + 3600000).toISOString(), text: 'C’est l’heure de ta séance de sport 💪' });
    if (/mail/i.test(text)) return tc('gmail_send', { to: 'marie@example.com', subject: 'Point de demain', body: 'Bonjour Marie,\n\nOn garde 10 h pour le point de demain ?\n\nBonne soirée,\nBryan' });
    if (/supprime/i.test(text)) return tc('calendar_delete', { id: 'evt1', title: 'Réunion budget' });
    if (/plusieurs|deux/i.test(text)) return tc('send_message', { text: 'Premier message : je regarde ça.' });
    return { content: 'Bonjour ! Je peux trier tes mails, organiser ton agenda, créer des tâches et des notes, chercher sur le web ou préparer un trajet. **Que veux-tu faire ?**' };
}
const model = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => setTimeout(() => {
        const r = reply(JSON.parse(body).messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content || '', tool_calls: r.tool_calls } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }));
    }, 900));
});
model.listen(8799, '127.0.0.1');
const realFetch = global.fetch;
global.fetch = (url, opts) => realFetch(String(url).replace('https://fake.model', 'http://127.0.0.1:8799'), opts);

const { server, createSession, upsertUser } = require('../index.js');
const db = require('../db');
const secrets = require('../secrets');
const { user } = upsertUser({ id: 'gdev', email: 'dev@example.com', name: 'Bryan', picture: '' });
db.run(`INSERT OR REPLACE INTO model_creds (user_id, provider, label, data_enc, models, updated_at) VALUES (?, 'demo', 'Modèle de démonstration', ?, '["demo-1"]', 0)`,
    user.id, secrets.seal(JSON.stringify({ baseUrl: 'https://fake.model', key: 'k' }), `model:${user.id}:demo`));
db.run("INSERT OR REPLACE INTO google_tokens (user_id, scopes) VALUES (?, ?)", user.id, 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly');
const token = createSession(user.id, 'web', 'dev');
server.prependListener('request', (req, res) => {
    if (req.url === '/dev-login') { res.writeHead(302, { Location: '/', 'Set-Cookie': `glyphes=${token}; Path=/; HttpOnly; SameSite=Lax` }); res.end(); res.end = () => res; res.write = () => true; res.writeHead = () => res; res.setHeader = () => res; }
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log(`[glyphes dev] http://localhost:${process.env.PORT}/dev-login`));
require('../scheduler').start();
