'use strict';

const crypto = require('crypto');
const { MUTATING_TOOLS, READ_ONLY_TOOLS } = require('./agent-contracts');

const DECISIONS = Object.freeze(['allow', 'ask', 'deny']);
const APPROVAL_TTL_MS = 2 * 60_000;

function normaliseRules(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = { allow: [], ask: [], deny: [] };
  for (const key of Object.keys(out)) {
    const rows = Array.isArray(source[key]) ? source[key] : [];
    out[key] = Array.from(new Set(rows.map((row) => String(row || '').trim()).filter(validRule))).slice(0, 200);
  }
  return out;
}

function validRule(rule) {
  return /^[A-Za-z]+(?:\([^\n()]+\))?$/.test(String(rule || '').trim());
}

function toolKind(tool) {
  const value = String(tool || '').toLowerCase();
  if (value === 'run') return 'bash';
  if (value === 'edit') return 'edit';
  if (value === 'write' || value === 'image_download') return 'write';
  if (value === 'browser') return 'browser';
  if (value === 'git') return 'git';
  if (value === 'git_write') return 'git';
  if (value === 'computer') return 'computer';
  if (value === 'brain') return 'mcp';
  if (value === 'mcp') return 'mcp';
  if (value === 'lsp') return 'read';
  if (value === 'audit') return 'read';
  return 'read';
}

function ruleValue(tool, input) {
  const safe = input && typeof input === 'object' ? input : {};
  if (tool === 'run') return String(safe.command || '');
  if (tool === 'brain') return String(safe.tool || '');
  return String(safe.path || safe.url || safe.action || '');
}

function matchesRule(rule, tool, input) {
  const match = String(rule || '').trim().match(/^([A-Za-z]+)(?:\((.*)\))?$/);
  if (!match) return false;
  const expected = match[1].toLowerCase();
  if (expected !== 'all' && expected !== toolKind(tool)) return false;
  const spec = String(match[2] || '').trim();
  if (!spec) return true;
  const actual = ruleValue(tool, input);
  return spec.endsWith('*') ? actual.startsWith(spec.slice(0, -1)) : actual === spec;
}

function ruleDecision(tool, input, rules) {
  const policy = normaliseRules(rules);
  // Deny is terminal and intentionally wins over all other matching rules.
  if (policy.deny.some((rule) => matchesRule(rule, tool, input))) return 'deny';
  if (policy.allow.some((rule) => matchesRule(rule, tool, input))) return 'allow';
  if (policy.ask.some((rule) => matchesRule(rule, tool, input))) return 'ask';
  return '';
}

// Deliberately NARROWER than the redactor's SENSITIVE_PATH: this gates an
// approval prompt, so it must match real secret-bearing files (.env, keys,
// credential dumps) WITHOUT catching ordinary source like password_reset.go or
// token_service.js. Over-matching here would turn normal reads into approvals.
const SECRET_FILE = /(?:^|[\\/])(?:\.env(?:\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\.(?:json|ya?ml))?|client_secret[^\\/]*\.json|service[-_]?account[^\\/]*\.json|[^\\/]*\.(?:pem|key|pfx|p12|keystore|jks|asc|ppk))$/i;
// A command that reads or writes one of those files (cat .env, cp id_rsa …).
const SECRET_FILE_IN_CMD = /(?:^|[\s"'=<>|(])(?:\.env(?:\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|id_rsa|id_dsa|id_ecdsa|id_ed25519|[^\s"']+\.(?:pem|key|pfx|p12|keystore|jks|ppk))(?=$|[\s"'/<>|)])/i;

// Reading or modifying a secret file is a privileged action on every guarded
// mode; only the unrestricted mode lets the agent touch it without a human.
function touchesSecretFile(tool, input) {
  const safe = input && typeof input === 'object' ? input : {};
  if (tool === 'run') return SECRET_FILE_IN_CMD.test(String(safe.command || ''));
  const targets = [];
  if (safe.path) targets.push(safe.path);
  if (safe.destination) targets.push(safe.destination);
  if (Array.isArray(safe.paths)) targets.push(...safe.paths);
  return targets.some((value) => SECRET_FILE.test(String(value || '').replace(/\\/g, '/')));
}

