'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./json-store');
const { sanitize } = require('../agent/secrets-mask');
function canonical(root) {
  let resolved; try { resolved = fs.realpathSync(root); } catch { resolved = path.resolve(root || '.'); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
const sameRoot = (a, b) => Boolean(a && b && canonical(a) === canonical(b));

// The Rust workspace token already identifies this agent, account and sandbox.
// A tool body cannot change their root or account by supplying extra fields.
function workspaceServiceAction(context, body, { memory, conversations, tasks, skills }) {
  const user = context.user.id, input = body.input || {}, root = context.projectRoot || context.root;
  const scopedTask = id => {
    const task = tasks.find(user, id); if (!sameRoot(task.root, root)) throw fail('Cette tâche appartient à un autre projet.', 403); return task;
  };
  const scopedMemory = id => {
    const record = memory.list(user).find(item => item.id === id);
    if (!record) throw fail('Mémoire introuvable.', 404);
    if (!sameRoot(record.root, root)) throw fail('Cette mémoire ne peut pas être modifiée depuis ce projet.', 403);
  };
  if (body.action === 'session_search') {
    const found = conversations.list(user, { kind: 'all', root, q: input.query || input.q, archived: 'all', limit: 20 });
    return { summary: `${found.total} conversation(s) trouvée(s).`, conversations: found.conversations.map(item => ({
      id: item.id, kind: item.kind, title: item.title, projectPath: item.projectPath, updatedAt: item.updatedAt,
      excerpt: (item.apiHistory || []).map(message => String(message.content || '')).join('\n').slice(-4000),
    })) };
  }
  if (body.action === 'memory') {
    if (['list', 'search'].includes(input.action || 'list')) return { summary: 'Mémoires du projet.', records: memory.list(user, { root, q: input.query || input.q }) };
    if (input.action === 'save') {
      if (input.id) scopedMemory(input.id);
      // Saved without a prompt, so secrets are masked and the record is marked
      // as written by the agent.
      const tags = [...new Set([...(Array.isArray(input.tags) ? input.tags : []), 'ia'])];
      return { summary: 'Mémoire enregistrée.', record: memory.save(user, { ...input, title: sanitize(String(input.title || '')), content: sanitize(String(input.content || '')), tags, root }) };
    }
    if (input.action === 'delete') { scopedMemory(input.id); memory.remove(user, input.id); return { summary: 'Mémoire supprimée.' }; }
    throw Object.assign(new Error('Action mémoire inconnue.'), { status: 400 });
  }
  if (body.action === 'tasks') {
    if ((input.action || 'list') === 'list') return { summary: 'Tâches du projet.', tasks: tasks.list(user).filter(task => sameRoot(task.root, root)) };
    if (input.action === 'create') return { summary: 'Tâche créée.', task: tasks.create(user, { ...input, root, permissionMode: context.permissionMode || 'supervised' }) };
    scopedTask(input.id);
    if (input.action === 'update') return { summary: 'Tâche modifiée.', task: tasks.update(user, input.id, { ...input, root, permissionMode: context.permissionMode || 'supervised' }) };
    if (input.action === 'run') return tasks.startRun(user, input.id).then(task => ({ summary: 'Tâche lancée.', task }));
    if (input.action === 'cancel') return { summary: 'Arrêt demandé.', ...tasks.cancel(user, input.id) };
    if (input.action === 'delete') { tasks.remove(user, input.id); return { summary: 'Tâche supprimée.' }; }
    throw Object.assign(new Error('Action tâche inconnue.'), { status: 400 });
  }
  if (body.action === 'skills' && skills) {
    if ((input.action || 'list') === 'list') return { summary: 'Skills disponibles.', skills: skills.list(user, projectRoot).skills.map(({ name, description, scope, enabled, origin }) => ({ name, description, scope, enabled, origin })) };
    if (input.action === 'propose') {
      const result = skills.propose(user, input);
      return { summary: result.status === 'active' ? `Skill ${result.name} enregistrée et active.` : `Skill ${result.name} proposée : l’utilisateur l’activera dans Paramètres → Skills.`, skill: result };
    }
    throw Object.assign(new Error('Action skills inconnue.'), { status: 400 });
  }
  return null;
}
module.exports = { workspaceServiceAction };
