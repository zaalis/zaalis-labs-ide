'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

// In the WhatsApp self-chat, only messages that start with "zaalis!" are for
// the AI; everything else stays a personal note. "!zaalis" is still accepted.
const WHATSAPP_TRIGGER = /^\s*(?:zaalis\s*!|!\s*zaalis)(?=\s|$)\s*/i;
const TRIGGER_WORD = 'zaalis!';
// In the self-chat every message is the owner's, so AI replies carry a label.
// A dedicated number is a contact of its own: it answers without one.
const REPLY_LABEL = 'Zaalis · ';
const outgoing = (client, text) => client?.mode === 'bot' ? String(text).replace(/^Zaalis · /, '') : REPLY_LABEL + String(text).replace(/^Zaalis · /, '');

class MessengerIntegrations {
  constructor({ loadUsers, saveUsers, encrypt, decrypt, dataDir, appDir, answer, continuation, decide, media, fetchImpl = fetch, whatsappFactory }) {
    Object.assign(this, { loadUsers, saveUsers, encrypt, decrypt, dataDir, appDir, answer, continuation, decide, media, fetch: fetchImpl, whatsappFactory });
    this.sessions = new Map(); this.queues = new Map(); this.histories = new Map(); this.activity = new Map();
  }
  // Last exchange per account and messenger, shown on the integration page so
  // a message that was ignored or failed never looks like silence.
  note(id, provider, kind, detail = '') { this.activity.set(this.key(id, provider), { at: Date.now(), kind, detail: String(detail).slice(0, 300) }); }
  user(id) { const user = this.loadUsers().find(u => u.id === id); if (!user) throw Error('Compte introuvable.'); return user; }
  save(id, fn) { const users = this.loadUsers(), user = users.find(u => u.id === id); if (!user) throw Error('Compte introuvable.'); user.messengers ||= {}; fn(user.messengers); this.saveUsers(users); }
  key(id, provider) { return `${id}:${provider}`; }
  // Text prefix the owner types before a command in this messenger.
  prefix(id, provider) { return provider === 'whatsapp' && (this.user(id).messengers?.whatsapp?.mode || 'self-chat') !== 'bot' ? TRIGGER_WORD + ' ' : ''; }
  status(id, provider) {
    const stored = this.user(id).messengers || {}, session = this.sessions.get(this.key(id, provider));
    let state = session?.state || (stored[provider]?.enabled ? 'offline' : 'disconnected');
    // An unused Telegram pairing link is only valid for ten minutes.
    if (provider === 'telegram' && state === 'pairing' && !(session.expires > Date.now())) state = 'expired';
    const pairing = state === 'pairing';
    return { provider, configured: provider === 'telegram' ? !!stored.telegram?.token : !!stored.whatsapp?.enabled,
      connected: !!session?.connected, state,
      name: provider === 'telegram' ? stored.telegram?.username || '' : session?.name || '',
      qr: session?.qr || '', link: pairing ? session?.link || '' : '', linkQr: pairing ? session?.linkQr || '' : '',
      expiresAt: pairing ? session?.expires || 0 : 0, error: session?.error || '',
      trigger: this.prefix(id, provider).trim(), activity: this.activity.get(this.key(id, provider)) || null,
      binding: stored[provider]?.binding || null, conversations: this.continuation?.choices(id) || [],
      gateway: true, mode: stored.whatsapp?.mode || 'self-chat', allowedUsers: stored.whatsapp?.allowedUsers || [],
      model: stored.model || 'codex', submodel: stored.submodel || 'gpt-5.6-sol', language: stored.language || 'fr' };
  }
  settings(id, input) {
    if (this.continuation) {
      if (!['telegram', 'whatsapp'].includes(input.provider)) throw Error('Messagerie inconnue.');
      const current = this.user(id).messengers?.[input.provider] || {};
      const automatic = input.automatic === true;
      const binding = automatic ? null : this.continuation.bind(id, input);
      if ([...this.queues.keys()].some(key => key === this.key(id, input.provider) || key.startsWith(this.key(id, input.provider) + ':')) && JSON.stringify(binding) !== JSON.stringify(current.binding || null)) throw Object.assign(Error('Attendez la fin du tour avant de changer de conversation.'), { status: 409 });
      const execution = input.execution ? this.continuation.validateExecution(input.execution) : current.execution;
      // Choosing a conversation must not reset the WhatsApp mode it omits.
      const mode = input.mode === undefined ? current.mode || 'self-chat' : input.mode === 'bot' ? 'bot' : 'self-chat';
      const allowedUsers = Array.isArray(input.allowedUsers) ? [...new Set(input.allowedUsers.map(String))] : current.allowedUsers || [];
      if (allowedUsers.length > 32 || allowedUsers.some(number => !/^\d{6,16}$/.test(number))) throw Error('Indiquez des numéros avec leur indicatif pays, sans espaces ni signe +.');
      if (input.provider === 'whatsapp' && mode === 'bot' && !allowedUsers.length) throw Error('Le numéro dédié exige au moins un correspondant autorisé.');
      if (this.sessions.get(this.key(id, input.provider))?.connected && input.provider === 'whatsapp' && (mode !== (current.mode || 'self-chat') || JSON.stringify(allowedUsers) !== JSON.stringify(current.allowedUsers || []))) throw Error('Déconnectez WhatsApp avant de changer le mode ou les correspondants.');
      this.save(id, m => { m[input.provider] ||= {}; if (JSON.stringify(binding) !== JSON.stringify(m[input.provider].binding || null)) delete m[input.provider].peerBindings;
        Object.assign(m[input.provider], { binding, ...(execution ? { execution } : {}), ...(input.provider === 'whatsapp' ? { mode, allowedUsers } : {}) }); m.language = input.language === 'en' ? 'en' : 'fr'; });
      return { saved: true, binding };
    }
    if (!/^[\w:-]{1,100}$/.test(input.model || '') || typeof input.submodel !== 'string' || !input.submodel.trim() || input.submodel.length > 250) throw Error('Choisissez un fournisseur et un modèle.');
    this.save(id, m => { m.model = input.model; m.submodel = input.submodel; m.language = input.language === 'en' ? 'en' : 'fr'; });
    return { saved: true };
  }
  async telegramCall(token, method, body = {}, signal) {
    let response, data;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(35000) });
      data = await response.json();
    } catch { throw Object.assign(Error('Telegram est injoignable. Vérifiez la connexion Internet.'), { code: 'network' }); }
    if (response.ok && data?.ok) return data.result;
    // Telegram's error codes say what the owner has to do; keep them apart.
    const code = Number(data?.error_code || response.status) || 0;
    const message = code === 401 || code === 404 ? 'Telegram refuse la clé de ce bot (révoquée ou changée dans BotFather). Associez à nouveau votre bot.'
      : code === 409 ? 'Ce bot est déjà utilisé par un autre programme (webhook ou autre instance). Arrêtez-le ou créez un bot dédié à Zaalis.'
      : code === 429 ? 'Telegram limite temporairement les envois. Nouvel essai automatique.'
      : code === 403 ? 'Telegram refuse l’envoi : la conversation a peut-être bloqué le bot.'
      : 'Telegram a refusé la demande. Réessayez.';
    throw Object.assign(Error(message), { code, retryAfter: Number(data?.parameters?.retry_after) || 0 });
  }
  async configureTelegram(id, token) {
    if (typeof token !== 'string' || !/^\d{5,16}:[a-zA-Z0-9_-]{20,150}$/.test(token)) throw Error('Identifiant du bot Telegram invalide.');
    if (this.loadUsers().some(u => u.id !== id && u.messengers?.telegram?.token && this.decrypt(u.messengers.telegram.token) === token)) throw Error('Ce bot est déjà associé à un autre compte Zaalis.');
    let bot;
    try { bot = await this.telegramCall(token, 'getMe'); }
    catch (e) { if (e.code === 401 || e.code === 404) throw Error('Telegram refuse cette clé. Copiez la clé complète donnée par BotFather (format 123456789:ABC…).'); throw e; }
    if (!bot.is_bot || !/^[a-zA-Z0-9_]{5,64}$/.test(bot.username || '')) throw Error('Bot Telegram invalide.');
    const hook = await this.telegramCall(token, 'getWebhookInfo');
    if (hook.url) throw Error('Ce bot utilise déjà un webhook. Choisissez un bot privé dédié à Zaalis.');
    await this.stop(id, 'telegram');
    this.save(id, m => { m.telegram = { binding: m.telegram?.binding, token: this.encrypt(token), username: bot.username, enabled: false, offset: 0 }; });
    return this.status(id, 'telegram');
  }
  async startTelegram(id) {
    await this.stop(id, 'telegram');
    const stored = this.user(id).messengers?.telegram;
    if (!stored?.token) return { ...this.status(id, 'telegram'), setupRequired: true, url: 'https://t.me/BotFather' };
    const token = this.decrypt(stored.token), nonce = crypto.randomBytes(24).toString('base64url');
    const session = { connected: !!stored.chatId, state: stored.chatId ? 'connected' : 'pairing', nonce, expires: Date.now() + 600000, offset: stored.offset || 0, controller: new AbortController() };
    session.link = `https://t.me/${stored.username}?start=${nonce}`;
    // Scannable from the phone, so the link opens directly in Telegram there.
    if (!stored.chatId) session.linkQr = await require('qrcode').toDataURL(session.link, { width: 240, margin: 2 }).catch(() => '');
    this.sessions.set(this.key(id, 'telegram'), session);
    this.save(id, m => { m.telegram.enabled = true; });
    this.pollTelegram(id, token, session);
    return { ...this.status(id, 'telegram'), url: session.link };
  }
  async pollTelegram(id, token, session) {
    const key = this.key(id, 'telegram');
    while (this.sessions.get(key) === session) {
      try {
        const updates = await this.telegramCall(token, 'getUpdates', { offset: session.offset, timeout: 25, allowed_updates: ['message'] }, session.controller.signal);
        for (const update of updates) {
          if (this.sessions.get(key) !== session) return;
          if (!Number.isSafeInteger(update.update_id) || update.update_id < session.offset) continue;
          session.offset = update.update_id + 1;
          // Keep receiving approval replies while a turn waits for a decision.
          this.telegramMessage(id, token, session, update.message).catch(() => {});
          this.save(id, m => { if (m.telegram) m.telegram.offset = session.offset; });
        }
        session.error = '';
        if (!updates.length) await new Promise(resolve => { session.delay = setTimeout(resolve, 250); session.delay.unref(); });
      } catch (e) {
        if (this.sessions.get(key) !== session) return;
        // A refused key cannot recover by itself: stop and ask for a new one.
        if (e.code === 401 || e.code === 404) { session.connected = false; session.state = 'error'; session.error = e.message; return; }
        session.error = e.code === 'network' ? 'Connexion Telegram interrompue. Nouvelle tentative en cours.' : e.message;
        const wait = e.code === 409 ? 30000 : e.code === 429 ? Math.max(1, e.retryAfter) * 1000 : 5000;
        await new Promise(resolve => { session.delay = setTimeout(resolve, wait); session.delay.unref(); });
      }
    }
  }
  async telegramMessage(id, token, session, message) {
    if (this.sessions.get(this.key(id, 'telegram')) !== session) return;
    if (!message || message.chat?.type !== 'private' || message.from?.is_bot || !Number.isSafeInteger(message.from?.id) || message.chat.id !== message.from.id || typeof message.text !== 'string') return;
    const stored = this.user(id).messengers?.telegram;
    if (session.nonce && message.text === `/start ${session.nonce}` && session.expires > Date.now() && !stored.chatId) {
      this.save(id, m => { m.telegram.chatId = String(message.chat.id); }); session.nonce = ''; session.link = ''; session.linkQr = ''; session.connected = true; session.state = 'connected';
      await this.telegramCall(token, 'sendMessage', { chat_id: message.chat.id, text: 'Zaalis est connecté ✓ Écrivez simplement votre demande : elle continue la conversation choisie dans l’IDE. Les questions et validations arrivent ici.\n/status · /new · /sessions · /stop' }); return;
    }
    // A stale or foreign pairing link: say what to do instead of staying silent.
    if (!stored?.chatId && message.text.startsWith('/start')) {
      await this.telegramCall(token, 'sendMessage', { chat_id: message.chat.id, text: 'Ce lien d’association n’est plus valide. Dans Zaalis, ouvrez Intégrations → Telegram puis cliquez sur « Nouveau lien ».' }).catch(() => {}); return;
    }
    if (!stored?.chatId || stored.chatId !== String(message.chat.id)) return;
    if (message.text === '/new' && !this.continuation) { this.histories.delete(this.key(id, 'telegram')); this.save(id, m => { delete m.telegram.history; }); await this.telegramCall(token, 'sendMessage', { chat_id: message.chat.id, text: 'Nouvelle conversation Zaalis.' }); return; }
    if (message.text.startsWith('/start')) return;
    this.note(id, 'telegram', 'received');
    const reply = await this.respond(id, 'telegram', message.text, { peer: String(message.chat.id) });
    if (this.sessions.get(this.key(id, 'telegram')) !== session) return;
    for (let i = 0; i < reply.length; i += 3900) await this.telegramCall(token, 'sendMessage', { chat_id: message.chat.id, text: reply.slice(i, i + 3900) });
    if (reply && this.activity.get(this.key(id, 'telegram'))?.kind === 'received') this.note(id, 'telegram', 'replied');
  }
  async respond(id, provider, text, input = {}) {
    const channelKey = this.key(id, provider), session = this.sessions.get(channelKey), peer = input.peer || '';
    const key = peer ? channelKey + ':' + peer : channelKey;
    let owner = session;
    if (peer && session) { session.dialogs ||= new Map(); if (!session.dialogs.has(peer)) session.dialogs.set(peer, { controller: new AbortController() }); owner = session.dialogs.get(peer); }
    const valid = () => !session || this.sessions.get(channelKey) === session;
    const previous = this.queues.get(key) || Promise.resolve();
    if (this.continuation && peer) {
      const commandReply = await this.gatewayCommand(id, provider, peer, text, owner, key);
      if (commandReply !== null) return commandReply;
    }
    if (this.continuation) {
      const command = text.trim().match(/^\/(approve|deny)\s+([a-f0-9]{8})(?:\s+([\s\S]+))?$/i);
      if (command) {
        const pending = owner?.pending;
        if (!pending || pending.code !== command[2]) return 'Validation introuvable ou expirée. Utilisez le code de la dernière demande.';
        const allow = command[1].toLowerCase() === 'approve';
        owner.pending = null;
        try { await this.decide(id, { sessionId: pending.sessionId, requestId: pending.requestId, kind: pending.kind, allow, feedback: command[3], scope: 'once', ...(pending.kind === 'budget' ? { stop: true } : {}) }); return allow && pending.kind !== 'budget' ? 'Validation enregistrée. Le travail reprend.' : 'Refus enregistré.'; } catch { return 'Cette validation n’est plus disponible.'; }
      }
      if (this.queues.has(key) && owner?.pending?.kind === 'plan' && !text.trim().startsWith('/')) {
        const pending = owner.pending; owner.pending = null;
        try { await this.decide(id, { ...pending, kind: 'plan', allow: false, feedback: text.slice(0, 12000) }); return 'Vos consignes sont transmises. L’IA révise le plan.'; }
        catch { return 'Ce plan n’attend plus de réponse.'; }
      }
      if (this.queues.has(key) && owner?.pending) return `Une validation attend votre réponse. Envoyez ${this.prefix(id, provider)}/approve ou ${this.prefix(id, provider)}/deny avec le code indiqué.`;
    }
    const task = previous.catch(() => {}).then(async () => {
      if (!valid()) return '';
      const config = this.user(id).messengers || {};
      let history = this.histories.get(key);
      if (!history) { try { history = JSON.parse(this.decrypt(config[provider]?.history || '') || '[]'); if (!Array.isArray(history)) history = []; } catch { history = []; } }
      if (text.length > 12000) return 'Votre message est trop long. Limitez-le à 12 000 caractères.';
      try {
        if (this.continuation) {
          let binding = config[provider]?.binding;
          if (peer) binding = this.gatewayBinding(id, provider, peer);
          if (!binding) return 'Choisissez la conversation à continuer dans Intégrations → ' + provider + ' dans l’IDE.';
          if (owner?.controller?.signal.aborted) owner.controller = new AbortController();
          owner.delivery = null;
          const delivery = owner.delivery = peer ? this.delivery(id, provider, peer, valid) : null;
          const media = input.media && this.media ? await this.media(id, provider, input.media) : {};
          const message = [text, media.text].filter(Boolean).join('\n\n');
          const reply = await this.continuation.answer(id, { binding, provider, message, images: media.images || [], signal: owner?.controller?.signal,
            onEvent: event => {
              delivery?.event(event);
              if (!['permission_required', 'plan_required', 'budget_required'].includes(event.type) || !valid()) return;
              const kind = event.type.split('_')[0], code = crypto.randomBytes(4).toString('hex');
              owner.pending = { kind, code, sessionId: event.sessionId, requestId: event.requestId };
              const prefix = this.prefix(id, provider);
              const detail = kind === 'plan' ? event.content : kind === 'permission' ? event.summary + (event.target ? '\n' + event.target : '') : 'Budget atteint. Arrêtez ce tour ; relancez depuis l’IDE pour ajuster le budget.';
              const prompt = String(detail || 'Validation demandée.') + '\n\n' + (kind === 'budget' ? '' : `Accepter : ${prefix}/approve ${code}\n`) + `Refuser : ${prefix}/deny ${code}`;
              this.send(id, provider, prompt, { peer }).catch(() => { owner.controller?.abort(); });
            } });
          return delivery && await delivery.finish(reply) ? '' : reply;
        }
        const answer = await this.answer(id, { model: config.model || 'codex', submodel: config.submodel || 'gpt-5.6-sol', language: config.language || 'fr', message: text, history, signal: owner?.controller?.signal });
        if (!valid()) return '';
        const reply = String(answer || '').trim() || 'L’IA n’a pas renvoyé de réponse.';
        const next = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }].slice(-20);
        this.histories.set(key, next); this.save(id, m => { m[provider] ||= {}; m[provider].history = this.encrypt(JSON.stringify(next)); });
        return reply;
      } catch (e) {
        owner?.delivery?.cancel();
        const reason = String(e.message || 'Tour interrompu.').slice(0, 1000);
        this.note(id, provider, 'failed', reason);
        return this.continuation ? '⚠️ L’IA n’a pas pu répondre : ' + reason : 'Zaalis ne peut pas répondre pour le moment. Vérifiez le modèle et sa connexion dans l’IDE.';
      }
    });
    this.queues.set(key, task); try { return await task; } finally { if (this.queues.get(key) === task) this.queues.delete(key); if (owner) owner.pending = null; }
  }
  gatewayBinding(id, provider, peer) {
    const config = this.user(id).messengers?.[provider] || {};
    const hash = crypto.createHash('sha256').update(peer).digest('hex');
    let binding = config.peerBindings?.[hash] || config.binding;
    if (binding) this.continuation.find(id, binding);
    else binding = this.continuation.create(id, provider, config.execution);
    if (!config.peerBindings?.[hash]) this.save(id, m => { m[provider].peerBindings ||= {}; m[provider].peerBindings[hash] = binding; });
    return binding;
  }
  async gatewayCommand(id, provider, peer, text, owner, key) {
    const match = text.trim().match(/^\/(new|status|stop|sessions|resume)(?:\s+(.+))?$/i);
    if (!match) return null;
    const command = match[1].toLowerCase();
    if (command === 'stop') { owner?.controller?.abort(); owner?.delivery?.cancel(); return 'Arrêt demandé. Vous pouvez reprendre depuis cette messagerie ou l’IDE.'; }
    const choices = this.continuation.choices(id);
    const prefix = this.prefix(id, provider);
    if (command === 'sessions') return choices.map((c, i) => `${i + 1}. ${c.title} · ${c.project || 'Sans projet'}`).join('\n') + `\n\nReprendre : ${prefix}/resume numéro`;
    if (command === 'status') { try { const c = this.continuation.find(id, this.gatewayBinding(id, provider, peer)); return `${c.title}\nProjet : ${c.projectPath || 'Sans projet'}\n${this.queues.has(key) ? 'Travail en cours' : 'Prêt'}\n${prefix}/new : nouveau fil · ${prefix}/sessions : conversations · ${prefix}/stop : arrêter`; } catch (e) { return e.message; } }
    if (this.queues.has(key)) return `Arrêtez le travail avec ${prefix}/stop et attendez sa fin avant de changer de conversation.`;
    try {
      const config = this.user(id).messengers?.[provider] || {};
      const binding = command === 'new' ? this.continuation.create(id, provider, config.execution, config.binding) : choices[Number(match[2]) - 1];
      if (!binding) return 'Conversation introuvable. Envoyez /sessions pour afficher la liste.';
      const selected = this.continuation.bind(id, { ...binding, execution: config.execution });
      const hash = crypto.createHash('sha256').update(peer).digest('hex');
      this.save(id, m => { m[provider].peerBindings ||= {}; m[provider].peerBindings[hash] = selected; });
      return command === 'new' ? 'Nouvelle conversation créée. Envoyez votre message.' : 'Conversation reprise avec son projet et son historique.';
    } catch (e) { return e.message; }
  }
  delivery(id, provider, peer, valid) {
    let cancelled = false, last = 0;
    return { event: () => {
      if (cancelled || !valid() || Date.now() - last < 4000) return; last = Date.now();
      const session = this.sessions.get(this.key(id, provider));
      if (provider === 'whatsapp') session?.client.typing?.(peer).catch(() => {});
      else { const stored = this.user(id).messengers.telegram; this.telegramCall(this.decrypt(stored.token), 'sendChatAction', { chat_id: peer, action: 'typing' }).catch(() => {}); }
    }, finish: async () => false, cancel: () => { cancelled = true; } };
  }
  async send(id, provider, text, input = {}) {
    const session = this.sessions.get(this.key(id, provider)); if (!session?.connected) throw Error('Messagerie déconnectée.');
    if (provider === 'whatsapp') return session.client.sendMessage(input.peer || session.client.info.wid._serialized, outgoing(session.client, text));
    const stored = this.user(id).messengers.telegram;
    for (let i = 0; i < text.length; i += 3900) {
      if (this.sessions.get(this.key(id, provider)) !== session) return;
      await this.telegramCall(this.decrypt(stored.token), 'sendMessage', { chat_id: input.peer || stored.chatId, text: text.slice(i, i + 3900) });
    }
  }
  // Proves the link end to end: a message that the owner sees on the phone.
  async test(id, provider) {
    const session = this.sessions.get(this.key(id, provider));
    if (!session?.connected) throw Error(provider === 'whatsapp' ? 'Connectez WhatsApp avant d’envoyer un test.' : 'Associez votre conversation Telegram avant d’envoyer un test.');
    if (provider === 'whatsapp' && session.client.mode === 'bot') throw Error('Avec un numéro dédié, écrivez au bot depuis un numéro autorisé pour tester.');
    const text = provider === 'whatsapp'
      ? `Test réussi ✓ Cette discussion est reliée à Zaalis sur votre PC.\nPour parler à l’IA, écrivez : ${TRIGGER_WORD} votre demande\nSans « ${TRIGGER_WORD} », vos messages restent de simples notes.`
      : 'Test réussi ✓ Cette conversation est reliée à Zaalis sur votre PC. Écrivez simplement votre demande.';
    await this.send(id, provider, text);
    this.note(id, provider, 'tested');
    return { ...this.status(id, provider), tested: true };
  }
  // How WhatsApp replies arrive. WhatsApp shows every message an account sends
  // as that account's own, so in the self-chat the AI's replies look like the
  // owner's. Only a second account — the dedicated number — can answer like a
  // contact, errors included. Changing mode unlinks the current account: the
  // other one is then linked with a new QR code.
  async whatsappMode(id, input) {
    const mode = input.mode === 'bot' ? 'bot' : 'self-chat';
    const current = this.user(id).messengers?.whatsapp || {};
    const allowedUsers = Array.isArray(input.allowedUsers)
      ? [...new Set(input.allowedUsers.map(value => String(value).replace(/[\s+().-]/g, '')).filter(Boolean))]
      : current.allowedUsers || [];
    if (allowedUsers.length > 32 || allowedUsers.some(number => !/^\d{6,16}$/.test(number))) throw Error('Indiquez des numéros avec leur indicatif pays, sans espaces ni signe +.');
    if (mode === 'bot' && !allowedUsers.length) throw Error('Le numéro dédié exige au moins un correspondant autorisé : indiquez votre numéro personnel.');
    const modeChanged = (current.mode || 'self-chat') !== mode;
    const peersChanged = JSON.stringify(allowedUsers) !== JSON.stringify(current.allowedUsers || []);
    // The bridge reads its correspondents at start: a running one restarts.
    const restart = !modeChanged && peersChanged && this.sessions.has(this.key(id, 'whatsapp'));
    if (modeChanged) await this.stop(id, 'whatsapp', true);
    else if (restart) await this.stop(id, 'whatsapp');
    this.save(id, m => { m.whatsapp = { ...m.whatsapp, mode, allowedUsers }; });
    if (restart) await this.startWhatsApp(id);
    return this.status(id, 'whatsapp');
  }
  // Forget the Telegram bot (its key, paired chat and offset), keep the
  // conversation choice, so another bot can be linked from scratch.
  async resetTelegram(id) {
    await this.stop(id, 'telegram');
    this.save(id, m => { if (m.telegram) m.telegram = { binding: m.telegram.binding, ...(m.telegram.execution ? { execution: m.telegram.execution } : {}) }; });
    return this.status(id, 'telegram');
  }
  async startWhatsApp(id) {
    const key = this.key(id, 'whatsapp');
    // A finished attempt (error, expired QR, logged out) is replaced by a new one.
    if (this.sessions.has(key) && !['error', 'expired', 'disconnected'].includes(this.sessions.get(key).state)) return this.status(id, 'whatsapp');
    if (this.sessions.has(key)) await this.stop(id, 'whatsapp');
    const session = { connected: false, state: 'connecting', startedAt: Math.floor(Date.now() / 1000), seen: new Set(), controller: new AbortController() }; this.sessions.set(key, session);
    try {
      let client;
      if (this.whatsappFactory) client = await this.whatsappFactory(id);
      else {
        const { WhatsAppBridge } = require('./whatsapp-bridge');
        const settings = this.user(id).messengers?.whatsapp || {};
        client = new WhatsAppBridge({ appDir: this.appDir, dataDir: this.dataDir, id, mode: settings.mode || 'self-chat', allowedUsers: settings.allowedUsers || [] });
      }
      session.client = client;
      client.on('qr', async qr => { if (this.sessions.get(key) !== session) return; const image = await require('qrcode').toDataURL(qr, { width: 300, margin: 2 }); if (this.sessions.get(key) === session && !session.connected && session.state !== 'linking') { session.qr = image; session.state = 'pairing'; session.error = ''; } });
      // The phone scanned the code: WhatsApp finishes linking this device.
      client.on('linking', () => { if (this.sessions.get(key) === session && !session.connected) { session.qr = ''; session.state = 'linking'; } });
      client.on('qr_expired', () => { if (this.sessions.get(key) !== session) return; session.qr = ''; session.state = 'expired'; session.error = ''; client.destroy().catch(() => {}); });
      client.on('logged_out', () => {
        if (this.sessions.get(key) !== session) return;
        Object.assign(session, { connected: false, qr: '', state: 'disconnected', error: 'WhatsApp a été déconnecté depuis votre téléphone. Cliquez sur « Connecter WhatsApp » pour l’associer à nouveau.' });
        this.save(id, m => { m.whatsapp = { ...m.whatsapp, enabled: false }; }); client.destroy().catch(() => {});
      });
      client.on('replaced', () => { if (this.sessions.get(key) !== session) return; Object.assign(session, { connected: false, qr: '', state: 'error', error: 'Cette session WhatsApp a été ouverte par un autre programme. Fermez-le puis reconnectez.' }); client.destroy().catch(() => {}); });
      client.on('ready', () => {
        if (this.sessions.get(key) !== session) return;
        session.connected = true; session.state = 'connected'; session.qr = ''; session.error = ''; session.name = client.info?.pushname || 'WhatsApp';
        const me = client.info?.wid?._serialized; session.selfIds = new Set(me ? [me] : []);
        this.save(id, m => { m.whatsapp = { ...m.whatsapp, enabled: true }; });
        // Recent WhatsApp accounts can address the same self-chat with an LID
        // or a phone-number JID. Resolve only the owner's own identifiers.
        if (me && client.getContactLidAndPhone) client.getContactLidAndPhone([me]).then(ids => {
          if (this.sessions.get(key) !== session) return;
          for (const item of ids || []) for (const value of [item.lid, item.pn]) if (typeof value === 'string' && /@(lid|c\.us)$/.test(value)) session.selfIds.add(value);
        }).catch(() => {});
      });
      client.on('reconnecting', () => { if (this.sessions.get(key) === session) { session.connected = false; session.state = 'connecting'; } });
      client.on('auth_failure', () => { if (this.sessions.get(key) !== session || ['expired', 'disconnected'].includes(session.state)) return; session.connected = false; session.qr = ''; session.state = 'error'; session.error = 'L’association WhatsApp a échoué. Cliquez sur « Réessayer ».'; });
      client.on('disconnected', () => { if (this.sessions.get(key) === session) { this.sessions.delete(key); client.destroy().catch(() => {}); } });
      client.on('message_create', async msg => {
        if (this.sessions.get(key) !== session) return;
        const me = client.info?.wid?._serialized;
        if (!session.connected || !me || (msg.timestamp && msg.timestamp < session.startedAt)) return;
        if (!client.isGateway && (!msg.fromMe || !session.selfIds?.has(msg.from) || !session.selfIds?.has(msg.to) || msg.hasMedia)) return;
        if (client.isGateway && (!msg.gatewayMessage || !msg.peer)) return;
        // Self-chat: a message without "zaalis!" is a personal note, not a request.
        const selfChat = client.isGateway ? client.mode !== 'bot' : true;
        if (selfChat && !WHATSAPP_TRIGGER.test(msg.body || '')) { if (msg.body && !msg.body.startsWith('Zaalis · ')) this.note(id, 'whatsapp', 'ignored'); return; }
        const messageId = msg.id?._serialized; if (!messageId || session.seen.has(messageId)) return;
        session.seen.add(messageId); if (session.seen.size > 500) session.seen.delete(session.seen.values().next().value);
        const text = (msg.body || '').replace(WHATSAPP_TRIGGER, '').trim(); if (!text && !msg.hasMedia) return;
        const peer = client.isGateway ? msg.peer : undefined;
        this.note(id, 'whatsapp', 'received');
        try {
          const reply = await this.respond(id, 'whatsapp', text, { peer, media: msg.media });
          if (reply && this.sessions.get(key) === session) await client.sendMessage(peer || me, outgoing(client, reply));
          if (reply && this.activity.get(key)?.kind === 'received') this.note(id, 'whatsapp', 'replied');
        } catch { session.error = 'La réponse WhatsApp n’a pas pu être envoyée.'; this.note(id, 'whatsapp', 'failed', session.error); }
      });
      client.initialize().catch(() => { session.state = 'error'; session.error = 'WhatsApp ne peut pas démarrer. Vérifiez Internet et réessayez.'; client.destroy().catch(() => {}); });
      return this.status(id, 'whatsapp');
    } catch (e) { this.sessions.delete(key); throw e; }
  }
  async stop(id, provider, disconnect = false) {
    const key = this.key(id, provider), session = this.sessions.get(key); this.sessions.delete(key); this.histories.delete(key);
    session?.controller?.abort(); for (const dialog of session?.dialogs?.values() || []) { dialog.controller?.abort(); dialog.delivery?.cancel(); } clearTimeout(session?.delay);
    if (session?.client) {
      let timer;
      const close = async () => { if (disconnect) await session.client.logout().catch(() => {}); await session.client.destroy().catch(() => {}); };
      try { await Promise.race([close(), new Promise(resolve => { timer = setTimeout(() => { session.client.pupBrowser?.process()?.kill(); resolve(); }, 5000); })]); }
      finally { clearTimeout(timer); }
    }
    if (disconnect && provider === 'whatsapp') {
      const gatewayRoot = path.resolve(this.dataDir, 'whatsapp-gateway-sessions');
      const gatewayProfile = path.join(gatewayRoot, crypto.createHash('sha256').update(id).digest('hex'));
      if (fs.existsSync(gatewayProfile)) {
        if (!fs.realpathSync(gatewayProfile).startsWith(fs.realpathSync(gatewayRoot) + path.sep)) throw Error('Dossier de session invalide.');
        await fs.promises.rm(gatewayProfile, { recursive: true, force: true });
      }
      const root = path.resolve(this.dataDir, 'whatsapp-sessions');
      const profile = path.join(root, 'session-' + crypto.createHash('sha256').update(id).digest('hex'));
      if (fs.existsSync(profile)) {
        if (!fs.realpathSync(profile).startsWith(fs.realpathSync(root) + path.sep)) throw Error('Le dossier de session WhatsApp ne correspond pas à ce compte.');
        await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
    if (disconnect) this.save(id, m => { if (provider === 'telegram' && m.telegram) { m.telegram.enabled = false; delete m.telegram.chatId; delete m.telegram.history; } if (provider === 'whatsapp') m.whatsapp = { ...m.whatsapp, enabled: false }; });
    return this.status(id, provider);
  }
  restore() { for (const u of this.loadUsers()) { if (u.messengers?.telegram?.enabled) this.startTelegram(u.id).catch(() => {}); if (u.messengers?.whatsapp?.enabled) this.startWhatsApp(u.id).catch(() => {}); } }
  async shutdown() { await Promise.allSettled([...this.sessions.keys()].map(key => { const split = key.lastIndexOf(':'); return this.stop(key.slice(0, split), key.slice(split + 1)); })); }
}
module.exports = { MessengerIntegrations, WHATSAPP_TRIGGER, TRIGGER_WORD };
