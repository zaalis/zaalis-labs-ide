'use strict';

// End-to-end regression tests for the exact failures observed in production
// (server-data/agent-sessions/logs, 2026-07-23):
//   - session 69f84964: 24 files read, final answer = one error line;
//   - session 296ade54: model call killed at 120s mid-audit;
//   - the reported run: a page of empty list markers shipped as a report.
// Each test drives the real runAgentTurn with a scripted model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentTurn } = require('../agent-engine');

const REQUEST = 'est ce que tu peut analyser et detecter toute les failles de securite ne modifie rien analyse juste';

const REPORT = [
  'Résumé exécutif',
  'Audit ciblé de la couche HTTP, 1 vulnérabilité critique confirmée.',
  '',
  'Constats confirmés',
  '',
  '1. routes/mod0.js:2 — Injection SQL par concaténation',
  '   - Source : req.query.a, contrôlable par l’attaquant.',
  '   - Sink : db.query avec concaténation de chaînes.',
  '   - Sévérité : Critique. Remédiation : requête paramétrée.',
  '',
  'Pistes à vérifier',
  '',
  '- Rien d’autre à signaler dans le périmètre lu.',
  '',
  'Couverture et limites',
  '',
  'Lecture ciblée de la couche routes.',
].join('\n');

const EMPTY_SCAFFOLD = ['1. ', '2. ', '3. ', '', '* ', '* ', '* ', '* ', '', '* ', '* '].join('\n');

function makeRepo(fileCount = 40) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-res-'));
  for (let i = 0; i < fileCount; i++) {
    const dir = path.join(root, i % 3 === 0 ? 'routes' : i % 3 === 1 ? 'auth' : 'db');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `mod${i}.js`),
      `// module ${i}\nfunction handler(req){ return db.query("SELECT * FROM t WHERE a='" + req.query.a + "'"); }\nmodule.exports={handler};\n`);
  }
  return root;
}

// Drives runAgentTurn with a fixed script of model answers. The last entry is
// repeated once the script runs out, which is how a stalled model behaves.
function scriptedModel(script) {
  let call = 0;
  const seen = [];
  const fn = async (payload) => {
    seen.push(payload);
    const step = script[Math.min(call, script.length - 1)];
    call++;
    return typeof step === 'function' ? step(payload, call) : step;
  };
  fn.calls = () => call;
  fn.payloads = seen;
  return fn;
}

function baseOptions(root, callModel) {
  return {
    root,
    sessionId: 'test-session',
    turnId: 'test-turn',
    model: 'mistral',
    message: REQUEST,
    language: 'fr',
    permissionMode: 'plan',
    callModel,
    config: {},
  };
}

const READ_CALL = '```tool\n{"name":"read","input":{"paths":["routes/mod0.js"]}}\n```';

