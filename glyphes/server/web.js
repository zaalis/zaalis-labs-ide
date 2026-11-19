'use strict';
// Web search (DuckDuckGo HTML page, no key) and page reading for the Glyphs.
// Every fetched address is resolved first and refused if it points inside the
// VM or the cloud network (metadata server, loopback, private ranges).
const dns = require('node:dns').promises;
const net = require('node:net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && privateAddress(v.slice(7));
}
async function assertPublic(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Adresse non web refusée.');
  if (/^(localhost|metadata(\.google\.internal)?)$/i.test(u.hostname) || u.hostname.endsWith('.internal')) throw new Error('Adresse interne refusée.');
  const addresses = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new Error('Adresse interne refusée.');
  return u;
}
async function safeFetch(url, options = {}, hops = 4) {
  let current = url;
  for (let i = 0; i <= hops; i++) {
    await assertPublic(current);
    const response = await fetch(current, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7', ...(options.headers || {}) } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { current = new URL(response.headers.get('location'), current).toString(); continue; }
    return response;
  }
  throw new Error('Trop de redirections.');
}
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (s) => decode(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function search(query, max = 6) {
  const response = await safeFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { Accept: 'text/html' } });
  const html = await response.text();
  const out = [], seen = new Set();
  const re = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    let url = decode(m[1]);
    try { const u = new URL(url, 'https://duckduckgo.com'); url = u.searchParams.get('uddg') || u.toString(); } catch { continue; }
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com/.test(new URL(url).hostname) || /[?&]ad_(provider|domain)=/.test(url) || seen.has(url)) continue;
    seen.add(url);
    const tail = html.slice(re.lastIndex, re.lastIndex + 1500);
    const sn = tail.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    out.push({ title: strip(m[2]).slice(0, 160), url, site: new URL(url).hostname.replace(/^www\./, ''), snippet: sn ? strip(sn[1]).slice(0, 300) : '' });
  }
  return out;
}
async function read(url) {
  const response = await safeFetch(url, { headers: { Accept: 'text/html,text/plain;q=0.9' } });
  const type = response.headers.get('content-type') || '';
  if (!/text\/|json|xml/.test(type)) return { url, error: `Contenu non textuel (${type || 'inconnu'}).` };
  const raw = (await response.text()).slice(0, 600000);
  const title = strip((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const text = strip(raw.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|h\d|br|tr)>/gi, '\n'));
  return { url, title, text: text.slice(0, 9000) };
}

module.exports = { search, read, assertPublic, privateAddress };
