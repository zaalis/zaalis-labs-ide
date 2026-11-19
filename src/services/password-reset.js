'use strict';

// Password reset: a single-use random token, stored only as its SHA-256 hash,
// valid 30 minutes. The IDE opens a temporary page in the default browser of
// this PC, where the new password is chosen.

const crypto = require('node:crypto');

const TTL_MS = 30 * 60 * 1000;
const RESEND_DELAY_MS = 10 * 1000;
const MIN_PASSWORD = 8;

const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

function createToken(now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, record: { hash: hashToken(token), expiresAt: now + TTL_MS, requestedAt: now } };
}

// The user whose pending reset matches this token, if still valid.
function findByToken(users, token, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(String(token || ''))) return null;
  const wanted = Buffer.from(hashToken(token), 'hex');
  return users.find((user) => {
    const pending = user && user.passwordReset;
    if (!pending || !pending.hash || Number(pending.expiresAt) <= now) return false;
    const stored = Buffer.from(String(pending.hash), 'hex');
    return stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted);
  }) || null;
}

function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD) return `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`;
  if (value.length > 200) return 'Le mot de passe est trop long (200 caractères au maximum).';
  if (!/[A-Za-zÀ-ÿ]/.test(value) || !/\d/.test(value)) return 'Le mot de passe doit contenir au moins une lettre et un chiffre.';
  return '';
}

module.exports = { TTL_MS, RESEND_DELAY_MS, MIN_PASSWORD, hashToken, createToken, findByToken, passwordProblem };
