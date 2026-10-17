'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson, safeKey, fail, copy } = require('./json-store');

class MemoryStore {
  constructor(directory) { this.directory = directory; }
  file(user) { return path.join(this.directory, `${safeKey(user)}.json`); }
  list(user, { root, q } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return readJson(this.file(user), []).filter(item => !root || !item.root || item.root === root)
      .filter(item => !needle || `${item.title}\n${item.content}\n${item.tags.join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt).map(copy);
  }
  save(user, input) {
    const content = String(input.content || '').trim();
    if (!content || content.length > 20000) throw fail('La mémoire doit contenir entre 1 et 20 000 caractères.');
    const list = readJson(this.file(user), []), previous = input.id && list.find(item => item.id === input.id);
    if (input.id && !previous) throw fail('Mémoire introuvable.', 404);
    if (!previous && list.length >= 1000) throw fail('Limite de 1 000 mémoires atteinte.');
    const now = Date.now();
    const record = { id: previous?.id || crypto.randomUUID(), title: String(input.title || previous?.title || content.split('\n')[0]).slice(0, 200),
      content, root: input.root === undefined ? previous?.root || null : input.root || null,
      tags: [...new Set((Array.isArray(input.tags) ? input.tags : previous?.tags || []).map(String))].slice(0, 20),
      createdAt: previous?.createdAt || now, updatedAt: now };
    const next = previous ? list.map(item => item.id === record.id ? record : item) : [...list, record];
    writeJson(this.file(user), next); return copy(record);
  }
  update(user, id, input) {
    const old = this.list(user).find(item => item.id === id); if (!old) throw fail('Mémoire introuvable.', 404);
    return this.save(user, { ...old, ...input, id });
  }
  remove(user, id) {
    const list = this.list(user); if (!list.some(item => item.id === id)) throw fail('Mémoire introuvable.', 404);
    writeJson(this.file(user), list.filter(item => item.id !== id));
  }
  recall(user, root, query) {
    const words = String(query).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [];
    const ranked = this.list(user, { root }).map(item => ({ item,
      score: words.reduce((n, word) => n + Number(`${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase().includes(word)), 0) }))
      .filter(entry => entry.score).sort((a, b) => b.score - a.score).slice(0, 6);
    if (!ranked.length) return '';
    return '\nMÉMOIRE DE RÉFÉRENCE (faits enregistrés par cet utilisateur, à confronter à la demande actuelle) :\n' +
      ranked.map(({ item }) => `[${item.id}] ${item.title}\n${item.content}`).join('\n\n').slice(0, 12000);
  }
}
module.exports = { MemoryStore };