test('un modèle qui boucle ne détruit plus le rapport déjà rédigé', async () => {
  const root = makeRepo();
  try {
    // Round 1-2 read, round 3 writes a real report while ALSO asking for the
    // same tool batch again, then the model repeats that batch forever.
    const callModel = scriptedModel([
      { response: READ_CALL },
      { response: `${REPORT}\n\n${READ_CALL}` },
      { response: READ_CALL },
    ]);
    const result = await runAgentTurn(baseOptions(root, callModel));
    assert.match(result.response, /routes\/mod0\.js:2/, 'le rapport du modèle doit survivre au blocage');
    assert.match(result.response, /Injection SQL/);
    assert.ok(!/^Analyse arrêtée/.test(result.response), 'le message moteur ne doit plus remplacer le rapport');
    assert.match(result.response, /Couverture\s*:/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('un modèle qui ne renvoie que des puces vides ne produit jamais un rapport vide', async () => {
  const root = makeRepo();
  try {
    const callModel = scriptedModel([
      { response: READ_CALL },
      { response: EMPTY_SCAFFOLD },
    ]);
    const result = await runAgentTurn(baseOptions(root, callModel));
    assert.ok(!/\n\s*\*\s*\n\s*\*\s*\n/.test(result.response), 'aucune suite de puces vides ne doit être rendue');
    assert.match(result.response, /Aucun constat confirmé|structure de liste sans contenu/);
    assert.match(result.response, /Couverture\s*:/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('une réponse tronquée est relancée en version compacte au lieu d’être acceptée', async () => {
  const root = makeRepo();
  try {
    const callModel = scriptedModel([
      { response: READ_CALL },
      { response: 'Constats confirmés\n\n1. routes/mod0.js:2 — Injection SQL, coupée au milieu de la phr', truncated: true, finishReason: 'length' },
      { response: REPORT },
    ]);
    const result = await runAgentTurn(baseOptions(root, callModel));
    assert.match(result.response, /Remédiation : requête paramétrée/, 'la version complète doit remplacer la version coupée');
    const retried = callModel.payloads.some((p) => /RÉPONSE TRONQUÉE/.test(String(p.message || '')));
    assert.ok(retried, 'une relance compacte doit avoir été demandée');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('la mémoire d’investigation est réinjectée à chaque tour', async () => {
  const root = makeRepo();
  try {
    const callModel = scriptedModel([{ response: READ_CALL }, { response: REPORT }]);
    await runAgentTurn(baseOptions(root, callModel));
    const withLedger = callModel.payloads.filter((p) => /MÉMOIRE D’INVESTIGATION/.test(String(p.message || '')));
    assert.ok(withLedger.length >= 1, 'le ledger doit être injecté après la première lecture');
    assert.match(withLedger[0].message, /routes\/mod0\.js/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('le budget de temps demandé pour un audit large dépasse l’ancien plafond de 120s', async () => {
  const root = makeRepo();
  try {
    const callModel = scriptedModel([{ response: REPORT }]);
    await runAgentTurn(baseOptions(root, callModel));
    assert.ok(callModel.payloads[0].timeoutMs > 120000, `timeout demandé trop bas : ${callModel.payloads[0].timeoutMs}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('le transcript par tour est émis pour le post-mortem, sans secret', async () => {
  const root = makeRepo();
  try {
    const events = [];
    const callModel = scriptedModel([
      { response: `api_key = "sk-live-abcdefghijklmnop"\n${REPORT}`, finishReason: 'stop' },
    ]);
    const options = baseOptions(root, callModel);
    options.emitEvent = (event) => events.push(event);
    await runAgentTurn(options);
    const rounds = events.filter((e) => e.type === 'model_round');
    assert.ok(rounds.length >= 1, 'un transcript par tour doit être émis');
    assert.equal(rounds[0].internal, true, 'le transcript doit être marqué interne');
    assert.ok(!/sk-live-abcdefghijklmnop/.test(rounds[0].raw), 'le transcript ne doit contenir aucun secret');
    assert.equal(typeof rounds[0].integrity.degenerate, 'boolean');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('le filet déterministe est câblé : un rapport ne peut plus être sans ancrage', async () => {
  const root = makeRepo();
  try {
    // The model produces a report that cites nothing the scanner found.
    const callModel = scriptedModel([
      { response: READ_CALL },
      { response: 'Constats confirmés\n\n1. auth/mod1.js:2 — contrôle d’accès à revoir, source req.query.\n\nPistes à vérifier\n\n- Rien d’autre.' },
    ]);
    const options = baseOptions(root, callModel);
    options.securityPipeline = require('../security-pipeline');
    const result = await runAgentTurn(options);
    assert.match(result.response, /Balayage déterministe/, 'le balayage mécanique doit compléter le rapport');
    assert.match(result.response, /routes\/mod0\.js:2/, 'les ancrages fichier:ligne du scanner doivent apparaître');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('aucune valeur secrète ne traverse le rapport final', async () => {
  const root = makeRepo(6);
  fs.writeFileSync(path.join(root, '.env'), 'API_SECRET_KEY=sk-live-supersecretvalue123\n');
  try {
    const callModel = scriptedModel([
      { response: 'Constats confirmés\n\n1. .env:1 — secret en dur, valeur API_SECRET_KEY=sk-live-supersecretvalue123 exposée.\n\nPistes à vérifier\n\n- Aucune.' },
    ]);
    const options = baseOptions(root, callModel);
    options.securityPipeline = require('../security-pipeline');
    const result = await runAgentTurn(options);
    assert.ok(!/sk-live-supersecretvalue123/.test(result.response), 'la valeur du secret ne doit jamais être rendue');
    assert.match(result.response, /\.env:1/, 'la référence au fichier doit rester');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
