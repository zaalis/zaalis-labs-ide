import makeWASocket, { useMultiFileAuthState, DisconnectReason, jidNormalizedUser, Browsers } from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fs from 'node:fs';
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const session = arg('--session'), port = Number(arg('--port'));
const token = process.env.ZAALIS_WHATSAPP_BRIDGE_TOKEN;
if (!session || !port || !token) throw Error('Invalid bridge configuration');
fs.mkdirSync(session, { recursive: true });
const { state, saveCreds } = await useMultiFileAuthState(session);
const log = event => process.stdout.write(JSON.stringify(event) + '\n');
const logger = pino({ level: 'silent' });
const queue = [], seen = new Set(), outbound = new Set();
const allowed = new Set((process.env.WHATSAPP_ALLOWED_USERS || '').split(','));
let socket, connected = false, closing = false, retry, writes = Promise.resolve(), sends = Promise.resolve();
const remember = (set, id) => { set.add(id); if (set.size > 2000) set.delete(set.values().next().value); };
async function connect() {
  socket = makeWASocket({ auth: state, logger, browser: Browsers.ubuntu('Zaalis'), syncFullHistory: false, markOnlineOnConnect: false });
  const current = socket;
  socket.ev.on('creds.update', () => { writes = writes.then(saveCreds).catch(() => log({ event: 'error' })); });
  socket.ev.on('connection.update', update => {
    if (closing || socket !== current) return;
    if (update.qr) log({ event: 'qr', qr: update.qr });
    if (update.connection === 'open') { connected = true; log({ event: 'connected', user: socket.user }); }
    if (update.connection === 'close') {
      connected = false;
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { log({ event: 'error' }); return; }
      log({ event: 'disconnected' }); clearTimeout(retry); retry = setTimeout(() => connect().catch(() => log({ event: 'error' })), 2000);
    }
  });
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || closing || socket !== current) return;
    for (const message of messages) {
      const { key } = message, peer = jidNormalizedUser(key.remoteJid || ''), id = key.id;
      if (!connected || !id || seen.has(id) || outbound.has(id) || !/@(s.whatsapp.net|lid)$/.test(peer)) continue;
      const normalized = value => jidNormalizedUser(value || '');
      const ownerIds = new Set([normalized(socket.user?.id), normalized(socket.user?.lid)]);
      if (process.env.WHATSAPP_MODE === 'bot') { if (key.fromMe || !allowed.has(peer.split('@')[0])) continue; }
      else {
        let self = ownerIds.has(peer);
        if (!self && peer.endsWith('@lid')) { try { self = ownerIds.has(normalized(await socket.signalRepository.lidMapping.getPNForLID(peer))); } catch {} }
        if (!key.fromMe || !self) continue;
      }
      let content = message.message;
      for (let i = 0; i < 4; i++) content = content?.ephemeralMessage?.message || content?.viewOnceMessage?.message || content?.viewOnceMessageV2?.message || content;
      const body = content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || content?.videoMessage?.caption || '';
      if (!body || body.startsWith('Zaalis · ')) continue;
      remember(seen, id);
      queue.push({ messageId: id, chatId: peer, body, fromMe: key.fromMe, timestamp: Number(message.messageTimestamp), isGroup: false });
      if (queue.length > 200) queue.shift();
    }
  });
}
const app = express();
app.use((req, res, next) => req.headers.authorization === 'Bearer ' + token ? next() : res.sendStatus(401));
app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => res.json({ connected, session }));
app.get('/messages', (req, res) => res.json(queue.splice(0)));
app.post('/typing', async (req, res) => { try { await socket.sendPresenceUpdate('composing', req.body.chatId); res.json({ ok: true }); } catch { res.sendStatus(503); } });
for (const operation of ['send', 'edit']) app.post('/' + operation, async (req, res) => {
  const task = sends.catch(() => {}).then(async () => {
    const peer = req.body.chatId;
    if (!connected || !/^[\d]+@(s.whatsapp.net|lid)$/.test(peer || '')) throw Error('Unavailable');
    let last;
    const text = 'Zaalis · ' + String(req.body.message || '').replace(/^Zaalis · /, '');
    for (let i = 0; i < text.length; i += 3900) {
      const result = await socket.sendMessage(peer, { text: text.slice(i, i + 3900), ...(operation === 'edit' ? { edit: { remoteJid: peer, id: req.body.messageId, fromMe: true } } : {}) });
      remember(outbound, result.key.id); last = result.key.id;
    }
    return { messageId: last };
  }); sends = task;
  try { res.json(await task); } catch { res.status(503).json({ error: 'Unavailable' }); }
});
const server = app.listen(port, '127.0.0.1');
async function close() { if (closing) return; closing = true; clearTimeout(retry); socket?.end(undefined); server.close(); await writes; process.exit(0); }
process.stdin.resume(); process.stdin.on('end', close); process.on('SIGTERM', close); process.on('SIGINT', close);
await connect();
