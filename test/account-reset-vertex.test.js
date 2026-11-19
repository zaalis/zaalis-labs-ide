'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const reset = require('../src/services/password-reset');
const vertex = require('../src/accounts/vertex-ai');

test('reset tokens: hashed, single account match, expiry, password rule', () => {
  const { token, record } = reset.createToken(1000);
  assert.notEqual(record.hash, token);
  const users = [{ id: 'a', passwordReset: record }, { id: 'b' }];
  assert.equal(reset.findByToken(users, token, 2000).id, 'a');
  assert.equal(reset.findByToken(users, token, 1000 + reset.TTL_MS + 1), null);
  assert.equal(reset.findByToken(users, 'x'.repeat(43), 2000), null);
  assert.match(reset.passwordProblem('short1'), /8 caractères/);
  assert.match(reset.passwordProblem('longpassword'), /lettre et un chiffre/);
  assert.equal(reset.passwordProblem('longpass1'), '');
});

test('Vertex AI: service account JWT is signed and the token cached', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({ type: 'service_account', project_id: 'demo-project-1', client_email: 'bot@demo.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
  const credentials = vertex.parseCredentials(key);
  assert.equal(credentials.project, 'demo-project-1');
  const [header, claims, signature] = vertex.signedAssertion(credentials, 100).split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, vertex.SCOPE);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.match(String(options.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
  };
  assert.equal(await vertex.accessToken(credentials, { fetchImpl }), 'ya29.test');
  assert.equal(await vertex.accessToken(credentials, { fetchImpl }), 'ya29.test');
  assert.equal(calls, 1);
});

test('Vertex AI: gcloud ADC, revoked tokens, settings and endpoints', async () => {
  const adc = vertex.parseCredentials({ type: 'authorized_user', client_id: 'id', client_secret: 's', refresh_token: 'r', quota_project_id: 'my-proj-42' });
  assert.equal(adc.project, 'my-proj-42');
  await assert.rejects(vertex.accessToken(adc, { fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) }), /expiré ou ont été révoqués/);
  assert.throws(() => vertex.parseCredentials('{oops'), /JSON valide/);
  assert.throws(() => vertex.parseCredentials({ type: 'external_account' }), /non pris en charge/);
  assert.throws(() => vertex.normalizeSettings({ location: 'mars' }), /Région Vertex AI invalide/);
  assert.equal(vertex.endpointBase('p-123456', 'global'), 'https://aiplatform.googleapis.com/v1/projects/p-123456/locations/global/endpoints/openapi');
  assert.equal(vertex.endpointBase('p-123456', 'europe-west1'), 'https://europe-west1-aiplatform.googleapis.com/v1/projects/p-123456/locations/europe-west1/endpoints/openapi');
  assert.match(vertex.upstreamMessage(403, ''), /Vertex AI User/);
  assert.match(vertex.adcPath({ APPDATA: 'C:\\Roaming' }, 'win32', 'C:\\Users\\x'), /gcloud[\\/]application_default_credentials\.json$/);
});

