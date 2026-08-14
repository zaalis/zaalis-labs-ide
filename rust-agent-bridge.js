'use strict';

// Thin JSON-RPC client for zaalis-agentd. It contains no provider/tool/agent
// logic: HTTP is only an adapter for the existing WebView while the Rust core
// owns sessions, permissions, streaming and orchestration.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function findAgentd(baseDir) {
  const exe = process.platform === 'win32' ? 'zaalis-agentd.exe' : 'zaalis-agentd';
  const candidates = [
    process.env.ZAALIS_AGENTD_PATH,
    // Packaged layout: the installer places the daemon beside
    // zaalis-server.exe. In development the native/dist and Cargo paths below
    // remain convenient fallbacks.
    path.join(baseDir, exe),
    path.join(baseDir, 'native', 'dist', exe),
    path.join(baseDir, 'rust', 'target', 'release', exe),
    path.join(baseDir, 'rust', 'target', 'debug', exe),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

class AgentdClient {
  constructor({ executable, dataDir, configDir, keys, extensionEnv, runtimeConfig }) {
    const env = { ...process.env, ...(extensionEnv || {}), ZAALIS_AGENTD_DATA_DIR: dataDir, ZAALIS_USER_CONFIG_DIR: configDir };
    if (runtimeConfig && runtimeConfig.ollamaUrl) env.ZAALIS_OLLAMA_URL = String(runtimeConfig.ollamaUrl);
    if (runtimeConfig && runtimeConfig.ggufUrl) env.ZAALIS_GGUF_URL = String(runtimeConfig.ggufUrl);
    if (runtimeConfig && runtimeConfig.computerEndpoint) env.ZAALIS_COMPUTER_ENDPOINT = String(runtimeConfig.computerEndpoint);
    if (runtimeConfig && runtimeConfig.computerToken) env.ZAALIS_COMPUTER_TOKEN = String(runtimeConfig.computerToken);
    const names = {
      openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY',
      grok: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY', moonshot: 'MOONSHOT_API_KEY'
    };
    for (const [name, variable] of Object.entries(names)) {
      if (keys && keys[name]) env[variable] = String(keys[name]);
    }
    this.child = spawn(executable, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.buffer = '';
    this.closed = false;
    this.stderr = '';
    this.exitPromise = new Promise((resolve) => { this._resolveExit = resolve; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.on('error', (error) => this._close(error));
    this.child.on('exit', (code) => { this._close(new Error(`agentd arrete (${code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`)); this._resolveExit(); });
  }

  _consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        this.pending.delete(String(message.id));
        if (message.error) {
          const error = new Error(message.error.message || 'Erreur agentd');
          error.code = message.error.code;
          error.data = message.error.data;
          error.status = message.error.code === -32602 || message.error.code === -32600 ? 400
            : message.error.code === -32601 ? 404 : 500;
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.method === 'session.event' && message.params && message.params.session_id) {
        const listeners = this.listeners.get(String(message.params.session_id));
        if (listeners) for (const listener of [...listeners]) listener(message.params);
      }
    }
  }

  _close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('agentd indisponible'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (!error) return;
        this.pending.delete(String(id));
        reject(error);
      });
    });
  }

  onSession(sessionId, listener) {
    const key = String(sessionId);
    const set = this.listeners.get(key) || new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key); };
  }

  stop() { try { this.child.kill(); } catch {} return this.exitPromise; }
}

class RustAgentBridge {
  constructor({ baseDir, dataDir, enabled = true }) {
    this.baseDir = baseDir;
    this.dataDir = dataDir;
    this.enabled = !!enabled;
    this.executable = findAgentd(baseDir);
    this.clients = new Map();
    this.sessions = new Map();
  }

  status() { return { enabled: this.enabled, available: !!this.executable, executable: this.executable ? path.basename(this.executable) : '' }; }

