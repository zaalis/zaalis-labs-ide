'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const controller = require('../investigation-controller');
const { redactSecrets } = require('../secret-redactor');
const { runAgentTurn } = require('../agent-engine');
const projectInspector = require('../project-inspector');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-investigation-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist-copy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"express":"1.0.0"}}\n');
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), 'function login(req) { return session.verify(req.headers.authorization); }\n');
  fs.writeFileSync(path.join(root, 'src', 'orders.js'), 'function order(req, db) { return db.query("SELECT * FROM orders WHERE id = ?", [req.params.id]); }\n');
  fs.writeFileSync(path.join(root, 'src', 'view.js'), 'function render(value) { element.textContent = value; }\n');
  fs.writeFileSync(path.join(root, 'src', 'files.js'), 'function upload(req) { return saveFile(req.body.name); }\n');
  fs.writeFileSync(path.join(root, 'dist-copy', 'generated.js'), 'eval(userInput);\n');
  return root;
}

test('natural security audits activate adaptive investigation but slash workflows do not', () => {
  const request = controller.detectInvestigation('Analyse toutes les failles de sécurité sans rien modifier');
  assert.equal(request.kind, 'security');
  assert.equal(request.broad, true);
  assert.equal(request.readOnly, undefined, 'natural phrasing must not become a permission mode');
  assert.equal(controller.detectInvestigation('/security deep'), null);
  assert.equal(controller.detectInvestigation('Corrige le bouton de connexion'), null);
});

