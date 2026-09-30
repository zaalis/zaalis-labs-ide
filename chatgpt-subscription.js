'use strict';

// ---------------------------------------------------------------------------
// CHATGPT SUBSCRIPTION — sign in with a ChatGPT Plus / Pro / Team account.
// ---------------------------------------------------------------------------
// Same flow as the OpenAI Codex CLI: the user types a short code on
// auth.openai.com, zaalis receives OAuth tokens, and model calls go to the
// ChatGPT Codex backend on the subscription's quota instead of a metered API
// key. zaalis never sees the account password.
//
// The Rust core only speaks chat-completions, and the Codex backend only
// speaks the Responses API. This module holds both halves of the translation,
// so server.js can expose the subscription as one more OpenAI-compatible
// endpoint on the loopback interface (see /api/internal/chatgpt).

const crypto = require('crypto');

// Public client id registered by OpenAI for Codex-style device sign-in.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_ISSUER = 'https://auth.openai.com';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1000;
// Refresh a little before expiry so a long agent turn never starts on a token
// that dies halfway through.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_CALL_ID_LENGTH = 64;

// Starter list shown before the account's live catalogue answers.
const DEFAULT_MODELS = Object.freeze([
  'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
]);

// Tests point both hosts at a fake server. Only a loopback http URL is ever
// honoured, so an environment variable cannot send tokens to another machine.
function loopbackOverride(name, fallback) {
  const raw = String(process.env[name] || '').trim().replace(/\/+$/, '');
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return raw;
  } catch {}
  return fallback;
}
const issuer = () => loopbackOverride('ZAALIS_CHATGPT_ISSUER', DEFAULT_ISSUER);
const baseUrl = () => loopbackOverride('ZAALIS_CHATGPT_BASE_URL', DEFAULT_BASE_URL);

function fail(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

let userAgent = 'zaalis-ide';
function setVersion(version) {
  userAgent = `zaalis-ide/${String(version || '0.0.0').replace(/[^\w.+-]/g, '')}`;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function jwtClaims(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return {};
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : {};
  } catch { return {}; }
}

function authClaims(token) {
  const auth = jwtClaims(token)['https://api.openai.com/auth'];
  return auth && typeof auth === 'object' ? auth : {};
}

// What zaalis stores (encrypted) for one account. The id token is only read
// for the e-mail and plan shown in Settings and is not kept.
function sessionFromTokens(tokens, previous) {
  const accessToken = String(tokens.access_token || '').trim();
  if (!accessToken) throw fail(502, 'OpenAI n’a pas renvoyé de jeton d’accès.');
  const access = jwtClaims(accessToken);
  const id = jwtClaims(tokens.id_token);
  const profile = access['https://api.openai.com/profile'] || {};
  const plan = authClaims(tokens.id_token).chatgpt_plan_type || authClaims(accessToken).chatgpt_plan_type;
  return {
    accessToken,
    refreshToken: String(tokens.refresh_token || (previous && previous.refreshToken) || '').trim(),
    expiresAt: Number(access.exp) > 0 ? Number(access.exp) * 1000 : 0,
    email: String(id.email || profile.email || (previous && previous.email) || ''),
    plan: String(plan || (previous && previous.plan) || ''),
    connectedAt: (previous && previous.connectedAt) || new Date().toISOString(),
  };
}

function needsRefresh(session, now = Date.now()) {
  return !!session && !!session.expiresAt && session.expiresAt - now < REFRESH_SKEW_MS;
}

// The Codex backend scopes every request to a workspace read from the token.
function accountHeaders(accessToken) {
  const auth = authClaims(accessToken);
  const headers = {};
  if (typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) {
    headers['ChatGPT-Account-ID'] = auth.chatgpt_account_id;
  }
  const residency = auth.chatgpt_data_residency || auth.chatgpt_compute_residency;
  if (typeof residency === 'string' && residency.trim()) headers['x-openai-internal-codex-residency'] = residency.trim();
  return headers;
}

function backendHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent,
    originator: 'zaalis-ide',
    ...accountHeaders(accessToken),
  };
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Device-code sign-in
// ---------------------------------------------------------------------------

