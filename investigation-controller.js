'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SENSITIVE_PATH, redactSecrets } = require('./secret-redactor');
const responseIntegrity = require('./response-integrity');

const IGNORED = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', 'target', 'Pods', 'DerivedData', 'server-data']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.py', '.rb', '.php', '.java', '.kt', '.kts', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.sh', '.bash', '.zsh', '.sql', '.html', '.htm', '.vue', '.svelte']);
const TEXT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config', '.xml', '.properties', '.gradle', '.lock', '.mod', '.sum']);
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'poetry.lock', 'gemfile', 'gemfile.lock', 'cargo.toml', 'cargo.lock', 'pom.xml', 'build.gradle', 'composer.json', 'composer.lock', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml']);
const MAX_FILES = 250_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;

const CATEGORY_RULES = Object.freeze([
  { id: 'entrypoints', label: 'Entrées HTTP/API', path: /(?:route|router|controller|handler|endpoint|api|server)/i, code: /\b(?:req(?:uest)?\.(?:body|query|params|headers)|http\.(?:Handle|HandleFunc)|@(?:RequestMapping|GetMapping|PostMapping)|fetch\(|serveHTTP|webhook)\b/i },
  { id: 'auth', label: 'Authentification et sessions', path: /(?:auth|login|session|oauth|jwt|permission|middleware)/i, code: /\b(?:authenticate|authorize|session|cookie|jwt|oauth|bcrypt|argon2|password|permission|role)\b/i },
  { id: 'database', label: 'Base de données et injections', path: /(?:database|db|sql|query|repository|model|migration)/i, code: /\b(?:SELECT|INSERT|UPDATE|DELETE|query|execute|exec|prepare|rawQuery|sprintf|fmt\.Sprintf)\b/i },
  { id: 'commands', label: 'Commandes et processus', path: /(?:script|shell|command|runner|process)/i, code: /\b(?:child_process|execFile|execSync|spawnSync|Runtime\.getRuntime|ProcessBuilder|os\.system|subprocess|Command::new|system\()\b/i },
  { id: 'files', label: 'Fichiers, chemins et uploads', path: /(?:upload|download|storage|file|asset|media)/i, code: /\b(?:multipart|upload|readFile|writeFile|open\(|sendFile|path\.join|filepath\.Join|extract|archive)\b/i },
  { id: 'rendering', label: 'Rendu Web et XSS', path: /(?:template|view|render|frontend|client|component)/i, code: /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write|v-html|template\.HTML|eval\(|new Function)\b/i },
  { id: 'crypto', label: 'Secrets et cryptographie', path: /(?:secret|token|crypto|key|credential|\.env)/i, code: /\b(?:secret|token|api_key|apiKey|private_key|encrypt|decrypt|createCipher|md5|sha1|random)\b/i },
  { id: 'dependencies', label: 'Dépendances et chaîne de build', path: /(?:package|lock|requirements|pyproject|cargo|composer|pom|gradle|docker)/i, code: /\b(?:dependencies|devDependencies|requirement|plugin|image:|FROM)\b/i },
]);

function slash(value) { return String(value || '').replace(/\\/g, '/'); }
function normalize(value) { return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function detectInvestigation(message) {
  const raw = String(message || '').trim();
  if (!raw || /^\/(?:security|security-review)\b/i.test(raw)) return null;
  const text = normalize(raw);
  const security = /\b(securite|security|faille|failles|vulnerabilit|vulnerability|vulnerabilities|secret|secrets|injection|xss|csrf)\b/.test(text);
  const inspect = /\b(analy|audit|inspect|detect|cherche|trouve|review|revu|scan|verif)\w*/.test(text);
  if (!security || !inspect) return null;
  const broad = /\b(tout|toute|toutes|complet|complete|exhaust|entier|entire|whole|all|deep|approfond)\w*/.test(text);
  // Phrases such as “ne modifie rien” describe the requested outcome, but
  // must never override the permission mode explicitly selected in the UI.
  return { kind: 'security', broad, explicit: true };
}

function gitTrackedFiles(root) {
  try {
    const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    if (result.status !== 0 || !result.stdout) return null;
    return new Set(result.stdout.toString('utf8').split('\0').filter(Boolean).map(slash));
  } catch { return null; }
}

function candidateFor(relative, bytes, tracked) {
  const lower = relative.toLowerCase();
  const base = path.basename(lower);
  const ext = path.extname(lower);
  const source = SOURCE_EXTENSIONS.has(ext);
  const manifest = MANIFESTS.has(base);
  const sensitive = SENSITIVE_PATH.test(relative);
  const config = manifest || sensitive || /(^|\/)(?:dockerfile|\.github\/workflows|[^/]+\.(?:ya?ml|toml|ini|conf|config))$/i.test(relative);
  const categories = new Set();
  let score = source ? 2 : 0;
  if (manifest) { score += 8; categories.add('dependencies'); }
  if (sensitive) { score += 12; categories.add('crypto'); }
  for (const rule of CATEGORY_RULES) if (rule.path.test(relative)) { categories.add(rule.id); score += 3; }
  return { path: relative, bytes, source, manifest, config, sensitive, tracked: tracked ? tracked.has(relative) : null, score, categories, signals: [], signalCounts: new Map() };
}

function ignoredDirectory(name) {
  return IGNORED.has(name) || /^(?:dist|build|release|out)(?:[-_.]|$)/i.test(name) || /^(?:\.venv|venv|__pycache__)$/.test(name);
}

function buildInvestigationPlan(root, request = {}) {
  const base = path.resolve(root);
  const tracked = gitTrackedFiles(base);
  const candidates = [];
  const excluded = new Map();
  const stack = [base];
  let totalFiles = 0;
  let sourceFiles = 0;
  let totalBytes = 0;
  let scannedBytes = 0;
  let truncated = false;

  while (stack.length && totalFiles < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { excluded.set(slash(path.relative(base, dir)) || '.', 'unreadable'); continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = slash(path.relative(base, full));
      if (entry.isSymbolicLink()) { excluded.set(relative, 'symlink'); continue; }
      if (entry.isDirectory()) {
        if (ignoredDirectory(entry.name)) excluded.set(relative, 'generated_or_third_party');
        else stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      totalFiles++;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      totalBytes += stat.size;
      const candidate = candidateFor(relative, stat.size, tracked);
      if (candidate.source) sourceFiles++;
      const ext = path.extname(entry.name.toLowerCase());
      const mayScan = (candidate.source || candidate.manifest || candidate.config || TEXT_EXTENSIONS.has(ext)) && stat.size <= MAX_FILE_BYTES && scannedBytes + stat.size <= MAX_SCAN_BYTES;
      if (mayScan) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          scannedBytes += stat.size;
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            for (const rule of CATEGORY_RULES) {
              if (!rule.code.test(line)) continue;
              candidate.categories.add(rule.id);
              const count = candidate.signalCounts.get(rule.id) || 0;
              if (count < 6) candidate.score += 1;
              candidate.signalCounts.set(rule.id, count + 1);
              if (candidate.signals.length < 8) candidate.signals.push({ line: index + 1, category: rule.id });
            }
          }
        } catch { excluded.set(relative, 'unreadable'); }
      } else if ((candidate.source || candidate.config) && stat.size > MAX_FILE_BYTES) excluded.set(relative, 'too_large_for_content_index');
      if (candidate.score > 0 || candidate.source || candidate.config) candidates.push(candidate);
      if (totalFiles >= MAX_FILES) { truncated = true; break; }
    }
  }
  if (stack.length) truncated = true;

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const relevant = candidates.filter((item) => item.source || item.config || item.manifest);
  // Depth scales with the repository instead of a flat ceiling. A "broad"
  // request ("toutes les failles", "audit complet") targets a real share of the
  // relevant files rather than a token sample: reading 8 of 342 files and
  // calling it an audit is what produced empty reports.
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const proportional = (ratio, min, max) => clamp(Math.ceil(relevant.length * ratio), min, max);
  const budget = sourceFiles <= 12
    ? { minReads: Math.min(Math.max(sourceFiles, 1), 3), minSearches: 1, targetCategories: Math.min(3, CATEGORY_RULES.length), maxRounds: 8, candidateLimit: 18 }
    : request.broad
      ? {
          minReads: proportional(0.12, 20, 60),
          minSearches: 4,
          targetCategories: Math.min(6, CATEGORY_RULES.length),
          maxRounds: 24,
          candidateLimit: proportional(0.35, 60, 120),
        }
      : sourceFiles <= 250
        ? { minReads: 6, minSearches: 2, targetCategories: 4, maxRounds: 10, candidateLimit: 30 }
        : { minReads: 10, minSearches: 3, targetCategories: 5, maxRounds: 14, candidateLimit: 45 };
  if (!request.broad) budget.maxRounds = Math.min(budget.maxRounds, 10);
  // The floor can never exceed what actually exists, otherwise the nudge loop
  // would ask for files that are not there.
  budget.minReads = Math.min(budget.minReads, Math.max(1, relevant.length));
  const selected = relevant.slice(0, budget.candidateLimit);
  const categoryCounts = Object.fromEntries(CATEGORY_RULES.map((rule) => [rule.id, relevant.filter((item) => item.categories.has(rule.id)).length]));
  const sensitiveTracked = relevant.filter((item) => item.sensitive && item.tracked === true).map((item) => item.path).slice(0, 50);
  const sensitiveUntracked = relevant.filter((item) => item.sensitive && item.tracked === false).map((item) => item.path).slice(0, 50);
  return {
    version: 1,
    request,
    root: base,
    scope: { totalFiles, sourceFiles, relevantFiles: relevant.length, totalBytes, scannedBytes, inventoryTruncated: truncated },
    budget,
    candidates: selected.map((item) => ({ path: item.path, score: item.score, bytes: item.bytes, categories: [...item.categories], signals: item.signals, sensitive: item.sensitive, tracked: item.tracked })),
    categoryCounts,
    sensitiveTracked,
    sensitiveUntracked,
    exclusions: [...excluded.entries()].slice(0, 100).map(([excludedPath, reason]) => ({ path: excludedPath, reason })),
  };
}

function formatInvestigationContext(plan, language = 'fr') {
  const fr = language !== 'en';
  const categories = CATEGORY_RULES
    .filter((rule) => plan.categoryCounts[rule.id])
    .map((rule) => `${rule.id}=${plan.categoryCounts[rule.id]}`)
    .join(', ') || 'aucun signal';
  // Only the top slice is rendered into the prompt. The full candidate pool
  // still drives the depth target and the "not yet read" nudges; dumping all of
  // it into every round inflated the context until model calls timed out.
  const SHOWN = 40;
  const shown = plan.candidates.slice(0, SHOWN);
  const hidden = Math.max(0, plan.candidates.length - shown.length);
  const candidates = shown.map((item) => {
    const signals = item.signals.slice(0, 3).map((signal) => `${signal.category}:${signal.line}`).join(',');
    return `- ${item.path} | score=${item.score} | zones=${item.categories.join(',') || 'source'}${signals ? ` | indices=${signals}` : ''}${item.tracked === false ? ' | git=untracked' : ''}`;
  }).join('\n') + (hidden
    ? `\n${fr ? `(+${hidden} autres candidats pertinents non listés : utilise glob/grep pour les atteindre)` : `(+${hidden} more relevant candidates not listed: use glob/grep to reach them)`}`
    : '');
  if (!fr) return `[ADAPTIVE READ-ONLY SECURITY INVESTIGATION]\nThis is a local risk map, not a vulnerability report. It scanned metadata and patterns without sending the repository to the model. Do not launch the central /security workflow.\nScope: ${plan.scope.totalFiles} files, ${plan.scope.sourceFiles} source files, ${plan.scope.relevantFiles} relevant files, ${plan.scope.scannedBytes} bytes locally indexed${plan.scope.inventoryTruncated ? ', inventory capped' : ''}.\n\nHOW TO WORK (efficiency matters as much as depth):\n- Read in BATCHES: pass several paths to a single read call instead of one file per call. Same for targeted greps. Sequential one-file-at-a-time reads waste the whole budget.\n- Delegate independent areas to read-only subagents with task (at most 3), e.g. one for authentication/sessions, one for database/HTTP inputs, one for frontend rendering. Give each a precise mission and ask for evidence with file:line.\n- Keep a todo list and work through it; mark each area done when its evidence is collected.\n\nDEPTH TARGET: inspect at least ${plan.budget.minReads} distinct candidate files, run ${plan.budget.minSearches} targeted searches and cover ${plan.budget.targetCategories} risk categories. This is a floor, not a stopping point: keep going while relevant candidates remain and the round budget allows.\n\nEVIDENCE RULES: never print secret values. Pattern hits are leads, not findings. Confirm every finding by reading the relevant code and cite file:line plus source-to-sink reasoning. If limits are reached, say exactly what remains unreviewed.\nCategory signals: ${categories}\nPriority candidates:\n${candidates || '(none)'}`;
  return `[INVESTIGATION SECURITE ADAPTATIVE EN LECTURE SEULE]\nCette carte locale de risques n'est pas un rapport de vulnérabilités. Les métadonnées et motifs ont été indexés localement sans envoyer tout le dépôt au modèle. Ne lance pas le workflow central /security.\nPérimètre : ${plan.scope.totalFiles} fichiers, ${plan.scope.sourceFiles} fichiers source, ${plan.scope.relevantFiles} fichiers pertinents, ${plan.scope.scannedBytes} octets indexés localement${plan.scope.inventoryTruncated ? ', inventaire plafonné' : ''}.\n\nMÉTHODE DE TRAVAIL (l'efficacité compte autant que la profondeur) :\n- Lis par LOTS : passe plusieurs chemins à un seul appel read au lieu d'un fichier par appel. Idem pour les greps ciblés. Lire un fichier à la fois épuise tout le budget.\n- Délègue les zones indépendantes à des sous-agents en lecture seule via task (3 maximum), par exemple un pour l'authentification/sessions, un pour la base de données et les entrées HTTP, un pour le rendu frontend. Donne à chacun une mission précise et exige des preuves avec fichier:ligne.\n- Tiens une liste todo et déroule-la ; marque chaque zone terminée quand ses preuves sont collectées.\n\nOBJECTIF DE PROFONDEUR : inspecte au moins ${plan.budget.minReads} fichiers candidats distincts, effectue ${plan.budget.minSearches} recherches ciblées et couvre ${plan.budget.targetCategories} catégories de risque. C'est un plancher, pas un point d'arrêt : continue tant qu'il reste des candidats pertinents et que le budget de tours le permet.\n\nRÈGLES DE PREUVE : n'affiche jamais les valeurs de secrets. Les motifs sont des pistes, pas des failles. Confirme chaque constat en lisant le code concerné et cite fichier:ligne avec le trajet source-vers-sink. Si une limite est atteinte, indique exactement ce qui reste non couvert.\nSignaux par catégorie : ${categories}\nCandidats prioritaires :\n${candidates || '(aucun)'}`;
}

// Seed todo list injected at the start of an investigation. Claude Code drives
// thoroughness with a self-managed plan rather than a server-side counter; the
// seed gives weaker models the same structure to follow.
function investigationTodoSeed(plan, language = 'fr') {
  const fr = language !== 'en';
  const present = new Set(CATEGORY_RULES.filter((rule) => plan.categoryCounts[rule.id]).map((rule) => rule.id));
  const labels = fr
    ? {
        map: `Cartographier le dépôt et cibler les ${plan.budget.minReads} fichiers les plus à risque`,
        auth: 'Authentification, sessions et autorisations',
        database: 'Base de données, requêtes et injections',
        entrypoints: 'Entrées HTTP/API et validation des paramètres',
        crypto: 'Secrets, jetons et cryptographie',
        rendering: 'Rendu web, XSS et sorties non échappées',
        files: 'Fichiers, chemins, uploads et traversée',
        commands: 'Exécution de commandes et processus',
        dependencies: 'Dépendances et chaîne de build',
        report: 'Rédiger le rapport final étayé (constats, sévérité, remédiation, couverture)',
      }
    : {
        map: `Map the repository and target the ${plan.budget.minReads} highest-risk files`,
        auth: 'Authentication, sessions and authorization',
        database: 'Database, queries and injections',
        entrypoints: 'HTTP/API entry points and parameter validation',
        crypto: 'Secrets, tokens and cryptography',
        rendering: 'Web rendering, XSS and unescaped output',
        files: 'Files, paths, uploads and traversal',
        commands: 'Command and process execution',
        dependencies: 'Dependencies and build chain',
        report: 'Write the evidence-backed final report (findings, severity, remediation, coverage)',
      };
  const items = [{ content: labels.map, status: 'in_progress' }];
  for (const rule of CATEGORY_RULES) {
    if (present.has(rule.id) && labels[rule.id]) items.push({ content: labels[rule.id], status: 'pending' });
  }
  items.push({ content: labels.report, status: 'pending' });
  return items;
}

function createCoverageState(plan) {
  return {
    plan, readFiles: new Set(), searches: 0, inventories: 0, coveredCategories: new Set(),
    retries: 0, synthesisRequested: false, validationRequested: false, finalRetries: 0,
    bestDraft: '', evidenceChunks: [], evidenceChars: 0,
    // Compacted digest of evidence that aged out of the live window, so the
    // model still knows those files were examined instead of losing them.
    compactedDigest: [],
    // Stall detection: how many nudge rounds produced no new file/category.
    lastReadCount: 0, lastCategoryCount: 0, stalledRounds: 0,
  };
}

function categoriesForPath(plan, file) {
  const normalized = slash(file).replace(/^\.\//, '');
  const candidate = plan.candidates.find((item) => item.path === normalized);
  if (candidate) return candidate.categories;
  return CATEGORY_RULES.filter((rule) => rule.path.test(normalized)).map((rule) => rule.id);
}

function observeTool(state, tool, result) {
  if (!state || !tool) return;
  const name = tool.name || tool.tool;
  const input = tool.input || result?.input || {};
  if (name === 'read') {
    for (const file of input.paths || []) {
      const normalized = slash(file).replace(/^\.\//, '');
      state.readFiles.add(normalized);
      for (const category of categoriesForPath(state.plan, normalized)) state.coveredCategories.add(category);
    }
  } else if (name === 'grep' || (name === 'audit' && input.action === 'grep')) {
    state.searches++;
  } else if (name === 'audit' && input.action === 'inventory') {
    state.inventories++;
  }
  if (result && result.text && ['read', 'grep', 'audit', 'git', 'lsp'].includes(name)) {
    const cap = name === 'grep' || (name === 'audit' && input.action === 'grep') ? 10_000 : 7_000;
    const chunk = `[${result.summary || name}]\n${redactSecrets(result.text).slice(0, cap)}`;
    state.evidenceChunks.push(chunk);
    state.evidenceChars += chunk.length;
    // Compaction instead of silent loss: when the live window overflows, the
    // oldest chunk is replaced by its header line in a digest. The model keeps
    // knowing that file was examined (Claude Code compacts, it never drops).
    while (state.evidenceChars > 42_000 && state.evidenceChunks.length > 1) {
      const dropped = state.evidenceChunks.shift();
      state.evidenceChars -= dropped.length;
      const header = String(dropped.split('\n', 1)[0] || '').slice(0, 160);
      if (header && !state.compactedDigest.includes(header)) state.compactedDigest.push(header);
      if (state.compactedDigest.length > 120) state.compactedDigest.shift();
    }
  }
  const nested = result && Array.isArray(result.subToolResults) ? result.subToolResults : [];
  for (const item of nested) observeTool(state, { name: item.tool, input: item.input || {} }, item);
}

function coverageSnapshot(state) {
  const plan = state.plan;
  const relevantRead = [...state.readFiles].filter((file) => plan.candidates.some((item) => item.path === file)).length;
  const readCount = Math.max(relevantRead, state.readFiles.size);
  const ready = readCount >= plan.budget.minReads && state.searches >= plan.budget.minSearches && state.coveredCategories.size >= Math.min(plan.budget.targetCategories, Object.values(plan.categoryCounts).filter(Boolean).length || 1);
  const exhaustive = !plan.scope.inventoryTruncated && plan.scope.relevantFiles > 0 && state.readFiles.size >= plan.scope.relevantFiles;
  return { readCount, searches: state.searches, categories: state.coveredCategories.size, ready, exhaustive, stalled: state.stalledRounds >= 2 };
}

// Records whether the last nudge round actually advanced coverage. Two
// consecutive rounds without a new file or category means the model has
// nothing left to add — pushing further would only burn rounds.
function noteCoverageProgress(state) {
  const readCount = state.readFiles.size;
  const categoryCount = state.coveredCategories.size;
  if (readCount > state.lastReadCount || categoryCount > state.lastCategoryCount) state.stalledRounds = 0;
  else state.stalledRounds++;
  state.lastReadCount = readCount;
  state.lastCategoryCount = categoryCount;
  return state.stalledRounds;
}

function coverageRetryPrompt(state, originalMessage, language = 'fr') {
  const snapshot = coverageSnapshot(state);
  const remaining = state.plan.candidates.filter((item) => !state.readFiles.has(item.path)).slice(0, 20).map((item) => item.path);
  if (language === 'en') return `Coverage is still below the depth target: ${snapshot.readCount}/${state.plan.budget.minReads} candidate files read, ${snapshot.searches}/${state.plan.budget.minSearches} targeted searches, ${snapshot.categories}/${state.plan.budget.targetCategories} categories. Keep investigating before the final report.\nWork in BATCHES to catch up fast: pass several paths to ONE read call, and delegate an untouched area to a read-only subagent with task if that is faster.\nNot yet read: ${remaining.join(', ') || '(none)'}.\nOriginal request: ${originalMessage}`;
  return `La couverture est encore sous l'objectif de profondeur : ${snapshot.readCount}/${state.plan.budget.minReads} fichiers candidats lus, ${snapshot.searches}/${state.plan.budget.minSearches} recherches ciblées, ${snapshot.categories}/${state.plan.budget.targetCategories} catégories. Continue l'investigation avant le rapport final.\nTravaille par LOTS pour rattraper vite : passe plusieurs chemins à UN SEUL appel read, et délègue une zone non traitée à un sous-agent en lecture seule via task si c'est plus rapide.\nPas encore lus : ${remaining.join(', ') || '(aucun)'}.\nDemande originale : ${originalMessage}`;
}

function synthesisPrompt(state, latestEvidence, originalMessage, language = 'fr') {
  const snapshot = coverageSnapshot(state);
  const evidence = redactSecrets(latestEvidence).slice(0, 32_000);
  if (language === 'en') return `[EVIDENCE COVERAGE REACHED]\nYou have enough breadth for a targeted synthesis: ${snapshot.readCount} files, ${snapshot.searches} searches, ${snapshot.categories} categories. Produce the complete evidence-backed report now. Do not announce future work. Do not call more tools unless one missing fact is indispensable. Separate confirmed findings from leads; cite file:line and explain source-to-sink for every confirmed finding. State that coverage is targeted when it is not exhaustive. Never expose secret values.\nOriginal request: ${originalMessage}\nLatest evidence:\n${evidence}`;
  return `[COUVERTURE DE PREUVES ATTEINTE]\nLa couverture est suffisante pour une synthèse ciblée : ${snapshot.readCount} fichiers, ${snapshot.searches} recherches, ${snapshot.categories} catégories. Produis maintenant le rapport complet étayé. N'annonce pas un travail futur. Ne rappelle un outil que si un fait manquant est indispensable. Sépare les constats confirmés des pistes ; cite fichier:ligne et explique le trajet source-vers-sink pour chaque constat confirmé. Indique que la couverture est ciblée lorsqu'elle n'est pas exhaustive. N'affiche jamais de valeur secrète.\nDemande originale : ${originalMessage}\nDernières preuves :\n${evidence}`;
}

function validationPrompt(state, draft, originalMessage, language = 'fr') {
  const snapshot = coverageSnapshot(state);
  const files = [...state.readFiles].slice(0, 60).join(', ') || '(aucun)';
  const safeDraft = redactSecrets(draft).slice(0, 16_000);
  const evidence = redactSecrets(state.evidenceChunks.join('\n\n')).slice(-42_000);
  const digest = state.compactedDigest && state.compactedDigest.length
    ? `\n${language === 'en' ? 'Earlier evidence, compacted (these were examined too)' : 'Preuves antérieures, compactées (ces éléments ont aussi été examinés)'} :\n${state.compactedDigest.slice(-40).join('\n')}`
    : '';
  if (language === 'en') return `[ADVERSARIAL EVIDENCE REVIEW — ANNOTATE, DO NOT DELETE]\nYou are reviewing the draft below. Your job is to make it ACCURATE, not to empty it. Return the COMPLETE report, keeping every finding the evidence supports.\n\nCONFIRM a finding when the evidence shows it, do not weaken it:\n- SQL built by string concatenation/format with a request-derived value\n- a mutating route with no authentication or authorization check\n- a secret, token or HMAC compared with == instead of a constant-time compare\n- user input reaching innerHTML/outerHTML/document.write or an unescaped template\n- a secret, private key or credential returned to the client or written to a log\n- a path built from user input without containment check (traversal)\n- missing/disabled signature verification on a webhook or callback\n\nDOWNGRADE to "Leads" (with the reason) only these known false positives:\n- spawn/execFile with an argument array and no shell: not shell injection\n- a disabled Chromium sandbox: defense-in-depth, needs a separate reachable exploit\n- replacing a local binary: already presupposes local write access\n- an environment variable with no proven attacker-controlled path\n- a filename, a bare regex hit, SQLite usage, or a precise CORS origin alone\n\nAnything else that is evidenced STAYS under "Confirmed findings". Never delete a finding silently: if you move one, say why in one clause. Never reproduce a secret value.\n\nRequired structure: Executive summary → Confirmed findings (each: file:line, attacker-controlled source, dangerous sink, exploit conditions, impact, SEVERITY Critical/High/Medium/Low, REMEDIATION, confidence) → Leads requiring verification → Coverage and limitations.\nCoverage: ${snapshot.readCount} files read, ${snapshot.searches} searches, ${snapshot.categories} categories. Files read: ${files}.\nOriginal request: ${originalMessage}\nDraft to review:\n${safeDraft}\n\nActual redacted tool evidence:\n${evidence}${digest}`;
  return `[REVUE ADVERSARIALE DES PREUVES — ANNOTE, NE SUPPRIME PAS]\nTu relis le brouillon ci-dessous. Ton rôle est de le rendre EXACT, pas de le vider. Rends le rapport COMPLET en conservant tout constat étayé par les preuves.\n\nCONFIRME un constat quand les preuves le montrent, ne l'affaiblis pas :\n- SQL construit par concaténation/format avec une valeur issue de la requête\n- route mutante sans contrôle d'authentification ou d'autorisation\n- secret, jeton ou HMAC comparé avec == au lieu d'une comparaison à temps constant\n- entrée utilisateur atteignant innerHTML/outerHTML/document.write ou un gabarit non échappé\n- secret, clé privée ou identifiant renvoyé au client ou écrit dans un log\n- chemin construit depuis une entrée utilisateur sans contrôle de confinement (traversée)\n- vérification de signature absente ou désactivée sur un webhook ou un callback\n\nRÉTROGRADE en « Pistes » (en donnant la raison) uniquement ces faux positifs connus :\n- spawn/execFile avec tableau d'arguments et sans shell : ce n'est pas une injection shell\n- sandbox Chromium désactivé : défense en profondeur, exige un exploit distinct accessible\n- remplacer un binaire local : suppose déjà un accès local en écriture\n- variable d'environnement sans chemin contrôlable par l'attaquant démontré\n- un nom de fichier, un simple résultat regex, l'usage de SQLite ou une origine CORS précise seuls\n\nTout le reste qui est étayé RESTE dans « Constats confirmés ». Ne supprime jamais un constat en silence : si tu en déplaces un, dis pourquoi en une proposition. Ne reproduis jamais une valeur secrète.\n\nStructure obligatoire : Résumé exécutif → Constats confirmés (chacun : fichier:ligne, source contrôlable par l'attaquant, sink dangereux, conditions d'exploitation, impact, SÉVÉRITÉ Critique/Élevé/Moyen/Faible, REMÉDIATION concrète, confiance) → Pistes à vérifier → Couverture et limites.\nCouverture : ${snapshot.readCount} fichiers lus, ${snapshot.searches} recherches, ${snapshot.categories} catégories. Fichiers lus : ${files}.\nDemande originale : ${originalMessage}\nBrouillon à relire :\n${safeDraft}\n\nPreuves réelles des outils, déjà masquées :\n${evidence}${digest}`;
}

function finalSystemPrompt(language = 'fr') {
  if (language === 'en') return `[CONFIDENTIAL]\nYou are the final evidence reviewer for a coding agent. Tools are intentionally disabled. Return ONLY the finished security report in the user's language; never announce what you will do and never output tool syntax.\n\nWrite these four sections, in this order:\n1. “Executive summary” — 2 to 4 sentences: what was reviewed, how many findings and the highest severity.\n2. “Confirmed findings” — numbered. Each one: file:line, attacker-controlled source, dangerous sink, exploit conditions, impact, Severity (Critical/High/Medium/Low), Remediation (a concrete actionable fix), confidence. If and only if nothing is proven, write exactly “No confirmed findings”.\n3. “Leads requiring verification” — plausible but unproven, each with what is missing to confirm it.\n4. “Coverage and limitations” — what was reviewed and what remains unreviewed.\n\nKeep every finding the evidence supports — your job is accuracy, not deletion. Confirm evidenced SQL string-concatenation injections, missing authorization on mutating routes, non-constant-time secret comparisons, user input reaching innerHTML, secrets returned to clients or logged, path traversal, and missing webhook signature checks. Downgrade to leads only the classic false positives: spawn/execFile argument arrays without a shell are not shell injection; defense-in-depth settings such as no-sandbox need a separate reachable exploit; local binary replacement presupposes local write access; environment data needs a proven attacker-controlled path; a filename, a bare regex hit, SQLite, or a precise CORS origin alone. Treat pattern matches as leads, not vulnerabilities. Never reveal secret values. Never claim exhaustive coverage unless the supplied coverage says it is exhaustive.`;
  return `[CONFIDENTIEL]\nTu es le relecteur final des preuves d'un agent de code. Les outils sont volontairement désactivés. Rends UNIQUEMENT le rapport de sécurité terminé en français ; n'annonce jamais ce que tu vas faire et n'affiche aucune syntaxe d'outil.\n\nÉcris ces quatre sections, dans cet ordre :\n1. « Résumé exécutif » — 2 à 4 phrases : ce qui a été examiné, combien de constats et la sévérité la plus élevée.\n2. « Constats confirmés » — numérotés. Chacun : fichier:ligne, source contrôlable par l'attaquant, sink dangereux, conditions d'exploitation, impact, Sévérité (Critique/Élevé/Moyen/Faible), Remédiation (correctif concret et actionnable), confiance. Si et seulement si rien n'est prouvé, écris exactement « Aucun constat confirmé ».\n3. « Pistes à vérifier » — plausibles mais non prouvées, avec ce qui manque pour conclure.\n4. « Couverture et limites » — ce qui a été examiné et ce qui reste non couvert.\n\nConserve tout constat étayé par les preuves : ton rôle est l'exactitude, pas la suppression. Confirme, quand la preuve est là : les injections SQL par concaténation, l'absence d'autorisation sur une route mutante, les comparaisons de secrets hors temps constant, une entrée utilisateur atteignant innerHTML, un secret renvoyé au client ou journalisé, la traversée de chemin, et l'absence de vérification de signature d'un webhook. Ne rétrograde en pistes que les faux positifs classiques : un tableau d'arguments spawn/execFile sans shell n'est pas une injection shell ; les réglages de défense en profondeur comme no-sandbox exigent un exploit distinct accessible ; remplacer un binaire local suppose déjà un accès local en écriture ; une donnée d'environnement exige un chemin contrôlable prouvé ; un nom de fichier, un simple résultat regex, SQLite ou une origine CORS précise seuls. Les résultats de motifs sont des pistes, pas des vulnérabilités. Ne révèle jamais de valeur secrète. Ne prétends à l'exhaustivité que si la couverture fournie l'indique.`;
}

// Detects a real code reference in the final report. Deliberately permissive:
// a good report must never be rejected over citation FORMATTING. Accepts
// "file.go:42", "file.go ligne 42", "file.go (L42)", "line 42 of file.go".
function hasEvidenceCitation(text) {
  const body = String(text || '');
  const fileToken = '[A-Za-z0-9_.@+/-]+\\.[A-Za-z0-9]+';
  // The boundary accepts any non-identifier character, so markdown decoration
  // (**file.go:42**, `file.go:42`, [file.go:42]) never hides a real citation.
  return new RegExp(`(?:^|[^A-Za-z0-9_])(?:${fileToken}|\\.[A-Za-z0-9_-]+):\\d+\\b`, 'm').test(body)
    || new RegExp(`${fileToken}[^\\n]{0,40}?\\b(?:ligne|lignes|line|lines|L)\\s*\\.?\\s*:?\\s*\\d+`, 'i').test(body)
    || new RegExp(`\\b(?:ligne|lignes|line|lines)\\s+\\d+[^\\n]{0,40}?${fileToken}`, 'i').test(body)
    || new RegExp(`${fileToken}\\s*\\(\\s*L\\.?\\s*\\d+`, 'i').test(body);
}

function finalAnswerNeedsRetry(response, language = 'fr') {
  const text = String(response || '').trim();
  if (!text) return true;
  // A page of empty list markers used to sail through: it has no citation, so
  // it was "preserved" with a polite note and shipped. Structure without
  // content is not a report.
  if (responseIntegrity.isDegenerate(text)) return true;
  const progressOnly = language === 'en'
    ? /^(?:i(?:'m| am)? going to|i will|let me|i(?:'ll| will) now|starting|i am starting)\b/i.test(text)
    : /^(?:je vais|je commence|je vais maintenant|commençons|analyse en cours|j['’]analyse maintenant)\b/i.test(text);
  const explicitNoFinding = language === 'en'
    ? /\b(?:no confirmed findings?|no vulnerability was confirmed|none confirmed)\b/i.test(text)
    : /\b(?:aucun constat confirm[eé]|aucune vuln[eé]rabilit[eé] confirm[eé]e|aucune faille confirm[eé]e)\b/i.test(text);
  return progressOnly || (!hasEvidenceCitation(text) && !explicitNoFinding);
}

function finalAnswerRetryPrompt(state, originalMessage, language = 'fr') {
  const snapshot = coverageSnapshot(state);
  const draft = redactSecrets(state.bestDraft || '').slice(0, 16_000);
  const evidence = redactSecrets(state.evidenceChunks.join('\n\n')).slice(-32_000);
  if (language === 'en') return `[FINAL REPORT REQUIRED]\nYour previous output was a progress announcement or lacked verifiable evidence. The investigation phase is over. Return the final answer now, not a plan. Use exactly these sections: Confirmed findings (or explicitly “No confirmed findings”), Leads requiring verification, Coverage and limitations. Every confirmed finding must cite file:line and explain source, sink, exploit condition, impact, and confidence. Apply the false-positive controls from the system prompt. Never expose secret values. Do not claim exhaustive coverage. Evidence collected: ${snapshot.readCount} files, ${snapshot.searches} searches, ${snapshot.categories} categories. Original request: ${originalMessage}\nEvidence draft to correct:\n${draft}\n\nActual redacted tool evidence:\n${evidence}`;
  return `[RAPPORT FINAL REQUIS]\nTa réponse précédente était encore une annonce de progression ou ne contenait aucune preuve vérifiable. La phase d'investigation est terminée. Rends maintenant la réponse finale, pas un plan. Utilise exactement ces sections : Constats confirmés (ou indique explicitement « Aucun constat confirmé »), Pistes à vérifier, Couverture et limites. Chaque constat confirmé doit citer fichier:ligne et expliquer source, sink, condition d'exploitation, impact et confiance. Applique les contrôles anti-faux-positifs du prompt système. N'affiche jamais les valeurs de secrets et ne prétends pas à une couverture exhaustive. Preuves collectées : ${snapshot.readCount} fichiers, ${snapshot.searches} recherches, ${snapshot.categories} catégories. Demande originale : ${originalMessage}\nBrouillon de preuves à corriger :\n${draft}\n\nPreuves réelles des outils, déjà masquées :\n${evidence}`;
}

function speculativeReason(block) {
  const text = normalize(block);
  if (/no-sandbox|sandbox chromium desactive|disabled chromium sandbox/.test(text)) {
    return 'défense en profondeur : nécessite un exploit distinct et une accessibilité démontrée';
  }
  if (/(secret|token).*(?:environnement|environment).*(?:processus enfant|child process)|(?:processus enfant|child process).*(?:secret|token)/s.test(text) && /(?:si|if).*(?:compromis|compromised)/s.test(text)) {
    return 'relation de confiance : compromettre le processus destinataire est déjà un prérequis non démontré';
  }
  if (/injection (?:de )?command|command injection/.test(text) && /\b(?:spawn|execfile)\b/.test(text) && !/shell\s*:\s*true/.test(text)) {
    return 'faux positif shell : spawn/execFile sans shell conserve les arguments séparés';
  }
  if (/(?:remplac|replace).*(?:binaire|binary|executable)/s.test(text) && /(?:acces local en ecriture|local write access|attaque locale|local attack)/s.test(text)) {
    return 'prérequis circulaire : suppose déjà un accès local en écriture';
  }
  return '';
}

function demoteSpeculativeFindings(response, language = 'fr') {
  const text = String(response || '');
  const confirmedHeading = /(^|\n)(?:#{1,6}\s*)?(?:\*\*)?(?:Constats confirm[eé]s|Confirmed findings)(?:\*\*)?\s*\n/i.exec(text);
  if (!confirmedHeading) return text;
  const confirmedStart = confirmedHeading.index + confirmedHeading[0].length;
  const afterConfirmed = text.slice(confirmedStart);
  const leadsHeading = /(^|\n)(?:-{3,}\s*\n)?(?:#{1,6}\s*)?(?:\*\*)?(?:Pistes (?:à|a) v[eé]rifier|Leads requiring verification)(?:\*\*)?\s*\n/i.exec(afterConfirmed);
  if (!leadsHeading) return text;
  const leadsStart = confirmedStart + leadsHeading.index;
  const leadsBodyStart = confirmedStart + leadsHeading.index + leadsHeading[0].length;
  const afterLeads = text.slice(leadsBodyStart);
  const coverageHeading = /(^|\n)(?:-{3,}\s*\n)?(?:#{1,6}\s*)?(?:\*\*)?(?:Couverture et limites|Coverage and limitations)(?:\*\*)?\s*\n/i.exec(afterLeads);
  const coverageStart = coverageHeading ? leadsBodyStart + coverageHeading.index : text.length;
  const confirmedBody = text.slice(confirmedStart, leadsStart).trim().replace(/(?:\n\s*-{3,}\s*)+$/g, '').trim();
  const leadBody = text.slice(leadsBodyStart, coverageStart).trim().replace(/(?:\n\s*-{3,}\s*)+$/g, '').trim();
  const blocks = confirmedBody.split(/\n(?=\s*(?:\*\*)?\d+[.)]\s)/).map((item) => item.trim()).filter(Boolean);
  const kept = [];
  const demoted = [];
  for (const block of blocks.length ? blocks : [confirmedBody]) {
    const reason = speculativeReason(block);
    if (!reason) kept.push(block);
    else demoted.push(`- [À valider — ${reason}]\n  ${block.replace(/\n/g, '\n  ')}`);
  }
  if (!demoted.length) return text;
  const noFinding = language === 'en' ? 'No confirmed findings.' : 'Aucun constat confirmé.';
  const newConfirmed = kept.length ? kept.join('\n\n') : noFinding;
  const newLeads = [leadBody, ...demoted].filter(Boolean).join('\n\n');
  const confirmedPrefix = text.slice(0, confirmedStart);
  const leadsHeadingText = text.slice(leadsStart, leadsBodyStart);
  const coverageAndAfter = text.slice(coverageStart);
  return `${confirmedPrefix}${newConfirmed}\n\n${leadsHeadingText}${newLeads}\n\n${coverageAndAfter}`.replace(/\n{4,}/g, '\n\n\n').trim();
}

// Engine-generated coverage footer, recognised so finalizeResponse can be
// called unconditionally without stacking a second one. This matters for
// security: the speculative-finding demotion lives here, and it used to be
// skipped whenever the model happened to write "Couverture :" itself.
const ENGINE_COVERAGE_LINE = /^\s*(?:Couverture|Coverage)\s*:[^\n]*(?:fichiers pertinents lus|relevant files read)[^\n]*$/gm;

function finalizeResponse(state, response, language = 'fr') {
  const snapshot = coverageSnapshot(state);
  let text = demoteSpeculativeFindings(redactSecrets(response).replace(ENGINE_COVERAGE_LINE, '').trim(), language);
  text = text
    .replace(/\b(?:toutes?|l['’]ensemble de)\s+(?:les\s+)?(?:failles|vuln[eé]rabilit[eé]s)\b/gi, 'les vulnérabilités confirmées dans le périmètre analysé')
    .replace(/\b(?:all|every)\s+(?:security\s+)?vulnerabilit(?:y|ies)\b/gi, 'the vulnerabilities confirmed in the reviewed scope');
  const citations = text.match(/(?:^|[\s(])((?:[A-Za-z0-9_.@+/-]+\.[A-Za-z0-9]+|\.[A-Za-z0-9_-]+)):(\d+)\b/g) || [];
  const fr = language !== 'en';
  if (!state.readFiles.size) {
    return fr
      ? `Analyse non concluante : le modèle n'a lu aucun fichier du projet. Aucun constat de sécurité n'est considéré comme confirmé.\n\n${text}`
      : `Inconclusive analysis: the model did not read any project file. No security finding is considered confirmed.\n\n${text}`;
  }
  const scope = snapshot.exhaustive ? (fr ? 'exhaustive sur les fichiers pertinents inventoriés' : 'exhaustive over inventoried relevant files') : (fr ? 'ciblée et non exhaustive' : 'targeted and non-exhaustive');
  const evidence = citations.length
    ? ''
    : (fr ? ' Aucun constat sans référence fichier:ligne ne doit être considéré comme confirmé.' : ' Findings without a file:line reference must not be considered confirmed.');
  const coverage = fr
    ? `Couverture : ${scope} — ${snapshot.readCount}/${state.plan.scope.relevantFiles} fichiers pertinents lus, ${snapshot.searches} recherches ciblées, ${snapshot.categories} catégories couvertes.${evidence}`
    : `Coverage: ${scope} — ${snapshot.readCount}/${state.plan.scope.relevantFiles} relevant files read, ${snapshot.searches} targeted searches, ${snapshot.categories} categories covered.${evidence}`;
  return `${text.trim()}\n\n${coverage}`.trim();
}

// Last-resort report, used ONLY when the model produced no usable text at all.
// When a draft exists it must be preserved (see preserveDraftResponse): losing
// a real report to a canned empty shell was the worst failure mode of the
// previous pipeline.
function fallbackResponse(state, reason = '', language = 'fr') {
  const snapshot = coverageSnapshot(state);
  const reviewed = [...state.readFiles].slice(0, 12);
  const leads = reviewed.map((file) => {
    const categories = categoriesForPath(state.plan, file);
    return `- ${file} — ${categories.length ? categories.join(', ') : (language === 'en' ? 'reviewed source' : 'source inspectée')}`;
  }).join('\n') || (language === 'en' ? '- No file was successfully read.' : '- Aucun fichier n’a pu être lu.');
  const why = redactSecrets(reason).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (language === 'en') return `Confirmed findings\n\nNo confirmed findings. The final verifier did not produce evidence strong enough to promote a lead to a vulnerability.\n\nLeads requiring verification\n\n${leads}\n\nCoverage and limitations\n\nCoverage: ${snapshot.exhaustive ? 'exhaustive over the inventoried relevant files' : 'targeted and non-exhaustive'} — ${snapshot.readCount}/${state.plan.scope.relevantFiles} relevant files read, ${snapshot.searches} targeted searches, ${snapshot.categories} categories covered.${why ? ` Finalization note: ${why}.` : ''}`;
  return `Constats confirmés\n\nAucun constat confirmé. Le vérificateur final n’a pas produit de preuve assez solide pour promouvoir une piste en vulnérabilité.\n\nPistes à vérifier\n\n${leads}\n\nCouverture et limites\n\nCouverture : ${snapshot.exhaustive ? 'exhaustive sur les fichiers pertinents inventoriés' : 'ciblée et non exhaustive'} — ${snapshot.readCount}/${state.plan.scope.relevantFiles} fichiers pertinents lus, ${snapshot.searches} recherches ciblées, ${snapshot.categories} catégories couvertes.${why ? ` Note de finalisation : ${why}.` : ''}`;
}

// Keeps the model's own report when it exists, appending a short note about
// why it could not be fully verified. Never replaces content with a canned
// empty report — the caller only falls back when there is genuinely no text.
function preserveDraftResponse(state, draft, reason = '', language = 'fr') {
  const text = String(draft || '').trim();
  if (!text) return fallbackResponse(state, reason, language);
  // Preserving the model's work is the rule — but a degenerate draft (list
  // scaffolding with no content, or one line repeated) is not work. Shipping it
  // under a "could not fully validate the format" note is how the user got a
  // page of empty bullets. Fall back to the evidence-based report instead.
  const integrity = responseIntegrity.analyzeAnswer(text);
  if (integrity.degenerate) {
    const why = responseIntegrity.degenerateReasonLabel(integrity.reason, language);
    return fallbackResponse(state, reason ? `${why} — ${reason}` : why, language);
  }
  const why = redactSecrets(reason).replace(/\s+/g, ' ').trim().slice(0, 200);
  const note = language === 'en'
    ? `Note: this report is returned as produced by the model; the automatic evidence check could not fully validate its format${why ? ` (${why})` : ''}. Treat findings without a file:line reference as leads.`
    : `Note : ce rapport est rendu tel que produit par le modèle ; la vérification automatique des preuves n'a pas pu en valider entièrement le format${why ? ` (${why})` : ''}. Considère comme pistes les constats sans référence fichier:ligne.`;
  return `${redactSecrets(text)}\n\n${note}`;
}

// Root cause of the repeat-until-killed loop: old tool results are compacted
// out of the history, so after a dozen rounds the model no longer knows which
// files it already read. It re-reads them, the identical-batch detector fires,
// and the run is killed with all its evidence. The engine HAS that knowledge in
// state.readFiles — this hands it back, every round, in ~2 KB.
function evidenceLedger(state, language = 'fr') {
  if (!state || !state.readFiles) return '';
  const fr = language !== 'en';
  const read = [...state.readFiles];
  if (!read.length && !state.searches) return '';
  const shownRead = read.slice(-70);
  const hiddenRead = read.length - shownRead.length;
  const remaining = state.plan && Array.isArray(state.plan.candidates)
    ? state.plan.candidates.filter((item) => !state.readFiles.has(item.path)).slice(0, 25).map((item) => item.path)
    : [];
  const lines = [];
  lines.push(fr
    ? '[MÉMOIRE D’INVESTIGATION — déjà fait, ne le refais pas]'
    : '[INVESTIGATION MEMORY — already done, do not redo it]');
  lines.push(fr
    ? `Fichiers déjà lus (${read.length}) : ${shownRead.join(', ')}${hiddenRead > 0 ? `, +${hiddenRead} autres` : ''}`
    : `Files already read (${read.length}): ${shownRead.join(', ')}${hiddenRead > 0 ? `, +${hiddenRead} more` : ''}`);
  lines.push(fr
    ? `Recherches ciblées effectuées : ${state.searches}. Catégories couvertes : ${state.coveredCategories.size}.`
    : `Targeted searches run: ${state.searches}. Categories covered: ${state.coveredCategories.size}.`);
  if (remaining.length) {
    lines.push(fr
      ? `Pas encore lus, par priorité : ${remaining.join(', ')}`
      : `Not yet read, by priority: ${remaining.join(', ')}`);
  }
  lines.push(fr
    ? 'Relire un fichier de cette liste ne produit aucune preuve nouvelle : lis ceux qui restent, ou rédige le rapport.'
    : 'Re-reading a file from this list produces no new evidence: read what remains, or write the report.');
  return lines.join('\n');
}

// Mechanical backstop. It runs whatever the model does, so a report can never
// be empty just because the model gave up: the pattern scanner always yields
// real file:line anchors. Its excerpts are redacted by security-pipeline.
function deterministicSweep(root, securityPipeline) {
  if (!securityPipeline || typeof securityPipeline.scan !== 'function') return null;
  try {
    const report = securityPipeline.scan({ root, mode: 'scan' });
    const findings = Array.isArray(report && report.findings) ? report.findings : [];
    return {
      findings,
      scanned: (report && report.scope && report.scope.scanned) || 0,
      high: findings.filter((item) => item.severity === 'high').length,
    };
  } catch {
    return null;
  }
}

// Adds the scanner hits the model never mentioned. Dedup is on file:line, so a
// finding the model already reported is not repeated.
function mergeDeterministicFindings(report, sweep, language = 'fr') {
  const text = String(report || '').trim();
  if (!sweep || !Array.isArray(sweep.findings) || !sweep.findings.length) return text;
  const cited = new Set((text.match(/[A-Za-z0-9_.@+/-]+\.[A-Za-z0-9]+:\d+/g) || []));
  const citedFiles = new Set([...cited].map((item) => item.replace(/:\d+$/, '')));
  const fresh = sweep.findings.filter((item) => {
    const anchor = `${item.file}:${item.line}`;
    if (cited.has(anchor)) return false;
    // Same file already analysed by the model with a nearby citation: trust the
    // model's reading over a raw regex hit.
    return !citedFiles.has(item.file);
  });
  if (!fresh.length) return text;
  const fr = language !== 'en';
  const shown = fresh.slice(0, 25);
  const hidden = fresh.length - shown.length;
  const rows = shown.map((item) => `- ${item.file}:${item.line} — ${item.rule} (${item.cwe || 'CWE n/a'}, ${item.severity}) : ${item.message}`).join('\n');
  const heading = fr ? 'Balayage déterministe (hors lecture du modèle)' : 'Deterministic sweep (outside the model reading)';
  const intro = fr
    ? `Le scanner de motifs a relevé ${fresh.length} emplacement(s) que le rapport ci-dessus ne mentionne pas. Ce sont des pistes mécaniques à confirmer par lecture, pas des vulnérabilités établies.`
    : `The pattern scanner flagged ${fresh.length} location(s) the report above does not mention. These are mechanical leads to confirm by reading, not established vulnerabilities.`;
  const more = hidden > 0 ? (fr ? `\n- (+${hidden} autres emplacements non listés)` : `\n- (+${hidden} more locations not listed)`) : '';
  return `${text}\n\n${heading}\n\n${intro}\n\n${rows}${more}`;
}

module.exports = {
  CATEGORY_RULES,
  detectInvestigation,
  buildInvestigationPlan,
  formatInvestigationContext,
  investigationTodoSeed,
  createCoverageState,
  observeTool,
  coverageSnapshot,
  noteCoverageProgress,
  hasEvidenceCitation,
  preserveDraftResponse,
  coverageRetryPrompt,
  synthesisPrompt,
  validationPrompt,
  finalSystemPrompt,
  finalAnswerNeedsRetry,
  finalAnswerRetryPrompt,
  demoteSpeculativeFindings,
  finalizeResponse,
  fallbackResponse,
  evidenceLedger,
  deterministicSweep,
  mergeDeterministicFindings,
};
