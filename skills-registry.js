'use strict';

const fs = require('fs');
const path = require('path');

function safeRead(file, max = 128 * 1024) {
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size <= max ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

function manifestFor(dir) {
  const raw = safeRead(path.join(dir, 'skill.json'), 32 * 1024);
  try { const data = JSON.parse(raw); return data && typeof data === 'object' ? data : {}; } catch { return {}; }
}

function discover(root) {
  const base = path.resolve(root || process.cwd());
  const locations = [path.join(base, '.zaalis', 'skills'), path.join(base, 'skills')];
  const found = [];
  for (const location of locations) {
    let entries = []; try { entries = fs.readdirSync(location, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._-]{1,80}$/.test(entry.name)) continue;
      const dir = path.join(location, entry.name); const file = path.join(dir, 'SKILL.md'); const instructions = safeRead(file);
      if (!instructions.trim()) continue;
      const manifest = manifestFor(dir);
      found.push({
        id: entry.name,
        name: String(manifest.name || entry.name).slice(0, 120),
        description: String(manifest.description || instructions.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#')) || '').trim().slice(0, 300),
        version: String(manifest.version || '0.0.0').slice(0, 40),
        tools: Array.isArray(manifest.tools) ? manifest.tools.map((item) => String(item).slice(0, 80)).slice(0, 50) : [],
        dependencies: Array.isArray(manifest.dependencies || manifest.dependsOn) ? (manifest.dependencies || manifest.dependsOn).map((item) => String(item || '').trim()).filter((item) => /^[A-Za-z0-9._-]{1,80}$/.test(item)).slice(0, 50) : [],
        location: path.relative(base, dir).split(path.sep).join('/'),
        instructions,
      });
    }
  }
  const ids = new Set(found.map((skill) => skill.id));
  return found.map((skill) => ({ ...skill, missingDependencies: skill.dependencies.filter((item) => !ids.has(item)), enabled: skill.dependencies.every((item) => ids.has(item)) })).sort((a, b) => a.name.localeCompare(b.name));
}

function promptContext(root, maxChars = 16000) {
  const chunks = []; let remaining = maxChars;
  for (const skill of discover(root)) {
    if (!skill.enabled) continue;
    if (remaining <= 0) break;
    const head = `[SKILL ${skill.id} · ${skill.name}]\n${skill.instructions}`;
    const part = head.slice(0, remaining); chunks.push(part); remaining -= part.length;
  }
  return chunks.join('\n\n');
}

module.exports = { discover, promptContext };
