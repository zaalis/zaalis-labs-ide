'use strict';

// Thin JSON-RPC client for zaalis-agentd. It contains no provider/tool/agent
// logic: HTTP is only an adapter for the existing WebView while the Rust core
// owns sessions, permissions, streaming and orchestration.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mcpRegistry = require('./mcp-registry');
// Noms de méthodes et étiquettes d'événements générés depuis
// rust/crates/zaalis-protocol.  Les retaper ici serait le bug silencieux
// classique : le cœur émet un événement que personne ne rend, sans erreur.
const { METHODS, EVENTS } = require('./interface/script/protocol.generated');

const SESSION_EVENT = 'session.event';

function findAgentd(baseDir) {
  const exe = process.platform === 'win32' ? 'zaalis-agentd.exe' : 'zaalis-agentd';
  const candidates = [
    process.env.ZAALIS_AGENTD_PATH,
    // Packaged layout: the installer places the daemon beside
    // zaalis-server.exe. In development the native/dist and Cargo paths below
    // remain convenient fallbacks.
    path.join(baseDir, exe),
    path.join(baseDir, 'native', 'dist', exe),
    path.join(baseDir, 'native', process.platform === 'darwin' ? `dist-macos-${process.arch}-server` : 'dist-linux-server', exe),
    path.join(baseDir, 'rust', 'target', 'release', exe),
    path.join(baseDir, 'rust', 'target', 'debug', exe),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

// A connected MCP server can come with a Skill: the one line that tells the
// model the server exists, and the instructions it loads on demand. They are
// written where the core reads user Skills. Only folders this bridge created
// (marked below) are ever replaced or removed.
const MANAGED_SKILL_MARKER = '.zaalis-managed';

// Tool calls to a local program (a render, a long script) outlast the 15 s the
// runtime grants by default; this is the most its configuration accepts.
const STDIO_MCP_TIMEOUT_MS = 120000;

// One `servers` entry of the runtime's mcp.json, or null when the server
// cannot be started. Secrets never enter the file: the token and the values of
// a stdio server's environment travel in `extensionEnv` and the file only
// names the variable to read. The runtime rejects the whole file on a single
// bad entry, so a program that is missing or cannot be resolved is left out.
function runtimeMcpEntry(source, index, extensionEnv) {
  const common = {
    ...(source.name ? { name: String(source.name) } : {}),
    allow: Array.isArray(source.allow) ? source.allow : [], deny: Array.isArray(source.deny) ? source.deny : [],
  };
  if (mcpRegistry.transportOf(source) !== 'stdio') {
    if (!mcpRegistry.parseEndpoint(source.endpoint)) return null;
    const tokenName = `ZAALIS_MCP_TOKEN_${index}`;
    if (source.token) extensionEnv[tokenName] = String(source.token);
    // A server whose calls run long (a render) says so; the runtime grants 15 s otherwise.
    const timeout = Number(source.timeoutMs) > 0 ? { timeout_ms: Math.min(Math.round(Number(source.timeoutMs)), 120000) } : {};
    return { transport: 'streamable_http', endpoint: String(source.endpoint || ''), ...(source.token ? { oauth_env: tokenName } : {}), ...timeout, ...common };
  }
  let executable = mcpRegistry.resolveCommand(source.command);
  try { executable = executable && fs.realpathSync.native(executable); } catch { executable = ''; }
  const args = Array.isArray(source.args) ? source.args.map(String) : [];
  if (!executable || args.length > 64) return null;
  const envFrom = {};
  for (const [position, [name, value]] of Object.entries(source.env && typeof source.env === 'object' ? source.env : {}).entries()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || position >= 64) continue;
    const holder = `ZAALIS_MCP_ENV_${index}_${position}`;
    extensionEnv[holder] = String(value == null ? '' : value);
    envFrom[name] = holder;
  }
  return { transport: 'stdio', executable, args, env_from: envFrom, timeout_ms: STDIO_MCP_TIMEOUT_MS, ...common };
}
function syncManagedSkills(configDir, skills) {
  const root = path.join(configDir, 'skills');
  const wanted = new Map();
  for (const skill of skills || []) {
    const name = String(skill && skill.name || '');
    if (/^[A-Za-z0-9_.-]{1,80}$/.test(name) && typeof skill.instructions === 'string') wanted.set(name, skill.instructions);
  }
  let existing = [];
  try { existing = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch {}
  for (const name of existing) {
    const dir = path.join(root, name);
    if (!wanted.has(name) && fs.existsSync(path.join(dir, MANAGED_SKILL_MARKER))) fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const [name, instructions] of wanted) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, MANAGED_SKILL_MARKER))) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANAGED_SKILL_MARKER), '');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), instructions.replace(/\r\n?/g, '\n'), 'utf8');
  }
}

