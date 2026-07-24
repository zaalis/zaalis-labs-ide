'use strict';

const PROFILES = Object.freeze({
  explorer: { label: 'Explorateur', tools: ['read', 'glob', 'grep', 'audit', 'git'], maxRounds: 5, timeoutMs: 90_000 },
  reviewer: { label: 'Relecteur de diff', tools: ['read', 'glob', 'grep', 'audit', 'git'], maxRounds: 5, timeoutMs: 90_000 },
  secrets: { label: 'Spécialiste secrets', tools: ['read', 'glob', 'grep', 'audit', 'git'], maxRounds: 4, timeoutMs: 90_000 },
  dependencies: { label: 'Spécialiste dépendances', tools: ['read', 'glob', 'grep', 'audit', 'run', 'git'], maxRounds: 5, timeoutMs: 120_000 },
  source_to_sink: { label: 'Analyste source-to-sink', tools: ['read', 'glob', 'grep', 'audit', 'git'], maxRounds: 6, timeoutMs: 120_000 },
  validator: { label: 'Validateur', tools: ['read', 'glob', 'grep', 'audit', 'git', 'run'], maxRounds: 5, timeoutMs: 120_000 },
  fixer: { label: 'Développeur correctif', tools: ['read', 'glob', 'grep', 'audit', 'git', 'edit', 'write', 'run'], maxRounds: 6, timeoutMs: 120_000 },
  verifier: { label: 'Vérificateur de tests', tools: ['read', 'glob', 'grep', 'audit', 'run', 'git'], maxRounds: 5, timeoutMs: 120_000 },
});

function profile(name) { return PROFILES[String(name || 'explorer').toLowerCase()] || PROFILES.explorer; }
function formatProfilePrompt(name) { const p = profile(name); return `Profil: ${p.label}. Outils autorisés: ${p.tools.join(', ')}. Ne dépasse jamais le périmètre de ta mission et fournis des preuves, des fichiers et un niveau de confiance.`; }

module.exports = { PROFILES, profile, formatProfilePrompt };
