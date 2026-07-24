'use strict';

// Redaction happens at the tool boundary and again on the final answer. Models
// may inspect the shape of a sensitive configuration file, but they never need
// the secret value itself to determine whether the file is tracked or unsafe.
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|token|private[-_]?key|password)[^/]*)(?:$|\/)/i;
const SENSITIVE_KEY = /(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?key|encryption[-_]?key|auth[-_]?token|smtp[-_]?password)/i;

function masked(value) {
  const clean = String(value == null ? '' : value);
  if (!clean) return '[REDACTED]';
  return clean.length <= 6 ? '[REDACTED]' : `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
}

function redactAssignment(line, maskAllValues) {
  const match = String(line).match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)(.*)$/);
  if (!match || (!maskAllValues && !SENSITIVE_KEY.test(match[2]))) return line;
  const raw = match[4];
  const quote = /^(["']).*\1\s*$/.exec(raw.trim());
  const replacement = quote ? `${quote[1]}[REDACTED]${quote[1]}` : '[REDACTED]';
  return `${match[1]}${match[2]}${match[3]}${replacement}`;
}

function redactSecrets(value, { path = '', maskAllValues = false } = {}) {
  let text = String(value == null ? '' : value);
  const sensitiveFile = maskAllValues || SENSITIVE_PATH.test(String(path || '').replace(/\\/g, '/'));
  text = text.split(/(\r?\n)/).map((line) => /\r?\n/.test(line) ? line : redactAssignment(line, sensitiveFile)).join('');
  text = text
    .replace(/-----BEGIN [^-\n]+-----[\s\S]*?-----END [^-\n]+-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}=*/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|rk|pk|ghp|gho|github_pat|xox[abprs]|AIza)[-_A-Za-z0-9]{12,}\b/g, (token) => masked(token))
    .replace(/\b[A-Za-z0-9._-]*(?:secret|token|password|passwd|api[-_]?key)[A-Za-z0-9._=-]{6,}\b/gi, '[REDACTED]')
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2')
    .replace(new RegExp(`(["']?(?:${SENSITIVE_KEY.source})["']?\\s*:\\s*["'])([^"'\\n]+)(["'])`, 'gi'), '$1[REDACTED]$3');
  return text;
}

module.exports = { SENSITIVE_PATH, SENSITIVE_KEY, redactSecrets };
