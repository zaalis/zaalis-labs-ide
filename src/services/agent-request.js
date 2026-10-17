'use strict';
const { EventEmitter } = require('node:events');

// Internal calls use the same authenticated HTTP handler as the desktop. The
// caller supplies an actual account resolved by the server, never a user id
// from a task body. Decisions stay in the normal interactive session bridge.
async function runAgentRequest(handler, user, input, onEvent = () => {}) {
  if (!user) throw new Error('Compte de la tâche introuvable.');
  const request = new EventEmitter(), response = new EventEmitter();
  Object.assign(request, { user, body: { ...input, stream: true, persistTurn: true }, headers: { accept: 'application/x-ndjson' } });
  let result, failure, status = 200;
  Object.assign(response, {
    status(code) { status = code; return response; },
    setHeader() {}, flushHeaders() {},
    write(line) {
      const event = JSON.parse(line);
      if (event.type === 'done') result = event.result;
      else if (event.type === 'error') failure = event.error;
      else onEvent(event);
    },
    end() { response.writableEnded = true; },
    json(value) { result = value; response.writableEnded = true; },
  });
  const abort = () => request.emit('aborted');
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (input.signal?.aborted) throw new Error('Tâche annulée.');
    await handler(request, response);
    if (failure || result?.error || status >= 400) throw Object.assign(new Error(failure || result?.error || `Erreur ${status}`), { status });
    return result;
  } finally { input.signal?.removeEventListener('abort', abort); }
}
module.exports = { runAgentRequest };
