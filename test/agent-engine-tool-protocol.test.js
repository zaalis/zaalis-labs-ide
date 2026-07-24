'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runAgentTurn,
  extractToolRequests,
  stripToolBlocks,
} = require('../agent-engine');

const root = process.cwd();

test('tool-named JSON fences are accepted for every registered tool', () => {
  const cases = [
    ['audit', { action: 'inventory', limit: 5000 }],
    ['git', { action: 'status' }],
    ['lsp', { action: 'diagnostics', path: 'server.js' }],
    ['web_fetch', { url: 'https://example.com' }],
  ];
  for (const [name, input] of cases) {
    const raw = `\`\`\`${name}\n${JSON.stringify(input)}\n\`\`\``;
    const calls = extractToolRequests(raw, root);
    assert.equal(calls.length, 1, `${name} should be decoded exactly once`);
    assert.equal(calls[0].name, name);
    assert.equal(stripToolBlocks(raw), '');
  }
});

test('Mistral bare inventory JSON is inferred only as the unique passive audit tool', () => {
  const raw = '{"action":"inventory","limit":5000}';
  const calls = extractToolRequests(raw, root);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'audit');
  assert.deepEqual(calls[0].input, {
    action: 'inventory', pattern: '', includeIgnored: false, cursor: 0, limit: 5000,
  });
  assert.equal(stripToolBlocks(raw), '');
});

test('bare ambiguous or mutating JSON is never inferred as an executable tool', () => {
  assert.deepEqual(extractToolRequests('{"url":"https://example.com"}', root), []);
  assert.deepEqual(extractToolRequests('{"path":"owned.txt","content":"no"}', root), []);
  assert.deepEqual(extractToolRequests('{"command":"touch owned.txt"}', root), []);
});

test('the exact Mistral audit transcript executes instead of leaking JSON into chat', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-mistral-audit-'));
  fs.writeFileSync(path.join(temp, 'sample.js'), 'const ok = true;\n');
  const replies = [
    '```audit\n{"action":"inventory","limit":5000}\n```',
    'Inventaire terminé : un fichier JavaScript a été inspecté.',
  ];
  try {
    const result = await runAgentTurn({
      root: temp,
      model: 'mistral',
      message: 'Fais maintenant l’inventaire complet, sans rien modifier.',
      language: 'fr',
      projectInspector: require('../project-inspector'),
      callModel: async () => ({ response: replies.shift() }),
    });
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0].tool, 'audit');
    assert.match(result.toolResults[0].summary, /audit inventory/);
    assert.equal(result.response, 'Inventaire terminé : un fichier JavaScript a été inspecté.');
    assert.doesNotMatch(result.response, /"action"\s*:/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('provider-native Mistral tool calls stay structured across the agent boundary', async () => {
  const replies = [
    {
      response: 'Je lance l’inventaire.',
      toolCalls: [{
        id: 'call_audit_1',
        type: 'function',
        function: { name: 'audit', arguments: '{"action":"inventory","limit":10}' },
      }],
    },
    { response: 'Inventaire natif terminé.' },
  ];
  const result = await runAgentTurn({
    root,
    model: 'mistral',
    message: 'Inventorie le projet.',
    language: 'fr',
    projectInspector: require('../project-inspector'),
    callModel: async () => replies.shift(),
  });
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].tool, 'audit');
  assert.equal(result.response, 'Inventaire natif terminé.');
});

