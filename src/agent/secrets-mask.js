'use strict';

// Masquage des secrets côté Node.
//
// Port fidèle de `rust/crates/zaalis-secrets` : le cœur Rust masque ce qui
// sort de ses propres processus, mais le terminal intégré tourne dans Node et
// sort par un autre chemin.  Deux implémentations pour un même contrat, donc
// les règles sont volontairement identiques et testées des deux côtés — si
// l'une gagne un motif, l'autre doit le gagner aussi.
//
// Le masquage est irréversible et ne laisse jamais de préfixe « pour le
// contexte » : montrer les premiers caractères d'une clé est exactement la
// façon dont une rédaction finit par fuiter.

const MIN_LITERAL_LENGTH = 12;
const MIN_ASSIGNED_LENGTH = 8;
const MASK = '[secret masqué]';

// Préfixe + longueur minimale.  Le préfixe est ancré en début de jeton, donc
// `sk-` ne matche pas le milieu de `task-runner`, et la longueur minimale évite
// de masquer le préfixe seul cité dans une doc.
const SHAPES = [
  { prefix: 'sk-ant-', min: 30, label: 'clé Anthropic' },
  { prefix: 'sk-proj-', min: 30, label: 'clé OpenAI' },
  { prefix: 'sk-or-', min: 30, label: 'clé OpenRouter' },
  { prefix: 'sk-', min: 24, label: 'clé de type OpenAI' },
  { prefix: 'github_pat_', min: 30, label: 'jeton GitHub' },
  { prefix: 'ghp_', min: 20, label: 'jeton GitHub' },
  { prefix: 'gho_', min: 20, label: 'jeton GitHub' },
  { prefix: 'ghu_', min: 20, label: 'jeton GitHub' },
  { prefix: 'ghs_', min: 20, label: 'jeton GitHub' },
  { prefix: 'ghr_', min: 20, label: 'jeton GitHub' },
  { prefix: 'glpat-', min: 20, label: 'jeton GitLab' },
  { prefix: 'AIza', min: 35, label: 'clé Google' },
  { prefix: 'ya29.', min: 30, label: 'jeton OAuth Google' },
  { prefix: 'xoxb-', min: 24, label: 'jeton Slack' },
  { prefix: 'xoxp-', min: 24, label: 'jeton Slack' },
  { prefix: 'xoxa-', min: 24, label: 'jeton Slack' },
  { prefix: 'xapp-', min: 24, label: 'jeton Slack' },
  { prefix: 'hf_', min: 20, label: 'jeton Hugging Face' },
  { prefix: 'gsk_', min: 20, label: 'clé Groq' },
  { prefix: 'xai-', min: 24, label: 'clé xAI' },
  { prefix: 'npm_', min: 30, label: 'jeton npm' },
  { prefix: 'dop_v1_', min: 30, label: 'jeton DigitalOcean' },
  { prefix: 'SG.', min: 40, label: 'clé SendGrid' },
  { prefix: 'shpat_', min: 30, label: 'jeton Shopify' },
];

const SENSITIVE_NAMES = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'apikey', 'api-key',
  'access_key', 'accesskey', 'private_key', 'privatekey', 'client_secret', 'auth',
  'credential', 'session_key', 'encryption_key', 'signing_key',
];

// Noms qui contiennent un mot sensible sans jamais porter la valeur sensible.
// Sans cette liste, un `printenv` masque sa propre structure : le *nom* du
// fichier qui contient une clé n'est pas une clé.
const SENSITIVE_NAME_EXCEPTIONS = [
  'token_count', 'tokens', 'max_tokens', 'token_limit', 'token_usage',
  'secret_path', 'secret_file', 'secret_name', 'key_file', 'keyfile',
  'password_file', 'auth_url', 'auth_type', 'auth_method',
  'credential_path', 'credentials_file',
];

// Registre des secrets exacts connus du processus (clés API configurées).
// Un match exact ne peut pas produire de faux négatif sur les clés qui
// comptent le plus.
const literals = [];

function registerSecret(label, value) {
  const trimmed = String(value == null ? '' : value).trim();
  if (trimmed.length < MIN_LITERAL_LENGTH) return;
  if (literals.some((entry) => entry.value === trimmed)) return;
  literals.push({ value: trimmed, label: String(label || 'secret') });
  // Le plus long d'abord : une clé qui contient le préfixe d'une autre doit
  // être masquée entière plutôt que de laisser une queue derrière elle.
  literals.sort((a, b) => b.value.length - a.value.length);
}

function clearRegisteredSecrets() { literals.length = 0; }

function isTokenChar(character) {
  return /[A-Za-z0-9\-_.+/=~]/.test(character);
}

