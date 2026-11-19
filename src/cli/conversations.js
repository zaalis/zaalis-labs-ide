'use strict';

function createConversationClient(request) {
  const endpoint = id => '/api/conversations' + (id ? '/' + encodeURIComponent(id) : '');
  async function call(method, pathname, body) {
    const result = await request(method, pathname, body);
    if (result.status < 200 || result.status >= 300 || result.json?.error) {
      throw new Error(result.json?.error || `HTTP ${result.status}`);
    }
    return result.json || {};
  }
  return {
    async list(query = '', projectPath = '') {
      const result = await call('GET', endpoint() + '?kind=chat&archived=all&q=' + encodeURIComponent(query));
      return (result.conversations || []).filter(item => !projectPath || (item.projectPath || item.root || '').toLowerCase() === projectPath.toLowerCase());
    },
    async get(id) { return (await call('GET', endpoint(id) + '?kind=chat')).conversation; },
    async create(metadata) { return (await call('POST', endpoint(), { ...metadata, kind: 'chat' })).conversation; },
    async update(id, metadata) { return (await call('PATCH', endpoint(id), { ...metadata, kind: 'chat' })).conversation; },
    async fork(id, title) { return (await call('POST', endpoint(id) + '/fork', { kind: 'chat', title })).conversation; },
    async remove(id) { return call('DELETE', endpoint(id) + '?kind=chat'); },
  };
}

function conversationHistory(conversation) {
  const records = Array.isArray(conversation?.apiHistory) && conversation.apiHistory.length
    ? conversation.apiHistory : (conversation?.messages || []);
  return records.filter(item => ['user', 'assistant'].includes(item.role || item.type)).map(item => ({
    role: item.role || item.type,
    content: String(item.content ?? item.text ?? ''),
  }));
}

module.exports = { createConversationClient, conversationHistory };
