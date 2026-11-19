'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const chatgpt = require('./chatgpt-subscription');
const fail = message => Object.assign(new Error(message), { status: 400 });
const random = () => crypto.randomBytes(32).toString('base64url');
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

async function validateIdentity(token, { issuer, clientId, nonce, fetchImpl = fetch }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw fail('Jeton identité OpenAI invalide.');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw fail('Jeton identité OpenAI invalide.'); }
  if (!['RS256', 'ES256'].includes(header.alg)) throw fail('Signature OpenAI non prise en charge.');
  const discovery = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!discovery.ok) throw fail('Découverte OpenAI indisponible.');
  const config = await discovery.json();
  const jwksUrl = new URL(config.jwks_uri);
  if (config.issuer !== issuer || jwksUrl.origin !== new URL(issuer).origin) throw fail('Autorité OpenAI invalide.');
  const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw fail('Clés de signature OpenAI indisponibles.');
  const keys = (await response.json()).keys || [];
  const key = keys.find(key => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig') && key.kty === (header.alg === 'RS256' ? 'RSA' : 'EC'));
  if (!key || !crypto.verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: crypto.createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) throw fail('Signature identité OpenAI refusée.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (claims.iss !== issuer || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf && claims.nbf > now + 30) || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) throw fail('Identité OpenAI expirée ou non liée à cette connexion.');
  return claims;
}

async function beginSignIn({ hostId, previous, onSession, fetchImpl = fetch }) {
  const issuer = chatgpt.issuer();
  const state = random(), nonce = random(), verifier = random();
  const savedClient = previous?.transport === 'public' ? previous.clientId : '';
  let status = 'pending', failure = '', completing = false, timer;
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404); return res.end('Introuvable'); }
    if (url.searchParams.get('state') !== state) { res.writeHead(400); return res.end('Etat OAuth invalide.'); }
    if (status !== 'pending' || completing) { res.writeHead(409); return res.end('Connexion deja traitee.'); }
    completing = true;
    try {
      if (url.searchParams.has('error')) throw fail('Connexion refusée sur OpenAI.');
      const clientId = url.searchParams.get('client_id') || savedClient;
      const code = url.searchParams.get('code');
      if (!clientId || clientId === 'dynamic_agent_client' || clientId.length > 256 || !code || (savedClient && clientId !== savedClient)) throw fail('Enregistrement OpenAI incomplet ou différent du compte choisi.');
      const response = await fetchImpl(`${issuer}/api/accounts/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(20000),
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: 'https://api.openai.com/v1' }),
      });
      if (!response.ok) throw fail(`Échange OAuth refusé (HTTP ${response.status}). Relancez la connexion.`);
      const tokens = await response.json();
      const scopes = String(tokens.scope || '').split(/\s+/);
      if (!scopes.includes('resource.invoke') || !scopes.includes('chatgpt.tokens.use.direct') || String(tokens.token_type).toLowerCase() !== 'bearer' || !tokens.refresh_token) throw fail('Permission d’utilisation du forfait ChatGPT absente.');
      const identity = await validateIdentity(tokens.id_token, { issuer, clientId, nonce, fetchImpl });
      if (previous?.transport === 'public' && previous.subject !== identity.sub) throw fail('Le compte choisi ne correspond pas à cette reconnexion.');
      if (status !== 'pending' || Date.now() >= expiresAt) throw fail('Connexion annulée ou expirée.');
      const session = { ...chatgpt.sessionFromTokens(tokens), transport: 'public', clientId, hostId, subject: identity.sub, email: String(identity.email || ''), idToken: tokens.id_token, scopes };
      await onSession(session);
      status = 'connected';
      res.end('ChatGPT est connecté à Zaalis Labs. Vous pouvez fermer cet onglet.');
    } catch (error) {
      status = 'error'; failure = error.message;
      res.writeHead(400); res.end('La connexion a échoué. Consultez Zaalis Labs pour réessayer.');
    } finally { clearTimeout(timer); server.close(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const url = new URL(`${issuer}/api/accounts/authorize`);
  const params = { client_id: savedClient || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: 'https://api.openai.com/v1', state, nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  if (!savedClient) params.agent_name_hint = 'Zaalis Labs IDE';
  else if (previous.idToken) params.id_token_hint = previous.idToken;
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  const cancel = () => { if (status === 'pending') status = 'expired'; clearTimeout(timer); server.close(); server.closeIdleConnections?.(); };
  timer = setTimeout(cancel, expiresAt - Date.now()); timer.unref();
  return { verificationUrl: url.toString(), expiresAt, interval: 2, poll: () => ({ status, ...(failure ? { error: failure } : {}) }), cancel };
}
module.exports = { beginSignIn, validateIdentity };
