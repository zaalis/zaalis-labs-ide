'use strict';
// Analyse des résultats de recherche (recherche IA) : DuckDuckGo HTML, dédoublonnage, repli.
// (extrait de main.js — aucune dépendance sur l'état du navigateur)

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCharCode(parseInt(d, 10)); } catch { return _m; } });
}

function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); }

function parseDuckDuckGo(html) {
  const results = [];
  // Bloc par resultat : de result__a (lien+titre) a la fin du snippet.
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<\/html>|$)/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < 10) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
    else if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//i.test(href)) continue;
    // Ecarte les publicites DuckDuckGo (redirections y.js / ad_domain).
    if (/duckduckgo\.com\/y\.js/i.test(href) || /[?&]ad_domain=/i.test(href)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    const sn = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = sn ? stripTags(sn[1]) : '';
    results.push({ url: href, title, snippet });
  }
  return results;
}

// Deduplique par URL en preservant l'ordre.
function dedupeResults(list) {
  const seen = new Set(), out = [];
  for (const r of list) { if (r && r.url && !seen.has(r.url)) { seen.add(r.url); out.push(r); } }
  return out;
}

// Resultats de repli quand le reseau echoue : liens vers les moteurs reels.
function fallbackResults(q) {
  const e = encodeURIComponent(q);
  return [
    { url: 'https://www.google.com/search?q=' + e,  title: 'Rechercher « ' + q + ' » sur Google',     snippet: 'Ouvrir les resultats Google pour cette requete.' },
    { url: 'https://duckduckgo.com/?q=' + e,         title: 'Rechercher « ' + q + ' » sur DuckDuckGo', snippet: 'Ouvrir les resultats DuckDuckGo pour cette requete.' },
    { url: 'https://en.wikipedia.org/w/index.php?search=' + e, title: 'Wikipedia — ' + q,               snippet: 'Chercher un article encyclopedique correspondant.' },
  ];
}

function buildOverview(q, results) {
  const parts = results.slice(0, 3).map(r => r.snippet).filter(Boolean);
  let txt = parts.join(' ');
  if (txt.length > 620) txt = txt.slice(0, 620).replace(/\s+\S*$/, '') + '…';
  if (!txt) txt = 'Voici les resultats les plus pertinents trouves pour « ' + q +' ».';
  return txt;
}

module.exports = { decodeEntities, stripTags, parseDuckDuckGo, dedupeResults, fallbackResults, buildOverview };
