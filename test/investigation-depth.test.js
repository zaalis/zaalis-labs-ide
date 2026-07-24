'use strict';

// Regression tests for the hybrid investigation pipeline: depth must scale with
// the repository, and a real report must NEVER be replaced by an empty shell.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildInvestigationPlan,
  investigationTodoSeed,
  createCoverageState,
  noteCoverageProgress,
  coverageSnapshot,
  hasEvidenceCitation,
  preserveDraftResponse,
  finalAnswerNeedsRetry,
  observeTool,
} = require('../investigation-controller');

function makeRepo(fileCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-inv-'));
  for (let i = 0; i < fileCount; i++) {
    const dir = path.join(root, i % 3 === 0 ? 'routes' : i % 3 === 1 ? 'auth' : 'db');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `mod${i}.js`),
      `// module ${i}\nfunction handler(req){ return db.query("SELECT * FROM t WHERE a='" + req.query.a + "'"); }\nmodule.exports={handler};\n`);
  }
  return root;
}

test('broad request scales depth with repository size', () => {
  const root = makeRepo(120);
  try {
    const broad = buildInvestigationPlan(root, { broad: true, readOnly: true });
    const narrow = buildInvestigationPlan(root, { broad: false, readOnly: true });
    // A broad audit must read a real share of the repo, not a token sample.
    assert.ok(broad.budget.minReads >= 14, `minReads too low: ${broad.budget.minReads}`);
    assert.ok(broad.budget.minReads > narrow.budget.minReads);
    assert.ok(broad.budget.maxRounds > narrow.budget.maxRounds);
    assert.ok(broad.candidates.length > narrow.candidates.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('depth floor never exceeds the number of relevant files', () => {
  const root = makeRepo(4);
  try {
    const plan = buildInvestigationPlan(root, { broad: true, readOnly: true });
    assert.ok(plan.budget.minReads <= Math.max(1, plan.scope.relevantFiles));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('todo seed covers the detected categories and ends with the report', () => {
  const root = makeRepo(20);
  try {
    const plan = buildInvestigationPlan(root, { broad: true, readOnly: true });
    const todos = investigationTodoSeed(plan, 'fr');
    assert.ok(todos.length >= 3);
    assert.strictEqual(todos[0].status, 'in_progress');
    assert.match(todos[todos.length - 1].content, /rapport final/i);
    assert.ok(investigationTodoSeed(plan, 'en').some((t) => /final report/i.test(t.content)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('citation detector accepts every common format, not just file:line', () => {
  assert.ok(hasEvidenceCitation('voir auth.go:42'));
  assert.ok(hasEvidenceCitation('dans auth.go ligne 42'));
  assert.ok(hasEvidenceCitation('app.js (L12)'));
  assert.ok(hasEvidenceCitation('ligne 42 de auth.go'));
  assert.ok(hasEvidenceCitation('see server.go line 7'));
  assert.ok(!hasEvidenceCitation('aucune reference ici'));
});

test('a real report is never replaced by the empty fallback', () => {
  const root = makeRepo(6);
  try {
    const state = createCoverageState(buildInvestigationPlan(root, { broad: true, readOnly: true }));
    state.readFiles.add('routes/mod0.js');
    const draft = 'Constats confirmés\n\n1. Injection SQL dans routes/mod0.js ligne 2.';
    const out = preserveDraftResponse(state, draft, 'format non reconnu', 'fr');
    assert.ok(out.includes('Injection SQL'), 'le constat doit survivre');
    assert.ok(!/Le v[ée]rificateur final n/.test(out), 'ne doit pas devenir la coquille vide');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('empty fallback is used only when there is genuinely no text', () => {
  const root = makeRepo(6);
  try {
    const state = createCoverageState(buildInvestigationPlan(root, { broad: true, readOnly: true }));
    const out = preserveDraftResponse(state, '   ', 'rien', 'fr');
    assert.match(out, /Constats confirm[ée]s/);
    assert.match(out, /Aucun constat confirm[ée]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a report citing "fichier ligne N" is no longer rejected', () => {
  // This exact shape used to be discarded and replaced by the empty report.
  const report = 'Constats confirmés\n\n1. XSS dans dashboard/js/app.js ligne 71.';
  assert.strictEqual(finalAnswerNeedsRetry(report, 'fr'), false);
});

test('stall detection stops nudging once nothing new is found', () => {
  const root = makeRepo(30);
  try {
    const state = createCoverageState(buildInvestigationPlan(root, { broad: true, readOnly: true }));
    state.readFiles.add('routes/mod0.js');
    assert.strictEqual(noteCoverageProgress(state), 0, 'progress resets the counter');
    assert.strictEqual(noteCoverageProgress(state), 1);
    assert.strictEqual(noteCoverageProgress(state), 2);
    assert.strictEqual(coverageSnapshot(state).stalled, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('evidence compaction keeps a digest instead of losing files', () => {
  const root = makeRepo(6);
  try {
    const state = createCoverageState(buildInvestigationPlan(root, { broad: true, readOnly: true }));
    for (let i = 0; i < 12; i++) {
      observeTool(state, { name: 'read', input: { paths: [`routes/mod${i}.js`] } },
        { summary: `read routes/mod${i}.js`, text: 'x'.repeat(7000) });
    }
    assert.ok(state.evidenceChars <= 42_000 + 7_000, 'live window stays bounded');
    assert.ok(state.compactedDigest.length > 0, 'aged-out evidence leaves a digest');
    assert.ok(state.compactedDigest.some((h) => /read routes\/mod/.test(h)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Robustness guarantees: a deep audit must ALWAYS end with a report -------
// Both scenarios below were real regressions observed on a 342-file repo once
// the depth target was raised: the evidence was collected but never written.
const { runAgentTurn } = require('../agent-engine');
const projectInspector = require('../project-inspector');

test('a malformed tool call late in an audit does not discard the evidence', async () => {
  const root = makeRepo(8);
  try {
    let call = 0;
    const result = await runAgentTurn({
      root, model: 'mistral', language: 'fr', projectInspector,
      message: 'Analyse toutes les failles de sécurité, ne modifie rien.',
      callModel: async () => {
        call++;
        if (call === 1) return { response: '```tool\n{"name":"read","input":{"paths":["routes/mod0.js","auth/mod1.js"]}}\n```' };
        // Two consecutive malformed calls used to kill the whole turn.
        if (call === 2 || call === 3) return { response: '{"name": "read" "input": broken' };
        return { response: 'Constats confirmés\n\n1. Injection SQL dans routes/mod0.js ligne 2. Sévérité : Critique. Remédiation : requête paramétrée.' };
      },
    });
    assert.ok(!/deux appels invalides/.test(result.response),
      `the turn must not die on malformed calls: ${result.response.slice(0, 120)}`);
    assert.match(result.response, /Injection SQL/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('running out of rounds still yields a written report, not silence', async () => {
  const root = makeRepo(200);
  try {
    let call = 0;
    let sawReportOnlyRound = false;
    const result = await runAgentTurn({
      root, model: 'mistral', language: 'fr', projectInspector,
      message: 'Analyse toutes les failles de sécurité, ne modifie rien.',
      callModel: async (payload) => {
        call++;
        // A model that never stops calling tools on its own.
        if (payload.nativeTools === false) {
          sawReportOnlyRound = true;
          return { response: 'Constats confirmés\n\n1. Injection SQL dans routes/mod0.js ligne 2. Sévérité : Critique. Remédiation : requête paramétrée.' };
        }
        return { response: '```tool\n{"name":"read","input":{"paths":["routes/mod' + (call % 60) + '.js"]}}\n```' };
      },
    });
    assert.ok(sawReportOnlyRound, 'the wrap-up must disable tools so the model can only write');
    assert.match(result.response, /Injection SQL/);
    assert.match(result.response, /Couverture/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
