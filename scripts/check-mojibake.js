const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'rust-agent-bridge.js',
  'rust',
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

const TEXT_EXTS = new Set(['.js', '.rs', '.toml', '.html', '.css', '.md', '.json', '.cpp', '.h', '.hpp', '.iss', '.bat', '.ps1', '.rc', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', 'packages', 'installer']);

// "\u00e2" (U+00E2) followed by ANY char windows-1252 maps a 0x80-0xBF byte to
// (C1 controls, smart punctuation, tildes\u2026) \u2014 this catches double-encoded
// box-drawing, arrows and bullets (\u256d \u2192 "\u00e2\u2022\u00ad", \u276f \u2192 "\u00e2\u00af") that the previous
// hand-picked alternation list let through.
const CP1252_HIGH = '\\u0080-\\u00bf\\u20ac\\u201a\\u0192\\u201e\\u2026\\u2020\\u2021\\u02c6\\u2030\\u0160\\u2039\\u0152\\u017d\\u2018\\u2019\\u201c\\u201d\\u2022\\u2013\\u2014\\u02dc\\u2122\\u0161\\u203a\\u0153\\u017e\\u0178';
const MOJIBAKE = new RegExp('(?:\\u00c3.|\\u00c2[^\\r\\n]?|\\u00e2[' + CP1252_HIGH + ']|\\u00f0\\u0178..|\\ufffd|\\u2b26)');

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
