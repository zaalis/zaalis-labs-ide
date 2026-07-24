'use strict';

// Small, dependency-free Streamable HTTP MCP client. The destination is
// strictly limited to the local Zaalis Brain gateway.
const http = require('http');
const ALLOWED_TOOLS = new Set(['list_projects','list_project_files','read_file','search_project','get_file_summary','propose_file_edit','write_file','create_note','update_note','delete_note','get_project_graph','get_project_context','list_notes']);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function validateEndpoint(value) {
  let url; try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.port !== '39191' || url.username || url.password || url.search || url.hash || !/^\/mcp\/[A-Za-z0-9_-]{24,}$/.test(url.pathname)) return null;
  url.hostname = '127.0.0.1'; // Brain validates Host exactly.
  return url;
}
function validateConfig(value) {
  const endpoint = validateEndpoint(value && value.endpoint), token = String(value && value.token || '').trim();
  return endpoint && /^[a-f0-9]{64}$/i.test(token) ? { endpoint: endpoint.toString(), token } : null;
}
// Brain speaks the MCP Streamable HTTP transport (@modelcontextprotocol/sdk).
// That transport (a) rejects requests whose Accept header does not list BOTH
// application/json and text/event-stream (HTTP 406), and (b) frames successful
// responses as Server-Sent Events (`event: message\ndata: <json>`), never as a
// bare JSON body. So we must advertise both content types and pull the JSON-RPC
// payload out of the SSE `data:` line. Error responses still come back as plain
// JSON, so the parser handles either shape.
function parseMcpBody(res, raw) {
  const text = raw.toString('utf8');
  if (!text.trim()) return null; // e.g. 202 Accepted for a notification.
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('text/event-stream') || /^(event|data|id|retry):/m.test(text)) {
    let json = '';
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d) json = d; }
    return json ? JSON.parse(json) : null;
  }
  return JSON.parse(text);
}
function request(endpoint, token, payload, sessionId) {
  const url = validateEndpoint(endpoint);
  if (!url) return Promise.reject(new Error('Route MCP Zaalis Brain invalide.'));
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 39191, path: url.pathname, method: 'POST', timeout: 10000, headers: { Host: '127.0.0.1:39191', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) return req.destroy(new Error('Réponse MCP trop volumineuse.')); chunks.push(chunk); });
      res.on('end', () => {
        let data; try { data = parseMcpBody(res, Buffer.concat(chunks)); } catch { return reject(new Error('Réponse MCP invalide.')); }
        if (res.statusCode < 200 || res.statusCode >= 300 || (data && data.error)) return reject(new Error((data && data.error && data.error.message) || `MCP HTTP ${res.statusCode}`));
        resolve({ data, sessionId: String(res.headers['mcp-session-id'] || sessionId || '') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Délai MCP dépassé.'))); req.on('error', reject); req.end(body);
  });
}
async function open(config) {
  const safe = validateConfig(config); if (!safe) throw new Error('Connexion Zaalis Brain non configurée.');
  const init = await request(safe.endpoint, safe.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zaalis Labs IDE', version: '1.0' } } });
  if (!init.sessionId) throw new Error('Session MCP non retournée par Zaalis Brain.');
  return { ...safe, sessionId: init.sessionId };
}
async function check(config) {
  const client = await open(config), response = await request(client.endpoint, client.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, client.sessionId);
  const tools = response.data && response.data.result && response.data.result.tools;
  return { tools: Array.isArray(tools) ? tools.map((tool) => tool && tool.name).filter(Boolean) : [] };
}
async function callTool(config, tool, args) {
  if (!ALLOWED_TOOLS.has(String(tool))) throw new Error('Outil MCP Zaalis Brain non autorisé.');
  const client = await open(config), response = await request(client.endpoint, client.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: String(tool), arguments: args && typeof args === 'object' ? args : {} } }, client.sessionId);
  const result = response.data && response.data.result;
  if (result && result.isError) throw new Error((result.content || []).map((item) => item.text || '').join('\n') || 'Outil MCP refusé.');
  return result || {};
}
module.exports = { validateConfig, check, callTool, ALLOWED_TOOLS };
