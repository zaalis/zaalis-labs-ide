'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rankSearchResults } = require('../src/services/search-ranking');
const { ErrorJournal, mask } = require('../src/services/error-journal');

const row = (url, title = '', snippet = '') => ({ url, title, snippet });

test('three links, one per site, engine pages and ads excluded', () => {
  const picked = rankSearchResults('rust async runtime', [
    row('https://duckduckgo.com/Rust', 'Rust'),
    row('https://duckduckgo.com/y.js?ad_domain=x.com&ad_provider=bing', 'Ad'),
    row('https://tokio.rs/', 'Tokio - An asynchronous Rust runtime'),
    row('https://tokio.rs/tokio/tutorial', 'Tutorial | Tokio - async Rust runtime'),
    row('https://docs.rs/async-std', 'async-std', 'Async version of the Rust standard library'),
    row('https://example.com/blog', 'Gardening tips'),
  ]);
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map(p => new URL(p.url).hostname), ['tokio.rs', 'docs.rs', 'example.com']);
});

test('pages matching the query outrank an earlier unrelated page', () => {
  const picked = rankSearchResults('électricité tarif', [
    row('https://a.example/', 'Accueil'),
    row('https://b.example/', 'Tarif de l’électricité 2026', 'Le tarif réglementé'),
  ], 1);
  assert.equal(picked[0].url, 'https://b.example/');
});

test('fills up with a second page of the same site when sites run out', () => {
  const picked = rankSearchResults('x', [row('https://one.example/a', 'A'), row('https://one.example/b', 'B')]);
  assert.equal(picked.length, 2);
});

test('error journal keeps clear message apart from masked detail, newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-journal-'));
  try {
    const journal = new ErrorJournal(dir);
    journal.record({ source: 'web-search', code: 'search_timeout', message: 'Le moteur de recherche n’a pas répondu à temps.', detail: 'AbortError Bearer abcdefghijklmnop' });
    journal.record({ source: 'browser', code: 'link_open_failed', message: 'Lien non ouvert', detail: 'https://user:secret@host.example/?token=123' });
    const [last, first] = journal.recent(10);
    assert.equal(last.code, 'link_open_failed');
    assert.equal(first.message, 'Le moteur de recherche n’a pas répondu à temps.');
    assert.ok(!first.detail.includes('abcdefghijklmnop'));
    assert.ok(!last.detail.includes('secret') && !last.detail.includes('123'));
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'ide-errors.log')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('masking covers API keys', () => {
  assert.ok(!mask('key sk-ant-api03-ABCDEFGHIJKLMNOP').includes('ABCDEFGHIJKLMNOP'));
});