test('an agent can continue beyond six useful tool rounds before it finishes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-long-agent-'));
  const replies = [];
  try {
    for (let index = 0; index < 8; index++) {
      const name = `evidence-${index}.txt`;
      fs.writeFileSync(path.join(temp, name), `proof ${index}\n`);
      replies.push({ response: '', toolCalls: [{ type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: [name] }) } }] });
    }
    replies.push({ response: 'Les huit éléments ont été vérifiés ; analyse terminée.' });
    const result = await runAgentTurn({
      root: temp,
      model: 'mistral',
      message: 'Lis toutes les preuves puis fais la synthèse.',
      language: 'fr',
      callModel: async () => replies.shift(),
    });
    assert.equal(result.toolResults.length, 8);
    assert.match(result.response, /huit éléments ont été vérifiés/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('an agent stops repeated tool batches and asks for a final synthesis', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-stalled-agent-'));
  const repeated = { response: '', toolCalls: [{ type: 'function', function: { name: 'read', arguments: '{"paths":["same.txt"]}' } }] };
  const replies = [repeated, repeated, repeated, { response: 'Je n’ai plus de nouvelle preuve : la même lecture avait déjà réussi.' }];
  try {
    fs.writeFileSync(path.join(temp, 'same.txt'), 'unchanged\n');
    const result = await runAgentTurn({
      root: temp,
      model: 'mistral',
      message: 'Analyse ce fichier.',
      language: 'fr',
      callModel: async () => replies.shift(),
    });
    assert.equal(result.toolResults.length, 2);
    assert.match(result.response, /plus de nouvelle preuve/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a normal chat cannot start the central security review', async () => {
  const result = await runAgentTurn({
    root,
    model: 'mistral',
    message: 'Analyse toutes les failles de sécurité du projet sans rien modifier.',
    language: 'fr',
    securityReviewStart: () => { throw new Error('must not be called'); },
    callModel: async () => ({
      response: 'Je peux faire une analyse de code en lecture seule, mais la revue centrale nécessite /security.',
      toolCalls: [{ type: 'function', function: { name: 'security', arguments: '{"action":"deep"}' } }],
    }),
  });
  assert.equal(result.toolResults.length, 0);
  assert.match(result.response, /aucun constat.*confirm/i);
  assert.doesNotMatch(result.response, /reviewId|securityReviewId/i);
});

test('a valid LSP tool call normalizes its path before execution', async () => {
  const replies = [
    { response: '```lsp\n{"action":"diagnostics","path":"server.js"}\n```' },
    { response: 'Aucun diagnostic bloquant.' },
  ];
  const seen = [];
  const result = await runAgentTurn({
    root,
    model: 'mistral',
    message: 'Vérifie les diagnostics de server.js.',
    language: 'fr',
    languageService: {
      diagnostics(input) { seen.push(input); return []; },
    },
    callModel: async () => replies.shift(),
  });
  assert.equal(result.toolResults[0].tool, 'lsp');
  assert.equal(seen[0].path, 'server.js');
  assert.equal(result.response, 'Aucun diagnostic bloquant.');
});

test('a malformed tool-shaped response is retried once and never shown as the final answer', async () => {
  const replies = [
    '```audit\n{"action":\n```',
    '```tool\n{"name":"audit","input":{"action":"inventory","limit":10}}\n```',
    'Audit terminé proprement.',
  ];
  const prompts = [];
  const result = await runAgentTurn({
    root,
    model: 'mistral',
    message: 'Inspecte le projet.',
    language: 'fr',
    projectInspector: require('../project-inspector'),
    callModel: async (payload) => {
      prompts.push(payload.message);
      return { response: replies.shift() };
    },
  });
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.response, 'Audit terminé proprement.');
  assert.match(prompts[1], /appel d.outil.*invalide/i);
});

test('nested Mistral tool syntax is rejected instead of becoming shell commands', async () => {
  const malformed = [
    '```run',
    '```tool',
    '{"name":"run","input":{"command":"find . -name \\"*.go\\""}}',
    '```',
    '```',
  ].join('\n');
  assert.deepEqual(extractToolRequests(malformed, root), []);

  const brokerCalls = [];
  const prompts = [];
  const replies = [
    malformed,
    '```tool\n{"name":"audit","input":{"action":"inventory","limit":10}}\n```',
    'Inventaire terminé proprement.',
  ];
  const result = await runAgentTurn({
    root,
    model: 'mistral',
    message: 'Inspecte le projet.',
    language: 'fr',
    projectInspector: require('../project-inspector'),
    executionBroker: {
      run: async (input) => {
        brokerCalls.push(input);
        return { exitCode: 0, stdout: '', stderr: '', sandbox: 'test' };
      },
    },
    callModel: async (payload) => {
      prompts.push(payload.message);
      return { response: replies.shift() };
    },
  });
  assert.equal(brokerCalls.length, 0, 'protocol JSON must never reach the shell');
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].tool, 'audit');
  assert.match(prompts[1], /appel d.outil.*invalide/i);
});

