'use strict';

// Google Vertex AI (beta channel). Gemini is reached through Vertex AI's
// OpenAI-compatible endpoint, billed to the user's Google Cloud project:
//   https://{host}/v1/projects/{project}/locations/{location}/endpoints/openapi
// The credentials never leave this process: the Rust core calls a loopback
// adapter in server.js, which adds a short-lived OAuth access token.
//
// Two kinds of credentials are accepted, both Google's own formats:
//  - a service account key (JSON, "type": "service_account"): a signed JWT is
//    exchanged for an access token;
//  - Application Default Credentials from `gcloud auth application-default
//    login` ("type": "authorized_user"): the refresh token is exchanged.
// Consumer Google AI Pro/Ultra plans are not usable here (Google forbids
// using the Gemini CLI login in third-party apps).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOCATION_RE = /^(global|[a-z]+(?:-[a-z]+)+\d)$/;
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// Parse and validate pasted credentials. Returns a normalized object or throws
// a clear, user-facing error.
function parseCredentials(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {
    throw fail(400, 'Les identifiants Google ne sont pas un JSON valide. Collez le fichier de clé de compte de service tel quel.', 'invalid_json');
  }
  if (!data || typeof data !== 'object') throw fail(400, 'Identifiants Google vides.', 'empty');
  if (data.type === 'service_account') {
    if (!data.client_email || !data.private_key) throw fail(400, 'Clé de compte de service incomplète (client_email ou private_key manquant).', 'incomplete');
    try { crypto.createPrivateKey(String(data.private_key)); } catch {
      throw fail(400, 'La clé privée du compte de service est illisible.', 'bad_private_key');
    }
    return { type: 'service_account', clientEmail: String(data.client_email), privateKey: String(data.private_key),
      tokenUri: /^https:\/\/oauth2\.googleapis\.com\/token$/.test(String(data.token_uri || '')) ? data.token_uri : TOKEN_URL,
      project: String(data.project_id || '') };
  }
  if (data.type === 'authorized_user') {
    if (!data.client_id || !data.client_secret || !data.refresh_token) throw fail(400, 'Identifiants gcloud incomplets.', 'incomplete');
    return { type: 'authorized_user', clientId: String(data.client_id), clientSecret: String(data.client_secret),
      refreshToken: String(data.refresh_token), project: String(data.quota_project_id || '') };
  }
  throw fail(400, 'Type d’identifiants Google non pris en charge : utilisez une clé de compte de service ou les identifiants gcloud (ADC).', 'unsupported_type');
}

// Where `gcloud auth application-default login` writes its credentials.
function adcPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json');
  return path.join(env.CLOUDSDK_CONFIG || path.join(home, '.config', 'gcloud'), 'application_default_credentials.json');
}
function readAdc(options) {
  const file = adcPath(options && options.env, options && options.platform, options && options.home);
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function normalizeSettings(settings = {}) {
  const location = String(settings.location || 'global').trim().toLowerCase() || 'global';
  const project = String(settings.project || '').trim().toLowerCase();
  if (!LOCATION_RE.test(location)) throw fail(400, `Région Vertex AI invalide : « ${location} » (exemples : global, europe-west1, us-central1).`, 'bad_location');
  if (project && !PROJECT_RE.test(project)) throw fail(400, `Identifiant de projet Google Cloud invalide : « ${project} ».`, 'bad_project');
  return { location, project, useAdc: !!settings.useAdc };
}

function endpointBase(project, location) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi`;
}

const b64url = (value) => Buffer.from(value).toString('base64url');
function signedAssertion(credentials, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: credentials.clientEmail, scope: SCOPE, aud: credentials.tokenUri, iat: now, exp: now + 3600 }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(credentials.privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

// One cached token per credential fingerprint, renewed 2 minutes before expiry.
const tokenCache = new Map();
async function accessToken(credentials, { fetchImpl = fetch } = {}) {
  const fingerprint = crypto.createHash('sha256')
    .update(credentials.type === 'service_account' ? credentials.clientEmail + credentials.privateKey : credentials.clientId + credentials.refreshToken).digest('hex');
  const cached = tokenCache.get(fingerprint);
  if (cached && cached.expiresAt - 120000 > Date.now()) return cached.token;
  const body = credentials.type === 'service_account'
    ? new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(credentials) })
    : new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken });
  let answer;
  try {
    answer = await fetchImpl(credentials.type === 'service_account' ? credentials.tokenUri : TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw fail(502, 'Le service d’authentification Google est injoignable. Vérifiez la connexion Internet.', 'token_unreachable');
  }
  const data = await answer.json().catch(() => ({}));
  if (!answer.ok || !data.access_token) {
    const reason = String(data.error_description || data.error || `HTTP ${answer.status}`);
    const revoked = /invalid_grant|revoked|expired/i.test(reason);
    throw fail(401, revoked
      ? 'Les identifiants Google ont expiré ou ont été révoqués. Relancez « gcloud auth application-default login » ou créez une nouvelle clé de compte de service.'
      : `Google a refusé les identifiants (${reason}).`, 'token_refused');
  }
  const token = String(data.access_token);
  tokenCache.set(fingerprint, { token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 });
  return token;
}

// Clear explanation for an upstream Vertex AI error status.
function upstreamMessage(status, detail = '') {
  if (status === 401) return 'Vertex AI a refusé le jeton d’accès. Vérifiez les identifiants Google.';
  if (status === 403) return /billing/i.test(detail)
    ? 'La facturation n’est pas activée sur ce projet Google Cloud.'
    : 'Accès refusé par Vertex AI : activez l’API « Vertex AI » sur le projet et donnez au compte le rôle « Vertex AI User ».';
  if (status === 404) return 'Modèle ou région introuvable sur Vertex AI. Essayez la région « global » ou un autre modèle.';
  if (status === 429) return 'Quota Vertex AI atteint pour ce projet. Réessayez dans un instant.';
  if (status >= 500) return 'Vertex AI est momentanément indisponible. Réessayez dans un instant.';
  return `Vertex AI a refusé la requête (HTTP ${status}).`;
}

module.exports = { parseCredentials, adcPath, readAdc, normalizeSettings, endpointBase, signedAssertion, accessToken, upstreamMessage, SCOPE };
