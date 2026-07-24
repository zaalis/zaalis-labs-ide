'use strict';

// A deterministic local baseline which stays useful even when optional SAST
// binaries are absent. Integrations can add findings to the same schema.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Generated and vendored sources create noisy matches (for example SQL-like
// strings in Go libraries). They are never application findings, even in a
// deep review; dependency risk is handled through the SBOM/scanner layer.
const ALWAYS_IGNORED = new Set(['node_modules', '.git', '.DS_Store', 'server-data', 'vendor', 'third_party', 'third-party', 'Pods', '.venv', 'venv']);
const IGNORED = new Set(['dist', 'build', 'coverage', 'installer']);
function ignoredName(name, includeIgnored = false) {
  const value = String(name || '');
  return ALWAYS_IGNORED.has(value) || (!includeIgnored && (IGNORED.has(value) || /^dist(?:[-_.]|$)/i.test(value)));
}

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeRel(root, full) { return path.relative(root, full).split(path.sep).join('/'); }
function isText(buf) { return !buf.slice(0, 4096).includes(0); }
function severityFor(rule) { return rule.startsWith('secret') ? 'high' : rule.includes('eval') || rule.includes('command') ? 'high' : 'medium'; }
function redacted(value) { const raw = String(value || ''); return raw.length <= 8 ? '••••' : `${raw.slice(0, 4)}••••${raw.slice(-4)}`; }

function finding({ rule, file, line, excerpt, cwe, message, source, sink, confidence = 'medium', status = 'candidate' }) {
  const key = `${rule}|${file}|${line}|${excerpt}`;
  return {
    id: `zaalis-${sha(key).slice(0, 16)}`, rule, cwe: cwe || '', severity: severityFor(rule), confidence, status,
    file, line, excerpt: redacted(excerpt), evidenceHash: sha(excerpt), message, source: source || null, sink: sink || null,
    impact: '', exploitConditions: '', remediation: '', test: '',
  };
}

function walk(root, { includeIgnored = false } = {}) {
  const files = []; const exclusions = []; const stack = [root];
  while (stack.length) {
    const dir = stack.pop(); let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { exclusions.push({ path: safeRel(root, dir), reason: 'unreadable' }); continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name); const rel = safeRel(root, full);
      if (ignoredName(entry.name, includeIgnored)) { exclusions.push({ path: rel, reason: ALWAYS_IGNORED.has(entry.name) ? 'third_party' : 'ignored' }); continue; }
      if (entry.isDirectory()) stack.push(full); else if (entry.isFile()) files.push(full);
    }
  }
  return { files, exclusions };
}

