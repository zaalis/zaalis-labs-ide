'use strict';
const { crypto, fail, text, publicData } = require('./common');
const SERVICES = Object.freeze({
  ...Object.fromEntries(require("../interface/script/integration-catalog").filter(c=>c.adapter!=="native").map(c=>[c.id,{title:c.title,baseUrl:c.baseUrl,auth:c.auth}])),
  discord: { title: 'Discord', baseUrl: 'https://discord.com/api/v10', auth: 'bot-token' },
  spotify: { title: 'Spotify', baseUrl: 'https://api.spotify.com/v1', auth: 'oauth', authorizeUrl: 'https://accounts.spotify.com/authorize', tokenUrl: 'https://accounts.spotify.com/api/token', scopes: 'user-read-playback-state user-modify-playback-state user-read-recently-played user-read-playback-position user-read-private user-library-read user-library-modify playlist-read-private playlist-modify-private playlist-modify-public' },
  feishu: { title: 'Feishu / Lark', baseUrl: 'https://open.feishu.cn/open-apis', auth: 'tenant-token' },
  homeassistant: { title: 'Home Assistant', auth: 'bearer-token' },
  yuanbao: { title: 'Yuanbao', auth: 'mcp' },
  a2a: { title: 'A2A agents', auth: 'endpoint' },
  media: { title: 'Image, video and speech providers', auth: 'api-key' },
  cdp: { title: 'CDP browser', auth: 'loopback-endpoint' },
  execution: { title: 'Execution backends', auth: 'owner-configured' },
});
class Connections {
  constructor(store, options) { this.store = store; this.encrypt = options.encrypt; this.decrypt = options.decrypt; this.mcp = options.mcp; this.oauth = new Map(); this.fetch = options.fetch || fetch; }
  settings(userId) { return this.store.read(userId, 'connections', {}); }
  get(userId, service) {
    const row = this.settings(userId)[service];
    if (!row || row.enabled === false) throw fail(`${service} needs a connection configured by the user.`, 'connection_required', 409);
    const secrets=row.encrypted?JSON.parse(this.decrypt(row.encrypted)):{};
    const register=value=>{if(typeof value==='string')require('../src/agent/secrets-mask').registerSecret('assistant connection credential',value);else if(value&&typeof value==='object')for(const v of Object.values(value))register(v);};register(secrets);
    return { ...row, ...secrets };
  }
  list(userId) {
    const settings = this.settings(userId);
    return Object.entries(SERVICES).map(([id, service]) => {
      const row = settings[id], configured = !!row && row.enabled !== false;
      return { id, title: service.title, auth: service.auth, mcpServer:row?.mcpServer, options:publicData(row?.options||{}), status: configured ? 'configured' : row?.enabled === false ? 'disabled' : 'connection_required', baseUrl: row?.baseUrl || service.baseUrl, detail: row?.lastError || '', hasCredential: !!row?.encrypted, lastVerifiedAt: row?.lastVerifiedAt || null };
    });
  }
  configure(userId, input) {
    const id = text(input.id || input.service, 'connection id', 80);
    if (!SERVICES[id]) throw fail('Unknown connection.');
    const settings = this.settings(userId), previous = settings[id] || {};
    const row = { ...previous, enabled: input.enabled !== false, baseUrl: input.baseUrl || previous.baseUrl || SERVICES[id].baseUrl, mcpServer: input.mcpServer || previous.mcpServer, options: input.options || previous.options || {} };
    const rejectSecrets=value=>{for(const[k,v]of Object.entries(value||{})){if(/^(token|tokens|apiKey|password|secret|clientSecret|authorization)$/i.test(k))throw fail('Store credentials in the encrypted credentials field, not options.');if(v&&typeof v==='object')rejectSecrets(v);}};rejectSecrets(row.options);
    if(JSON.stringify(row.options).length>64000)throw fail('Connection options too large.');
    if (row.baseUrl) validateBase(row.baseUrl);
    if (input.credentials) { if(typeof input.credentials!=='object'||Array.isArray(input.credentials)||JSON.stringify(input.credentials).length>128000)throw fail('Credentials must be an object up to 128000 characters.');row.encrypted = this.encrypt(JSON.stringify({...((previous.encrypted && JSON.parse(this.decrypt(previous.encrypted)))||{}),...input.credentials})); }
    if (input.clearCredentials) delete row.encrypted;
    delete row.lastVerifiedAt;delete row.lastError;
    settings[id] = row; this.store.write(userId, 'connections', settings); return this.list(userId).find(row => row.id === id);
  }
  async run(input, ctx) {
    const action = input.action || 'list';
    if (['list', 'catalog', 'status'].includes(action)) return { connections: this.list(ctx.userId), mcp: await this.mcp(ctx, 'list', {}) };
    const id = text(input.id || input.service, 'id', 80);
    if(input.mcp&&['install','connect','reconnect'].includes(action)){
      const answer=await ctx.ask({question:`Configure the HTTP MCP connection ${id}`,fields:[{name:'endpoint',label:'MCP endpoint (HTTPS or loopback HTTP)',type:'text'},{name:'token',label:'Bearer token (leave blank if not required)',type:'password',required:false}],secret:true});
      return this.mcp(ctx,'install',{id,endpoint:answer.endpoint,token:answer.token});
    }
    if (!SERVICES[id]) throw fail('Unknown connection.');
    if(['connect','reconnect','install'].includes(action)){
      try{if(action==='reconnect'&&!input.force)return await this.run({action:'test',id},ctx);}catch{}
      const current=this.settings(ctx.userId)[id];
      const answer=await ctx.ask({question:`Configure ${SERVICES[id].title}. Credentials are encrypted and are not given to the model.`,fields:[{name:'baseUrl',label:'Service URL',type:'text',required:false},{name:'token',label:'Token (optional)',type:'password',required:false}],secret:true});
      this.configure(ctx.userId,{id,baseUrl:answer.baseUrl||current?.baseUrl||SERVICES[id].baseUrl,...(answer.token?{credentials:{token:answer.token}}:{})});return {connection:this.list(ctx.userId).find(c=>c.id===id)};
    }
    if (action === 'authorize') return this.authorize(id, ctx);
    if (action === 'disable' || action === 'enable') { const rows = this.settings(ctx.userId); if (!rows[id]) throw fail('Configure this connection first.', 'connection_required', 409); rows[id].enabled = action === 'enable'; this.store.write(ctx.userId, 'connections', rows); return this.list(ctx.userId).find(row => row.id === id); }
    if (action === 'disconnect') { const rows = this.settings(ctx.userId); delete rows[id]; this.store.write(ctx.userId, 'connections', rows); return { disconnected: id }; }
    if (action === 'test') {
      const info=require('../interface/script/integration-catalog').find(c=>c.id===id);
      if(info && !['existing','native'].includes(info.adapter)){
        const row=this.get(ctx.userId,id);const response=info.adapter==='mcp'&&!row.options?.tools?.test?await this.mcp(ctx,'describe',{server:row.mcpServer}):await require('./connectors/messaging').run(this,'messaging_read',{service:id,action:'test'},ctx);
        if(response?.ok===false)throw fail('Service rejected verification.','authorization_required',401);
        const rows=this.settings(ctx.userId);rows[id].lastVerifiedAt=new Date().toISOString();this.store.write(ctx.userId,'connections',rows);return {verified:id,response};
      }
      const row = this.get(ctx.userId, id), target = { discord: '/users/@me', spotify: '/me', homeassistant: '/api/', feishu: '/drive/v1/files' }[id];
      if (!target) { if (row.mcpServer) return this.mcp(ctx, 'describe', { server: row.mcpServer }); throw fail('Use the matching tool to verify this adapter.', 'verification_required', 409); }
      const response = await this.request(ctx.userId, id, target, { signal: ctx.signal });
      const rows = this.settings(ctx.userId); rows[id].lastVerifiedAt = new Date().toISOString(); delete rows[id].lastError; this.store.write(ctx.userId, 'connections', rows);
      return { verified: id, response };
    }
    throw fail('Connection settings and credentials are managed by the user in the tools panel or CLI.');
  }
  authorize(id, ctx) {
    const info = SERVICES[id], row = this.get(ctx.userId, id);
    if (!info.authorizeUrl || !row.options.clientId) throw fail('OAuth application clientId is required in the connection settings.', 'connection_required', 409);
    const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url');
    const redirectUri = `${ctx.localBase}/api/assistant/oauth/callback`;
    this.oauth.set(state, { userId: ctx.userId, id, verifier, redirectUri, deadline: Date.now() + 900000 });
    const url = new URL(info.authorizeUrl); for (const [key, value] of Object.entries({ client_id: row.options.clientId, response_type: 'code', redirect_uri: redirectUri, scope: info.scopes, state, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') })) url.searchParams.set(key, value);
    return { status: 'authorization_required', authorizeUrl: url.href };
  }
  async callback(userId, state, code) {
    const item = this.oauth.get(state); this.oauth.delete(state);
    if (!item || item.userId !== userId || item.deadline < Date.now()) throw fail('Expired OAuth state.', 'authorization_failed', 403);
    const row = this.get(userId, item.id), response = await this.fetch(SERVICES[item.id].tokenUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: row.options.clientId, grant_type: 'authorization_code', code: text(code, 'code', 8000), redirect_uri: item.redirectUri, code_verifier: item.verifier }), signal: AbortSignal.timeout(30000) });
    const tokens = await boundedJson(response); if (!response.ok || !tokens.access_token) throw fail('OAuth token exchange failed.', 'authorization_failed', 401);
    return this.configure(userId, { id: item.id, credentials: { token: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 } });
  }
  async request(userId, service, route, { method = 'GET', body, query, signal, headers = {} } = {}) {
    const row = this.get(userId, service); if (!row.baseUrl) throw fail('Connection endpoint is missing.', 'connection_required', 409);
    if (service === 'spotify' && row.expiresAt && row.expiresAt < Date.now() + 30000) {
      if (!row.refreshToken || !row.options.clientId) throw fail('Spotify authorization expired.', 'authorization_required', 401);
      const response = await this.fetch(SERVICES.spotify.tokenUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refreshToken, client_id: row.options.clientId }), signal: AbortSignal.timeout(30000) });
      const tokens = await boundedJson(response); if (!response.ok || !tokens.access_token) throw fail('Spotify refresh failed.', 'authorization_required', 401);
      this.configure(userId, { id: service, credentials: { token: tokens.access_token, refreshToken: tokens.refresh_token || row.refreshToken, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 } }); row.token = tokens.access_token;
    }
    const base = new URL(row.baseUrl.replace(/\/$/, '') + '/'), url = new URL(route.replace(/^\//, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw fail('Connector request outside the configured API.', 'endpoint_denied', 403);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const token = row.token || row.apiKey;
    const response = await this.fetch(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), headers: { ...(token ? { Authorization: (service === 'discord' ? 'Bot ' : 'Bearer ') + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = response.status === 204 ? { success: true } : await boundedJson(response,2*1024*1024,service==='ntfy');
    if (!response.ok) throw fail(`${service} HTTP ${response.status}: ${String(data.message || data.error?.message || data.error || 'request failed').slice(0, 500)}`, response.status === 401 ? 'authorization_required' : 'provider_error', response.status);
    return publicData(data);
  }
}
function validateBase(raw) { const url = new URL(raw); if (url.username || url.password || url.hash || url.search || !['https:', 'http:', 'ws:', 'wss:'].includes(url.protocol)) throw fail('Invalid connection endpoint.'); if (['http:', 'ws:'].includes(url.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) throw fail('Remote endpoints require HTTPS.'); return url; }
async function boundedJson(response, limit = 2 * 1024 * 1024, ndjson = false) { let size = 0, chunks = []; for await (const chunk of response.body || []) { size += chunk.length; if (size > limit) throw fail('Connector response too large.', 'response_limit', 502); chunks.push(chunk); } const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {}; try { return ndjson ? {messages:raw.trim().split(/\r?\n/).map(line=>JSON.parse(line))} : JSON.parse(raw); } catch { throw fail('Provider returned non-JSON data.', 'provider_error', 502); } }
module.exports = { Connections, SERVICES, validateBase, boundedJson };
