'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate, ApprovalStore } = require('../permission-policy');
const { ExecutionBroker } = require('../execution-broker');
const { SessionStore } = require('../session-store');
const security = require('../security-pipeline');
const inspector = require('../project-inspector');
const { openAIFunctionTools, geminiTools } = require('../tool-registry');

test('deny policy is terminal and wins over allow or approval modes', () => {
  const rules = { allow: ['Bash(npm test*)'], ask: ['Bash(*)'], deny: ['Bash(npm test:delete*)'] };
  assert.equal(evaluate({ tool: 'run', input: { command: 'npm test' }, mode: 'supervised', rules }).decision, 'allow');
  const denied = evaluate({ tool: 'run', input: { command: 'npm test:delete-now' }, mode: 'auto', rules });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.terminal, true);
  assert.equal(evaluate({ tool: 'run', input: { command: 'npm run lint' }, mode: 'auto', rules: { ask: ['Bash(npm run lint)'] } }).decision, 'ask');
});

test('supervised runs commands freely but asks before writing files', () => {
  assert.equal(evaluate({ tool: 'run', input: { command: 'npm test' }, mode: 'supervised' }).decision, 'allow');
  assert.equal(evaluate({ tool: 'write', input: { path: 'src/app.js' }, mode: 'supervised' }).decision, 'ask');
  assert.equal(evaluate({ tool: 'edit', input: { path: 'src/app.js' }, mode: 'supervised' }).decision, 'ask');
});

test('semi is broadly autonomous but asks for a secret file', () => {
  assert.equal(evaluate({ tool: 'write', input: { path: 'src/app.js' }, mode: 'semi' }).decision, 'allow');
  assert.equal(evaluate({ tool: 'run', input: { command: 'go build ./...' }, mode: 'semi' }).decision, 'allow');
  assert.equal(evaluate({ tool: 'write', input: { path: '.env' }, mode: 'semi' }).decision, 'ask');
  assert.equal(evaluate({ tool: 'read', input: { paths: ['.env'] }, mode: 'auto' }).decision, 'ask');
});

test('reading a secret asks on every mode except the unrestricted one', () => {
  for (const mode of ['supervised', 'semi', 'auto']) {
    assert.equal(evaluate({ tool: 'read', input: { paths: ['config/.env.production'] }, mode }).decision, 'ask');
    assert.equal(evaluate({ tool: 'run', input: { command: 'cat .env' }, mode }).decision, 'ask');
  }
  // Unrestricted mode: reads and edits the secret without a prompt.
  assert.equal(evaluate({ tool: 'read', input: { paths: ['.env'] }, mode: 'bypass' }).decision, 'allow');
  assert.equal(evaluate({ tool: 'write', input: { path: '.env' }, mode: 'bypass' }).decision, 'allow');
  assert.equal(evaluate({ tool: 'run', input: { command: 'cat .env' }, mode: 'bypass' }).decision, 'allow');
});

test('the secret-file guard does not catch ordinary source files', () => {
  for (const mode of ['supervised', 'semi', 'auto']) {
    assert.equal(evaluate({ tool: 'read', input: { paths: ['auth-system/password_reset.go'] }, mode }).decision, 'allow');
    assert.equal(evaluate({ tool: 'read', input: { paths: ['credential-store.js'] }, mode }).decision, 'allow');
  }
  // plan/read-only still forbid every mutation, secret or not.
  assert.equal(evaluate({ tool: 'write', input: { path: '.env' }, mode: 'plan' }).decision, 'deny');
  assert.equal(evaluate({ tool: 'write', input: { path: 'a.js' }, mode: 'read-only' }).terminal, true);
});

test('approval token is single-use and bound to exact call arguments', () => {
  const store = new ApprovalStore({ ttlMs: 1000 });
  const issued = store.issue({ sessionId: 's', callId: 'c', tool: 'run', input: { command: 'npm test' }, userId: 'u' });
  assert.equal(store.consume({ approvalId: issued.approvalId, token: issued.token, sessionId: 's', callId: 'c', tool: 'run', input: { command: 'npm run test' }, userId: 'u' }).ok, false);
  assert.equal(store.consume({ approvalId: issued.approvalId, token: issued.token, sessionId: 's', callId: 'c', tool: 'run', input: { command: 'npm test' }, userId: 'u' }).ok, true);
  assert.equal(store.consume({ approvalId: issued.approvalId, token: issued.token, sessionId: 's', callId: 'c', tool: 'run', input: { command: 'npm test' }, userId: 'u' }).ok, false);
});

test('execution broker sanitises inherited environment and isolates temp writes', async (t) => {
  const broker = new ExecutionBroker({ timeoutMs: 10_000 });
  if (broker.backend() === 'none') return t.skip('No sandbox backend on this platform.');
  const result = await broker.run({ command: 'test -z "$ZAALIS_TEST_SECRET" && printf "$HOME" && printf x > "$TMPDIR/probe" && cat "$TMPDIR/probe"', root: process.cwd(), write: false });
  assert.equal(result.exitCode, 0);
  assert.equal(result.sandboxed, true);
  assert.match(result.stdout, /x$/);
});