class AgentdClient {
  constructor({ executable, dataDir, configDir, keys, extensionEnv, runtimeConfig }) {
    const env = { ...process.env, ...(extensionEnv || {}), ZAALIS_AGENTD_DATA_DIR: dataDir, ZAALIS_USER_CONFIG_DIR: configDir };
    if (runtimeConfig && runtimeConfig.ollamaUrl) env.ZAALIS_OLLAMA_URL = String(runtimeConfig.ollamaUrl);
    if (runtimeConfig && runtimeConfig.ggufUrl) env.ZAALIS_GGUF_URL = String(runtimeConfig.ggufUrl);
    if (runtimeConfig && runtimeConfig.computerEndpoint) env.ZAALIS_COMPUTER_ENDPOINT = String(runtimeConfig.computerEndpoint);
    if (runtimeConfig && runtimeConfig.computerToken) env.ZAALIS_COMPUTER_TOKEN = String(runtimeConfig.computerToken);
    // Integrated browser (desktop only): endpoint of the Rust `browser` tool.
    if (runtimeConfig && runtimeConfig.browserEndpoint) env.ZAALIS_BROWSER_ENDPOINT = String(runtimeConfig.browserEndpoint);
    if (runtimeConfig && runtimeConfig.browserToken) env.ZAALIS_BROWSER_TOOL_TOKEN = String(runtimeConfig.browserToken);
    if (runtimeConfig && runtimeConfig.workspaceEndpoint) env.ZAALIS_WORKSPACE_ENDPOINT = String(runtimeConfig.workspaceEndpoint);
    if (runtimeConfig && runtimeConfig.workspaceToken) env.ZAALIS_WORKSPACE_TOKEN = String(runtimeConfig.workspaceToken);
    const names = {
      openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY',
      grok: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY', moonshot: 'MOONSHOT_API_KEY'
    };
    for (const [name, variable] of Object.entries(names)) {
      if (keys && keys[name]) env[variable] = String(keys[name]);
    }
    // OpenAI-compatible endpoints configured in zaalis: the list names each
    // key's variable, the keys themselves travel one per variable.
    const compat = [];
    for (const [index, endpoint] of ((runtimeConfig && runtimeConfig.compatEndpoints) || []).entries()) {
      if (!endpoint || !endpoint.id || !endpoint.base_url) continue;
      const entry = { id: String(endpoint.id), base_url: String(endpoint.base_url) };
      if (endpoint.key) {
        entry.key_env = `ZAALIS_COMPAT_KEY_${index}`;
        env[entry.key_env] = String(endpoint.key);
      }
      compat.push(entry);
    }
    if (compat.length) env.ZAALIS_COMPAT_ENDPOINTS = JSON.stringify(compat);
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
      } else if (message.method === SESSION_EVENT && message.params && message.params.session_id) {
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
    const skills = [];
    for (const [index, source] of (mcpServers || []).filter((server) => server && server.enabled !== false).slice(0, 32).entries()) {
      const id = String(source.id || '').trim();
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) continue;
      const entry = runtimeMcpEntry(source, index, extensionEnv);
      if (!entry) continue;
      if (source.skill) skills.push(source.skill);
      servers[id] = entry;
    }
    const target = path.join(configDir, 'mcp.json');
    fs.writeFileSync(target, JSON.stringify({ servers }, null, 2), { encoding: 'utf8', mode: 0o600 });
    syncManagedSkills(configDir, skills);
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
    else create.model = { provider: options.model, model: options.submodel || undefined,
      reasoning: options.reasoningLevel || 0, ...(options.modelCapabilities ? { capabilities: options.modelCapabilities } : {}) };
    let made;
    if (options.sessionId) {
      try {
        // No historical events need to be replayed into the new HTTP response:
        // the conversation already owns them. The daemon still restores its
        // durable agent tree and model history from the same session id.
        made = await client.request('session.resume', { session_id: String(options.sessionId), from_seq: Number.MAX_SAFE_INTEGER });
        // A moved project or a chat attached to a different folder must never
        // revive a daemon session with the old filesystem sandbox.
        const canonical = value => {
          let resolved;
          try { resolved = fs.realpathSync(value); } catch { resolved = path.resolve(value || ''); }
          return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        };
        if (!made.workspace || canonical(made.workspace) !== canonical(options.root)) made = null;
      } catch (error) {
        if (!/introuvable|not found|fermée|closed/i.test(String(error.message || ''))) throw error;
      }
    }
    if (!made) made = await client.request('session.create', create);
    const sessionId = made.session_id;
    onEvent({ type: 'run_started', runId: sessionId, sessionId, conversationId: options.conversationId || null, resumed: !!made.resumed });
    for (const agent of made.agents || []) {
      onEvent({ type: 'rust_event', event: { type: 'agent_spawned', agent } });
    }
    const lead = options.team
      ? made.agents.find((agent) => agent.role && agent.role.name === 'lead') || made.agents[made.agents.length - 1]
      : made.agents[0];
    if (!lead) throw new Error('Session restaurée sans agent principal.');
    if (made.resumed && !options.team) {
      const wanted = create.model;
      if (lead.model && (lead.model.provider !== wanted.provider || lead.model.model !== wanted.model ||
          lead.model.reasoning !== wanted.reasoning || JSON.stringify(lead.model.capabilities || null) !== JSON.stringify(wanted.capabilities || null))) {
        await client.request('agent.update', { session_id: sessionId, agent_id: lead.id, model: wanted });
      }
    }
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
      if (frame.type === EVENTS.TEXT_DELTA) text.set(agent, (text.get(agent) || '') + String(frame.text || ''));
      if (frame.type === EVENTS.REASONING_DELTA) reasoning.set(agent, (reasoning.get(agent) || '') + String(frame.text || ''));
      if (frame.type === EVENTS.TOOL_STARTED) {
        startedTools.set(String(frame.call_id), { tool: frame.tool, input: frame.input || {} });
        onEvent({ type: 'tool_started', id: frame.call_id, tool: frame.tool, input: frame.input || {}, summary: frame.title });
      }
      if (frame.type === EVENTS.TOOL_COMPLETED) {
        const original = startedTools.get(String(frame.call_id)) || {};
        const outcome = frame.outcome || {};
        const result = { tool: original.tool || 'outil', input: original.input || {}, summary: outcome.summary || outcome.status || 'termine', text: outcome.result ? JSON.stringify(outcome.result) : (outcome.message || ''), error: outcome.status === 'error', blocked: outcome.status === 'denied' };
        toolResults.push(result);
        onEvent({ type: 'tool_done', id: frame.call_id, ...result });
      }
      if (frame.type === EVENTS.PERMISSION_REQUESTED) onEvent({ type: 'permission_required', sessionId, requestId: frame.request_id, summary: frame.summary, target: frame.target, risks: frame.risks || [] });
      if (frame.type === EVENTS.PLAN_READY) onEvent({ type: 'plan_required', sessionId, requestId: frame.request_id, content: frame.content });
      if (frame.type === EVENTS.BUDGET_EXHAUSTED) onEvent({ type: 'budget_required', sessionId, requestId: frame.request_id, limit: frame.limit, usage: frame.usage });
      if (frame.type === EVENTS.AGENT_STATE_CHANGED) onEvent({ type: 'agent_state', agentId: frame.agent_id, state: frame.state });
      if (frame.type === EVENTS.PROVIDER_ERROR || frame.type === EVENTS.AGENT_FAILED) failure = frame.message || frame.error || 'Erreur agent.';
      if (frame.type === EVENTS.TURN_COMPLETED) { usage = frame.usage || usage; finish(); }
      onEvent({ type: 'rust_event', event: frame });
    });
    let abortHandler = null;
    if (options.signal) {
      abortHandler = () => { client.request(METHODS.SESSION_CANCEL, { session_id: sessionId }).catch(() => {}); };
      if (options.signal.aborted) abortHandler(); else options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    try {
      await client.request(METHODS.SESSION_PROMPT, { session_id: sessionId, text: options.message, images: options.images || [] });
      await completed;
      const leadId = String(lead.id);
      return {
        response: text.get(leadId) || '',
        thinking: reasoning.get(leadId) || '',
        usage: usage ? {
          input: usage.input_tokens,
          output: usage.output_tokens,
          toolCalls: usage.tool_calls || 0,
          rounds: usage.rounds || 0,
          webQueries: usage.web_queries || 0,
          webResults: usage.web_results || 0,
          webPagesRead: usage.web_pages_read || 0,
          contextCompactions: usage.context_compactions || 0,
        } : null,
        toolResults,
        sessionId,
        ...(failure && !text.get(leadId) ? { error: failure } : {})
      };
    } finally {
      if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
      off();
      this.sessions.delete(sessionId);
    }
  }

  async decide(userId, body) {
    const session = this.sessions.get(String(body.sessionId || ''));
    if (!session || session.userId !== userId) throw Object.assign(new Error('Session interactive introuvable.'), { status: 404 });
    const base = { session_id: body.sessionId, request_id: body.requestId };
    if (body.kind === 'permission') return session.client.request(METHODS.PERMISSION_DECIDE, { ...base, answer: body.allow ? { allow: { scope: body.scope || 'once' } } : 'deny' });
    if (body.kind === 'plan') return session.client.request(body.allow ? METHODS.PLAN_APPROVE : METHODS.PLAN_REJECT, { ...base, feedback: body.feedback || undefined });
    if (body.kind === 'budget') return session.client.request(METHODS.BUDGET_EXTEND, { ...base, additional_tokens: body.additionalTokens, stop: !!body.stop });
    throw Object.assign(new Error('Decision interactive invalide.'), { status: 400 });
  }

  async cancel(userId, sessionId, agentId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session || session.userId !== userId) throw Object.assign(new Error('Tache introuvable.'), { status: 404 });
    await session.client.request('session.cancel', { session_id: String(sessionId),
      ...(agentId ? { agent_id: String(agentId) } : {}) });
    return { cancelled: true };
  }

  async close() {
    const stops = [...this.clients.values()].map((entry) => entry.client.stop());
    this.clients.clear();
    await Promise.allSettled(stops);
  }
}

module.exports = { AgentdClient, RustAgentBridge, findAgentd, syncManagedSkills, runtimeMcpEntry };
