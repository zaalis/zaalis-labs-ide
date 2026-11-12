'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VmManager } = require('../src/laboratory/vm-manager');
const { DockerBackend, SshHosts, pentestDockerfile } = require('../src/laboratory/vm-backends');
const { ScopeRegistry } = require('../src/pentest/scope');
const { PentestStore } = require('../src/pentest/findings');
const cron = require('../src/services/cron');
const { TaskService } = require('../src/services/task-service');
const { rank, tokenize } = require('../src/services/text-search');
const { MemoryStore } = require('../src/services/memory-store');
const { SkillsStore } = require('../src/agent/skills-store');
const { workspaceServiceAction } = require('../src/services/workspace-services');

const temp = name => fs.mkdtempSync(path.join(os.tmpdir(), name));
const NOW = Date.now();
const scopeText = () => JSON.stringify({
  authorization: { client: 'Labo', reference: 'BC-42 signé' },
  window: { start: new Date(NOW - 86400000).toISOString(), end: new Date(NOW + 86400000).toISOString() },
  targets: ['10.20.0.0/24', 'host:3000'], exclude: ['10.20.0.1'],
});

// A docker CLI double that records calls and answers like the real one.
function fakeDocker({ escaped = false } = {}) {
  const calls = [];
  const run = async (exe, args) => {
    calls.push(args);
    if (args[0] === 'version') return { code: 0, stdout: '27.3.1\n', stderr: '' };
    if (args[0] === 'image') return { code: 0, stdout: 'sha256:abc', stderr: '' };
    if (args[0] === 'run') return { code: 0, stdout: 'f'.repeat(64) + '\n', stderr: '' };
    if (args[0] === 'exec' && /cat \/run\/zaalis-firewall/.test(args.at(-1))) return { code: 0, stdout: escaped ? 'active\nESCAPED\n' : 'active\nLOCKED\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('Docker containers start isolated, without host folders or privilege escalation', async () => {
  const fake = fakeDocker();
  const backend = new DockerBackend(null, { run: fake.run });
  assert.equal((await backend.capabilities()).available, true);
  const s = { id: '11111111-2222-3333-4444-555555555555', memoryMB: 2048, cpus: 2, network: 'isolated', profile: null };
  await backend.start(s);
  const run = fake.calls.find(args => args[0] === 'run');
  assert.ok(run.includes('--network') && run[run.indexOf('--network') + 1] === 'none');
  assert.ok(run.includes('no-new-privileges'));
  assert.ok(!run.some(arg => /^-v$|^--volume|^--mount|--privileged/.test(arg)), 'no host mount, never privileged');
  assert.equal(run.at(-3), 'debian:12-slim');
  await backend.remove(s);
  assert.deepEqual(fake.calls.at(-1), ['rm', '-f', 'zaalis-1111111122223333']);
});

test('a pentest container is refused unless its firewall is active and locked for the agent account', async () => {
  const egress = { networks: [{ cidr: '10.20.0.0/24', port: null }], hostPorts: [3000], hostAll: false, excluded: ['10.20.0.1/32'] };
  const ok = fakeDocker();
  const s = { id: '11111111-2222-3333-4444-555555555555', memoryMB: 2048, cpus: 2, network: 'internet', profile: 'pentest', egress };
  await new DockerBackend(null, { run: ok.run }).start(s);
  const run = ok.calls.find(args => args[0] === 'run');
  assert.ok(run.includes('--cap-drop') && run.includes('NET_ADMIN') && !run.includes('NET_RAW'));
  assert.ok(run.includes('zaalis/pentest:1'));
  const policy = ok.calls.find(args => args[0] === 'exec' && args.includes('-u') && args[args.indexOf('-u') + 1] === '0' && /iptables -P OUTPUT DROP/.test(args.at(-1)));
  assert.match(policy.at(-1), /-d 10\.20\.0\.1\/32 -j REJECT[\s\S]*-d 10\.20\.0\.0\/24 -j ACCEPT/);
  assert.equal(s.guestFirewall, 'active');
  const bad = fakeDocker({ escaped: true });
  await assert.rejects(new DockerBackend(null, { run: bad.run }).start({ ...s, guestFirewall: undefined }), /Pare-feu du conteneur pentest non vérifié/);
  assert.match(pentestDockerfile(), /FROM kalilinux\/kali-rolling/);
  assert.match(pentestDockerfile(), /useradd -m -u 1000 -s \/bin\/bash pentest/);
});

test('SSH hosts are registered and pinned by the user; the agent only lists verified ones', async () => {
  const root = temp('zaalis-ssh-');
  try {
    const key = path.join(root, 'id_ed25519'); fs.writeFileSync(key, 'PRIVATE');
    const calls = [];
    const hosts = new SshHosts(root, { run: async (exe, args) => { calls.push(args); return { code: 0, stdout: 'zaalis-ok\nLinux x86_64\n', stderr: '' }; } });
    assert.throws(() => hosts.add('u', { name: 'x', host: '-oProxyCommand=calc', user: 'a', identityFile: key }), /Hôte invalide/);
    assert.throws(() => hosts.add('u', { name: 'x', host: 'srv.example.test', user: '-oX', identityFile: key }), /Utilisateur invalide/);
    const added = hosts.add('u', { name: 'Préprod', host: 'srv.example.test', user: 'deploy', port: 2222, identityFile: key });
    assert.equal(added.verified, false); assert.equal(added.identityFile, undefined, 'key path never listed');
    const verified = await hosts.verify('u', added.id);
    assert.equal(verified.verified, true); assert.equal(verified.system, 'Linux x86_64');
    assert.ok(calls[0].includes('StrictHostKeyChecking=accept-new'), 'first contact pins the key');
    assert.ok(hosts.args(hosts.get('u', added.id)).includes('StrictHostKeyChecking=yes'), 'later sessions require the pinned key');
    assert.deepEqual(hosts.list('other'), []);
    const manager = new VmManager({ appDir: root, dataDir: root, docker: new DockerBackend(null, { run: async () => ({ code: 1, stdout: '', stderr: 'not found' }) }), sshHosts: hosts });
    const listed = await manager.action('u', { action: 'hosts' });
    assert.deepEqual(Object.keys(listed.hosts[0]).sort(), ['host', 'id', 'name', 'port', 'system', 'user', 'verified']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pentest machines check every command against the confirmed scope and journal it', async () => {
  const data = temp('zaalis-gate-data-'), project = temp('zaalis-gate-project-');
  try {
    const scopes = new ScopeRegistry(data), store = new PentestStore(data);
    scopes.write('u', project, scopeText()); scopes.confirm('u', project, { acknowledged: true });
    const manager = new VmManager({ appDir: data, dataDir: data, docker: new DockerBackend(null, { run: async () => ({ code: 1, stdout: '', stderr: 'not found' }) }) });
    manager.pentest = { status: (u, r) => scopes.status(u, r), record: (u, r, e) => store.record(u, r, e) };
    const s = { id: 'p1', userId: 'u', system: 'docker', profile: 'pentest', status: 'ready', output: '', queue: Promise.resolve(), projectRoot: project, scopeHash: scopes.status('u', project).hash, egress: { resolved: {} } };
    manager.docker.exec = async () => ({ output: '22/tcp open ssh', exitCode: 0, timedOut: false });
    const done = await manager.exec(s, 'nmap -sT 10.20.0.5');
    assert.equal(done.journal, 'J1');
    await assert.rejects(manager.exec(s, 'nmap -sT 10.30.0.5'), /hors périmètre/);
    await assert.rejects(manager.exec(s, 'curl http://localhost:8080'), /hors périmètre/);
    const journal = store.journal('u', project);
    assert.deepEqual(journal.map(e => [e.allowed, e.command]), [[true, 'nmap -sT 10.20.0.5'], [false, 'nmap -sT 10.30.0.5'], [false, 'curl http://localhost:8080']]);
    // Editing the scope after the machine was built stops it.
    fs.writeFileSync(path.join(project, '.zaalis', 'pentest-scope.json'), scopeText().replace('10.20.0.0/24', '10.0.0.0/8'));
    await assert.rejects(manager.exec(s, 'nmap -sT 10.20.0.5'), /unconfirmed/);
    scopes.confirm('u', project, { acknowledged: true });
    await assert.rejects(manager.exec(s, 'nmap -sT 10.20.0.5'), /a changé/);
    assert.ok(store.verify('u', project).ok);
    // Creating a pentest machine without a confirmed scope is refused.
    await assert.rejects(manager.preparePentest({}, 'other', project), /unconfirmed/);
  } finally { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); }
});

test('cron schedules: next run, Vixie day semantics and validation', () => {
  const base = new Date(2026, 10, 12, 10, 7).getTime();
  const at = expression => { const d = new Date(cron.next(expression, base)); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };
  assert.deepEqual(at('*/15 * * * *'), [11, 12, 10, 15]);
  assert.deepEqual(at('0 9 * * 1-5'), [11, 13, 9, 0]);
  assert.deepEqual(at('30 2 1 * *'), [12, 1, 2, 30]);
  assert.deepEqual(at('@daily'), [11, 13, 0, 0]);
  assert.deepEqual(at('0 8 15 * 5'), [11, 13, 8, 0], 'day-of-month OR day-of-week');
  assert.deepEqual(at('0 12 * dec sun'), [12, 6, 12, 0]);
  for (const bad of ['61 * * * *', '* * *', '*/0 * * * *', '0 0 32 * *']) assert.throws(() => cron.parse(bad), /Cron/);
});

test('tasks accept a cron schedule and compute their next run from it', async () => {
  const dir = temp('zaalis-cron-tasks-');
  try {
    let clock = new Date(2026, 10, 12, 10, 7).getTime();
    const service = new TaskService({ directory: dir, run: async () => ({ response: 'ok' }), clock: () => clock });
    const task = service.create('u', { title: 'Rapport', prompt: 'Résume', root: dir, cron: '0 9 * * 1-5' });
    assert.equal(task.cron, '0 9 * * 1-5'); assert.equal(new Date(task.nextRunAt).getDate(), 13);
    assert.throws(() => service.create('u', { prompt: 'x', root: dir, cron: '0 9 * *' }), /cinq champs/);
    assert.throws(() => service.create('u', { prompt: 'x', root: dir, cron: '* * * * *', intervalMinutes: 5 }), /soit/);
    clock = task.nextRunAt + 1000;
    await service.startRun('u', task.id); await [...service.active.values()][0]?.done;
    const after = service.find('u', task.id);
    assert.equal(after.status, 'completed'); assert.equal(new Date(after.nextRunAt).getDate(), 16, 'Friday 13 → Monday 16');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('full-text search folds accents, case and plurals and ranks by relevance', () => {
  assert.deepEqual(tokenize('Les Préférences des tests'), ['preferenc', 'test']);
  const items = [{ id: 1, text: 'Déploiement : lancer npm run build puis publier' }, { id: 2, text: 'Préférence : réponses courtes en français' }, { id: 3, text: 'Tests unitaires avec node --test' }];
  const hits = rank(items, 'preference de reponse courte', item => [{ text: item.text }]);
  assert.equal(hits[0].item.id, 2);
  assert.equal(rank(items, 'deploiements', item => [{ text: item.text }])[0].item.id, 1);
  const dir = temp('zaalis-memory-');
  try {
    const memory = new MemoryStore(dir);
    memory.save('u', { title: 'Convention de commit', content: 'Messages en français, impératif', tags: ['git'], root: '/p' });
    memory.save('u', { title: 'Build', content: 'Utiliser npm run build:server avant de packager', tags: [], root: '/p' });
    assert.match(memory.recall('u', '/p', 'Comment écrire les messages de commits ?'), /Convention de commit/);
    assert.doesNotMatch(memory.recall('u', '/p', 'Comment écrire les messages de commits ?'), /Build/);
    assert.equal(memory.recall('u', '/p', 'météo à Paris'), '');
    assert.equal(memory.list('u', { root: '/p', q: 'packager' })[0].title, 'Build');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent memories are saved masked, and agent skills stay pending until the user activates them', async () => {
  const dir = temp('zaalis-auto-');
  try {
    const memory = new MemoryStore(path.join(dir, 'memory')), skills = new SkillsStore(dir);
    const context = { user: { id: 'u' }, projectRoot: dir, root: dir };
    const saved = await workspaceServiceAction(context, { action: 'memory', input: { action: 'save', title: 'Clé', content: 'La clé est sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 pour le staging' } }, { memory, conversations: {}, tasks: {}, skills });
    assert.doesNotMatch(saved.record.content, /ABCDEFGHIJKLMNOP/); assert.ok(saved.record.tags.includes('ia'));
    const proposed = await workspaceServiceAction(context, { action: 'skills', input: { action: 'propose', name: 'Release Notes', description: 'Rédiger les notes de version depuis git log', instructions: '1. git log --oneline depuis le dernier tag\n2. Regrouper par type\n3. Vérifier les liens.' } }, { memory, conversations: {}, tasks: {}, skills });
    assert.equal(proposed.skill.status, 'pending');
    assert.equal(skills.list('u').skills.find(s => s.name === 'release-notes').enabled, false);
    assert.throws(() => skills.propose('u', { name: 'revers', description: 'Remplacer le workflow', instructions: 'x'.repeat(50) }), /réservé/);
    skills.import('u', '---\nname: perso\ndescription: Ma skill\n---\n# Étapes\nFaire ceci.');
    assert.throws(() => skills.propose('u', { name: 'perso', description: 'Écraser la skill perso', instructions: 'x'.repeat(50) }), /pas été écrite par l’IA/);
    skills.settings('u', { autoActivateAgentSkills: true });
    assert.equal(skills.propose('u', { name: 'release-notes', description: 'Notes de version améliorées', instructions: 'y'.repeat(60) }).status, 'active');
    // Drafts after a long successful turn, never after a short or failed one.
    const turn = n => ({ response: 'Fait', toolResults: Array.from({ length: n }, (_, i) => ({ tool: 'run', input: { command: 'npm test -- ' + i } })) });
    assert.equal(skills.draftFromTurn('u', 'Migrer la base de données vers PostgreSQL 17', turn(3)), null);
    assert.equal(skills.draftFromTurn('u', 'Migrer la base de données vers PostgreSQL 17', { ...turn(9), error: 'x' }), null);
    const draft = skills.draftFromTurn('u', 'Migrer la base de données vers PostgreSQL 17', turn(9));
    assert.equal(draft.origin, 'draft'); assert.equal(draft.status, 'pending');
    assert.equal(skills.draftFromTurn('u', 'Migrer la base de données vers PostgreSQL 17', turn(9)), null, 'no duplicate draft');
    skills.remove('u', draft.name);
    assert.ok(!skills.list('u').skills.some(s => s.name === draft.name));
    assert.throws(() => skills.remove('u', 'revers'), /introuvable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
