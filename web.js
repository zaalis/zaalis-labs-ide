'use strict';

// Native web access for the agent: a keyless search (DuckDuckGo HTML endpoint)
// and a single-URL reader that returns readable text. Both go through the same
// SSRF guard so a model can never reach the loopback interface, the local
// network, or a cloud metadata endpoint. No API key, no paid provider: the
// free tier is the default. A paid search provider can be layered on later
// without changing the tool surface.
const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const USER_AGENT = 'Mozilla/5.0 (compatible; zaalis-agent/1.0; +https://zaalis.dev)';

// Private, loopback, link-local and other non-routable ranges an agent must
// never be able to reach through a URL it chose or a redirect it followed.
function isPrivateIp(ip) {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
    if (a.startsWith('::ffff:')) return isPrivateIp(a.slice(7)); // IPv4-mapped
    return false;
  }
  return true;
}

function parseHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url;
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('adresse privee bloquee');
    return;
  }
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('hote local bloque');
  }
  let addresses;
  try { addresses = await dns.lookup(hostname, { all: true }); } catch { throw new Error('resolution DNS impossible'); }
  if (!addresses.length) throw new Error('hote introuvable');
  for (const a of addresses) if (isPrivateIp(a.address)) throw new Error('adresse privee bloquee');
}

// fetch() follows redirects transparently, which would let a public URL bounce
// to a private one after our check. So we resolve+validate every hop ourselves
// and stop the client from redirecting on its own.
async function safeFetch(rawUrl, { method = 'GET', headers = {}, body } = {}) {
  let current = parseHttpUrl(rawUrl);
  if (!current) throw new Error('URL invalide');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current.hostname);
    const response = await fetch(current, {
      method,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr,en;q=0.8', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      const next = parseHttpUrl(new URL(location, current).toString());
      if (!next) throw new Error('redirection invalide');
      current = next;
      method = 'GET';
      body = undefined;
      continue;
    }
    return response;
  }
  throw new Error('trop de redirections');
}

async function readBody(response) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) return (await response.text()).slice(0, MAX_BODY_BYTES);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= MAX_BODY_BYTES) { try { await reader.cancel(); } catch {} break; }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}

// Turn an HTML page into plain, readable text: drop the noise (scripts, styles,
// nav chrome), keep a title, collapse the rest. Good enough to feed a model
// without shipping a full DOM parser.
function htmlToText(html) {
  let out = String(html || '');
  const titleMatch = out.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|header|aside|form|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  out = decodeEntities(out)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: out };
}

// DuckDuckGo's HTML endpoint needs no key. Result links are wrapped in a
// redirect (/l/?uddg=<encoded target>), so we pull the real URL back out.
function parseDuckResults(html, max) {
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < max) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//i.test(href)) continue;
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (title) results.push({ title, url: href, snippet: '' });
  }
  const snippets = [];
  const sre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let s;
  while ((s = sre.exec(html)) !== null) {
    snippets.push(decodeEntities(s[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
  }
  for (let i = 0; i < results.length; i++) if (snippets[i]) results[i].snippet = snippets[i];
  return results;
}

async function webSearch(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('requete vide');
  const max = Math.min(Math.max(parseInt(options.max, 10) || 6, 1), 15);
  const response = await safeFetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q, kl: options.region || 'wt-wt' }).toString(),
  });
  if (!response.ok) throw new Error(`recherche HTTP ${response.status}`);
  const html = await readBody(response);
  return { query: q, results: parseDuckResults(html, max) };
}

async function webFetch(url, options = {}) {
  const parsed = parseHttpUrl(url);
  if (!parsed) throw new Error('URL invalide');
  const response = await safeFetch(parsed.toString(), {
    headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const raw = await readBody(response);
  const maxChars = Math.min(Math.max(parseInt(options.max, 10) || MAX_TEXT_CHARS, 500), MAX_TEXT_CHARS);
  if (/text\/html|application\/xhtml/.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)) {
    const { title, text } = htmlToText(raw);
    const truncated = text.length > maxChars;
    return { url: parsed.toString(), title, contentType, text: text.slice(0, maxChars), truncated };
  }
  const truncated = raw.length > maxChars;
  return { url: parsed.toString(), title: '', contentType, text: raw.slice(0, maxChars), truncated };
}

module.exports = { webSearch, webFetch, isPrivateIp, parseHttpUrl, htmlToText };