  _client(userId, keys, mcpServers, runtimeConfig) {
    if (!this.enabled) throw Object.assign(new Error('Core Rust desactive.'), { status: 404 });
    if (!this.executable) throw Object.assign(new Error('Binaire zaalis-agentd introuvable.'), { status: 503 });
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ keys: keys || {}, mcpServers: mcpServers || [], runtimeConfig: runtimeConfig || {} })).digest('hex');
    const existing = this.clients.get(userId);
    if (existing && existing.fingerprint === fingerprint && !existing.client.closed) return existing.client;
    if (existing) existing.client.stop();
    const userDir = path.join(this.dataDir, 'rust-agentd', crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24));
    fs.mkdirSync(userDir, { recursive: true });
    const configDir = path.join(userDir, 'extensions');
    fs.mkdirSync(configDir, { recursive: true });
    const extensionEnv = {};
    const servers = {};
    for (const [index, source] of (mcpServers || []).filter((server) => server && server.enabled !== false).slice(0, 32).entries()) {
      const id = String(source.id || '').trim();
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) continue;
      const tokenName = `ZAALIS_MCP_TOKEN_${index}`;
      if (source.token) extensionEnv[tokenName] = String(source.token);
      servers[id] = {
        transport: 'streamable_http', endpoint: String(source.endpoint || ''),
        ...(source.name ? { name: String(source.name) } : {}),
        ...(source.token ? { oauth_env: tokenName } : {}),
        allow: Array.isArray(source.allow) ? source.allow : [], deny: Array.isArray(source.deny) ? source.deny : [],
      };
    }
    const target = path.join(configDir, 'mcp.json');
    fs.writeFileSync(target, JSON.stringify({ servers }, null, 2), { encoding: 'utf8', mode: 0o600 });
    const client = new AgentdClient({ executable: this.executable, dataDir: userDir, configDir, keys, extensionEnv, runtimeConfig });
    this.clients.set(userId, { fingerprint, client });
    return client;
  }

  async run(options, onEvent) {
    const client = this._client(options.userId, options.keys, options.mcpServers, options.runtimeConfig);
    const create = {
      root: options.root,
      mode: options.team ? 'team' : 'chat',
      permission_mode: options.permissionMode || 'supervised',
      language: options.language || 'fr',
      history: (options.history || []).filter((item) => item && ['user', 'assistant'].includes(item.role))
        .map((item) => ({ role: item.role, content: String(item.content || '') })),
      ...(options.systemPrompt ? { system_prompt: String(options.systemPrompt).slice(0, 200000) } : {}),
    };
    if (options.team) create.agents = options.team;
    else create.model = { provider: options.model, model: options.submodel || undefined, reasoning: options.reasoningLevel || 0 };
    const made = await client.request('session.create', create);
    const sessionId = made.session_id;
    onEvent({ type: 'run_started', runId: sessionId, sessionId });
    const lead = options.team
      ? made.agents.find((agent) => agent.role && agent.role.name === 'lead') || made.agents[made.agents.length - 1]
      : made.agents[0];
    const text = new Map();
    const reasoning = new Map();
    const startedTools = new Map();
    const toolResults = [];
    let usage = null;
    let failure = '';
    this.sessions.set(sessionId, { client, userId: options.userId });
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const off = client.onSession(sessionId, (frame) => {
      const agent = String(frame.agent_id || 'session');
      if (frame.type === 'text_delta') text.set(agent, (text.get(agent) || '') + String(frame.text || ''));
      if (frame.type === 'reasoning_delta') reasoning.set(agent, (reasoning.get(agent) || '') + String(frame.text || ''));
      if (frame.type === 'tool_started') {
        startedTools.set(String(frame.call_id), { tool: frame.tool, input: frame.input || {} });
        onEvent({ type: 'tool_started', id: frame.call_id, tool: frame.tool, input: frame.input || {}, summary: frame.title });
      }
      if (frame.type === 'tool_completed') {
        const original = startedTools.get(String(frame.call_id)) || {};
        const outcome = frame.outcome || {};
        const result = { tool: original.tool || 'outil', input: original.input || {}, summary: outcome.summary || outcome.status || 'termine', text: outcome.result ? JSON.stringify(outcome.result) : (outcome.message || ''), error: outcome.status === 'error', blocked: outcome.status === 'denied' };
        toolResults.push(result);
        onEvent({ type: 'tool_done', id: frame.call_id, ...result });
      }
      if (frame.type === 'permission_requested') onEvent({ type: 'permission_required', sessionId, requestId: frame.request_id, summary: frame.summary, target: frame.target, risks: frame.risks || [] });
      if (frame.type === 'plan_ready') onEvent({ type: 'plan_required', sessionId, requestId: frame.request_id, content: frame.content });
      if (frame.type === 'budget_exhausted') onEvent({ type: 'budget_required', sessionId, requestId: frame.request_id, limit: frame.limit, usage: frame.usage });
      if (frame.type === 'agent_state_changed') onEvent({ type: 'agent_state', agentId: frame.agent_id, state: frame.state });
      if (frame.type === 'provider_error' || frame.type === 'agent_failed') failure = frame.message || frame.error || 'Erreur agent.';
      if (frame.type === 'turn_completed') { usage = frame.usage || usage; finish(); }
      onEvent({ type: 'rust_event', event: frame });
    });
    let abortHandler = null;
    if (options.signal) {
      abortHandler = () => { client.request('session.cancel', { session_id: sessionId }).catch(() => {}); };
      if (options.signal.aborted) abortHandler(); else options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    try {
      await client.request('session.prompt', { session_id: sessionId, text: options.message, images: options.images || [] });
      await completed;
      const leadId = String(lead.id);
      return { response: text.get(leadId) || '', thinking: reasoning.get(leadId) || '', usage: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null, toolResults, sessionId, ...(failure && !text.get(leadId) ? { error: failure } : {}) };
    } finally {
      if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
      off();
      this.sessions.delete(sessionId);
      client.request('session.close', { session_id: sessionId }).catch(() => {});
    }
  }

  async decide(userId, body) {
    const session = this.sessions.get(String(body.sessionId || ''));
    if (!session || session.userId !== userId) throw Object.assign(new Error('Session interactive introuvable.'), { status: 404 });
    const base = { session_id: body.sessionId, request_id: body.requestId };
    if (body.kind === 'permission') return session.client.request('permission.decide', { ...base, answer: body.allow ? { allow: { scope: body.scope || 'once' } } : 'deny' });
    if (body.kind === 'plan') return session.client.request(body.allow ? 'plan.approve' : 'plan.reject', { ...base, feedback: body.feedback || undefined });
    if (body.kind === 'budget') return session.client.request('budget.extend', { ...base, additional_tokens: body.additionalTokens, stop: !!body.stop });
    throw Object.assign(new Error('Decision interactive invalide.'), { status: 400 });
  }

  async cancel(userId, sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session || session.userId !== userId) throw Object.assign(new Error('Tache introuvable.'), { status: 404 });
    await session.client.request('session.cancel', { session_id: String(sessionId) });
    return { cancelled: true };
  }

  async close() {
    const stops = [...this.clients.values()].map((entry) => entry.client.stop());
    this.clients.clear();
    await Promise.allSettled(stops);
  }
}

module.exports = { AgentdClient, RustAgentBridge, findAgentd };
