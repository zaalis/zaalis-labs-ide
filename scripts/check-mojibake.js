const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'agent-engine.js',
  'cli.js',
  'server.js',
  'README.md',
  'interface',
  path.join('native', 'main.cpp'),
  path.join('native', 'installer.iss'),
  path.join('native', 'README.md'),
  path.join('native', 'app.rc'),
  path.join('native', 'build_cli.bat'),
  path.join('native', 'build_server.bat'),
  path.join('native', 'build_installer.bat'),
  path.join('native', 'build_shell.bat'),
];

const TEXT_EXTS = new Set(['.js', '.html', '.css', '.md', '.json', '.cpp', '.h', '.hpp', '.iss', '.bat', '.rc', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'packages', 'installer']);

const MOJIBAKE = /(?:\u00c3.|\u00c2[^\r\n]?|\u00e2(?:\u20ac|\u201e|\u0153|\u2020|\u2021|\u2014|\u008f|\u20ac\u00a6|\u20ac\u2122|\u20ac\u0153|\u20ac\u009d|\u20ac\u201c|\u20ac\u201d|\u0153\u201c|\u0153\u2026)|\u00f0\u0178..|\ufffd|\u2b26)/;

function walk(target, files) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(full))) return;
    for (const entry of fs.readdirSync(full)) walk(path.join(target, entry), files);
    return;
  }
  if (TEXT_EXTS.has(path.extname(full).toLowerCase())) files.push(full);
}

const files = [];
for (const target of TARGETS) walk(target, files);

const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (MOJIBAKE.test(line)) {
      hits.push({
        file: path.relative(ROOT, file),
        line: index + 1,
        text: line.trim().slice(0, 180),
      });
    }
  });
}

if (hits.length) {
  console.error('Mojibake detected. Fix the encoding before building:');
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.text}`);
  process.exit(1);
}

console.log(`No mojibake detected in ${files.length} source file(s).`);
