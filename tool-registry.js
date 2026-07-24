'use strict';

// One catalogue drives provider function calling, validation and capability
// disclosure. Keep schemas deliberately small: every tool still validates paths
// and values again at execution time.
const definitions = [
  ['todo', 'Maintient le plan de travail de la tâche.', { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, content: { type: 'string' } }, required: ['content'], additionalProperties: false }, maxItems: 30 } }, required: ['items'], additionalProperties: false }],
  ['task', 'Délègue une investigation ciblée à un sous-agent.', { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' }, profile: { type: 'string' } }, required: ['prompt'], additionalProperties: false }],
  ['read', 'Lit des fichiers du projet.', { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 } }, required: ['paths'], additionalProperties: false }],
  ['glob', 'Liste des fichiers du projet correspondant à un motif.', { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, type: { type: 'string', enum: ['all', 'files', 'dirs'] }, max: { type: 'integer', minimum: 1, maximum: 5000 } }, additionalProperties: false }],
  ['grep', 'Recherche un motif dans les fichiers du projet.', { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['pattern'], additionalProperties: false }],
  ['audit', 'Inspecte exhaustivement le projet avec pagination et exclusions explicites.', { type: 'object', properties: { action: { type: 'string', enum: ['inventory', 'glob', 'grep'] }, pattern: { type: 'string' }, includeIgnored: { type: 'boolean' }, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } }, required: ['action'], additionalProperties: false }],
  ['git', 'Interroge Git de façon structurée.', { type: 'object', properties: { action: { type: 'string', enum: ['status', 'diff', 'log', 'branch', 'show', 'blame', 'history', 'worktree_list', 'conflicts'] }, path: { type: 'string' }, ref: { type: 'string' }, base: { type: 'string' }, scope: { type: 'string', enum: ['all', 'staged', 'unstaged'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['action'], additionalProperties: false }],
  ['git_write', 'Exécute une opération Git modifiante approuvée.', { type: 'object', properties: { action: { type: 'string', enum: ['branch_create', 'worktree_create', 'commit', 'push'] }, branch: { type: 'string' }, remote: { type: 'string' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: 100 } }, required: ['action'], additionalProperties: false }],
  ['edit', 'Applique des remplacements exacts dans un fichier.', { type: 'object', properties: { path: { type: 'string' }, hunks: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: { search: { type: 'string' }, replace: { type: 'string' } }, required: ['search', 'replace'], additionalProperties: false } } }, required: ['path', 'hunks'], additionalProperties: false }],
  ['write', 'Crée ou remplace un fichier du projet.', { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }],
  ['run', 'Exécute une commande isolée dans le projet.', { type: 'object', properties: { command: { type: 'string' }, network: { type: 'boolean' }, write: { type: 'boolean' } }, required: ['command'], additionalProperties: false }],
  ['browser', 'Ouvre une URL dans le navigateur Zaalis.', { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }],
  ['web_fetch', 'Lit une page Web autorisée sans modifier le projet.', { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'integer', minimum: 100, maximum: 50000 } }, required: ['url'], additionalProperties: false }],
  ['image_search', 'Recherche une image sous licence ouverte.', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['query'], additionalProperties: false }],
  ['image_download', 'Télécharge une image déjà validée vers le projet.', { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' } }, required: ['id', 'path'], additionalProperties: false }],
  ['brain', 'Appelle un outil MCP autorisé.', { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool'], additionalProperties: false }],
  ['mcp', 'Appelle un outil d’un serveur MCP explicitement configuré.', { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool'], additionalProperties: false }],
  ['lsp', 'Interroge le service de langage du projet.', { type: 'object', properties: { action: { type: 'string', enum: ['symbols', 'diagnostics', 'definition', 'references', 'rename'] }, path: { type: 'string' }, symbol: { type: 'string' }, replacement: { type: 'string' } }, required: ['action'], additionalProperties: false }],
  ['computer', 'Contrôle macOS dans une session explicitement autorisée.', { type: 'object', properties: { action: { type: 'string', enum: ['observe', 'menus', 'move', 'click', 'scroll', 'type', 'key', 'open_terminal', 'activate_app'] }, path: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, duration: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, dx: { type: 'integer' }, dy: { type: 'integer' }, text: { type: 'string' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' }, maxItems: 4 } }, required: ['action'], additionalProperties: false }],
].map(([name, description, parameters]) => Object.freeze({ name, description, parameters }));

const byName = Object.freeze(Object.fromEntries(definitions.map((tool) => [tool.name, tool])));
const TOOL_CATALOG = Object.freeze(Object.fromEntries(definitions.map((tool) => [tool.name, { readOnly: ['todo', 'task', 'read', 'glob', 'grep', 'audit', 'git', 'browser', 'image_search', 'brain', 'mcp', 'lsp', 'computer', 'web_fetch'].includes(tool.name) }])));

function openAIFunctionTools({ computerOnly = false } = {}) {
  const list = computerOnly ? [byName.computer] : definitions;
  return list.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

function anthropicTools({ computerOnly = false } = {}) {
  const list = computerOnly ? [byName.computer] : definitions;
  return list.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}

function geminiTools({ computerOnly = false } = {}) {
  const list = computerOnly ? [byName.computer] : definitions;
  const withoutAdditionalProperties = (value) => {
    if (Array.isArray(value)) return value.map(withoutAdditionalProperties);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, item]) => [key, withoutAdditionalProperties(item)]));
  };
  return [{ functionDeclarations: list.map((tool) => {
    return { name: tool.name, description: tool.description, parameters: withoutAdditionalProperties(tool.parameters) };
  }) }];
}

module.exports = { TOOL_DEFINITIONS: definitions, TOOL_CATALOG, byName, openAIFunctionTools, anthropicTools, geminiTools };