// Permission ladder (mirrors Claude Code's tiers):
//   read-only / plan : read & search only, never write or run.
//   supervised       : commands run freely; any file write asks first.
//   semi             : broad autonomy; only sensitive actions ask.
//   auto             : autonomous; everything except truly destructive/publish
//                      commands (handled by the engine) runs without asking.
//   bypass           : NO restriction — reads/writes secrets in clear, no prompt.
function evaluate({ tool, input, mode = 'supervised', rules } = {}) {
  const name = String(tool || '').toLowerCase();
  const matched = ruleDecision(name, input, rules);
  if (matched === 'deny') return { decision: 'deny', reason: 'refusé par règle de permission', terminal: true };
  if (matched === 'allow') return { decision: 'allow', reason: 'autorisé par règle' };
  if (matched === 'ask') return { decision: 'ask', reason: 'validation requise par règle' };

  const readOnly = READ_ONLY_TOOLS.has(name);
  const mutating = MUTATING_TOOLS.has(name);
  if (!readOnly && !mutating) return { decision: 'deny', reason: 'outil non reconnu', terminal: true };

  // Hard mode gate first: plan / read-only forbid every mutation outright, and
  // this must win over the softer secret-file "ask" below.
  if (mutating && (mode === 'plan' || mode === 'read-only')) {
    return { decision: 'deny', reason: `mode ${mode}`, terminal: true };
  }

  // Secret files (.env, private keys, credentials) require explicit approval on
  // every mode EXCEPT the unrestricted one — reading and writing alike.
  if (mode !== 'bypass' && touchesSecretFile(name, input)) {
    return { decision: 'ask', reason: 'fichier sensible : validation requise' };
  }

  if (readOnly) return { decision: 'allow', reason: 'outil lecture seule' };

  // Mutating tools, non-sensitive, on a mode that allows some autonomy.
  if (mode === 'bypass') return { decision: 'allow', reason: 'mode sans restriction' };
  if (mode === 'auto') return { decision: 'allow', reason: 'mode autonome' };
  if (mode === 'semi') return { decision: 'allow', reason: 'mode semi-auto' };
  if (mode === 'supervised') {
    // Commands run freely; anything that writes a file asks first.
    if (name === 'run') return { decision: 'allow', reason: 'commande autorisée (supervisé)' };
    return { decision: 'ask', reason: 'écriture de fichier : validation requise' };
  }
  return { decision: 'ask', reason: 'validation requise' };
}

function hashPayload({ sessionId, callId, tool, input }) {
  return crypto.createHash('sha256').update(JSON.stringify({ sessionId, callId, tool, input })).digest('hex');
}

class ApprovalStore {
  constructor({ ttlMs = APPROVAL_TTL_MS } = {}) { this.ttlMs = ttlMs; this.records = new Map(); }

  issue({ sessionId, callId, tool, input, userId, context } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const record = {
      id: `approval_${crypto.randomUUID()}`,
      token,
      userId: String(userId || ''),
      payloadHash: hashPayload({ sessionId, callId, tool, input }),
      expiresAt: Date.now() + this.ttlMs,
      used: false,
      context: context && typeof context === 'object' ? context : {},
    };
    this.records.set(record.id, record);
    return { approvalId: record.id, token, expiresAt: new Date(record.expiresAt).toISOString() };
  }

  consume({ approvalId, token, sessionId, callId, tool, input, userId }) {
    const record = this.records.get(String(approvalId || ''));
    if (!record || record.used || record.expiresAt < Date.now()) return { ok: false, reason: 'approbation absente ou expirée' };
    const supplied = Buffer.from(String(token || ''));
    const expected = Buffer.from(record.token);
    if (!token || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return { ok: false, reason: 'jeton d’approbation invalide' };
    if (record.userId !== String(userId || '') || record.payloadHash !== hashPayload({ sessionId, callId, tool, input })) return { ok: false, reason: 'approbation non liée à cette action' };
    record.used = true;
    return { ok: true, context: record.context };
  }

  prune() {
    const now = Date.now();
    for (const [key, value] of this.records) if (value.used || value.expiresAt < now) this.records.delete(key);
  }
}

module.exports = { DECISIONS, APPROVAL_TTL_MS, normaliseRules, validRule, matchesRule, ruleDecision, evaluate, touchesSecretFile, SECRET_FILE, ApprovalStore };
