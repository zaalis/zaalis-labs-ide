'use strict';

// Generic Streamable-HTTP MCP registry. Servers are explicitly configured by
// the owner; an agent can only call discovered tools which also pass that
// server's allow/deny rules.
const crypto = require('crypto');
const net = require('net');

function safeId(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80); }
function parseEndpoint(value) {
  let url; try { url = new URL(String(value || '')); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return null;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname) || (net.isIP(url.hostname) && (url.hostname === '127.0.0.1' || url.hostname === '::1'));
  if (url.protocol !== 'https:' && !loopback) return null;
  return url;
}
function normaliseServer(value) {
  const src = value && typeof value === 'object' ? value : {}; const endpoint = parseEndpoint(src.endpoint); const id = safeId(src.id || src.name);
  if (!id || !endpoint) return null;
  return { id, name: String(src.name || id).trim().slice(0, 120), endpoint: endpoint.toString(), enabled: src.enabled !== false, allow: normaliseNames(src.allow), deny: normaliseNames(src.deny) };
}
function normaliseNames(values) { return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter((value) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value)))).slice(0, 500); }
function parseResponse(response, text) {
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/event-stream') || /^(?:event|data|id|retry):/m.test(text)) {
    let payload = ''; for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) payload = line.slice(5).trim() || payload;
    return payload ? JSON.parse(payload) : null;
  }
  return text.trim() ? JSON.parse(text) : null;
}

async function request(server, payload, sessionId) {
  const endpoint = parseEndpoint(server.endpoint); if (!endpoint) throw new Error('Endpoint MCP invalide.');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await response.text(); const data = parseResponse(response, text);
  if (!response.ok || data?.error) throw new Error(data?.error?.message || `MCP HTTP ${response.status}`);
  return { data, sessionId: response.headers.get('mcp-session-id') || sessionId || '' };
}

async function open(server) {
  const init = await request(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Zaalis Labs IDE', version: '1.0' } } });
  return { ...server, sessionId: init.sessionId };
}
function allowed(server, tool) { const name = String(tool || ''); return !server.deny.includes(name) && (!server.allow.length || server.allow.includes(name)); }
async function tools(server) { const client = await open(server); const response = await request(client, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, client.sessionId); return Array.isArray(response.data?.result?.tools) ? response.data.result.tools : []; }
async function call(server, tool, args) { if (!allowed(server, tool)) throw new Error('Outil MCP refusé par la politique du serveur.'); const client = await open(server); const response = await request(client, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: String(tool), arguments: args && typeof args === 'object' ? args : {} } }, client.sessionId); if (response.data?.result?.isError) throw new Error((response.data.result.content || []).map((item) => item.text || '').join('\n') || 'Outil MCP en erreur.'); return response.data?.result || {}; }

module.exports = { safeId, parseEndpoint, normaliseServer, tools, call, allowed };
