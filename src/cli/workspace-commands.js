'use strict';

// HTTP commands share the same services as the graphical workspace. This
// module contains no terminal state, so command parsing remains testable.
async function workspaceCommand(name, argument, { request, root, model, submodel }) {
  const [action = 'list', ...rest] = argument.trim().split(/\s+/);
  const id = rest[0];
  let method = 'GET', endpoint, body;
  if (name === 'tools') {
    endpoint = '/api/tools?root=' + encodeURIComponent(root) + '&q=' + encodeURIComponent(argument);
    if (action === 'describe') { method = 'POST'; endpoint = '/api/tools/describe'; body = { root, name: rest.join(' ') }; }
  } else if (name === 'tasks') {
    endpoint = '/api/tasks';
    if (['run', 'cancel', 'delete', 'pause', 'enable'].includes(action)) {
      if (!id) throw new Error('Un identifiant de tâche est requis.');
      endpoint += '/' + encodeURIComponent(id);
      if (action === 'delete') method = 'DELETE';
      else if (action === 'pause' || action === 'enable') { method = 'PATCH'; body = { enabled: action === 'enable' }; }
      else { method = 'POST'; endpoint += '/' + action; body = {}; }
    } else if (action === 'create') {
      const words = [...rest];
      let intervalMinutes, runAt;
      for (const flag of ['--every', '--at']) {
        const index = words.indexOf(flag);
        if (index < 0) continue;
        const value = words[index + 1];
        if (!value) throw new Error('Valeur requise pour ' + flag);
        words.splice(index, 2);
        if (flag === '--every') {
          intervalMinutes = Number(value);
          if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('--every attend un nombre de minutes positif.');
        } else {
          const timestamp = Date.parse(value);
          if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error('--at attend une date future ISO 8601.');
          runAt = new Date(timestamp).toISOString();
        }
      }
      const prompt = words.join(' ');
      if (!prompt) throw new Error('Usage : /tasks create <consigne>');
      if (intervalMinutes && runAt) throw new Error('Choisir --every ou --at.');
      method = 'POST'; body = { title: prompt.slice(0, 80), prompt, root, model, submodel, permissionMode: 'supervised', enabled: !!(intervalMinutes || runAt), intervalMinutes, runAt };
    } else if (action !== 'list') throw new Error('Usage : /tasks list|create <consigne>|run|cancel|delete|pause|enable <id>');
  } else if (name === 'memory' || name === 'knowledge') {
    endpoint = '/api/knowledge?root=' + encodeURIComponent(root) + '&q=' + encodeURIComponent(action === 'list' ? rest.join(' ') : argument);
    if (action === 'add') {
      const content = rest.join(' ');
      if (!content) throw new Error('Usage : /memory add <note>');
      method = 'POST'; endpoint = '/api/knowledge'; body = { root, title: content.slice(0, 80), content, tags: ['cli'] };
    } else if (action === 'delete') {
      if (!id) throw new Error('Un identifiant de mémoire est requis.');
      method = 'DELETE'; endpoint = '/api/knowledge/' + encodeURIComponent(id);
    }
  } else return null;
  const result = await request(method, endpoint, body);
  if (result.status < 200 || result.status >= 300 || result.json?.error) throw new Error(result.json?.error || `HTTP ${result.status}`);
  return result.json || {};
}

module.exports = { workspaceCommand };
