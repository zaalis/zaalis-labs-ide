'use strict';

// Lightweight, dependency-free language service. It gives every install useful
// symbols/diagnostics and can later hand off to a native LSP server when one is
// configured, without changing the UI/API contract.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'server-data', 'dist', 'build']);
function inside(root, target) { const rel = path.relative(root, target); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); }
function target(root, relative) { const file = path.resolve(root, relative || ''); if (!inside(root, file)) throw new Error('Chemin hors projet refusé.'); return file; }
function text(file) { return fs.readFileSync(file, 'utf8'); }
function linesFor(content, re, kind) { const out = []; let m; while ((m = re.exec(content))) out.push({ name: m[1], kind, line: content.slice(0, m.index).split(/\r?\n/).length, column: m[0].indexOf(m[1]) + 1 }); return out; }

function symbols({ root, file }) {
  const base = path.resolve(root); const full = target(base, file); const content = text(full);
  return [
    ...linesFor(content, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 'function'),
    ...linesFor(content, /\bclass\s+([A-Za-z_$][\w$]*)/g, 'class'),
    ...linesFor(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'variable'),
    ...linesFor(content, /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, 'type'),
  ].sort((a, b) => a.line - b.line);
}

function diagnostics({ root, file }) {
  const base = path.resolve(root); const full = target(base, file); const ext = path.extname(full).toLowerCase();
  if (!['.js', '.cjs', '.mjs'].includes(ext)) return [];
  const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8', timeout: 15000 });
  if (!result.status) return [];
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const line = Number((raw.match(/:(\d+)(?::\d+)?\s*$/m) || [])[1] || 1);
  return [{ severity: 'error', message: raw.slice(-2000) || 'Erreur de syntaxe JavaScript.', line, column: 1, source: 'node --check' }];
}

function walk(root, max = 20000) {
  const out = []; const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop(); let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) { if (SKIP.has(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) stack.push(full); else if (entry.isFile()) out.push(full); }
  }
  return out;
}

function references({ root, symbol, limit = 500 }) {
  const base = path.resolve(root); const re = new RegExp(`\\b${String(symbol || '').replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')}\\b`, 'g'); const out = [];
  for (const file of walk(base)) {
    if (out.length >= limit || fs.statSync(file).size > 1024 * 1024) continue;
    let content = ''; try { content = text(file); } catch { continue; }
    let m; while ((m = re.exec(content)) && out.length < limit) out.push({ file: path.relative(base, file).split(path.sep).join('/'), line: content.slice(0, m.index).split(/\r?\n/).length, column: m.index - content.lastIndexOf('\n', m.index - 1) });
  }
  return out;
}

function definition({ root, symbol }) { return references({ root, symbol, limit: 100 }).find((row) => { try { return new RegExp(`\\b(?:function|class|const|let|var|interface|type|enum)\\s+${String(symbol).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')}\\b`).test(text(target(root, row.file))); } catch { return false; } }) || null; }
function renamePlan({ root, symbol, replacement }) { if (!/^[A-Za-z_$][\w$]*$/.test(String(replacement || ''))) throw new Error('Identifiant de remplacement invalide.'); return { symbol, replacement, edits: references({ root, symbol, limit: 5000 }) }; }

module.exports = { symbols, diagnostics, references, definition, renamePlan };