async function requestDeviceCode({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${issuer()}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 429) throw fail(429, 'OpenAI limite temporairement les demandes de connexion. Réessayez dans une minute.');
  if (!response.ok) throw fail(502, `OpenAI a refusé la demande de code (HTTP ${response.status}).`);
  const data = (await readJson(response)) || {};
  const userCode = String(data.user_code || data.usercode || '');
  const deviceAuthId = String(data.device_auth_id || '');
  if (!userCode || !deviceAuthId) throw fail(502, 'Réponse de connexion OpenAI incomplète.');
  return {
    userCode,
    deviceAuthId,
    interval: Math.max(3, Math.min(30, Number(data.interval) || 5)),
    expiresAt: Date.now() + DEVICE_CODE_LIFETIME_MS,
    verificationUrl: `${issuer()}/codex/device`,
  };
}

// One poll. Returns null while the user has not confirmed the code yet, and
// the stored session once they have.
async function pollDeviceCode({ deviceAuthId, userCode }, { fetchImpl = fetch } = {}) {
  const poll = await fetchImpl(`${issuer()}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(15000),
  });
  if (poll.status === 403 || poll.status === 404) return null;
  if (poll.status === 429) throw fail(429, 'OpenAI limite temporairement les demandes de connexion. Réessayez dans une minute.');
  if (!poll.ok) throw fail(502, `La vérification du code a échoué (HTTP ${poll.status}).`);
  const code = (await readJson(poll)) || {};
  if (!code.authorization_code || !code.code_verifier) throw fail(502, 'Réponse de connexion OpenAI incomplète.');
  const exchange = await fetchImpl(`${issuer()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': userAgent },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code.authorization_code),
      redirect_uri: `${issuer()}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: String(code.code_verifier),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!exchange.ok) throw fail(502, `L’échange du code a échoué (HTTP ${exchange.status}).`);
  const session = sessionFromTokens((await readJson(exchange)) || {});
  if (!session.refreshToken) throw fail(502, 'OpenAI n’a pas renvoyé de jeton de renouvellement.');
  return session;
}

// Refresh tokens are single-use: the caller must store the returned session
// before anything else uses the old one, and must not run two refreshes at once.
async function refreshSession(session, { fetchImpl = fetch } = {}) {
  if (!session || !session.refreshToken) throw fail(401, 'Session ChatGPT expirée. Reconnectez votre abonnement.', { relogin: true });
  const response = await fetchImpl(`${issuer()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': userAgent },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 429) throw fail(429, 'OpenAI limite temporairement le renouvellement de la session. Réessayez dans une minute.');
  if (!response.ok) {
    const body = (await readJson(response)) || {};
    const code = typeof body.error === 'string' ? body.error : String((body.error && (body.error.code || body.error.type)) || '');
    const relogin = [401, 403].includes(response.status)
      || ['invalid_grant', 'invalid_token', 'invalid_request', 'refresh_token_reused'].includes(code);
    throw fail(relogin ? 401 : 502,
      relogin ? 'Session ChatGPT expirée ou révoquée. Reconnectez votre abonnement dans Paramètres › Clés API.'
        : `Le renouvellement de la session ChatGPT a échoué (HTTP ${response.status}).`,
      { relogin });
  }
  return sessionFromTokens((await readJson(response)) || {}, session);
}

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

// The endpoint gates models on a Codex client version: ask as the newest
// client first, then as the ungated legacy sentinel.
async function listModels(accessToken, { fetchImpl = fetch } = {}) {
  for (const version of ['99.0.0', '0.0.0']) {
    const response = await fetchImpl(`${baseUrl()}/models?client_version=${version}`, {
      headers: { ...backendHeaders(accessToken), Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) throw fail(401, 'Session ChatGPT refusée.');
    if (!response.ok) continue;
    const data = (await readJson(response)) || {};
    const entries = Array.isArray(data.models) ? data.models : [];
    const ranked = entries
      .filter((item) => item && typeof item.slug === 'string' && item.slug.trim())
      .filter((item) => !['hide', 'hidden'].includes(String(item.visibility || '').trim().toLowerCase()))
      .map((item) => ({ rank: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 10000, slug: item.slug.trim() }))
      .sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug));
    if (ranked.length) return [...new Set(ranked.map((item) => item.slug))];
  }
  return [];
}

// ---------------------------------------------------------------------------
// chat-completions request -> Responses request
// ---------------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .filter((part) => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')
    .map((part) => part.text).join('');
}

// The backend rejects the literal control tokens of its own prompt format, so
// they are made inert (full-width bars) wherever user or tool text contains them.
function inert(text) {
  return String(text).replace(/<\|(start|end|channel|message|constrain|return|call)\|>/g, '<｜$1｜>');
}

function userParts(content) {
  if (!Array.isArray(content)) return [{ type: 'input_text', text: inert(textOf(content)) }];
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (['text', 'input_text'].includes(part.type) && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: inert(part.text) });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
      if (typeof url === 'string' && url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts.length ? parts : [{ type: 'input_text', text: '' }];
}

function clampCallId(id) {
  const value = String(id || '').trim() || 'call';
  if (value.length <= MAX_CALL_ID_LENGTH) return value;
  return `call_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function toResponsesRequest(chat, { cacheScope = '' } = {}) {
  const body = chat && typeof chat === 'object' ? chat : {};
  const model = String(body.model || '').trim();
  if (!model) throw fail(400, 'Modèle ChatGPT requis.');

  const instructions = [];
  const input = [];
  // A call id may recur in a long history (ids minted per turn by another
  // provider). The backend refuses duplicates, so later occurrences get a
  // suffix and each result is paired with the call it answers, in order.
  const seen = new Map();
  const waiting = new Map();
  const unanswered = new Map();
  let firstUserText = '';

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content).trim();
      if (text) instructions.push(text);
    } else if (message.role === 'user') {
      const content = userParts(message.content);
      if (!firstUserText) firstUserText = content.filter((part) => part.type === 'input_text').map((part) => part.text).join('');
      input.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text.trim()) input.push({ role: 'assistant', content: [{ type: 'output_text', text: inert(text) }] });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = (call && call.function) || {};
        const name = String(fn.name || '').trim();
        if (!name) continue;
        const base = clampCallId(call.id);
        const count = seen.get(base) || 0;
        seen.set(base, count + 1);
        const wire = count ? clampCallId(`${base}_dup${count}`) : base;
        waiting.set(base, [...(waiting.get(base) || []), wire]);
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
        const item = { type: 'function_call', call_id: wire, name, arguments: args.trim() || '{}' };
        input.push(item);
        unanswered.set(wire, item);
      }
    } else if (message.role === 'tool') {
      const queue = waiting.get(clampCallId(message.tool_call_id));
      // A result whose call was compacted away cannot be sent: the backend
      // refuses an output without its call.
      if (!queue || !queue.length) continue;
      const wire = queue.shift();
      unanswered.delete(wire);
      input.push({ type: 'function_call_output', call_id: wire, output: inert(textOf(message.content)) });
    }
  }
  // Symmetrically, a call left without a result (an interrupted tool) is
  // answered with a placeholder right after it.
  for (const [wire, item] of unanswered) {
    input.splice(input.indexOf(item) + 1, 0,
      { type: 'function_call_output', call_id: wire, output: '[résultat indisponible : outil interrompu]' });
  }

  const request = {
    model,
    instructions: instructions.join('\n\n') || 'Tu es un assistant de développement.',
    input,
    store: false,
    stream: true,
    include: [],
  };
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => (tool && tool.function) || {})
    .filter((fn) => typeof fn.name === 'string' && fn.name.trim())
    .map((fn) => ({
      type: 'function', name: fn.name, description: String(fn.description || ''), strict: false,
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    }));
  if (tools.length) {
    request.tools = tools;
    request.tool_choice = 'auto';
    request.parallel_tool_calls = true;
  }
  // `summary` is what makes the model's reasoning visible in the interface.
  const effort = String(body.reasoning_effort || '').trim().toLowerCase();
  request.reasoning = EFFORTS.has(effort) ? { effort, summary: 'auto' } : { summary: 'auto' };
  // Stable for a whole conversation (same system prompt, same first message):
  // this is what lets the backend reuse its prompt cache from turn to turn.
  request.prompt_cache_key = crypto.createHash('sha256')
    .update(`${cacheScope}\n${request.instructions}\n${firstUserText}`).digest('hex').slice(0, 32);
  return request;
}

// ---------------------------------------------------------------------------
// Responses stream -> chat-completions chunks
// ---------------------------------------------------------------------------

// Splits a byte stream into the JSON payloads of its `data:` lines.
function createSseReader() {
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = (flush) => {
    const events = [];
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? '' : blocks.pop() || '';
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
    return events;
  };
  return {
    push(chunk) { buffer += decoder.decode(chunk, { stream: true }); return drain(false); },
    finish() { buffer += decoder.decode(); return drain(true); },
  };
}

function errorText(event) {
  const source = (event.response && event.response.error) || event.error || event;
  const message = (source && (source.message || source.detail)) || event.message;
  return typeof message === 'string' && message.trim() ? message.trim() : 'Le modèle ChatGPT a interrompu la réponse.';
}

function createChunkTranslator(model) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const calls = new Map();       // Responses item id -> { index, streamed }
  const textItems = new Set();   // message items whose text already streamed
  let reasoningParts = 0;
  let finished = false;
  const chunk = (delta, finishReason = null) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const openCall = (item, key) => {
    const entry = { index: calls.size, streamed: false };
    calls.set(key, entry);
    return [entry, chunk({ tool_calls: [{
      index: entry.index, id: String(item.call_id || item.id || `call_${entry.index}`), type: 'function',
      function: { name: String(item.name || ''), arguments: '' },
    }] })];
  };
  const callFor = (itemId, outputIndex) => calls.get(itemId) || calls.get(`#${outputIndex}`);
  const callKey = (item, outputIndex) => item.id || `#${outputIndex}`;

  return {
    get finished() { return finished; },
    // One Responses event in, zero or more chat-completions payloads out.
    push(event) {
      if (!event || typeof event !== 'object' || finished) return [];
      const type = String(event.type || '');
      const item = event.item || {};
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        if (typeof event.delta !== 'string' || !event.delta) return [];
        if (event.item_id) textItems.add(event.item_id);
        return [chunk({ content: event.delta })];
      }
      if (type === 'response.reasoning_summary_part.added') {
        return reasoningParts++ ? [chunk({ reasoning_content: '\n\n' })] : [];
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        return typeof event.delta === 'string' && event.delta ? [chunk({ reasoning_content: event.delta })] : [];
      }
      if (type === 'response.output_item.added' && item.type === 'function_call') {
        return [openCall(item, callKey(item, event.output_index))[1]];
      }
      if (type === 'response.function_call_arguments.delta') {
        const entry = callFor(event.item_id, event.output_index);
        if (!entry || typeof event.delta !== 'string' || !event.delta) return [];
        entry.streamed = true;
        return [chunk({ tool_calls: [{ index: entry.index, function: { arguments: event.delta } }] })];
      }
      if (type === 'response.output_item.done' && item.type === 'function_call') {
        const out = [];
        let entry = callFor(item.id, event.output_index);
        if (!entry) { const opened = openCall(item, callKey(item, event.output_index)); entry = opened[0]; out.push(opened[1]); }
        // Arguments that never streamed arrive whole on the closing event.
        if (!entry.streamed && typeof item.arguments === 'string' && item.arguments) {
          entry.streamed = true;
          out.push(chunk({ tool_calls: [{ index: entry.index, function: { arguments: item.arguments } }] }));
        }
        return out;
      }
      if (type === 'response.output_item.done' && item.type === 'message' && !textItems.has(item.id)) {
        const text = textOf(item.content);
        return text ? [chunk({ content: text })] : [];
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        finished = true;
        const response = event.response || {};
        const usage = response.usage || {};
        const cut = response.incomplete_details && response.incomplete_details.reason === 'max_output_tokens';
        const final = chunk({}, calls.size ? 'tool_calls' : cut ? 'length' : 'stop');
        final.usage = {
          prompt_tokens: Number(usage.input_tokens) || 0,
          completion_tokens: Number(usage.output_tokens) || 0,
          prompt_tokens_details: { cached_tokens: Number(usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0 },
          completion_tokens_details: { reasoning_tokens: Number(usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens) || 0 },
        };
        return [final];
      }
      if (type === 'response.failed' || type === 'error') {
        finished = true;
        return [{ error: { message: errorText(event) } }];
      }
      return [];
    },
    // A stream that stops without a terminal event is a failure, not an answer.
    finish() {
      if (finished) return [];
      finished = true;
      return [{ error: { message: 'La réponse de ChatGPT a été interrompue avant la fin.' } }];
    },
  };
}

// ---------------------------------------------------------------------------
// Backend call
// ---------------------------------------------------------------------------

function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.ceil((total % 3600) / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} jours`;
  if (hours) return `${hours} h ${String(minutes).padStart(2, '0')}`;
  return `${Math.max(1, minutes)} min`;
}

// Turns a refused request into the status and sentence the Rust core relays.
async function upstreamError(response) {
  const raw = await response.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(raw); } catch {}
  const detail = body && (body.error || body.detail);
  const info = detail && typeof detail === 'object' ? detail : {};
  const message = typeof detail === 'string' ? detail : String(info.message || '');
  const code = String(info.type || info.code || '');
  if (response.status === 429 && /usage_limit|usage limit/i.test(`${code} ${message}`)) {
    const resets = Number(info.resets_in_seconds) > 0 ? ` Réinitialisation dans ${duration(info.resets_in_seconds)}.` : '';
    // Not a transient rate limit: retrying would only wait on a quota that
    // comes back in hours, so it is reported as a plain refusal.
    return fail(400, `Limite d’utilisation de votre abonnement ChatGPT atteinte.${resets}`);
  }
  if (response.status === 401) return fail(401, 'Session ChatGPT refusée. Reconnectez votre abonnement dans Paramètres › Clés API.', { relogin: true });
  const readable = message || (raw && raw.length < 400 && !/^\s*</.test(raw) ? raw.trim() : '');
  return fail(response.status, readable ? `ChatGPT : ${readable}` : `ChatGPT a refusé la requête (HTTP ${response.status}).`);
}

// Opens the streamed Responses call. Resolves with the fetch Response on
// success and throws a shaped error otherwise.
async function openResponseStream(accessToken, request, { signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl()}/responses`, {
      method: 'POST',
      headers: {
        ...backendHeaders(accessToken),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        session_id: request.prompt_cache_key,
        'x-client-request-id': request.prompt_cache_key,
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw fail(502, 'ChatGPT est injoignable. Vérifiez la connexion Internet.');
  }
  if (!response.ok) throw await upstreamError(response);
  return response;
}

module.exports = {
  CLIENT_ID, DEFAULT_MODELS, DEFAULT_BASE_URL,
  setVersion, jwtClaims, needsRefresh,
  requestDeviceCode, pollDeviceCode, refreshSession, listModels,
  toResponsesRequest, createSseReader, createChunkTranslator, openResponseStream,
};
