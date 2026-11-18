#!/usr/bin/env node
'use strict';

// Vendors the latest zaalis Browser (Electron edition) into the IDE so the
// integrated browser IS that browser, not a re-implementation that drifts.
//
//   node scripts/sync-zaalis-browser.js [path/to/zaalis Browser]
//
// The upstream working tree is copied as-is (uncommitted fixes included), then
// a handful of exact, verified patches adapt it to run inside zaalis-server
// (see zaalis-browser/host.js). Every patch must match exactly once: when the
// upstream code moves, the script stops instead of shipping a half-patched
// browser.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || process.env.ZAALIS_BROWSER_SRC ||
  path.join(repo, '..', 'zaalis web', 'zaalis Browser'));
const target = path.join(repo, 'zaalis-browser', 'app');

const FILES = [
  'main.js',
  'preload-chrome.js',
  'preload-content.js',
  'LICENSE',
  'assets/logo-zaalis.png',
  'interface/aichat.html',
  'interface/aisearch.html',
  'interface/chrome.html',
  'interface/incognito.html',
  'interface/index.html',
  'interface/panel.html',
  'src/features/index.js',
];

const PATCHES = [
  {
    name: 'dossier de données propre à l’IDE',
    find: "  dataFolder = path.join(app.getPath('appData'), 'zaalis browser');",
    replace: "  // [zaalis IDE] navigateur intégré : dossier de données fourni par l'hôte.\n" +
      "  dataFolder = process.env.ZAALIS_BROWSER_DATA || path.join(app.getPath('appData'), 'zaalis browser');",
  },
  {
    name: 'secret du pont IDE fourni par le serveur',
    find: 'function ideSecretPath() {\n',
    replace: 'function ideSecretPath() {\n' +
      '  if (process.env.ZAALIS_BROWSER_SECRET_FILE) return process.env.ZAALIS_BROWSER_SECRET_FILE; // [zaalis IDE]\n',
  },
  {
    name: 'API HTTP 8715 laissée au navigateur autonome',
    find: 'function startApi() {\n',
    replace: 'function startApi() {\n' +
      '  if (process.env.ZAALIS_BROWSER_EMBEDDED) return; // [zaalis IDE] l\'IDE pilote le navigateur directement\n',
  },
  {
    name: 'pas de réserve pour les boutons de fenêtre',
    find: '    chromeView.webContents.insertCSS(`',
    replace: '    if (!process.env.ZAALIS_BROWSER_EMBEDDED) chromeView.webContents.insertCSS(`',
  },
  {
    name: 'signaler le mode embarqué au panneau',
    find: "    ...featureState('panel'),",
    replace: "    ...featureState('panel'),\n    embedded: !!process.env.ZAALIS_BROWSER_EMBEDDED,",
  },
  {
    name: 'charger les modules compatibles avec la session embarquée',
    from: '  let list = [];\n  try { list = require(\'./src/features\');',
    to: "      const mod = require('./src/features/' + name);",
    replace: [
      "  const embeddedModules = new Set(['tabgroups', 'crashes', 'safebrowsing', 'translate', 'reader', 'qrcode', 'cast']);",
      "  const modules = require('./src/features');",
      '  for (const [name, load] of Object.entries(modules)) {',
      '    if (process.env.ZAALIS_BROWSER_EMBEDDED && !embeddedModules.has(name)) continue;',
      '    try {',
      '      const mod = load();',
    ].join('\n'),
  },
  {
    name: 'photo de profil recadrée par l’hôte natif',
    from: '  let img = nativeImage.createFromPath(r.filePaths[0]);\n',
    to: '    fs.writeFileSync(avatarPath(id), img.toPNG());\n  } catch { return; }\n',
    replace: '  // [zaalis IDE] recadrage carré centré + 256 px par l\'hôte natif (WIC).\n' +
      '  try {\n' +
      '    fs.mkdirSync(avatarsDir(), { recursive: true });\n' +
      '    await nativeImage.squareAvatar(r.filePaths[0], avatarPath(id), 256);\n' +
      '  } catch { return; }\n',
  },
  {
    name: 'points d’entrée pour l’IDE',
    append: [
      '',
      '// [zaalis IDE] Points d\'entrée du navigateur intégré (zaalis-browser/host.js).',
      'module.exports = {',
      '  tabs, activeTab, createTab, closeTab, selectTab, navigateActive, resolveQuery,',
      '  runAgentTool, setAiControlBorder, agentHoldCursor, waitLoad, quickPageContext,',
      '  openAiPanel, settings,',
      '  get ideStatus() { return ideStatus; },',
      '};',
      '',
    ].join('\n'),
  },
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function packagedFeatures(text) {
  const names = [...text.matchAll(/^\s*'([a-z]+)',/gm)].map(match => match[1]);
  if (!names.includes('tabgroups')) throw new Error('Index des modules du navigateur introuvable.');
  return 'module.exports = {\n' + names.map(name => `  ${name}: () => require('./${name}'),\n`).join('') + '};\n';
}

function embeddedPanel(text) {
  const marker = '    state = d || state;';
  if (text.split(marker).length !== 2) throw new Error('Point d’insertion du panneau embarqué introuvable.');
  return text.replace(marker, `${marker}
    for (const row of document.querySelectorAll('[data-internal="extensions"], [data-internal="passwords"], [data-internal="import"], [data-internal="sync"], [data-internal="languages"], [data-internal="about"], #open-taskmanager')) {
      row.style.display = state.embedded ? 'none' : '';
    }
    const performance = document.getElementById('perf-menu-hint');
    if (performance) performance.closest('.menu-row').style.display = state.embedded ? 'none' : '';`);
}

function git(args) {
  try { return execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function main() {
  if (!fs.existsSync(path.join(source, 'main.js'))) {
    throw new Error(`Source zaalis Browser introuvable : ${source}`);
  }
  const manifest = {
    upstream: 'zaalis Browser (édition Windows, Electron)',
    commit: git(['rev-parse', 'HEAD']),
    commitDate: git(['log', '-1', '--format=%cI']),
    uncommitted: git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean),
    syncedAt: new Date().toISOString(),
    patches: PATCHES.map((patch) => patch.name),
    files: {},
  };
  const staged = new Map();
  for (const file of FILES) {
    const from = path.join(source, file);
    let data = fs.readFileSync(from);
    if (file === 'main.js') {
      // Line endings normalised so the patches match on any checkout.
      let text = data.toString('utf8').replace(/\r\n/g, '\n');
      for (const patch of PATCHES) {
        if (patch.append) { text = text.replace(/\n*$/, '\n') + patch.append; continue; }
        if (patch.from) {
          const start = text.indexOf(patch.from);
          const end = start < 0 ? -1 : text.indexOf(patch.to, start);
          if (start < 0 || end < 0 || text.indexOf(patch.from, start + 1) >= 0) {
            throw new Error(`Patch « ${patch.name} » : bloc introuvable ou ambigu.`);
          }
          text = text.slice(0, start) + patch.replace + text.slice(end + patch.to.length);
          continue;
        }
        const count = text.split(patch.find).length - 1;
        if (count !== 1) throw new Error(`Patch « ${patch.name} » : ${count} occurrence(s) au lieu d'une.`);
        text = text.replace(patch.find, () => patch.replace);
      }
      data = Buffer.from(text, 'utf8');
    }
    if (file === 'interface/panel.html') data = Buffer.from(embeddedPanel(data.toString('utf8')));
    if (file === 'src/features/index.js') data = Buffer.from(packagedFeatures(data.toString('utf8')));
    staged.set(file, data);
  }
  fs.rmSync(target, { recursive: true, force: true });
  // The current browser splits its agent, search and Chrome-level features
  // out of main.js. Those modules and the extra zaalis:// pages have to travel
  // with the vendored copy or the integrated browser cannot boot.
  for (const dir of ['src', 'assets']) {
    const from = path.join(source, dir);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, dir), { recursive: true });
  }
  for (const [file, data] of staged) {
    const to = path.join(target, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
    manifest.files[file] = sha256(data);
  }
  const interfaceDir = path.join(source, 'interface');
  if (fs.existsSync(interfaceDir)) {
    for (const name of fs.readdirSync(interfaceDir)) {
      const from = path.join(interfaceDir, name);
      const to = path.join(target, 'interface', name);
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      manifest.files[`interface/${name}`] = sha256(fs.readFileSync(to));
    }
  }
  fs.writeFileSync(path.join(target, 'UPSTREAM.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`zaalis Browser ${manifest.commit.slice(0, 7) || '(hors git)'} synchronisé dans ${path.relative(repo, target)}` +
    (manifest.uncommitted.length ? ` (+ ${manifest.uncommitted.length} modification(s) non commitée(s))` : ''));
}

main();
