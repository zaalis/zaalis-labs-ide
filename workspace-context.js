'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function knownProjects(user, root) {
  const paths = [root, ...(user.recentProjects || [])].filter(Boolean);
  const seen = new Set();
  return paths.filter(value => {
    const key = path.resolve(value).toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(value => ({ path: path.resolve(value), name: path.basename(value), available: (() => {
    try { return fs.statSync(value).isDirectory(); } catch { return false; }
  })() }));
}

// Never use the installed executable's directory as the implicit workspace.
function agentRoot(body, user, fallbackRoot, conversation) {
  const explicit = body.root || body.projectRoot || conversation?.projectPath;
  const candidate = explicit || fallbackRoot || path.join(os.tmpdir(), 'zaalis-chat-workspaces', String(user.id || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!explicit) fs.mkdirSync(candidate, { recursive: true });
  const resolved = path.resolve(candidate);
  let available = false;
  try { available = fs.statSync(resolved).isDirectory(); } catch {}
  if (!available) throw Object.assign(new Error('Dossier de projet indisponible. Rouvrez le projet dans la navigation.'), { status: 400 });
  return resolved;
}

function selectProject(projects, target) {
  const requested = String(target || '').trim();
  const matches = projects.filter(project => project.path.toLocaleLowerCase() === requested.toLocaleLowerCase()
    || project.name.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (!matches.length) throw new Error('Projet inconnu. Utilisez workspace list pour consulter les projets connus.');
  if (matches.length !== 1) throw new Error('Plusieurs projets portent ce nom. Utilisez le chemin complet renvoyé par workspace list.');
  if (!matches[0].available) throw new Error('Le dossier de ce projet a été déplacé ou supprimé.');
  return matches[0].path;
}

module.exports = { knownProjects, agentRoot, selectProject };
