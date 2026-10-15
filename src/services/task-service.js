'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson, safeKey, fail, copy } = require('./json-store');

class TaskService {
  constructor({ directory, run, concurrency = 2, clock = Date.now }) {
    this.directory = directory; this.runAgent = run; this.concurrency = concurrency; this.clock = clock;
    this.active = new Map(); this.users = new Set();
    fs.mkdirSync(directory, { recursive: true });
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const document = readJson(path.join(directory, name), null);
      if (!document?.user) continue; this.users.add(document.user);
      for (const task of document.tasks || []) if (task.status === 'running' || task.status === 'waiting') {
        task.status = 'interrupted'; task.pending = null; task.lastError = 'Exécution interrompue par le redémarrage du serveur.';
      }
      writeJson(path.join(directory, name), document);
    }
  }
  file(user) { return path.join(this.directory, `${safeKey(user)}.json`); }
  read(user) { return readJson(this.file(user), { user, tasks: [] }).tasks; }
  write(user, tasks) { this.users.add(user); writeJson(this.file(user), { user, tasks }); }
  list(user) { return copy(this.read(user).sort((a, b) => b.updatedAt - a.updatedAt)); }
  find(user, id) { const task = this.read(user).find(task => task.id === id); if (!task) throw fail('Tâche introuvable.', 404); return task; }
  validate(input, old = {}) {
    const task = { ...old, ...input };
    task.title = String(task.title || 'Nouvelle tâche').trim().slice(0, 200);
    task.prompt = String(task.prompt || '').trim(); if (!task.prompt || task.prompt.length > 50000) throw fail('Une demande de 1 à 50 000 caractères est requise.');
    if (!task.root || typeof task.root !== 'string' || !path.isAbsolute(task.root) || !fs.existsSync(task.root) || !fs.statSync(task.root).isDirectory()) throw fail('Le dossier de la tâche doit exister.');
    task.permissionMode = task.permissionMode || 'supervised';
    if (!['read-only', 'plan', 'supervised', 'semi', 'auto'].includes(task.permissionMode)) throw fail('Mode de permissions invalide.');
    task.intervalMinutes = task.intervalMinutes ? Number(task.intervalMinutes) : null;
    if (task.intervalMinutes !== null && (!Number.isFinite(task.intervalMinutes) || task.intervalMinutes < 1 || task.intervalMinutes > 525600)) throw fail('La récurrence doit être comprise entre 1 minute et 1 an.');
    task.runAt = task.runAt || null;
    if (task.runAt && !Number.isFinite(Date.parse(task.runAt))) throw fail('Date de lancement invalide.');
    task.enabled = task.enabled !== false;
    return task;
  }
  create(user, input) {
    const list = this.read(user); if (list.length >= 100) throw fail('Limite de 100 tâches atteinte.');
    const valid = this.validate(input), now = this.clock();
    // Only accepted fields are persisted; a body cannot forge another account,
    // conversation, current execution status or approval request.
    const task = { id: crypto.randomUUID(), title: valid.title, prompt: valid.prompt, root: valid.root,
      model: valid.model || 'mistral', submodel: valid.submodel || null, permissionMode: valid.permissionMode,
      intervalMinutes: valid.intervalMinutes, runAt: valid.runAt, enabled: valid.enabled,
      nextRunAt: valid.enabled ? valid.runAt ? Date.parse(valid.runAt) : valid.intervalMinutes ? now + valid.intervalMinutes * 60000 : null : null,
      createdAt: now, updatedAt: now, status: 'idle', history: [] };
    list.push(task); this.write(user, list); return copy(task);
  }
  update(user, id, input) {
    const old = this.find(user, id);
    const fields = Object.fromEntries(['title', 'prompt', 'root', 'model', 'submodel', 'permissionMode', 'intervalMinutes', 'runAt', 'enabled'].filter(key => key in input).map(key => [key, input[key]]));
    if (this.active.has(`${user}:${id}`) && Object.keys(fields).some(key => !['title', 'enabled'].includes(key))) throw fail('Arrêtez la tâche avant de modifier sa configuration.', 409);
    const valid = this.validate(fields, old);
    valid.updatedAt = this.clock();
    valid.nextRunAt = !valid.enabled ? null : valid.runAt ? Date.parse(valid.runAt) : valid.intervalMinutes ? this.clock() + valid.intervalMinutes * 60000 : null;
    this.write(user, this.read(user).map(task => task.id === id ? valid : task)); return copy(valid);
  }
  mutate(user, id, change) {
    const list = this.read(user), task = list.find(task => task.id === id); if (!task) throw fail('Tâche introuvable.', 404);
    change(task); task.updatedAt = this.clock(); this.write(user, list); return task;
  }
  async startRun(user, id) {
    const task = this.find(user, id), key = `${user}:${id}`;
    if (this.active.has(key)) throw fail('Cette tâche est déjà en cours.', 409);
    if (this.active.size >= this.concurrency) throw fail('Le nombre maximal de tâches simultanées est atteint.', 409);
    const controller = new AbortController(), started = this.clock();
    const entry = { controller }; this.active.set(key, entry);
    this.mutate(user, id, current => { current.status = 'running'; current.pending = null; current.lastError = null; current.lastStartedAt = started; });
    entry.done = (async () => {
      let result, error;
      try {
        result = await this.runAgent(user, copy(task), event => {
          if (event.type === 'run_started') this.mutate(user, id, current => { current.sessionId = event.sessionId; });
          if (['permission_required', 'plan_required', 'budget_required', 'clarification_required'].includes(event.type)) {
            this.mutate(user, id, current => { current.status = 'waiting'; current.pending = event; });
          }
          if (event.type === 'rust_event' && /(?:permission|clarification)_resolved/.test(event.event?.type || '')) this.clearPending(user, event.event.request_id);
        }, controller.signal);
      } catch (failure) { error = String(failure.message || failure); }
      finally {
        this.active.delete(key);
        this.mutate(user, id, current => {
          current.status = controller.signal.aborted ? 'cancelled' : error ? 'failed' : 'completed';
          current.pending = null; current.lastError = error || null; current.lastResult = String(result?.response || '').slice(0, 100000);
          current.sessionId = result?.sessionId || current.sessionId;
          current.lastFinishedAt = this.clock();
          current.history = [...(current.history || []), { startedAt: started, finishedAt: current.lastFinishedAt, status: current.status, error: current.lastError }].slice(-20);
          current.nextRunAt = current.enabled && current.intervalMinutes ? this.clock() + current.intervalMinutes * 60000 : null;
        });
      }
    })();
    entry.done.catch(() => {}); return copy(this.find(user, id));
  }
  clearPending(user, requestId) {
    for (const task of this.read(user)) if (task.pending?.requestId === requestId) this.mutate(user, task.id, current => { current.pending = null; current.status = 'running'; });
  }
  cancel(user, id) {
    this.find(user, id); const entry = this.active.get(`${user}:${id}`);
    if (entry) entry.controller.abort(); return { cancelled: Boolean(entry) };
  }
  remove(user, id) {
    this.find(user, id); if (this.active.has(`${user}:${id}`)) throw fail('Arrêtez la tâche avant de la supprimer.', 409);
    this.write(user, this.read(user).filter(task => task.id !== id));
  }
  async tick() {
    for (const user of this.users) for (const task of this.read(user)) {
      if (task.enabled && task.nextRunAt && task.nextRunAt <= this.clock() && !this.active.has(`${user}:${task.id}`) && this.active.size < this.concurrency) await this.startRun(user, task.id);
    }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(error => { this.lastError = error.message; }), 15000); this.timer.unref(); } }
  async shutdown() { clearInterval(this.timer); for (const entry of this.active.values()) entry.controller.abort(); await Promise.allSettled([...this.active.values()].map(entry => entry.done)); }
}
module.exports = { TaskService };
