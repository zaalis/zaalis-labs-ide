'use strict';

// Account login is kept on the desktop server. OAuth credentials never reach
// the interface or the Rust daemon; the latter calls a per-user loopback proxy.
const crypto = require('crypto');
const { createSseReader, toResponsesRequest, createChunkTranslator } = require('./chatgpt-subscription');

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const MINIMAX_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113';
const XAI_AUTH = 'https://auth.x.ai';
const XAI_API = 'https://api.x.ai/v1';
const MINIMAX_AUTH = 'https://api.minimax.io';
const MINIMAX_API = 'https://api.minimax.io/anthropic/v1';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const MINIMAX_SCOPE = 'group_id profile model.completion';
const MINIMAX_GRANT = 'urn:ietf:params:oauth:grant-type:user_code';

function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
function form(data) { return new URLSearchParams(data).toString(); }
function expiresAt(value, fallbackSeconds = 3600) {
  const number = Number(value);
  if (number > Date.now() / 2) return number; // MiniMax returns Unix milliseconds.
  return Date.now() + Math.max(1, number || fallbackSeconds) * 1000;
}
async function jsonResponse(response, name) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== 'object') {
    const detail = data && (data.error_description || data.error || data.base_resp?.status_msg);
    throw fail(response.status || 502, `${name} : ${typeof detail === 'string' ? detail : `HTTP ${response.status}`}`);
  }
  return data;
}
async function xaiTokenEndpoint(fetchImpl = fetch) {
  const answer = await fetchImpl(`${XAI_AUTH}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
  const data = await jsonResponse(answer, 'xAI OAuth');
  const token = new URL(String(data.token_endpoint || ''));
  if (token.protocol !== 'https:' || token.hostname !== 'auth.x.ai') throw fail(502, 'Endpoint OAuth xAI invalide.');
  return token.toString();
}
async function start(provider, { fetchImpl = fetch } = {}) {
  if (provider === 'xai') {
    const tokenEndpoint = await xaiTokenEndpoint(fetchImpl);
    const response = await fetchImpl(`${XAI_AUTH}/oauth2/device/code`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }), signal: AbortSignal.timeout(20000),
    });
    const data = await jsonResponse(response, 'xAI OAuth');
    if (!data.device_code || !data.user_code || !data.verification_uri) throw fail(502, 'Réponse de connexion xAI incomplète.');
    return {
      provider, deviceCode: String(data.device_code), tokenEndpoint,
      userCode: String(data.user_code), verificationUrl: String(data.verification_uri_complete || data.verification_uri),
      interval: Math.max(2, Number(data.interval) || 5), expiresAt: expiresAt(data.expires_in, 600),
    };
  }
  if (provider === 'minimax') {
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const response = await fetchImpl(`${MINIMAX_AUTH}/oauth/code`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'x-request-id': crypto.randomUUID() },
      body: form({ response_type: 'code', client_id: MINIMAX_CLIENT_ID, scope: MINIMAX_SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256', state }), signal: AbortSignal.timeout(20000),
    });
    const data = await jsonResponse(response, 'MiniMax OAuth');
    if (!data.user_code || !data.verification_uri || data.state !== state) throw fail(502, 'Réponse de connexion MiniMax invalide.');
    return {
      provider, verifier, userCode: String(data.user_code), verificationUrl: String(data.verification_uri),
      interval: Math.max(2, (Number(data.interval_ms) || 2000) / 1000), expiresAt: expiresAt(data.expired_in, 600),
    };
  }
  throw fail(404, 'Abonnement inconnu.');
}
async function poll(flow, { fetchImpl = fetch } = {}) {
  let endpoint, body;
  if (flow.provider === 'xai') {
    endpoint = flow.tokenEndpoint;
    body = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: XAI_CLIENT_ID, device_code: flow.deviceCode };
  } else if (flow.provider === 'minimax') {
    endpoint = `${MINIMAX_AUTH}/oauth/token`;
    body = { grant_type: MINIMAX_GRANT, client_id: MINIMAX_CLIENT_ID, user_code: flow.userCode, code_verifier: flow.verifier };
  } else throw fail(404, 'Abonnement inconnu.');
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form(body), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => null);
  if (flow.provider === 'xai' && data?.error === 'authorization_pending') return null;
  if (flow.provider === 'xai' && data?.error === 'slow_down') { flow.interval += 5; return null; }
  if (flow.provider === 'minimax' && response.ok && data?.status === 'pending') return null;
  if (!response.ok || !data || data.error || data.status === 'error') {
    if (flow.provider === 'xai' && response.status === 402) {
      throw fail(402, 'xAI refuse cette connexion pour le compte utilisé (HTTP 402). Vérifiez que votre abonnement SuperGrok ou X Premium+ donne accès à Grok dans les applications tierces. Le détail du forfait requis dépend de xAI.');
    }
    throw fail(response.status || 502, `${flow.provider === 'xai' ? 'xAI' : 'MiniMax'} : ${data?.error_description || data?.error || data?.base_resp?.status_msg || `HTTP ${response.status}`}`);
  }
  if (!data.access_token || !data.refresh_token || (flow.provider === 'minimax' && data.status !== 'success')) {
    throw fail(502, 'Jetons OAuth incomplets.');
  }
  return {
    provider: flow.provider, accessToken: String(data.access_token), refreshToken: String(data.refresh_token),
    expiresAt: expiresAt(flow.provider === 'minimax' ? data.expired_in : data.expires_in),
    tokenEndpoint: flow.provider === 'xai' ? flow.tokenEndpoint : `${MINIMAX_AUTH}/oauth/token`,
    connectedAt: new Date().toISOString(),
  };
}
function needsRefresh(session) { return !session.expiresAt || session.expiresAt - Date.now() < 60_000; }
async function refresh(session, { fetchImpl = fetch } = {}) {
  if (!session.refreshToken) throw fail(401, 'Session expirée : reconnectez le compte.', { relogin: true });
  const xai = session.provider === 'xai';
  const endpoint = xai ? await xaiTokenEndpoint(fetchImpl) : `${MINIMAX_AUTH}/oauth/token`;
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form({ grant_type: 'refresh_token', client_id: xai ? XAI_CLIENT_ID : MINIMAX_CLIENT_ID,
      refresh_token: session.refreshToken }), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.access_token || (!xai && data.status !== 'success')) {
    throw fail(response.status || 502, `${xai ? 'xAI' : 'MiniMax'} : session à renouveler.`,
      { relogin: [400, 401].includes(response.status) });
  }
  return { ...session, accessToken: String(data.access_token), refreshToken: String(data.refresh_token || session.refreshToken),
    expiresAt: expiresAt(xai ? data.expires_in : data.expired_in), tokenEndpoint: endpoint };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text || '').join('') : '';
}
function miniMaxRequest(chat) {
  const system = [];
  const messages = [];
  const append = (role, content) => {
    const previous = messages[messages.length - 1];
    if (previous?.role === role) {
      previous.content = [...(Array.isArray(previous.content) ? previous.content : [{ type: 'text', text: previous.content }]),
        ...(Array.isArray(content) ? content : [{ type: 'text', text: content }])];
    } else messages.push({ role, content });
  };
  for (const message of Array.isArray(chat.messages) ? chat.messages : []) {
    if (message.role === 'system' || message.role === 'developer') { system.push(textOf(message.content)); continue; }
    if (message.role === 'tool') {
      append('user', [{ type: 'tool_result', tool_use_id: String(message.tool_call_id), content: textOf(message.content) }]);
      continue;
    }
    if (message.role === 'assistant') {
      const content = [];
      const text = textOf(message.content);
      if (text) content.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: String(call.id), name: String(call.function?.name || ''), input });
      }
      if (content.length) append('assistant', content);
      continue;
    }
    if (message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : (message.content || []).map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text || '' };
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url || '');
        return match ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } } : null;
      }).filter(Boolean);
      append('user', content);
    }
  }
  const tools = (chat.tools || []).map(t => ({ name: t.function?.name, description: t.function?.description || '',
    input_schema: t.function?.parameters || { type: 'object', properties: {} } })).filter(t => t.name);
  const request = { model: String(chat.model || ''), messages, max_tokens: Math.max(1024, Number(chat.max_tokens) || 8192), stream: true };
  if (system.length) request.system = system.join('\n\n');
  if (tools.length) { request.tools = tools; request.tool_choice = { type: 'auto' }; }
  if (typeof chat.temperature === 'number') request.temperature = chat.temperature;
  return request;
}
function miniMaxTranslator(model) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let callIndex = 0, stop = 'stop', complete = false, usage = null;
  const blocks = new Map();
  // Anthropic-style counts: message_start opens them, message_delta carries
  // the cumulative final values. Cache reads are part of the prompt.
  const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const measure = (reported = {}) => {
    const next = usage ? { ...usage } : { input: 0, cached: 0, output: 0 };
    if (reported.input_tokens !== undefined) {
      next.input = count(reported.input_tokens) + count(reported.cache_read_input_tokens) + count(reported.cache_creation_input_tokens);
      next.cached = count(reported.cache_read_input_tokens);
    }
    if (reported.output_tokens !== undefined) next.output = count(reported.output_tokens);
    usage = next;
  };
  const chunk = (delta, finish = null, usage) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  return {
    push(event) {
      if (event.type === 'error') { complete = true; return [{ error: { message: event.error?.message || 'MiniMax a interrompu la réponse.' } }]; }
      if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        if (block.type === 'tool_use') {
          const index = callIndex++;
          blocks.set(event.index, { type: 'tool', index });
          return [chunk({ tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name,
            arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '' } }] })];
        }
        blocks.set(event.index, { type: block.type });
        return [];
      }
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (block?.type === 'tool' && event.delta?.type === 'input_json_delta')
          return [chunk({ tool_calls: [{ index: block.index, function: { arguments: event.delta.partial_json || '' } }] })];
        if (event.delta?.type === 'text_delta') return [chunk({ content: event.delta.text || '' })];
        return [];
      }
      if (event.type === 'message_start') { if (event.message?.usage) measure(event.message.usage); return []; }
      if (event.type === 'message_delta') { stop = event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'; if (event.usage) measure(event.usage); return []; }
      if (event.type === 'message_stop') {
        complete = true;
        return [chunk({}, stop, usage && (usage.input || usage.output) ? { prompt_tokens: usage.input, completion_tokens: usage.output,
          prompt_tokens_details: { cached_tokens: usage.cached } } : undefined)];
      }
      return [];
    },
    finish() { return complete ? [] : [{ error: { message: 'Flux MiniMax interrompu.' } }]; },
  };
}
async function openStream(provider, accessToken, body, { fetchImpl = fetch, signal } = {}) {
  const minimax = provider === 'minimax';
  const endpoint = minimax ? `${MINIMAX_API}/messages` : `${XAI_API}/responses`;
  const request = minimax ? miniMaxRequest(body) : toResponsesRequest(body);
  const response = await fetchImpl(endpoint, {
    method: 'POST', signal, headers: minimax
      ? { Authorization: `Bearer ${accessToken}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', Accept: 'text/event-stream' }
      : { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let detail = '';
    try { const json = JSON.parse(raw); detail = json.error?.message || json.message || ''; } catch {}
    if (response.status === 403 && !minimax) detail = 'Ce compte xAI n’a pas accès à l’inférence OAuth pour son forfait (HTTP 403).';
    throw fail(response.status, detail || `${minimax ? 'MiniMax' : 'xAI'} : HTTP ${response.status}`,
      { relogin: response.status === 401 });
  }
  return response;
}

module.exports = { start, poll, needsRefresh, refresh, miniMaxRequest, miniMaxTranslator, openStream,
  createSseReader, createChunkTranslator, XAI_API, MINIMAX_API };
