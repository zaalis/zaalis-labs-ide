'use strict';

// Picks the few pages worth showing the user from a list of search results.
// The engine's order is the main signal; words of the query found in the title
// or snippet refine it, and one page per site keeps the links complementary.
// Ads and the search engine's own pages never qualify.

const plain = value => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

function rankSearchResults(query, results, count = 3) {
  const terms = [...new Set(plain(query).split(/[^a-z0-9]+/).filter(word => word.length > 2))];
  const scored = (Array.isArray(results) ? results : [])
    .filter(result => result && /^https?:\/\//i.test(String(result.url || ''))
      && !/(^|\.)duckduckgo\.com$/.test(hostOf(result.url))
      && !/[?&]ad_(?:provider|domain)=/i.test(result.url))
    .map((result, index) => {
      const title = plain(result.title), snippet = plain(result.snippet);
      const hits = terms.reduce((sum, term) => sum + (title.includes(term) ? 2 : 0) + (snippet.includes(term) ? 1 : 0), 0);
      // Full match of every term ≈ 3 points; each rank lower costs 0.6.
      return { result, score: (terms.length ? hits / terms.length : 0) - index * 0.6 };
    })
    .sort((a, b) => b.score - a.score);
  const picked = [], hosts = new Set();
  for (const { result } of scored) {
    const host = hostOf(result.url);
    if (hosts.has(host)) continue;
    hosts.add(host);
    picked.push(result);
    if (picked.length >= count) break;
  }
  // Too few distinct sites: fill with the next best pages.
  for (const { result } of scored) {
    if (picked.length >= count) break;
    if (!picked.includes(result)) picked.push(result);
  }
  return picked;
}

module.exports = { rankSearchResults, hostOf };
