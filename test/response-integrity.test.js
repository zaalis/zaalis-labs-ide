'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const integrity = require('../response-integrity');
const { preserveDraftResponse, finalAnswerNeedsRetry, evidenceLedger, mergeDeterministicFindings } = require('../investigation-controller');

// The exact shape the user was shown: numbered and bulleted markers with the
// content missing. It must never be classified as a usable answer again.
const EMPTY_SCAFFOLD = ['Mistral', '', '1. ', '2. ', '3. ', '4. ', '', '* ', '* ', '* ', '', '* ', '* ', '* ', '* '].join('\n');

const REAL_REPORT = [
  'Résumé exécutif',
  'Audit de 43 fichiers, 2 vulnérabilités confirmées de sévérité critique.',
  '',
  'Constats confirmés',
  '',
  '1. server/src/routes_colis.go:150 — Injection SQL',
  '   - Source : paramètre owner contrôlable via la query string.',
  '   - Sink : requête construite par concaténation de chaînes.',
  '   - Sévérité : Critique. Remédiation : requête paramétrée.',
].join('\n');

test('la charpente de liste vide est détectée comme dégénérée', () => {
  const result = integrity.analyzeAnswer(EMPTY_SCAFFOLD);
  assert.equal(result.degenerate, true);
  assert.equal(result.reason, 'structure_only');
});

test('un vrai rapport n’est jamais classé dégénéré', () => {
  assert.equal(integrity.analyzeAnswer(REAL_REPORT).degenerate, false);
});

test('une réponse courte mais réelle passe', () => {
  assert.equal(integrity.isDegenerate('Oui, le fichier server.js:42 valide bien le jeton.'), false);
  assert.equal(integrity.isDegenerate('- server.js:42 corrigé\n- cli.js:10 corrigé'), false);
});

test('un bloc de code compte comme du contenu', () => {
  const answer = 'Voici le correctif :\n\n```js\nconst safe = db.query("SELECT 1 WHERE id = ?", [id]);\n```';
  assert.equal(integrity.isDegenerate(answer), false);
});

test('la répétition en boucle est détectée', () => {
  assert.equal(integrity.analyzeAnswer(Array(12).fill('Je continue l analyse.').join('\n')).reason, 'repetition');
});

test('finish_reason "length" est normalisé sur tous les fournisseurs', () => {
  for (const raw of ['length', 'max_tokens', 'MAX_OUTPUT_TOKENS', 'model_length']) {
    assert.equal(integrity.isTruncated(raw), true, raw);
  }
  for (const raw of ['stop', 'end_turn', 'tool_calls', '']) {
    assert.equal(integrity.isTruncated(raw), false, raw);
  }
});

test('un brouillon dégénéré n’est plus "préservé" et affiché', () => {
  const state = {
    plan: { root: '/tmp', scope: { relevantFiles: 342 }, budget: { minReads: 20, minSearches: 4, targetCategories: 6 }, categoryCounts: { auth: 3 }, candidates: [{ path: 'a.js', categories: ['auth'] }] },
    readFiles: new Set(['a.js', 'b.js']),
    searches: 1,
    coveredCategories: new Set(['auth']),
  };
  const out = preserveDraftResponse(state, EMPTY_SCAFFOLD, 'format de citation non reconnu', 'fr');
  assert.ok(!/^\s*\*\s*$/m.test(out), 'aucune puce vide ne doit subsister');
  assert.match(out, /Aucun constat confirmé/);
  assert.match(out, /structure de liste sans contenu/);
});

test('un brouillon réel reste préservé tel quel', () => {
  const state = { plan: { scope: { relevantFiles: 10 }, budget: { minReads: 6, minSearches: 2, targetCategories: 4 }, categoryCounts: { auth: 2 }, candidates: [] }, readFiles: new Set(['a.js']), searches: 1, coveredCategories: new Set(['auth']) };
  const out = preserveDraftResponse(state, REAL_REPORT, 'format inconnu', 'fr');
  assert.match(out, /routes_colis\.go:150/);
});

test('finalAnswerNeedsRetry rejette la charpente vide', () => {
  assert.equal(finalAnswerNeedsRetry(EMPTY_SCAFFOLD, 'fr'), true);
  assert.equal(finalAnswerNeedsRetry(REAL_REPORT, 'fr'), false);
});

test('la mémoire d’investigation liste le déjà-lu et le reste à lire', () => {
  const state = {
    plan: { candidates: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] },
    readFiles: new Set(['a.js', 'b.js']),
    searches: 3,
    coveredCategories: new Set(['auth', 'database']),
  };
  const ledger = evidenceLedger(state, 'fr');
  assert.match(ledger, /a\.js, b\.js/);
  assert.match(ledger, /Pas encore lus[^\n]*c\.js/);
  assert.match(ledger, /Recherches ciblées effectuées : 3/);
  assert.ok(ledger.length < 4000, 'le ledger doit rester compact');
});

test('la mémoire est vide tant que rien n’a été fait', () => {
  assert.equal(evidenceLedger({ readFiles: new Set(), searches: 0, coveredCategories: new Set(), plan: { candidates: [] } }, 'fr'), '');
});

test('le balayage déterministe ajoute ce que le modèle a manqué, sans doublon', () => {
  const sweep = {
    findings: [
      { file: 'server/src/routes_colis.go', line: 150, rule: 'sql.concatenation', cwe: 'CWE-89', severity: 'high', message: 'Requête SQL construite par concaténation.' },
      { file: 'other/handler.js', line: 12, rule: 'javascript.eval', cwe: 'CWE-95', severity: 'high', message: 'Exécution dynamique via eval.' },
    ],
  };
  const merged = mergeDeterministicFindings(REAL_REPORT, sweep, 'fr');
  assert.match(merged, /other\/handler\.js:12/, 'le constat manquant doit être ajouté');
  assert.equal((merged.match(/routes_colis\.go:150/g) || []).length, 1, 'le constat déjà cité ne doit pas être dupliqué');
});

test('rien à fusionner quand le scanner ne trouve rien', () => {
  assert.equal(mergeDeterministicFindings(REAL_REPORT, { findings: [] }, 'fr'), REAL_REPORT);
  assert.equal(mergeDeterministicFindings(REAL_REPORT, null, 'fr'), REAL_REPORT);
});

test('finalizeResponse est idempotente : une seule ligne de couverture', () => {
  const { finalizeResponse } = require('../investigation-controller');
  const state = {
    plan: { scope: { relevantFiles: 342 }, budget: { minReads: 20, minSearches: 4, targetCategories: 6 }, categoryCounts: { auth: 3 }, candidates: [] },
    readFiles: new Set(['a.js']),
    searches: 2,
    coveredCategories: new Set(['auth']),
  };
  const once = finalizeResponse(state, REAL_REPORT, 'fr');
  const twice = finalizeResponse(state, once, 'fr');
  assert.equal((twice.match(/fichiers pertinents lus/g) || []).length, 1, 'la couverture ne doit pas être empilée');
  assert.match(twice, /routes_colis\.go:150/, 'le contenu du rapport doit survivre');
});
