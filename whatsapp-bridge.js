'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');

function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
function markdown(text) {
  return String(text).split(/(```[\s\S]*?```|`[^`]+`)/g).map((part, i) => i % 2 ? part : part
    .replace(/\*\*(.*?)\*\*/g, '*$1*').replace(/~~(.*?)~~/g, '~$1~').replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')).join('');
}

class WhatsAppBridge extends EventEmitter {
  constructor({ appDir, dataDir, id, mode = 'self-chat', allowedUsers = [] }) {
    super(); Object.assign(this, { appDir, dataDir, id, mode, allowedUsers }); this.isGateway = true; this.seen = new Set();
    this.info = {}; this.controller = new AbortController(); this.token = crypto.randomBytes(32).toString('base64url');
    this.accountHash = crypto.createHash('sha256').update(String(id)).digest('hex');
    this.profile = path.join(dataDir, 'whatsapp-gateway-sessions', this.accountHash);
    this.cacheDir = path.join(dataDir, 'messenger-media', this.accountHash, 'whatsapp');
  }
  async initialize() {
    const runtime = process.pkg ? path.join(this.appDir, 'messenger-runtime') : path.join(this.appDir, 'native', 'dist', 'messenger-runtime');
    const node = process.pkg ? path.join(runtime, 'node.exe') : process.execPath;
    const script = path.join(runtime, 'launcher.mjs');
    if (!fs.existsSync(node) || !fs.existsSync(script)) throw Error('Le pont WhatsApp Zaalis est manquant. Réinstallez Zaalis.');
    this.port = await freePort(); this.base = `http://127.0.0.1:${this.port}`; this.startedAt = Math.floor(Date.now() / 1000);
    const env = { ...process.env, ZAALIS_WHATSAPP_BRIDGE_TOKEN: this.token,
      WHATSAPP_MODE: this.mode, WHATSAPP_DM_POLICY: 'allowlist', WHATSAPP_GROUP_POLICY: 'disabled',
      WHATSAPP_ALLOWED_USERS: this.allowedUsers.join(','), WHATSAPP_GROUP_ALLOWED_USERS: '', WHATSAPP_FORWARD_OWNER_MESSAGES: 'false',
      WHATSAPP_DEBUG: 'false', WHATSAPP_REPLY_PREFIX: this.mode === 'bot' ? '' : 'Zaalis · ', WHATSAPP_SEND_READ_RECEIPTS: this.mode === 'bot' ? 'true' : 'false',
      ZAALIS_IMAGE_CACHE_DIR: path.join(this.cacheDir, 'images'), ZAALIS_DOCUMENT_CACHE_DIR: path.join(this.cacheDir, 'documents'), ZAALIS_AUDIO_CACHE_DIR: path.join(this.cacheDir, 'audio') };
    this.child = spawn(node, [script, '--port', String(this.port), '--session', this.profile, '--mode', this.mode, '--pair-json'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    this.child.stdout.on('data', chunk => {
      output += chunk.toString(); if (output.length > 100000) output = output.slice(-100000);
      let end; while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1); let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'qr') this.emit('qr', event.qr);
        if (event.event === 'connected') {
          const jid = String(event.user?.id || '').replace(/:[^@]+@/, '@');
          this.info = { wid: { _serialized: jid }, pushname: event.user?.name || 'WhatsApp' }; this.connected = true; this.emit('ready');
        }
        if (event.event === 'disconnected') { this.connected = false; this.emit('reconnecting'); }
        if (event.event === 'linking') this.emit('linking');
        if (event.event === 'qr_expired') { this.ended = true; this.emit('qr_expired'); }
        if (event.event === 'logged_out') { this.ended = true; this.connected = false; this.emit('logged_out'); }
        if (event.event === 'replaced') { this.ended = true; this.connected = false; this.emit('replaced'); }
        if (event.event === 'error') this.emit('auth_failure');
      }
    });
    // Do not expose bridge stdout/stderr: they can contain account identifiers.
    this.child.stderr.resume();
    this.child.once('error', () => { if (!this.controller.signal.aborted) this.emit('auth_failure'); });
    // A bridge that announced why it stopped (expired QR, logged out) exits on purpose.
    this.child.once('exit', () => { if (!this.controller.signal.aborted && !this.ended) this.emit('auth_failure'); });
    this.poll().catch(() => {});
  }
  async call(endpoint, body) {
    const response = await fetch(this.base + '/' + endpoint, { redirect: 'error', headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(65000)]) });
    const result = await response.json(); if (!response.ok) throw Error('Le pont WhatsApp ne peut pas terminer cette opération.'); return result;
  }
  async poll() {
    while (!this.controller.signal.aborted) {
      try {
        const health = await this.call('health');
        if (path.resolve(health.session || '') !== path.resolve(this.profile)) throw Error('Pont WhatsApp associé à un autre compte.');
        const messages = await this.call('messages');
        for (const message of messages) {
          if (this.controller.signal.aborted) return;
          if (!message.messageId || this.seen.has(message.messageId) || message.isGroup || (message.timestamp && message.timestamp < this.startedAt)) continue;
          this.seen.add(message.messageId); if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
          this.emit('message_create', { id: { _serialized: message.messageId }, body: message.body || '', fromMe: message.fromMe,
            from: message.chatId, to: message.chatId, peer: message.chatId, timestamp: message.timestamp, hasMedia: message.hasMedia,
            gatewayMessage: true, media: message });
        }
      } catch { /* Startup and temporary network reconnects keep polling. */ }
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 650); this.controller.signal.addEventListener('abort', finish, { once: true });
        if (this.controller.signal.aborted) finish();
      });
    }
  }
  async sendMessage(chatId, text) { return this.call('send', { chatId, message: markdown(text) }); }
  async editMessage(chatId, messageId, text) { return this.call('edit', { chatId, messageId, message: markdown(text) }); }
  async typing(chatId) { return this.call('typing', { chatId }); }
  async logout() { return this.destroy(); }
  async destroy() {
    this.controller.abort(); const child = this.child; if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end();
    let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 3000); })]); clearTimeout(timer);
  }
}
module.exports = { WhatsAppBridge, markdown };
