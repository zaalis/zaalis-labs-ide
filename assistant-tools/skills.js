'use strict';
const { fs, path, hash, fail, text, within, atomic } = require('./common');
class SkillTools {
  constructor(dataDir) { this.dataDir = dataDir; }
  roots(ctx) { return [path.join(ctx.root, '.zaalis', 'skills'), path.join(this.dataDir, 'rust-agentd', hash(ctx.userId), 'extensions', 'skills')]; }
  list(ctx) {
    const rows = [];
    for (const root of this.roots(ctx)) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 512)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = within(root, entry.name + '/SKILL.md');
        if (!fs.existsSync(file) || fs.statSync(file).size > 128000) continue;
        const content = fs.readFileSync(file, 'utf8');
        rows.push({ name: entry.name, description: (/^description:\s*["']?(.*)/m.exec(content)?.[1] || '').replace(/["']$/, ''), scope: root === this.roots(ctx)[0] ? 'project' : 'user', file });
      }
    }
    return rows;
  }
  run(name, input, ctx) {
    if (name === 'skills_list' || input.action === 'list') return { skills: this.list(ctx) };
    const skill = text(input.name, 'name', 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(skill)) throw fail('Invalid skill name.');
    const found = this.list(ctx).find(row => row.name === skill && (!input.scope || input.scope === row.scope));
    if (name === 'skill_view' || ['inspect', 'view', 'validate'].includes(input.action)) {
      if (!found) throw fail('Skill not found.', 'not_found', 404);
      const file = within(path.dirname(found.file), input.file || input.path || 'SKILL.md', true);
      if (fs.statSync(file).size > 128000) throw fail('Skill file too large.');
      const content = fs.readFileSync(file, 'utf8');
      return { ...found, file, content, valid: file !== found.file || valid(content, skill) };
    }
    const scope = input.scope || found?.scope || 'user', root = scope === 'project' ? this.roots(ctx)[0] : this.roots(ctx)[1];
    if (!['project', 'user'].includes(scope)) throw fail('Skill scope must be project or user.');
    fs.mkdirSync(root, { recursive: true });
    const dir = within(root, skill), file = path.join(dir, 'SKILL.md');
    if (['create', 'update', 'install'].includes(input.action)) {
      if (input.action === 'create' && fs.existsSync(file)) throw fail('Skill already exists.', 'conflict', 409);
      if (input.action === 'update' && !fs.existsSync(file)) throw fail('Skill not found.', 'not_found', 404);
      let content = text(input.content, 'content', 128000);
      if (!valid(content, skill)) throw fail('SKILL.md must have YAML front matter with name, description and instructions.');
      const resources = [];
      if (input.files) {
        if (typeof input.files !== 'object' || Array.isArray(input.files) || Object.keys(input.files).length > 64) throw fail('At most 64 explicit skill files.');
        for (const [relative, body] of Object.entries(input.files)) {
          const target = within(root, path.resolve(dir, relative));
          const normalized = process.platform === 'win32' ? target.toLowerCase() : target;
          const normalizedDir = process.platform === 'win32' ? dir.toLowerCase() : dir;
          if (!normalized.startsWith(normalizedDir + path.sep)) throw fail('Path outside the selected skill.');
          if ([file, path.join(dir, '.zaalis-owned')].some(v => (process.platform === 'win32' ? v.toLowerCase() : v) === normalized)) throw fail('Reserved skill filename.');
          resources.push([target, text(body, 'skill file', 128000)]);
        }
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
      fs.writeFileSync(path.join(dir, '.zaalis-owned'), 'assistant-skill-v1', { mode: 0o600 });
      for (const [target, body] of resources) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body, { mode: 0o600 }); }
      return { name: skill, scope, installed: true, valid: true };
    }
    if (['delete', 'uninstall'].includes(input.action)) {
      if (!fs.existsSync(file)) throw fail('Skill not found.', 'not_found', 404);
      if (!fs.existsSync(path.join(dir, '.zaalis-owned'))) throw fail('This skill was not installed by the manager; remove it manually.', 'ownership_required', 403);
      // Remove only our two files. Preserve user-created scripts/references.
      fs.unlinkSync(file); fs.unlinkSync(path.join(dir, '.zaalis-owned'));
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
      return { removed: skill };
    }
    throw fail('Unknown skill action. Installation uses explicit SKILL.md content; no unreviewed scripts are downloaded.');
  }
}
function valid(content, name) { return /^---\r?\n/.test(content) && new RegExp('^name:\\s*["\']?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\s*$', 'm').test(content) && /^description:\s*\S+/m.test(content) && content.split(/---/).slice(2).join('---').trim().length > 0; }
module.exports = { SkillTools, valid };