test('glob limits matches after traversal and matches patterns relative to path', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-glob-limit-'));
  const source = path.join(temp, 'server', 'src');
  fs.mkdirSync(source, { recursive: true });
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(source, `a-${String(i).padStart(3, '0')}.txt`), 'x');
  fs.writeFileSync(path.join(source, 'handler.go'), 'package main\n');
  const replies = [
    '```tool\n{"name":"glob","input":{"pattern":"*.go","path":"server/src","type":"files","max":5}}\n```',
    'Fichier Go trouvé.',
  ];
  try {
    const result = await runAgentTurn({
      root: temp,
      model: 'mistral',
      message: 'Trouve les fichiers Go.',
      language: 'fr',
      callModel: async () => ({ response: replies.shift() }),
    });
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0].tool, 'glob');
    assert.match(result.toolResults[0].text, /server\/src\/handler\.go/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('natural no-modification phrasing never overrides the selected autonomous mode', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-auto-phrase-'));
  fs.writeFileSync(path.join(temp, 'app.js'), 'const safe = true;\n');
  const brokerCalls = [];
  let turn = 0;
  try {
    const result = await runAgentTurn({
      root: temp,
      model: 'mistral',
      message: 'Analyse toutes les failles de sécurité, ne modifie rien, analyse juste.',
      language: 'fr',
      permissionMode: 'auto',
      projectInspector: require('../project-inspector'),
      executionBroker: {
        run: async (input) => {
          brokerCalls.push(input);
          return { exitCode: 0, stdout: 'app.js', stderr: '', sandbox: 'test' };
        },
      },
      callModel: async () => {
        turn++;
        if (turn === 1) {
          return {
            response: 'Je vérifie le dépôt.',
            toolCalls: [{ type: 'function', function: { name: 'run', arguments: '{"command":"find . -name \\"*.js\\""}' } }],
          };
        }
        if (turn === 2) {
          return {
            response: 'Je lis la preuve.',
            toolCalls: [{ type: 'function', function: { name: 'read', arguments: '{"paths":["app.js"]}' } }],
          };
        }
        return { response: 'Constats confirmés\n\nAucun constat confirmé.\n\nPistes à vérifier\nAucune.\n\nCouverture et limites\napp.js:1 inspecté.' };
      },
    });
    assert.equal(brokerCalls.length, 1);
    assert.equal(result.toolResults[0].tool, 'run');
    assert.equal(result.toolResults[0].blocked, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('no-modification wording has no hidden effect on mutation intent detection', async () => {
  const prompts = [];
  const replies = [
    { response: 'Je prépare le fichier.' },
    { response: 'Action non exécutée dans ce test.' },
  ];
  await runAgentTurn({
    root,
    model: 'mistral',
    message: 'Crée result.txt, ne modifie rien.',
    permissionMode: 'auto',
    callModel: async (payload) => {
      prompts.push(payload.message);
      return replies.shift();
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /implique de creer ou modifier/i);
});

test('tool history is protocol-neutral for every provider', async () => {
  for (const model of ['codex', 'mistral', 'kimi']) {
    const payloads = [];
    const replies = [
      {
        response: '',
        toolCalls: [{ type: 'function', function: { name: 'read', arguments: '{"paths":["package.json"]}' } }],
      },
      { response: 'Lecture terminée.' },
    ];
    const result = await runAgentTurn({
      root,
      model,
      message: 'Lis package.json.',
      callModel: async (payload) => {
        payloads.push(payload);
        return replies.shift();
      },
    });
    assert.equal(result.response, 'Lecture terminée.');
    const replayedAssistant = payloads[1].history.find((item) => item.role === 'assistant');
    assert.match(replayedAssistant.content, /Appels outils structurés/);
    assert.doesNotMatch(replayedAssistant.content, /```|"\s*name\s*":/);
  }
});
