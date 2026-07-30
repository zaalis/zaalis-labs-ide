'use strict';

// One neutral representation for provider-native calls. The server owns this
// catalogue: a model never gets arbitrary process or desktop capabilities.
const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'glob', description: 'List project files matching a glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, type: { type: 'string', enum: ['all', 'files', 'dirs'] }, max: { type: 'integer' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search text or a regular expression in project files.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, max: { type: 'integer' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'read', description: 'Read one or more project files.', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } } },
  { type: 'function', function: { name: 'edit', description: 'Apply one exact search/replace edit in a project file.', parameters: { type: 'object', properties: { path: { type: 'string' }, hunks: { type: 'array', items: { type: 'object', properties: { search: { type: 'string' }, replace: { type: 'string' } }, required: ['search', 'replace'] } } }, required: ['path', 'hunks'] } } },
  { type: 'function', function: { name: 'write', description: 'Write a complete project file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run', description: 'Run a project command and return its output.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'mcp_call', description: 'Call an explicitly configured MCP server tool. Use only a server and tool advertised in the task context.', parameters: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the public web (free, keyless) and return a list of results with title, URL and snippet. Use it when the answer depends on up-to-date or external information, then read the useful pages with web_fetch.', parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', description: 'Number of results, 1-15 (default 6).' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch one public web page (http/https) and return its readable text. Private and local addresses are blocked.', parameters: { type: 'object', properties: { url: { type: 'string' }, max: { type: 'integer', description: 'Maximum characters of text to return.' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'deep_search', description: 'Run a deep, multi-source web research on a question: it splits the question into sub-questions, searches and reads several pages per sub-question, then returns a synthesised, cited answer. Slower and heavier than web_search; use it only when the user asks for thorough or in-depth research.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The research question.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'todo', description: 'Publish or update the task plan so the user can follow the progress.', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content'] } } }, required: ['items'] } } },
  { type: 'function', function: { name: 'task', description: 'Delegate a self-contained piece of work to a sub-agent and get its report back.', parameters: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' } }, required: ['prompt'] } } },
  // The parameter names below must match normalizeAction() in
  // automation-manager.js exactly: anything it does not recognise makes the
  // whole action invalid, which the model sees only as "action invalide".
  { type: 'function', function: { name: 'computer', description: 'Inspect or operate the Windows desktop only when the user explicitly enabled computer control. Inspect first, then act, then inspect again to verify.', parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['observe', 'inspect', 'menus', 'move', 'click', 'scroll', 'type', 'key', 'activate_app', 'open_terminal'] },
    x: { type: 'number', description: 'Screen X for move/click, or region left for inspect.' },
    y: { type: 'number', description: 'Screen Y for move/click, or region top for inspect.' },
    button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button for click (default left).' },
    dx: { type: 'number', description: 'Horizontal scroll amount.' },
    dy: { type: 'number', description: 'Vertical scroll amount, negative scrolls down.' },
    text: { type: 'string', description: 'Text to type.' },
    key: { type: 'string', description: 'Single key for the key action, e.g. "enter", "n", "escape".' },
    modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'win'] }, description: 'Modifiers held during the key action.' },
    path: { type: 'string', description: 'Application to launch with activate_app, e.g. "notepad" or a full .exe path.' },
    target: { type: 'string', enum: ['active_window', 'display', 'region'], description: 'What inspect should capture.' },
    width: { type: 'number', description: 'Region width when target is region.' },
    height: { type: 'number', description: 'Region height when target is region.' }
  }, required: ['action'] } } }
];

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

function normaliseNativeCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls.map((call, index) => ({
    id: String(call && call.id || 'tool_' + (index + 1)),
    name: String(call && call.function && call.function.name || call && call.name || '').trim(),
    input: parseArguments(call && call.function ? call.function.arguments : call && call.arguments),
    provider: 'native'
  })).filter((call) => call.name);
}

function toolResultMessage(id, result) {
  const payload = {
    ok: !result.error && !result.blocked,
    blocked: !!result.blocked,
    summary: String(result.summary || result.name || ''),
    output: String(result.text || '').slice(0, 24000)
  };
  return { role: 'tool', tool_call_id: String(id), content: JSON.stringify(payload) };
}

module.exports = { TOOL_DEFINITIONS, normaliseNativeCalls, toolResultMessage };
