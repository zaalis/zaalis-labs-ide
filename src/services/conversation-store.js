'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { readJson, writeJson, safeKey, fail, copy } = require('./json-store');

const kindOf = value => value === 'agents' ? 'agents' : 'chat';
const searchable = conversation => [conversation.id, conversation.title, conversation.projectPath,
  ...(conversation.apiHistory || []).map(item => item.content),
  ...(conversation.messages || []).map(item => item.text)].join('\n').toLocaleLowerCase();

class ConversationStore {
  constructor({ directory, file }) { this.directory = directory; this.file = file; }
  read(user, kind = 'chat') {
    let file = this.file(user, kindOf(kind));
    if (kindOf(kind) === 'chat' && !fs.existsSync(file)) {
      const legacy = path.join(this.directory, `${user}.json`);
      if (fs.existsSync(legacy)) file = legacy;
    }
    const list = readJson(file, []);
    if (!Array.isArray(list)) throw fail('Historique de conversations invalide.', 500);
    return list;
  }
  write(user, kind, list) { writeJson(this.file(user, kindOf(kind)), list); }
  tombstoneFile(user, kind) { return path.join(this.directory, `${safeKey(user)}__${kindOf(kind)}.deleted.json`); }
  tombstones(user, kind) { return readJson(this.tombstoneFile(user, kind), []); }
  find(user, id, kind = 'chat') {
    const conversation = this.read(user, kind).find(item => item.id === id);
    if (!conversation) throw fail('Conversation introuvable.', 404);
    return copy(conversation);
  }
  list(user, query = {}) {
    const kinds = query.kind === 'all' ? ['chat', 'agents'] : [kindOf(query.kind)];
    const needle = String(query.q || '').trim().toLocaleLowerCase();
    const all = kinds.flatMap(kind => this.read(user, kind).map(item => ({ ...item, kind })))
      .filter(item => query.archived === 'all' || (query.archived === 'true' ? item.archived : !item.archived))
      .filter(item => !query.root || item.projectPath === query.root)
      .filter(item => !needle || searchable(item).includes(needle))
      .sort((a, b) => Number(b.updatedAt || b.contentUpdatedAt || b.id) - Number(a.updatedAt || a.contentUpdatedAt || a.id));
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 100));
    const offset = Math.max(0, Number(query.offset) || 0);
    return { conversations: copy(all.slice(offset, offset + limit)), total: all.length, offset, limit };
  }
  create(user, input = {}, id = crypto.randomUUID()) {
    const kind = kindOf(input.kind), now = Date.now();
    const conversation = { id, kind, title: String(input.title || 'Nouvelle conversation').slice(0, 200),
      date: new Date(now).toLocaleDateString('fr-FR'), createdAt: now, updatedAt: now,
      contentUpdatedAt: now, metadataRevision: 1, archived: false, messages: [], apiHistory: [],
      projectPath: input.projectPath || input.root || null,
      project: input.project || String(input.projectPath || input.root || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null,
      model: input.model || null, submodel: input.submodel || null, source: input.source || 'ide' };
    const list = this.read(user, kind); list.push(conversation); this.write(user, kind, list);
    return copy(conversation);
  }
  ensure(user, id, input = {}) {
    try { return this.find(user, id, input.kind); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(id)) || this.tombstones(user, input.kind).includes(id)) throw fail('Conversation supprimée ou identifiant invalide.', 404);
    return this.create(user, input, id);
  }
  update(user, id, input = {}) {
    const kind = kindOf(input.kind), list = this.read(user, kind), index = list.findIndex(item => item.id === id);
    if (index < 0) throw fail('Conversation introuvable.', 404);
    const current = list[index];
    if ('title' in input) {
      const title = String(input.title).trim(); if (!title) throw fail('Le titre est requis.');
      current.title = title.slice(0, 200);
    }
    if ('archived' in input) current.archived = Boolean(input.archived);
    current.metadataRevision = (current.metadataRevision || 0) + 1;
    current.updatedAt = Date.now(); this.write(user, kind, list); return copy(current);
  }
  fork(user, id, input = {}) {
    const original = this.find(user, id, input.kind), kind = kindOf(input.kind);
    const created = this.create(user, { ...original, ...input, title: input.title || `${original.title} · branche`, kind });
    const list = this.read(user, kind), index = list.findIndex(item => item.id === created.id);
    // A fork owns a new runtime. Its context starts from the copied transcript;
    // sharing the old sessionId would mutate the parent's model history.
    const branch = { ...created, messages: copy(original.messages || []), apiHistory: copy(original.apiHistory || []),
      parentId: original.id, forkedAt: Date.now(), contextTokens: original.contextTokens || null };
    list[index] = branch; this.write(user, kind, list); return copy(branch);
  }
  remove(user, id, kind = 'chat') {
    if (this.find(user, id, kind).status === 'running') throw fail('Arrêtez la réponse en cours avant de supprimer cette conversation.', 409);
    const deleted = this.tombstones(user, kind); deleted.push(id);
    writeJson(this.tombstoneFile(user, kind), [...new Set(deleted)]);
    this.write(user, kind, this.read(user, kind).filter(item => item.id !== id));
  }
  clear(user, kind) { for (const item of this.read(user, kind)) this.remove(user, item.id, kind); }
  recoverInterrupted() {
    fs.mkdirSync(this.directory, { recursive: true });
    for (const name of fs.readdirSync(this.directory).filter(name => /__(chat|agents)\.json$/.test(name))) {
      const file = path.join(this.directory, name), list = readJson(file, []); let changed = false;
      for (const item of list) if (item.status === 'running' || item.status === 'waiting') {
        item.status = 'interrupted'; item.activeTurnId = null;
        item.lastError = 'Tour interrompu par le redémarrage. La conversation peut être reprise.'; changed = true;
      }
      if (changed) writeJson(file, list);
    }
  }
  mergeLegacy(user, kind, incoming) {
    if (!Array.isArray(incoming)) throw fail('Liste de conversations invalide.');
    const previous = this.read(user, kind), byId = new Map(previous.map(item => [item.id, item]));
    const deleted = new Set(this.tombstones(user, kind)), seen = new Set();
    const merged = incoming.filter(item => item && typeof item.id === 'string' && !deleted.has(item.id)).map(item => {
      if (seen.has(item.id)) throw fail('Identifiant de conversation dupliqué.');
      seen.add(item.id); const old = byId.get(item.id);
      if (!old) return item;
      const fresh = Number(item.contentUpdatedAt || 0) >= Number(old.contentUpdatedAt || 0);
      const value = fresh ? { ...old, ...item } : { ...item, ...old };
      if (old.metadataRevision) for (const key of ['title', 'archived', 'metadataRevision', 'parentId', 'source']) value[key] = old[key];
      for (const key of ['sessionId', 'status', 'activeTurnId', 'lastError', 'execution', 'remoteRunning']) if (key in old) value[key] = old[key];
      value.updatedAt = Math.max(Number(old.updatedAt) || 0, Number(item.updatedAt) || 0, Number(item.contentUpdatedAt) || 0);
      return value;
    });
    // Bulk saves from an older window cannot erase canonical conversations
    // created by another window or the CLI. Explicit DELETE owns deletion.
    for (const item of previous) if (!seen.has(item.id) && item.metadataRevision && !deleted.has(item.id)) merged.push(item);
    this.write(user, kind, merged); return copy(merged);
  }
  mutate(user, id, kind, change) {
    const list = this.read(user, kind), index = list.findIndex(item => item.id === id);
    if (index < 0) throw fail('Conversation introuvable.', 404);
    change(list[index]); list[index].updatedAt = Date.now(); this.write(user, kind, list); return copy(list[index]);
  }
  beginTurn(user, id, kind, body, turnId) {
    return this.mutate(user, id, kind, conversation => {
      if (conversation.title === 'Nouvelle conversation' && !(conversation.messages || []).some(message => message.type === 'user')) conversation.title = String(body.message).slice(0, 80);
      if (body.persistTurn) {
        conversation.messages ||= []; conversation.apiHistory ||= [];
        conversation.messages.push({ type: 'user', text: body.message, turnId });
        conversation.apiHistory.push({ role: 'user', content: body.message });
      }
      Object.assign(conversation, { status: 'running', activeTurnId: turnId, contentUpdatedAt: Date.now() });
    });
  }
  finishTurn(user, id, kind, body, result, error) {
    return this.mutate(user, id, kind, conversation => {
      if (body.persistTurn && result?.response) {
        conversation.messages.push({ type: 'ai', text: result.response, markdown: result.response, turnId: conversation.activeTurnId });
        conversation.apiHistory.push({ role: 'assistant', content: result.response });
      }
      if (result?.sessionId) conversation.sessionId = result.sessionId;
      conversation.status = error ? 'failed' : 'completed'; conversation.lastError = error || null;
      conversation.activeTurnId = null; conversation.contentUpdatedAt = Date.now();
    });
  }
}
module.exports = { ConversationStore, kindOf };