// ---- HTTP integration: beta gating, sign-up names, reset end to end --------
const PORT = 31977;
const base = `http://127.0.0.1:${PORT}`;
async function startServer(dataDir, extraEnv) {
  const child = spawn(process.execPath, ['src/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZAALIS_PORT: String(PORT), ZAALIS_DATA_DIR: dataDir, ZAALIS_RUST_CORE: 'off', ...extraEnv },
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try { if ((await fetch(base)).ok) return child; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error('server did not start');
}
const json = (method, body, cookie) => ({ method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

test('server: Vertex only on beta, names at sign-up, password reset in the browser', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-reset-'));
  // No real browser in tests: the server hands the page address back instead.
  const child = await startServer(dataDir, { ZAALIS_NO_EXTERNAL_BROWSER: '1' });
  try {
    // Sign-up: names validated, strong password when the form sends them.
    assert.equal((await fetch(`${base}/api/auth/register`, json('POST', { firstName: 'Ana', lastName: '', email: 'ana@example.test', password: 'abcdefg1' }))).status, 400);
    assert.equal((await fetch(`${base}/api/auth/register`, json('POST', { firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.test', password: 'short' }))).status, 400);
    const signup = await fetch(`${base}/api/auth/register`, json('POST', { firstName: ' Ana  María ', lastName: "D'Arc-Lopez", email: 'ana@example.test', password: 'abcdefg1' }));
    assert.equal(signup.status, 200);
    const profile = (await signup.json()).profile;
    assert.deepEqual([profile.firstName, profile.lastName, profile.pseudo], ['Ana María', "D'Arc-Lopez", 'Ana María']);
    let cookie = signup.headers.get('set-cookie').split(';')[0];

    // Beta gating of Vertex AI.
    const providers = async () => (await (await fetch(`${base}/api/compat/providers`, { headers: { cookie } })).json()).providers.map((p) => p.id);
    assert.ok(!(await providers()).includes('vertex'));
    assert.equal((await fetch(`${base}/api/compat/keys`, json('PUT', { keys: {}, vertex: { location: 'global' } }, cookie))).status, 403);
    assert.equal((await (await fetch(`${base}/api/preferences`, { headers: { cookie } })).json()).updateChannel, null);
    const beta = await fetch(`${base}/api/preferences`, json('PUT', { updateChannel: 'beta' }, cookie));
    assert.equal(beta.status, 200);
    assert.ok((await beta.json()).providers.some((p) => p.id === 'vertex'));
    assert.equal((await fetch(`${base}/api/compat/keys`, json('PUT', { keys: { vertex: '{"type":"nope"}' } }, cookie))).status, 400);
    const adcKey = JSON.stringify({ type: 'authorized_user', client_id: 'id', client_secret: 's', refresh_token: 'r', quota_project_id: 'demo-proj-7' });
    const saved = await (await fetch(`${base}/api/compat/keys`, json('PUT', { keys: { vertex: adcKey }, vertex: { location: 'europe-west1' } }, cookie))).json();
    const entry = saved.providers.find((p) => p.id === 'vertex');
    assert.equal(entry.configured, true);
    assert.equal(entry.vertex.resolvedProject, 'demo-proj-7');
    assert.equal(entry.vertex.location, 'europe-west1');
    assert.ok(!JSON.stringify(saved).includes('refresh_token'));
    await fetch(`${base}/api/preferences`, json('PUT', { updateChannel: 'stable' }, cookie));
    assert.ok(!(await providers()).includes('vertex'));

    // Password reset: an unknown address is said so; a real one gets the page.
    const unknown = await fetch(`${base}/api/auth/password-reset/request`, json('POST', { email: 'nobody@example.test' }));
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /Aucun compte/);
    const asked = await fetch(`${base}/api/auth/password-reset/request`, json('POST', { email: 'ANA@example.test' }));
    assert.equal(asked.status, 200);
    const answer = await asked.json();
    assert.equal(answer.opened, false);
    assert.equal((await fetch(`${base}/api/auth/password-reset/request`, json('POST', { email: 'ana@example.test' }))).status, 429);
    const link = String(answer.url).match(/^http:\/\/127\.0\.0\.1:\d+\/reset-password\.html#token=([A-Za-z0-9_-]+)$/);
    assert.ok(link, 'reset page address');
    const page = await fetch(`${base}/reset-password.html`);
    assert.equal(page.status, 200);
    assert.equal((await fetch(`${base}/api/auth/password-reset/check`, json('POST', { token: link[1] }))).status, 200);
    assert.equal((await fetch(`${base}/api/auth/password-reset/confirm`, json('POST', { token: link[1], password: 'nodigits' }))).status, 400);
    assert.equal((await fetch(`${base}/api/auth/password-reset/confirm`, json('POST', { token: link[1], password: 'newpass42' }))).status, 200);
    // Single use, old session ended, new password works, old one does not.
    assert.equal((await fetch(`${base}/api/auth/password-reset/confirm`, json('POST', { token: link[1], password: 'other123' }))).status, 410);
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()).authenticated, false);
    assert.equal((await fetch(`${base}/api/auth/login`, json('POST', { email: 'ana@example.test', password: 'abcdefg1' }))).status, 401);
    const login = await fetch(`${base}/api/auth/login`, json('POST', { email: 'ana@example.test', password: 'newpass42' }));
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()).authenticated, true);

    // Older clients may still sign up without names.
    assert.equal((await fetch(`${base}/api/auth/register`, json('POST', { email: 'cli@example.test', password: 'local-fixture-only' }))).status, 200);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