function scanFile(root, file) {
  let data; let st;
  try { st = fs.statSync(file); if (st.size > MAX_FILE_BYTES) return { findings: [], exclusion: { path: safeRel(root, file), reason: 'too_large', bytes: st.size } }; data = fs.readFileSync(file); } catch { return { findings: [], exclusion: { path: safeRel(root, file), reason: 'unreadable' } }; }
  if (!isText(data)) return { findings: [], exclusion: { path: safeRel(root, file), reason: 'binary', bytes: st.size } };
  const content = data.toString('utf8'); const rel = safeRel(root, file); const findings = [];
  const rules = [
    { rule: 'secret.aws_access_key', re: /\b(AKIA[0-9A-Z]{16})\b/g, cwe: 'CWE-798', message: 'Clé AWS potentielle dans le dépôt.' },
    { rule: 'secret.github_token', re: /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, cwe: 'CWE-798', message: 'Jeton GitHub potentiel dans le dépôt.' },
    { rule: 'secret.private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, cwe: 'CWE-321', message: 'Clé privée potentielle dans le dépôt.' },
    { rule: 'javascript.eval', re: /\beval\s*\(/g, cwe: 'CWE-95', message: 'Exécution dynamique via eval.' },
    { rule: 'javascript.child_process', re: /(?:exec|spawn|execFile)\s*\([^\n]{0,240}(?:req\.|params\.|query\.|body\.)/g, cwe: 'CWE-78', message: 'Entrée HTTP potentiellement transmise à une commande.' },
    { rule: 'sql.concatenation', re: /(?:SELECT|INSERT|UPDATE|DELETE)[^\n]{0,200}(?:\+|\$\{)/gi, cwe: 'CWE-89', message: 'Requête SQL construite par concaténation.' },
    { rule: 'path.traversal', re: /path\.join\([^\n]{0,200}(?:req\.|params\.|query\.|body\.)/g, cwe: 'CWE-22', message: 'Chemin construit à partir d’une entrée HTTP.' },
  ];
  for (const rule of rules) {
    let match; while ((match = rule.re.exec(content))) {
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      findings.push(finding({ ...rule, file: rel, line, excerpt: match[0] }));
      if (findings.length > 200) break;
    }
  }
  return { findings, exclusion: null };
}

function inventory(root, opts = {}) {
  const { files, exclusions } = walk(root, opts);
  const selected = Array.isArray(opts.paths) && opts.paths.length
    ? new Set(opts.paths.map((item) => String(item || '').replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))
    : null;
  const scoped = selected ? files.filter((file) => selected.has(safeRel(root, file))) : files;
  const types = {}; let bytes = 0;
  for (const file of scoped) { const ext = path.extname(file).toLowerCase() || '(none)'; types[ext] = (types[ext] || 0) + 1; try { bytes += fs.statSync(file).size; } catch {} }
  return { files: scoped.map((file) => safeRel(root, file)), types, bytes, exclusions };
}

function changedPaths(root) {
  const args = (list) => {
    try { return execFileSync('git', ['-C', root, ...list], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).split(/\r?\n/).map((item) => item.trim()).filter(Boolean); } catch { return []; }
  };
  // Both staged and unstaged changes matter for a review before commit; add
  // untracked source files as they are often the actual change under review.
  return Array.from(new Set([
    ...args(['diff', '--name-only']),
    ...args(['diff', '--cached', '--name-only']),
    ...args(['ls-files', '--others', '--exclude-standard']),
  ])).filter((item) => !item.startsWith('../') && !path.isAbsolute(item));
}

function dependencyInventory(root) {
  const packageFile = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    let transitive = [];
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
      if (lock.packages && typeof lock.packages === 'object') {
        transitive = Object.entries(lock.packages)
          .filter(([location, value]) => location.startsWith('node_modules/') && value && typeof value === 'object')
          .map(([location, value]) => ({ name: value.name || location.slice('node_modules/'.length), version: String(value.version || ''), license: String(value.license || '') }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } else if (lock.dependencies && typeof lock.dependencies === 'object') {
        transitive = Object.entries(lock.dependencies).map(([name, value]) => ({ name, version: String(value && value.version || ''), license: String(value && value.license || '') })).sort((a, b) => a.name.localeCompare(b.name));
      }
    } catch {}
    return { ecosystem: 'npm', manifest: 'package.json', direct, transitive, lockfile: fs.existsSync(path.join(root, 'package-lock.json')) ? 'package-lock.json' : null };
  } catch { return { ecosystem: null, direct: {}, lockfile: null }; }
}

function technologyInventory(inv) {
  const names = new Set(inv.files.map((item) => item.toLowerCase()));
  const has = (re) => [...names].some((item) => re.test(item));
  return {
    languages: Object.entries(inv.types).filter(([ext]) => ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.swift', '.java', '.go', '.rs'].includes(ext)).map(([ext, count]) => ({ extension: ext, files: count })),
    delivery: [
      ...(has(/(^|\/)dockerfile$|docker-compose/) ? ['containers'] : []),
      ...(has(/(^|\/)\.github\/workflows\/|gitlab-ci|azure-pipelines|jenkinsfile/) ? ['ci'] : []),
      ...(has(/terraform|\.tf$|kubernetes|helm|cloudformation/) ? ['infrastructure'] : []),
    ],
  };
}

function sbom(dependencies) {
  const components = [
    ...Object.entries(dependencies.direct || {}).map(([name, version]) => ({ name, version: String(version), scope: 'required', direct: true })),
    ...(dependencies.transitive || []).map((item) => ({ name: item.name, version: item.version, scope: 'required', direct: false, licenses: item.license ? [{ license: { id: item.license } }] : undefined })),
  ].filter((item, index, rows) => rows.findIndex((other) => other.name === item.name && other.version === item.version) === index);
  return {
    cyclonedx: { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${crypto.randomUUID()}`, version: 1, metadata: { timestamp: new Date().toISOString(), tools: [{ vendor: 'Zaalis', name: 'Zaalis Security' }] }, components: components.map((item) => ({ type: 'library', name: item.name, version: item.version, scope: item.scope, ...(item.licenses ? { licenses: item.licenses } : {}) })) },
    spdx: { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'zaalis-security-sbom', documentNamespace: `https://zaalis.local/sbom/${crypto.randomUUID()}`, creationInfo: { creators: ['Tool: Zaalis Security'], created: new Date().toISOString() }, packages: components.map((item, index) => ({ SPDXID: `SPDXRef-Package-${index + 1}`, name: item.name, versionInfo: item.version || 'NOASSERTION', downloadLocation: 'NOASSERTION', licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION' })) },
  };
}

function externalScannerStatus() {
  const binaries = ['gitleaks', 'semgrep', 'osv-scanner', 'syft', 'trivy'];
  return binaries.map((name) => {
    try { return { name, available: execFileSync('/usr/bin/which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim().length > 0 }; } catch { return { name, available: false }; }
  });
}

function threatModel(root, inv) {
  const names = new Set(inv.files.map((item) => item.toLowerCase()));
  const surfaces = [];
  if ([...names].some((item) => /server|app|route|controller|api/.test(item))) surfaces.push('HTTP/API locale ou distante');
  if ([...names].some((item) => /docker|terraform|kubernetes|\.ya?ml$/.test(item))) surfaces.push('CI/CD, conteneurs ou infrastructure');
  if ([...names].some((item) => /auth|login|session|user/.test(item))) surfaces.push('authentification et sessions');
  return { root, assets: ['code source', 'secrets locaux', 'jetons API', 'données utilisateur'], trustBoundaries: ['entrée utilisateur → agent', 'agent → outils', 'processus local → réseau', 'projet → système de fichiers'], attackSurface: surfaces };
}

function toSarif(report) {
  const rules = []; const seen = new Set();
  for (const item of report.findings) if (!seen.has(item.rule)) { seen.add(item.rule); rules.push({ id: item.rule, shortDescription: { text: item.message }, properties: { tags: [item.cwe].filter(Boolean) } }); }
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'Zaalis Security', rules } }, results: report.findings.map((item) => ({ ruleId: item.rule, level: item.severity === 'high' ? 'error' : 'warning', message: { text: item.message }, locations: [{ physicalLocation: { artifactLocation: { uri: item.file }, region: { startLine: item.line } } }], partialFingerprints: { zaalisFinding: item.id } })) }] };
}

function toMarkdown(report) {
  const rows = [
    '# Rapport de sécurité Zaalis', '',
    `- Généré : ${report.generatedAt}`, `- Périmètre : ${report.scope.kind} (${report.scope.scanned} fichier(s))`,
    `- Constats : ${report.summary.total} (${report.summary.high} élevés, ${report.summary.medium} moyens)`, '',
    '## Modèle de menace', '',
    ...report.threatModel.trustBoundaries.map((item) => `- ${item}`), '',
    '## Constats', '',
  ];
  if (!report.findings.length) rows.push('Aucun constat candidat.');
  for (const item of report.findings) {
    rows.push(`### ${item.id} — ${item.severity.toUpperCase()}`, '', `- Règle/CWE : ${item.rule}${item.cwe ? ` / ${item.cwe}` : ''}`, `- Emplacement : ${item.file}:${item.line}`, `- Statut/confiance : ${item.status} / ${item.confidence}`, `- Preuve masquée : ${item.excerpt}`, `- Impact : ${item.impact || 'À confirmer lors de la validation.'}`, `- Remédiation : ${item.remediation || 'Éviter l’entrée non fiable au niveau du sink et ajouter un test de non-régression.'}`, '');
  }
  return rows.join('\n');
}

function scan({ root, includeIgnored = false, mode = 'scan', paths } = {}) {
  const base = path.resolve(root || process.cwd());
  const scopedPaths = Array.isArray(paths) ? paths : (mode === 'diff' ? changedPaths(base) : null);
  const inv = inventory(base, { includeIgnored, paths: scopedPaths }); const findings = []; const exclusions = [...inv.exclusions];
  for (const rel of inv.files) { const result = scanFile(base, path.join(base, rel)); findings.push(...result.findings); if (result.exclusion) exclusions.push(result.exclusion); }
  const unique = Array.from(new Map(findings.map((item) => [item.id, item])).values());
  const dependencies = dependencyInventory(base);
  const report = { version: 1, generatedAt: new Date().toISOString(), mode, root: base, scope: scopedPaths ? { kind: 'changed_files', requested: scopedPaths.length, scanned: inv.files.length } : { kind: 'project', scanned: inv.files.length }, inventory: { files: inv.files.length, bytes: inv.bytes, types: inv.types }, technology: technologyInventory(inv), threatModel: threatModel(base, inv), dependencies, sbom: sbom(dependencies), scanners: { local: ['secret patterns', 'JavaScript eval', 'command injection candidate', 'SQL concatenation candidate', 'path traversal candidate'], optional: externalScannerStatus(), dynamic: { enabled: false, reason: 'Les tests dynamiques exigent un profil et une cible explicitement autorisés.' } }, exclusions, findings: unique, summary: { total: unique.length, high: unique.filter((item) => item.severity === 'high').length, medium: unique.filter((item) => item.severity === 'medium').length, low: unique.filter((item) => item.severity === 'low').length } };
  report.sarif = toSarif(report); report.markdown = toMarkdown(report); return report;
}

function validate(report, ids = []) {
  const selected = new Set(Array.isArray(ids) ? ids : []);
  const next = JSON.parse(JSON.stringify(report));
  next.findings = next.findings.map((item) => (!selected.size || selected.has(item.id)) ? { ...item, status: 'validated', confidence: item.confidence === 'low' ? 'medium' : item.confidence } : item);
  next.summary.validated = next.findings.filter((item) => item.status === 'validated').length; next.sarif = toSarif(next); next.markdown = toMarkdown(next); return next;
}

function fixPlan(report, ids = []) {
  const selected = new Set(Array.isArray(ids) ? ids : []);
  const findings = report.findings.filter((item) => !selected.size || selected.has(item.id));
  return { mode: 'controlled', changes: findings.map((item) => ({ findingId: item.id, file: item.file, line: item.line, status: item.status, proposedRemediation: item.remediation || 'Lire le contexte, appliquer un correctif minimal via edit/write approuvé, puis exécuter le test de non-régression.', requiresApproval: true })) };
}

module.exports = { scan, validate, toSarif, toMarkdown, fixPlan, redacted, finding, changedPaths };
