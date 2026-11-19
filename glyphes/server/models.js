'use strict';
// Model access for the Glyphs: the same providers as zaalis Labs IDE.
//  - API-key providers (OpenAI, Anthropic, Google Gemini, xAI, Mistral,
//    Moonshot and every OpenAI-compatible provider of the IDE) are pushed from
//    the IDE, sealed per user, and called in the chat-completions dialect.
//  - The ChatGPT subscription signs in on the server itself with OpenAI's
//    device code, so the server owns its own token family and never fights
//    the IDE over single-use refresh tokens.
// A model is named "<provider>::<model>".
const db = require('./db');
const secrets = require('./secrets');

function vendor(name) {
  try { return require('./vendor/' + name); } catch { return require('../../src/accounts/' + name); }
}
const chatgpt = vendor('chatgpt-subscription');
chatgpt.setVersion && chatgpt.setVersion('glyphes');

const BUILTIN = {
  openai:    { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  google:    { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  grok:      { label: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  mistral:   { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  moonshot:  { label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1' },
};

function credentials(userId, provider) {
  const row = db.get('SELECT * FROM model_creds WHERE user_id = ? AND provider = ?', userId, provider);
  if (!row) return null;
  const data = db.json(secrets.open(row.data_enc, `model:${userId}:${provider}`), null);
  return data && { ...row, data, models: db.json(row.models, []) };
}
function saveCredentials(userId, provider, { label, data, models }) {
  if (!/^[a-z0-9:_-]{2,60}$/i.test(provider)) throw Object.assign(new Error('Fournisseur invalide.'), { status: 400 });
  db.run(`INSERT INTO model_creds (user_id, provider, label, data_enc, models, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, provider) DO UPDATE SET label = excluded.label, data_enc = excluded.data_enc, models = excluded.models, updated_at = excluded.updated_at`,
    userId, provider, String(label || provider).slice(0, 80), secrets.seal(JSON.stringify(data), `model:${userId}:${provider}`),
    JSON.stringify((models || []).map(String).filter(Boolean).slice(0, 80)), Date.now());
}
function removeCredentials(userId, provider) { db.run('DELETE FROM model_creds WHERE user_id = ? AND provider = ?', userId, provider); }
function catalog(userId) {
  return db.all('SELECT provider, label, models, updated_at FROM model_creds WHERE user_id = ? ORDER BY label', userId)
    .map(r => ({ provider: r.provider, label: r.label, models: db.json(r.models, []), updatedAt: r.updated_at }));
}
function defaultModel(userId) {
  const user = db.get('SELECT settings FROM users WHERE id = ?', userId);
  const wanted = db.json(user && user.settings, {}).defaultModel;
  const list = catalog(userId);
  if (wanted && list.some(p => wanted.startsWith(p.provider + '::'))) return wanted;
  const first = list.find(p => p.models.length);
  return first ? `${first.provider}::${first.models[0]}` : null;
}

// ---------------------------------------------------------------- calls
const SUB_LOCKS = new Map();
async function chatgptSession(userId) {
  const creds = credentials(userId, 'chatgpt');
  if (!creds) throw Object.assign(new Error('Abonnement ChatGPT non connecté sur le serveur Glyphes.'), { status: 401 });
  let session = creds.data;
  if (!chatgpt.needsRefresh(session)) return session;
  if (SUB_LOCKS.has(userId)) return SUB_LOCKS.get(userId);
  const job = chatgpt.refreshSession(session).then(next => {
    saveCredentials(userId, 'chatgpt', { label: creds.label, data: next, models: creds.models });
    return next;
  }).finally(() => SUB_LOCKS.delete(userId));
  SUB_LOCKS.set(userId, job);
  return job;
}
function assemble(chunks) {
  const message = { role: 'assistant', content: '', tool_calls: [] };
  let usage = null;
  for (const chunk of chunks) {
    if (chunk.error) throw Object.assign(new Error(chunk.error.message || 'Erreur du modèle.'), { status: 502 });
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (!delta) continue;
    if (delta.content) message.content += delta.content;
    for (const call of delta.tool_calls || []) {
      const slot = message.tool_calls[call.index] || (message.tool_calls[call.index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (call.id) slot.id = call.id;
      if (call.function && call.function.name) slot.function.name = call.function.name;
      if (call.function && call.function.arguments) slot.function.arguments += call.function.arguments;
    }
  }
  message.tool_calls = message.tool_calls.filter(Boolean);
  if (!message.tool_calls.length) delete message.tool_calls;
  return { message, usage };
}
async function callChatgpt(userId, model, messages, tools, signal) {
  const session = await chatgptSession(userId);
  const request = chatgpt.toResponsesRequest({ model, messages, tools, tool_choice: tools && tools.length ? 'auto' : undefined, stream: true }, { subscription: true, cacheScope: userId });
  const response = await chatgpt.openResponseStream(session.accessToken, request, { signal });
  const reader = chatgpt.createSseReader(), translate = chatgpt.createChunkTranslator(model), chunks = [];
  for await (const part of response.body) for (const event of reader.push(part)) chunks.push(...translate.push(event));
  for (const event of reader.finish()) chunks.push(...translate.push(event));
  chunks.push(...translate.finish());
  return assemble(chunks);
}
async function callKey(creds, model, messages, tools, signal) {
  const { baseUrl, key } = creds.data;
  if (!/^https:\/\//.test(baseUrl || '')) throw Object.assign(new Error('Adresse du fournisseur invalide.'), { status: 400 });
  const response = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'zaalis-glyphes' },
    body: JSON.stringify({ model, messages, ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (data.error && (data.error.message || data.error.code)) || data.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(`${creds.label} : ${String(detail).slice(0, 300)}`), { status: response.status === 429 ? 429 : 502 });
  }
  const message = data.choices && data.choices[0] && data.choices[0].message;
  if (!message) throw Object.assign(new Error(`${creds.label} : réponse vide.`), { status: 502 });
  return { message: { role: 'assistant', content: message.content || '', ...(message.tool_calls && message.tool_calls.length ? { tool_calls: message.tool_calls } : {}) }, usage: data.usage || null };
}
async function complete(userId, modelRef, messages, tools, { signal } = {}) {
  const ref = String(modelRef || defaultModel(userId) || '');
  const split = ref.indexOf('::');
  if (split < 1) throw Object.assign(new Error('Aucun modèle configuré. Envoie un modèle depuis zaalis Labs IDE (Glyphes › Paramètres › Modèles) ou connecte ton abonnement ChatGPT.'), { status: 400, setup: true });
  const provider = ref.slice(0, split), model = ref.slice(split + 2);
  const timeout = AbortSignal.timeout(180000);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let result;
  if (provider === 'chatgpt') result = await callChatgpt(userId, model, messages, tools, merged);
  else {
    const creds = credentials(userId, provider);
    if (!creds) throw Object.assign(new Error(`Le fournisseur « ${provider} » n’est pas connecté sur le serveur Glyphes.`), { status: 400, setup: true });
    result = await callKey(creds, model, messages, tools, merged);
  }
  const day = new Date().toISOString().slice(0, 10), u = result.usage || {};
  db.run(`INSERT INTO usage (user_id, day, model, input, output, calls) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(user_id, day, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output, calls = calls + 1`,
    userId, day, ref, Number(u.prompt_tokens) || 0, Number(u.completion_tokens) || 0);
  return result.message;
}

// ---------------------------------------------------------------- ChatGPT device sign-in on the server
const flows = new Map();
async function startChatgpt(userId) {
  const flow = await chatgpt.requestDeviceCode();
  flows.set(userId, flow);
  return { userCode: flow.userCode, verificationUrl: flow.verificationUrl, interval: flow.interval, expiresAt: flow.expiresAt };
}
async function pollChatgpt(userId) {
  const flow = flows.get(userId);
  if (!flow) return { status: 'none' };
  if (Date.now() > flow.expiresAt) { flows.delete(userId); return { status: 'expired' }; }
  const session = await chatgpt.pollDeviceCode(flow);
  if (!session) return { status: 'pending' };
  flows.delete(userId);
  saveCredentials(userId, 'chatgpt', { label: 'ChatGPT (abonnement)', data: session, models: chatgpt.DEFAULT_MODELS });
  return { status: 'connected', email: session.email, plan: session.plan };
}

module.exports = { BUILTIN, credentials, saveCredentials, removeCredentials, catalog, defaultModel, complete, startChatgpt, pollChatgpt, assemble };
