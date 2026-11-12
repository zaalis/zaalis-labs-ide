'use strict';

// Full-text ranking shared by memories, experiences and conversations. Okapi
// BM25 over normalised tokens: case and accents folded, common French/English
// stop words dropped and a light suffix stemmer, so « préférences » finds
// « preference » and « tests » finds « test ». Pure JavaScript: the packaged
// server cannot rely on an SQLite build with FTS5.

const STOP = new Set(('le la les un une des du de d l et ou en au aux a ce ces cet cette il elle ils elles on nous vous je tu ' +
  'que qui quoi dont ou est sont etre avoir ai as avons avez ont pour par sur dans avec sans pas ne plus moins tres ' +
  'mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs se sa y the an of to in on at for by with from is are ' +
  'was were be been it its this that these those and or not no but as if then so do does did can could should would ' +
  'will my your our their me you we they he she him her them').split(/\s+/));

function fold(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function stem(word) {
  if (/^\d+$/.test(word) || word.length <= 3) return word;
  for (const [suffix, min] of [['issements', 8], ['issement', 7], ['ements', 7], ['ement', 6], ['ations', 7], ['ation', 6],
    ['ments', 6], ['ment', 5], ['ings', 6], ['ing', 5], ['ies', 5], ['euses', 7], ['euse', 6], ['eux', 5], ['ees', 5], ['ee', 4], ['es', 5], ['ed', 5], ['s', 4], ['x', 5], ['e', 5]]) {
    if (word.length >= min && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

function tokenize(text) {
  const words = fold(text).match(/[\p{L}\p{N}_]{2,}/gu) || [];
  return words.filter(word => !STOP.has(word)).map(stem);
}

class Bm25Index {
  constructor(documents, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b; this.docs = []; this.df = new Map();
    for (const document of documents) {
      const terms = new Map();
      for (const field of document.fields) {
        for (const token of tokenize(field.text)) terms.set(token, (terms.get(token) || 0) + (field.weight || 1));
      }
      const length = [...terms.values()].reduce((n, v) => n + v, 0);
      this.docs.push({ id: document.id, terms, length });
      for (const token of terms.keys()) this.df.set(token, (this.df.get(token) || 0) + 1);
    }
    this.average = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }
  search(query, { limit = 10, minScore = 0 } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const total = this.docs.length;
    const results = [];
    for (const doc of this.docs) {
      let score = 0, matched = 0;
      for (const term of terms) {
        const frequency = doc.terms.get(term);
        if (!frequency) continue;
        matched++;
        const df = this.df.get(term) || 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        score += idf * (frequency * (this.k1 + 1)) / (frequency + this.k1 * (1 - this.b + this.b * doc.length / (this.average || 1)));
      }
      // Documents covering more of the query outrank one repeating a single word.
      if (matched) score *= 1 + matched / terms.length;
      if (score > minScore) results.push({ id: doc.id, score, matched, coverage: matched / terms.length });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// Rank `items` for `query`. `fields(item)` returns [{ text, weight }].
function rank(items, query, fields, options = {}) {
  const index = new Bm25Index(items.map((item, id) => ({ id, fields: fields(item) })), options);
  return index.search(query, options).map(hit => ({ item: items[hit.id], score: hit.score, coverage: hit.coverage }));
}

module.exports = { Bm25Index, rank, tokenize, fold, stem };