function classifyToken(token) {
  for (const shape of SHAPES) {
    if (token.length >= shape.min && token.startsWith(shape.prefix)) return shape.label;
  }
  // `AKIA`/`ASIA` puis seize alphanumériques majuscules, et rien d'autre.
  if (token.length === 20 && /^(AKIA|ASIA)[A-Z0-9]{16}$/.test(token)) return "clé d'accès AWS";
  // `eyJ` est `{"` en base64 : l'exiger garde les identifiants pointés
  // ordinaires dehors tout en attrapant tous les vrais JWT.
  if (token.startsWith('eyJ') && token.length >= 40) {
    const segments = token.split('.');
    if (segments.length === 3 && segments.every((segment) => segment && /^[A-Za-z0-9\-_=]+$/.test(segment))) {
      return 'jeton JWT';
    }
  }
  return null;
}

function maskTokens(text) {
  let result = '';
  let copied = 0;
  let index = 0;
  let masked = false;
  while (index < text.length) {
    if (!isTokenChar(text[index])) { index += 1; continue; }
    const start = index;
    while (index < text.length && isTokenChar(text[index])) index += 1;
    const label = classifyToken(text.slice(start, index));
    if (!label) continue;
    result += text.slice(copied, start) + `[${label} masquée]`;
    copied = index;
    masked = true;
  }
  return masked ? result + text.slice(copied) : text;
}

// Les blocs PEM sont du base64 avec des retours à la ligne : le scanner de
// jetons ne grignoterait que des lignes isolées et laisserait une clé
// reconstructible derrière lui.
function maskPemBlocks(text) {
  if (!text.includes('-----BEGIN')) return text;
  return text.replace(
    /-----BEGIN [^\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\n-]*PRIVATE KEY-----/g,
    '[clé privée masquée]',
  );
}

function looksSensitiveName(name) {
  if (!name) return false;
  if (SENSITIVE_NAME_EXCEPTIONS.some((exception) => name.includes(exception))) return false;
  return SENSITIVE_NAMES.some((marker) => name.includes(marker));
}

function maskAssignmentLine(line) {
  const equals = line.indexOf('=');
  const colon = line.indexOf(':');
  const candidates = [equals, colon].filter((index) => index >= 0);
  if (!candidates.length) return null;
  const separator = Math.min(...candidates);

  const namePart = line.slice(0, separator);
  const rawValue = line.slice(separator + 1);
  const name = namePart.trim()
    .replace(/^["'${\-]+/, '')
    .replace(/["']+$/, '')
    .split(/[\s.,([{]/).pop()
    .toLowerCase();
  if (!looksSensitiveName(name)) return null;

  const trailingNewline = rawValue.endsWith('\n');
  const withoutNewline = rawValue.replace(/[\r\n]+$/, '');
  const leadingSpaces = withoutNewline.length - withoutNewline.trimStart().length;
  const value = withoutNewline.trimStart();

  // `Authorization: Bearer <token>` est la seule forme dont la valeur porte
  // légitimement une espace ; le secret est ce qui suit le schéma.
  let scheme = null;
  let credential = value;
  const spaceIndex = value.indexOf(' ');
  if (spaceIndex > 0) {
    const head = value.slice(0, spaceIndex).toLowerCase();
    if (head === 'bearer' || head === 'basic' || head === 'token') {
      scheme = value.slice(0, spaceIndex);
      credential = value.slice(spaceIndex + 1).trim();
    } else {
      return null; // une phrase, pas un identifiant
    }
  }

  const bare = credential.replace(/^["'`]+|["'`]+$/g, '');
  if (bare.length < MIN_ASSIGNED_LENGTH || bare.includes(' ')) return null;

  return `${namePart}${line[separator]}${' '.repeat(leadingSpaces)}${scheme ? `${scheme} ` : ''}${MASK}${trailingNewline ? '\n' : ''}`;
}

function maskAssignments(text) {
  if (!text.includes('=') && !text.includes(':')) return text;
  let masked = false;
  const lines = text.split(/(?<=\n)/).map((line) => {
    const result = maskAssignmentLine(line);
    if (result === null) return line;
    masked = true;
    return result;
  });
  return masked ? lines.join('') : text;
}

function maskLiterals(text) {
  let result = text;
  for (const literal of literals) {
    if (!result.includes(literal.value)) continue;
    result = result.split(literal.value).join(`[secret masqué : ${literal.label}]`);
  }
  return result;
}

/** Masque tous les secrets présents dans `text`. */
function sanitize(text) {
  if (typeof text !== 'string' || !text) return text;
  return maskAssignments(maskTokens(maskPemBlocks(maskLiterals(text))));
}

/** Indique si `text` contient quelque chose que `sanitize` masquerait. */
function detectsSecret(text) {
  return typeof text === 'string' && sanitize(text) !== text;
}

module.exports = { sanitize, detectsSecret, registerSecret, clearRegisteredSecrets };
