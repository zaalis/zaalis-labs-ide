'use strict';
const { conversationHistory } = require('./conversations');

function createConversationController({ conversations, history, getSession, saveSession, persistConversation, projectRoot, output = console.log }) {
  let active = null;
  function adoptConversation(conversation) {
    if (!conversation?.id) throw new Error('Conversation introuvable.');
    active = conversation;
    history.splice(0, history.length, ...conversationHistory(conversation));
    if (conversation.model) { getSession().model = conversation.model; getSession().submodel = conversation.submodel; saveSession(getSession()); }
    persistConversation();
    return conversation;
  }

  async function ensureConversation(message) {
    if (!active) active = await conversations.create({
      title: String(message || 'Nouvelle conversation').slice(0, 90),
      projectPath: projectRoot(), model: getSession().model, submodel: getSession().submodel, source: 'cli',
    });
    persistConversation();
    return active;
  }

  async function conversationCommand(name, arg = '') {
    const query = arg.trim();
    if (name === 'resume' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(query)) {
      adoptConversation(await conversations.get(query));
      output('Session reprise : ' + active.title + ' · ' + active.id);
      return;
    }
    if (name === 'sessions' || name === 'session' || name === 'resume') {
      const listed = await conversations.list(/^\d+$/.test(query) ? '' : query);
      const selected = listed.find(item => item.id === query) || (/^\d+$/.test(query) ? listed[Number(query) - 1] : null);
      if (name === 'resume' && selected) {
        adoptConversation(await conversations.get(selected.id));
        output('Session reprise : ' + active.title + ' · ' + active.id); return;
      }
      const matches = listed;
      if (name === 'resume' && query && matches.length === 1) {
        adoptConversation(await conversations.get(matches[0].id)); output('Session reprise : ' + active.title); return;
      }
      matches.slice(0, 50).forEach((item, index) => output(`${index + 1}. ${item.id} · ${item.title || 'Conversation'}${item.archived ? ' [archive]' : ''}`));
      if (!matches.length) output('Aucune conversation correspondante.');
      return;
    }
    if (name === 'fork') {
      if (!active) throw new Error('Reprends une conversation avant de la forker.');
      adoptConversation(await conversations.fork(active.id, query || undefined));
      output('Conversation forkée : ' + active.id); return;
    }
    const id = active?.id;
    if (!id) throw new Error('Aucune conversation active.');
    if (name === 'rename') {
      if (!query) throw new Error('Usage : /rename <titre>');
      active = await conversations.update(id, { title: query });
    } else if (name === 'archive') {
      active = await conversations.update(id, { archived: query !== 'off' });
    } else if (name === 'delete') {
      if (query !== id) throw new Error('Pour supprimer la conversation active : /delete ' + id);
      await conversations.remove(id); active = null; history.length = 0;
    }
    persistConversation(); output('Conversation mise à jour.');
  }

  return { adoptConversation, ensureConversation, conversationCommand,
    get active() { return active; }, set active(value) { active = value; } };
}
module.exports = { createConversationController };
