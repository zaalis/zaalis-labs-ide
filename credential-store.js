'use strict';

// Session cookies must not be written to the CLI JSON state on macOS. Keychain
// is available without a dependency; other platforms retain the caller's
// encrypted/permissioned storage strategy and never broaden file permissions.
const { execFileSync } = require('child_process');

const SERVICE = 'zaalis-cli-session';
const ACCOUNT = process.env.USER || process.env.USERNAME || 'default';

function macSecurity(args) {
  try { return execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return ''; }
}

function loadCookie() {
  if (process.platform !== 'darwin') return '';
  return macSecurity(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
}

function saveCookie(value) {
  if (process.platform !== 'darwin') return false;
  const cookie = String(value || '').trim();
  if (!cookie) return clearCookie();
  try {
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', cookie], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

function clearCookie() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

module.exports = { loadCookie, saveCookie, clearCookie };
