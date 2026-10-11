'use strict';
const { crypto, fail, text, publicData } = require('../common');
const { boundedJson, validateBase } = require('../connections');
class A2ATools {
  constructor(connections, store) { this.connections = connections; this.store = store; }
  async run(name, input, ctx) {
    const config = this.connections.get(ctx.userId, 'a2a'), agents = config.options.agents || [];
    if (name === 'a2a_list') return { agents: agents.map(({ token, ...row }) => row) };
    if (name === 'a2a_history') return { exchanges: this.store.read(ctx.userId, 'a2a-history').filter(row => !input.agent || row.agent === input.agent).slice(-100) };
    if (name === 'a2a_orchestrate') { const tasks=input.tasks||input.requests;if (!Array.isArray(tasks) || !tasks.length || tasks.length > 8) throw fail('One to eight A2A tasks.'); return { results: await Promise.all(tasks.map(task => this.run('a2a_call', task, ctx))) }; }
    const agent = agents.find(row => row.id === (input.agent||input.id)); if (!agent) throw fail('Choose an agent configured by the user.', 'connection_required', 409);
    const base = validateBase(agent.endpoint), token = config.tokens?.[agent.id];
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    if (name === 'a2a_discover') {
      const url = new URL('/.well-known/agent-card.json', base);
      const response = await this.connections.fetch(url, { redirect: 'error', headers, signal: ctx.signal || AbortSignal.timeout(30000) }); const card = await boundedJson(response);
      if (!response.ok) throw fail('A2A discovery HTTP ' + response.status, 'provider_error', response.status); return publicData(card);
    }
    if (name !== 'a2a_call') throw fail('Unknown A2A action.');
    // JSON-RPC binding of A2A 0.3; endpoints and credentials are owner-configured.
    const method = input.task_id ? 'tasks/get' : 'message/send';
    const params = input.task_id ? { id: input.task_id } : { message: { role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: text(input.message || input.goal, 'message', 32000) }] } };
    const response = await this.connections.fetch(base, { method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }), signal: ctx.signal || AbortSignal.timeout(120000) });
    const data = await boundedJson(response); if (!response.ok || data.error) throw fail('A2A call failed: ' + String(data.error?.message || response.status), 'provider_error', 502);
    const rows = this.store.read(ctx.userId, 'a2a-history'); rows.push(publicData({ agent: agent.id, time: new Date().toISOString(), method, result: data.result })); this.store.write(ctx.userId, 'a2a-history', rows.slice(-200)); return publicData(data.result);
  }
}
module.exports = { A2ATools };
