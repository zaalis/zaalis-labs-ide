'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentTurn, nativeComputerCallsAsText } = require('../agent-engine');

test('preserves Mistral native tool-call correlation across desktop actions', async () => {
  const nativeToolCalls = [{
    id: 'mistral-call-1',
    type: 'function',
    function: { name: 'computer', arguments: '{"action":"activate_app","path":"notepad.exe"}' },
  }];
  const requests = [];
  const events = [];
  const computerSession = { state: 'running' };
  const result = await runAgentTurn({
    root: process.cwd(),
    model: 'mistral',
    message: 'Ouvre Notes.',
    computerControl: { execute: async () => ({ name: 'computer', summary: 'computer activate_app', text: 'Application activee.' }) },
    computerSession,
    emitEvent: (event) => events.push(event),
    callModel: async (payload) => {
      requests.push(payload);
      if (requests.length === 1) {
        return {
          response: nativeComputerCallsAsText('', nativeToolCalls),
          nativeToolCalls,
          nativeAssistantMessage: { role: 'assistant', content: null, tool_calls: nativeToolCalls },
        };
      }
      return { response: 'Notes est ouverte.' };
    },
  });

  assert.equal(result.response, 'Notes est ouverte.');
  assert.equal(result.toolResults.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].message, '');
  assert.equal(requests[1].continueAfterToolResult, true);
  assert.ok(events.some((event) => event.type === 'agent_log' && /Appel envoye/.test(event.message)));
  assert.ok(events.some((event) => event.type === 'final_response'));
  const history = requests[1].history;
  const toolResult = history.find((message) => message.role === 'tool');
  assert.deepEqual(toolResult, {
    role: 'tool',
    name: 'computer',
    tool_call_id: 'mistral-call-1',
    content: JSON.stringify({ ok: true, summary: 'computer activate_app', result: 'Application activee.' }),
  });
  const nativeAssistant = history.find((message) => Array.isArray(message.tool_calls));
  assert.equal(nativeAssistant.role, 'assistant');
  assert.deepEqual(nativeAssistant.tool_calls, nativeToolCalls);
});

test('reports a provider diagnostic to the chat stream when a model request fails', async () => {
  const events = [];
  const result = await runAgentTurn({
    root: process.cwd(),
    model: 'mistral',
    submodel: 'mistral-medium-3-5',
    message: 'Ouvre Notes.',
    callModel: async () => { throw new Error('HTTP 400: invalid tool result'); },
    emitEvent: (event) => events.push(event),
  });

  assert.match(result.error, /mistral\/mistral-medium-3-5 \| tour 1/i);
  assert.match(result.error, /HTTP 400: invalid tool result/);
  assert.ok(events.some((event) => event.type === 'error' && /Actions PC executees/.test(event.error)));
});
