const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runAgentTurn,
  extractToolRequests,
  nativeComputerCallsAsText,
} = require('../agent-engine');

test('Mistral native computer calls are converted to the validated tool protocol', () => {
  const text = nativeComputerCallsAsText('', [{
    type: 'function',
    function: { name: 'computer', arguments: '{"action":"activate_app","path":"/System/Applications/Notes.app"}' },
  }]);
  assert.deepEqual(extractToolRequests(text, process.cwd()), [{
    name: 'computer',
    input: { action: 'activate_app', path: '/System/Applications/Notes.app' },
  }]);
});

test('native computer calls from Claude, Gemini and Ollama share the same protocol', () => {
  const variants = [
    { type: 'tool_use', name: 'computer', input: { action: 'key', key: 't', modifiers: ['cmd'] } },
    { functionCall: { name: 'computer', args: { action: 'type', text: 'restaurants Marseille' } } },
    { type: 'function', function: { name: 'computer', arguments: { action: 'key', key: 'return' } } },
  ];
  const text = nativeComputerCallsAsText('', variants);
  assert.deepEqual(extractToolRequests(text, process.cwd()).map((tool) => tool.input), [
    { action: 'key', key: 't', modifiers: ['cmd'] },
    { action: 'type', text: 'restaurants Marseille' },
    { action: 'key', key: 'return' },
  ]);
});

test('computer control retries prose-only Mistral output and really executes the requested steps', async () => {
  const modelReplies = [
    'Je vais ouvrir Notes, observer, créer une note et écrire hello world.',
    '```tool\n{"name":"computer","input":{"action":"activate_app","path":"/System/Applications/Notes.app"}}\n```',
    '```tool\n{"name":"computer","input":{"action":"observe"}}\n```',
    '```tool\n{"name":"computer","input":{"action":"key","key":"n","modifiers":["cmd"]}}\n```',
    '```tool\n{"name":"computer","input":{"action":"type","text":"hello world"}}\n```',
    'Notes est ouvert et « hello world » a été écrit.',
  ];
  const calls = [];
  const result = await runAgentTurn({
    root: process.cwd(),
    model: 'mistral',
    message: 'controle le pc et ouvre les note et ecrite hello world',
    language: 'fr',
    callModel: async (payload) => {
      assert.equal(payload.computerTools, true);
      return { response: modelReplies.shift() };
    },
    computerSession: { state: 'running' },
    computerControl: {
      execute: async (_session, input) => {
        calls.push(input);
        return { name: 'computer', summary: `computer ${input.action}`, text: `Action ${input.action} effectuée.` };
      },
    },
  });

  assert.deepEqual(calls, [
    { action: 'activate_app', path: '/System/Applications/Notes.app' },
    { action: 'observe' },
    { action: 'key', key: 'n', modifiers: ['cmd'] },
    { action: 'type', text: 'hello world' },
  ]);
  assert.equal(result.response, 'Notes est ouvert et « hello world » a été écrit.');
  assert.equal(result.toolResults.length, 4);
});

test('computer control breaks activate/observe loops and reaches the keyboard action', async () => {
  const modelReplies = [
    '```tool\n{"name":"computer","input":{"action":"activate_app","path":"/System/Applications/Notes.app"}}\n```',
    '```tool\n{"name":"computer","input":{"action":"observe"}}\n```',
    '```tool\n{"name":"computer","input":{"action":"activate_app","path":"/System/Applications/Notes.app"}}\n```',
    '```tool\n{"name":"computer","input":{"action":"observe"}}\n```',
    '```tool\n{"name":"computer","input":{"action":"key","key":"n","modifiers":["cmd"]}}\n```',
    '```tool\n{"name":"computer","input":{"action":"type","text":"hello world"}}\n```',
    'Terminé.',
  ];
  const executed = [];
  const result = await runAgentTurn({
    root: process.cwd(),
    model: 'mistral',
    message: 'contrôle le pc, ouvre Notes et écris hello world',
    language: 'fr',
    callModel: async () => ({ response: modelReplies.shift() }),
    computerSession: { state: 'running' },
    computerControl: {
      execute: async (_session, input) => {
        executed.push(input.action);
        return { name: 'computer', summary: `computer ${input.action}`, text: 'ok' };
      },
    },
  });
  assert.deepEqual(executed, ['activate_app', 'observe', 'key', 'type']);
  assert.equal(result.response, 'Terminé.');
  assert.match(result.toolResults[2].summary, /ignoré/);
  assert.match(result.toolResults[3].summary, /ignoré/);
});

test('computer control can execute a complete Chrome tab and search sequence', async () => {
  const actions = [
    { action: 'activate_app', path: '/Applications/Google Chrome.app' },
    { action: 'key', key: 't', modifiers: ['cmd'] },
    { action: 'key', key: 'l', modifiers: ['cmd'] },
    { action: 'type', text: 'meilleurs restaurants Marseille' },
    { action: 'key', key: 'return' },
  ];
  const replies = actions.map((input) => `\`\`\`tool\n${JSON.stringify({ name: 'computer', input })}\n\`\`\``).concat('Recherche lancée dans un nouvel onglet.');
  const executed = [];
  const result = await runAgentTurn({
    root: process.cwd(),
    model: 'local',
    message: 'ouvre un nouvel onglet Google Chrome et cherche les meilleurs restaurants de Marseille',
    language: 'fr',
    callModel: async () => ({ response: replies.shift() }),
    computerSession: { state: 'running' },
    computerControl: {
      execute: async (_session, input) => {
        executed.push(input);
        return { name: 'computer', summary: `computer ${input.action}`, text: 'ok' };
      },
    },
  });
  assert.deepEqual(executed, actions);
  assert.equal(result.response, 'Recherche lancée dans un nouvel onglet.');
});
