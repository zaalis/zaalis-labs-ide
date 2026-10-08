'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');

// The IDE and both messenger transports share these same owned conversations.
class MessengerContinuation {
  constructor({ file, run }) { this.file = file; this.run = run; this.active = new Set(); this.execution = new Map(); }
  key(id, kind, conversationId) { return JSON.stringify([id, kind, conversationId]); }
  read(id, kind) { try { const list = JSON.parse(fs.readFileSync(this.file(id, kind), 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; } }
  find(id, binding) { const conv = this.read(id, binding.kind).find(c => c.id === binding.conversationId); if (!conv) throw Error('Conversation introuvable. Choisissez une conversation dans les intégrations.'); return conv; }
  choices(id) { return ['chat', 'agents'].flatMap(kind => this.read(id, kind).map(c => ({ kind, conversationId: c.id, title: c.title || 'Conversation', projectPath: c.projectPath || '', project: c.project || '' }))); }
  capture(id, kind, conversationId, config) { if (conversationId) this.execution.set(this.key(id, kind, conversationId), config); }
  bind(id, input) {
    if (!['chat', 'agents'].includes(input.kind) || typeof input.conversationId !== 'string') throw Error('Choisissez une conversation existante.');
    const binding = { kind: input.kind, conversationId: input.conversationId }, conv = this.find(id, binding);
    let execution = this.execution.get(this.key(id, input.kind, conv.id)) || conv.execution;
    if (!execution && input.execution) {
      execution = this.validateExecution(input.execution);
      const list = this.read(id, input.kind); list.find(c => c.id === conv.id).execution = execution;
      fs.writeFileSync(this.file(id, input.kind), JSON.stringify(list, null, 2));
    }
    if (!execution?.model && !execution?.team) throw Error('Ouvrez cette conversation dans l’IDE, puis choisissez « Utiliser la conversation active ».');
    return binding;
  }
  validateExecution(input) {
    if (!input || JSON.stringify(input).length > 100000) throw Error('Configuration de session invalide.');
    const model = String(input.model || ''), submodel = String(input.submodel || '');
    if (!/^[\w:-]{1,100}$/.test(model) || !submodel.trim() || submodel.length > 250) throw Error('Choisissez un modèle dans l’IDE avant de connecter la messagerie.');
    return { model, submodel, language: input.language === 'en' ? 'en' : 'fr', permissionMode: ['plan', 'supervised', 'semi', 'auto', 'read-only'].includes(input.permissionMode) ? input.permissionMode : 'supervised',
      reasoningLevel: Math.max(0, Math.min(2, Number(input.reasoningLevel) || 0)), projectPath: typeof input.projectPath === 'string' ? input.projectPath : null };
  }
  create(id, provider, execution, template) {
    const config = template ? this.find(id, template).execution : this.validateExecution(execution);
    if (!config) throw Error('Configuration de session introuvable.');
    const list = this.read(id, 'chat'), conversationId = crypto.randomUUID();
    const projectPath = template ? this.find(id, template).projectPath : config.projectPath;
    list.push({ id: conversationId, title: provider === 'whatsapp' ? 'WhatsApp' : 'Telegram', date: new Date().toLocaleDateString('fr-FR'), projectPath: projectPath || null,
      project: projectPath ? require('node:path').basename(projectPath) : null, execution: config, messages: [], gateway: provider });
    fs.writeFileSync(this.file(id, 'chat'), JSON.stringify(list, null, 2));
    return { kind: 'chat', conversationId };
  }
  merge(id, kind, incoming) {
    const current = this.read(id, kind);
    return incoming.map(c => {
      const old = current.find(x => x.id === c.id), messages = [...(c.messages || [])];
      const seen = new Set(messages.map(m => m.remoteId).filter(Boolean));
      for (const m of old?.messages || []) if (m.remoteId && !seen.has(m.remoteId)) messages.push(m);
      return { ...c, messages, execution: this.execution.get(this.key(id, kind, c.id)) || old?.execution || c.execution,
        remoteRevision: old?.remoteRevision || c.remoteRevision,
        ...(old?.remoteRevision && old.remoteRevision !== c.remoteRevision ? { sessionId: old.sessionId, apiHistory: undefined } : {}) };
    });
  }
  async answer(id, input) {
    const binding = input.binding, conv = this.find(id, binding), key = this.key(id, binding.kind, conv.id);
    if (this.active.has(key)) throw Error('Cette conversation travaille déjà dans l’IDE ou une autre messagerie. Réessayez à la fin du tour.');
    const execution = this.execution.get(key) || conv.execution;
    if (!execution) throw Error('Rouvrez cette conversation dans l’IDE avant de la reprendre.');
    this.active.add(key);
    const append = (type, text) => {
      const list = this.read(id, binding.kind), saved = list.find(c => c.id === conv.id);
      if (!saved) throw Error('La conversation a été supprimée.');
      saved.messages ||= []; saved.messages.push({ type, text, label: type === 'user' ? input.provider : 'Zaalis', remoteId: crypto.randomUUID() });
      saved.remoteRevision = crypto.randomUUID(); delete saved.apiHistory;
      fs.writeFileSync(this.file(id, binding.kind), JSON.stringify(list, null, 2));
    };
    try {
      const history = (conv.messages || []).filter(m => m.type === 'user' || (m.type === 'ai' && !m.activity)).map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.markdown || m.text || '' }));
      append('user', input.message);
      const result = await this.run(id, { ...execution, kind: binding.kind, conversationId: conv.id, root: conv.projectPath || null,
        sessionId: conv.sessionId, history, message: input.message, images: input.images || [], signal: input.signal }, input.onEvent);
      if (result.error) throw Error(result.error);
      const reply = result.response || 'L’IA n’a pas renvoyé de réponse.';
      append('ai', reply);
      const list = this.read(id, binding.kind), saved = list.find(c => c.id === conv.id);
      if (saved) { saved.sessionId = result.sessionId; fs.writeFileSync(this.file(id, binding.kind), JSON.stringify(list, null, 2)); }
      return reply;
    } finally { this.active.delete(key); }
  }
}
module.exports = { MessengerContinuation };