test('local risk mapping excludes generated trees and keeps a bounded evidence budget', () => {
  const root = fixture();
  try {
    const plan = controller.buildInvestigationPlan(root, { broad: true, readOnly: true });
    assert.equal(plan.scope.inventoryTruncated, false);
    assert.ok(plan.scope.sourceFiles >= 4);
    assert.ok(plan.budget.minReads >= 1);
    assert.ok(plan.budget.maxRounds <= 12);
    assert.ok(plan.candidates.some((item) => item.path === 'src/auth.js'));
    assert.equal(plan.candidates.some((item) => item.path.startsWith('dist-copy/')), false);
    assert.ok(plan.exclusions.some((item) => item.path === 'dist-copy' && item.reason === 'generated_or_third_party'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('secret redaction covers dotenv, JSON, bearer tokens and final prose', () => {
  const source = [
    'SMTP_PASSWORD=very-secret-password',
    '{"api_token":"json-secret-value"}',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  ].join('\n');
  const safe = redactSecrets(source, { path: '.env' });
  assert.doesNotMatch(safe, /very-secret-password|json-secret-value|abcdefghijklmnopqrstuvwxyz/);
  assert.match(safe, /REDACTED/);
});

test('known speculative security claims are demoted from confirmed findings', () => {
  const report = `Constats confirmés

**1. Désactivation no-sandbox critique**
- Fichier:ligne : main.js:31
- Conditions : nécessite d'abord une faille Chromium distincte.

**2. Injection SQL confirmée**
- Fichier:ligne : api.js:42
- Source : req.query.id
- Sink : db.query("SELECT " + id)

Pistes à vérifier

- Vérifier les dépendances.

Couverture et limites

Analyse ciblée.`;
  const safe = controller.demoteSpeculativeFindings(report, 'fr');
  const confirmed = safe.slice(0, safe.indexOf('Pistes à vérifier'));
  const leads = safe.slice(safe.indexOf('Pistes à vérifier'));
  assert.doesNotMatch(confirmed, /no-sandbox/i);
  assert.match(confirmed, /Injection SQL confirmée/);
  assert.match(leads, /no-sandbox/i);
  assert.match(leads, /À valider/);
});

test('Mistral cannot finish a broad audit before coverage and evidence validation', async () => {
  const root = fixture();
  const prompts = [];
  const timeouts = [];
  const replies = [
    { response: 'J’ai trouvé toutes les failles de sécurité après une vérification rapide.' },
    {
      response: 'Je poursuis avec des preuves.',
      toolCalls: [
        { type: 'function', function: { name: 'audit', arguments: '{"action":"grep","pattern":"auth|query|upload|innerHTML","limit":50}' } },
        { type: 'function', function: { name: 'read', arguments: '{"paths":["src/auth.js","src/orders.js","src/view.js"]}' } },
      ],
    },
    { response: 'Brouillon : la requête SQL semble sûre et l’authentification reste à approfondir.' },
    { response: 'Je vais maintenant produire le rapport de sécurité final.' },
    { response: 'Constat confirmé : aucun sink SQL injectable observé dans src/orders.js:1. Piste : vérifier la politique de session dans src/auth.js:1.' },
  ];
  try {
    const result = await runAgentTurn({
      root,
      model: 'mistral',
      message: 'Analyse toutes les failles de sécurité sans rien modifier.',
      language: 'fr',
      projectInspector,
      callModel: async (payload) => {
        prompts.push(payload.message);
        timeouts.push(payload.timeoutMs);
        return replies.shift() || { response: 'Analyse partielle.' };
      },
    });
    assert.match(prompts[0], /INVESTIGATION SECURITE ADAPTATIVE/);
    assert.match(prompts[1], /objectif de profondeur/i);
    assert.match(prompts[2], /COUVERTURE DE PREUVES ATTEINTE/);
    assert.match(prompts[3], /REVUE ADVERSARIALE DES PREUVES/);
    // The review must instruct annotation, never deletion of evidenced findings.
    assert.match(prompts[3], /ANNOTE, NE SUPPRIME PAS/);
    assert.match(prompts[3], /spawn\/execFile.*sans shell/i);
    assert.match(prompts[3], /src\/orders\.js/);
    assert.match(prompts[4], /RAPPORT FINAL REQUIS/);
    // A broad audit carries a much larger context, so its per-call ceiling is
    // higher than the old flat 120s (which aborted healthy calls mid-thought).
    assert.ok(timeouts.every((value) => value === 240_000));
    assert.equal(result.investigation.ready, true);
    assert.ok(result.investigation.readCount >= 3);
    assert.match(result.response, /Couverture : ciblée et non exhaustive/);
    assert.doesNotMatch(result.response, /toutes les failles/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('adaptive investigations retry one transient model failure', async () => {
  const root = fixture();
  let calls = 0;
  const replies = [
    {
      response: 'Je collecte les preuves.',
      toolCalls: [
        { type: 'function', function: { name: 'audit', arguments: '{"action":"grep","pattern":"auth|query|upload","limit":50}' } },
        { type: 'function', function: { name: 'read', arguments: '{"paths":["src/auth.js","src/orders.js","src/files.js"]}' } },
      ],
    },
    { response: 'Brouillon étayé dans src/orders.js:1 et src/auth.js:1.' },
    { response: 'Constats confirmés\n\nAucun constat confirmé\n\nPistes à vérifier\n- src/auth.js:1\n\nCouverture et limites\nAnalyse ciblée.' },
  ];
  try {
    const result = await runAgentTurn({
      root,
      model: 'mistral',
      message: 'Analyse toutes les failles de sécurité sans rien modifier.',
      language: 'fr',
      projectInspector,
      callModel: async () => {
        calls++;
        if (calls === 1) throw new Error('temporary network failure');
        return replies.shift() || { response: 'Aucun constat confirmé.' };
      },
    });
    assert.ok(calls >= 4);
    assert.equal(result.error, undefined);
    assert.equal(result.investigation.ready, true);
    assert.match(result.response, /Aucun constat confirmé/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('direct reads and model answers never expose dotenv values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-secret-audit-'));
  const secret = 'smtp-super-secret-123456';
  fs.writeFileSync(path.join(root, '.env'), `SMTP_PASSWORD=${secret}\nPUBLIC_URL=https://example.test\n`);
  fs.writeFileSync(path.join(root, 'app.js'), 'const auth = request.headers.authorization;\n');
  const replies = [
    {
      response: 'Je vérifie sans afficher les valeurs.',
      toolCalls: [
        { type: 'function', function: { name: 'read', arguments: '{"paths":[".env","app.js"]}' } },
        { type: 'function', function: { name: 'audit', arguments: '{"action":"grep","pattern":"PASSWORD|authorization","limit":20}' } },
      ],
    },
    { response: `Le mot de passe ${secret} est exposé.` },
    { response: `Piste dans .env:1 : le mot de passe ${secret} doit être vérifié côté Git.` },
  ];
  try {
    const result = await runAgentTurn({
      root,
      model: 'mistral',
      message: 'Analyse les failles de sécurité du projet sans rien modifier.',
      language: 'fr',
      projectInspector,
      callModel: async () => replies.shift() || { response: 'Analyse partielle.' },
    });
    assert.ok(result.toolResults.length >= 2);
    assert.equal(JSON.stringify(result.toolResults).includes(secret), false);
    assert.equal(result.response.includes(secret), false);
    assert.match(result.response, /REDACTED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