test('filesystem broker writes atomically and rejects symlink escape paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-filesystem-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-outside-test-'));
  try {
    const broker = new ExecutionBroker();
    const write = broker.writeFile({ root, path: 'nested/file.txt', content: 'first' });
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'file.txt'), 'utf8'), 'first');
    assert.equal(write.sandbox, 'filesystem-broker');
    broker.editFile({ root, path: 'nested/file.txt', hunks: [{ search: 'first', replace: 'second' }] });
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'file.txt'), 'utf8'), 'second');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.throws(() => broker.writeFile({ root, path: 'escape/leak.txt', content: 'nope' }), /symbolique/);
    assert.equal(fs.existsSync(path.join(outside, 'leak.txt')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('session store persists an indexed session with append-only events and forks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-session-test-'));
  try {
    const store = new SessionStore({ dataDir: dir });
    const first = store.create({ userId: 'user', cwd: process.cwd(), title: 'Session source', model: 'codex' });
    store.append(first.id, { type: 'message', role: 'user', content: 'bonjour' });
    const fork = store.fork(first.id, 'user', { title: 'Branche' });
    assert.equal(store.list({ userId: 'user' }).length, 2);
    assert.equal(store.events(first.id, 'user').some((event) => event.content === 'bonjour'), true);
    assert.equal(fork.parentId, first.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session event recovery preserves valid JSONL entries after a torn final line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-session-recovery-test-'));
  try {
    const store = new SessionStore({ dataDir: dir });
    const session = store.create({ userId: 'user', cwd: process.cwd() });
    store.append(session.id, { type: 'message', role: 'user', content: 'durable' });
    fs.appendFileSync(path.join(dir, 'agent-sessions', 'logs', `${session.id}.jsonl`), '{"partial":');
    const events = store.events(session.id, 'user');
    assert.equal(events.some((event) => event.content === 'durable'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('security pipeline redacts secrets and creates SARIF', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-security-test-'));
  try {
    fs.writeFileSync(path.join(root, 'sample.js'), 'const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";\neval(userInput);\n');
    const report = security.scan({ root });
    assert.ok(report.findings.some((item) => item.rule === 'secret.github_token'));
    assert.ok(report.findings.some((item) => item.rule === 'javascript.eval'));
    assert.equal(JSON.stringify(report.findings).includes('abcdefghijklmnopqrstuvwxyz'), false);
    assert.equal(report.sarif.version, '2.1.0');
    assert.equal(report.sbom.cyclonedx.bomFormat, 'CycloneDX');
    assert.match(report.markdown, /Rapport de sécurité Zaalis/);
    assert.equal(security.fixPlan(report).changes.length, report.findings.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('security pipeline excludes vendored code, including in deep reviews', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-security-vendor-test-'));
  try {
    fs.mkdirSync(path.join(root, 'vendor', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.js'), 'eval(userInput);\n');
    fs.writeFileSync(path.join(root, 'vendor', 'example', 'library.go'), 'query := "SELECT " + value\n');
    const report = security.scan({ root, mode: 'deep', includeIgnored: true });
    assert.equal(report.findings.some((item) => item.file.startsWith('vendor/')), false);
    assert.equal(report.findings.some((item) => item.rule === 'javascript.eval'), true);
    assert.equal(report.exclusions.some((item) => item.path === 'vendor' && item.reason === 'third_party'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native registry exposes schemas for all standard tools', () => {
  const names = openAIFunctionTools().map((entry) => entry.function.name);
  for (const name of ['read', 'write', 'run', 'audit', 'git', 'web_fetch', 'computer']) assert.ok(names.includes(name));
  assert.equal(names.includes('security'), false);
  const geminiSchema = JSON.stringify(geminiTools());
  assert.equal(geminiSchema.includes('additionalProperties'), false);
});

test('project audit paginates results and masks sensitive grep output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-audit-test-'));
  try {
    fs.writeFileSync(path.join(root, 'a.js'), 'const visible = true;\n');
    fs.writeFileSync(path.join(root, 'b.js'), 'const second = true;\n');
    fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=very-secret-value\n');
    const first = inspector.inventory({ root, limit: 1 });
    assert.equal(first.total, 3);
    assert.equal(first.items.length, 1);
    assert.equal(first.nextCursor, 1);
    assert.equal(first.complete, false);
    const last = inspector.inventory({ root, cursor: 2, limit: 1 });
    assert.equal(last.nextCursor, null);
    assert.equal(last.complete, true);
    const matches = inspector.grep({ root, pattern: 'API_TOKEN', limit: 10 });
    assert.equal(matches.items.length, 1);
    assert.equal(matches.items[0].text.includes('very-secret-value'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
