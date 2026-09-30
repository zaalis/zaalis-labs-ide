'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutomationManager, SENSITIVE_TARGET, normalizeAction, isSensitive, visualChange } = require('../automation-manager');

function onPlatform(platform, check) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { check(); }
  finally { Object.defineProperty(process, 'platform', original); }
}

test('activate_app conserve les applications Windows admises', () => {
  onPlatform('win32', () => {
    for (const path of ['notepad', 'C:\\Windows\\System32\\notepad.exe']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['C:\\temp\\..\\bad.exe', 'C:\\temp\\bad.sh', '/bin/sh']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});

test('activate_app limite les lanceurs Linux', () => {
  onPlatform('linux', () => {
    for (const path of ['chrome', 'gedit.desktop', '/usr/share/applications/firefox.desktop', '/usr/local/share/applications/code.desktop', '~/.local/share/applications/local.desktop', '/var/lib/flatpak/exports/share/applications/org.example.App.desktop']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['/bin/sh', '/tmp/x.sh', '/tmp/x.desktop', '/usr/share/applications/../x.desktop', 'notepad', 'explorer', 'edge', 'msedge']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});

test('activate_app limite les applications macOS', () => {
  onPlatform('darwin', () => {
    for (const path of ['Safari', 'Google Chrome', 'Visual Studio Code', '/Applications/Safari.app', '/System/Applications/Notes.app', '~/Applications/Calculator.app']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['/tmp/Evil.app', '/Applications/../Evil.app', '/bin/sh', 'Other App', 'Safari.app']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});

test('activate_app accepte sous Windows le nom affiché dans le menu Démarrer', () => {
  onPlatform('win32', () => {
    for (const path of ['Blender', 'Paint 3D', 'Bloc-notes', 'Calculatrice', 'Visual Studio Code']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['a/b', 'C:\\temp\\bad.sh', ' Blender', 'x'.repeat(81), 'nom;commande']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null, path);
    }
  });
});

test('les gestes de souris et de clavier sont validés et bornés', () => {
  assert.deepEqual(normalizeAction({ action: 'double_click', x: 10, y: 20, modifiers: ['ctrl', 'bogus'] }), { action: 'double_click', x: 10, y: 20, modifiers: ['ctrl'] });
  assert.deepEqual(normalizeAction({ action: 'click', x: 1, y: 2, button: 'middle' }), { action: 'click', x: 1, y: 2, button: 'middle' });
  assert.equal(normalizeAction({ action: 'click', x: 1, y: 2, button: 'weird' }).button, 'left');
  assert.equal(normalizeAction({ action: 'drag', x: 1, y: 2 }), null);
  assert.deepEqual(normalizeAction({ action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40, duration: 0.5 }), { action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40, duration: 0.5 });
  assert.deepEqual(normalizeAction({ action: 'scroll', dy: 3, x: 5, y: 6 }), { action: 'scroll', dx: 0, dy: 3, x: 5, y: 6 });
  assert.deepEqual(normalizeAction({ action: 'scroll', dy: -2 }), { action: 'scroll', dx: 0, dy: -2 });
  assert.deepEqual(normalizeAction({ action: 'wait', seconds: 2.5 }), { action: 'wait', seconds: 2.5 });
  assert.deepEqual(normalizeAction({ action: 'wait', seconds: 60 }), { action: 'wait', seconds: 1 });
  assert.deepEqual(normalizeAction({ action: 'key', key: 'Down', repeat: 5 }), { action: 'key', key: 'down', modifiers: [], repeat: 5 });
  assert.equal(normalizeAction({ action: 'key', key: 'down', repeat: 500 }).repeat, undefined);
  // Without an index `display` means every screen; OCR no longer needs the image.
  const inspect = normalizeAction({ action: 'inspect', target: 'display', include_image: false });
  assert.equal('display_index' in inspect, false);
  assert.equal(inspect.include_ocr, true);
  assert.equal(normalizeAction({ action: 'inspect', target: 'display', display_index: 1 }).display_index, 1);
  assert.equal(normalizeAction({ action: 'observe', display_index: 2 }).display_index, 2);
});

test('le filtre sensible vise les secrets, pas les mots ordinaires', () => {
  assert.equal(isSensitive({ action: 'type', text: 'Supprimer le brouillon puis envoyer le compte rendu' }), false);
  assert.equal(isSensitive({ action: 'type', text: 'Acheter du pain' }), false);
  assert.equal(isSensitive({ action: 'type', text: 'Mon mot de passe est hunter2' }), true);
  assert.equal(isSensitive({ action: 'type', text: 'code de vérification 123456' }), true);
  assert.equal(isSensitive({ action: 'type', text: '4111 1111 1111 1111' }), true);
  assert.equal(isSensitive({ action: 'type', text: 'Commande n° 4111 1111 1111 1112' }), false);
  assert.equal(isSensitive({ action: 'key', key: 'delete', modifiers: ['shift'] }), true);
  assert.equal(isSensitive({ action: 'key', key: 'delete', modifiers: [] }), false);
  // The pattern the bridge applies to button labels (.NET: case-insensitive).
  const target = new RegExp(SENSITIVE_TARGET, 'i');
  for (const label of ['Supprimer le fichier', 'Envoyer', 'Payer maintenant', 'Place order', 'Vider la corbeille']) assert.match(label, target, label);
  for (const label of ['Valider', 'Format', 'Enregistrer', 'PayPal', 'Fichier']) assert.doesNotMatch(label, target, label);
});

test('la signature visuelle mesure la part de l’image qui a changé', () => {
  const grey = (level, cells = 2304) => level.toString(16).padStart(2, '0').repeat(cells);
  assert.equal(visualChange(grey(128), grey(128)), 0);
  assert.equal(visualChange(grey(128), grey(131)), 0);
  assert.equal(visualChange(grey(128), grey(200)), 1);
  assert.equal(visualChange(grey(128), grey(128, 10)), null);
  assert.equal(visualChange('', grey(1)), null);
});

async function session(replies) {
  const sent = [];
  const manager = new AutomationManager({
    actionHandler: async (body) => {
      if (['status', 'overlay_start', 'overlay_stop'].includes(body.action)) return { ok: true, accessibility: true, screenRecording: true };
      sent.push(body);
      const reply = replies[body.action];
      return typeof reply === 'function' ? reply(body) : (reply || { ok: true });
    },
  });
  return { manager, sent, session: await manager.start({ userId: 'u', permissionMode: 'auto' }) };
}

test('les coordonnées de l’image sont converties vers l’écran, glisser compris', async () => {
  const { manager, sent, session: s } = await session({
    observe: { ok: true, image: 'aW1n', target: 'display', capture: { x: 100, y: 0, width: 2000, height: 1000 }, image_width: 1000, image_height: 500 },
  });
  await manager.execute(s, { action: 'observe' });
  await manager.execute(s, { action: 'drag', x: 10, y: 20, to_x: 110, to_y: 220 });
  await manager.execute(s, { action: 'scroll', x: 50, y: 50, dy: 3 });
  await manager.execute(s, { action: 'double_click', x: 1, y: 1 });
  assert.deepEqual(sent[1], { action: 'drag', x: 120, y: 40, to_x: 320, to_y: 440 });
  assert.deepEqual(sent[2], { action: 'scroll', dx: 0, dy: 3, x: 200, y: 100 });
  assert.equal(sent[3].x, 102);
  // Clicks carry the label pattern the bridge checks before acting.
  assert.equal(sent[3].guard, SENSITIVE_TARGET);
});

test('un clic irréversible ou un champ mot de passe renvoie un refus clair', async () => {
  const { manager, session: s } = await session({
    click: { ok: false, error: 'sensitive-target', target: 'Supprimer le fichier' },
    type: { ok: false, error: 'password-field' },
    activate_app: { ok: false, error: 'application-not-found', suggestions: ['Blender 5.2'] },
  });
  const click = await manager.execute(s, { action: 'click', x: 1, y: 1 });
  assert.equal(click.blocked, true);
  assert.match(click.text, /« Supprimer le fichier » déclenche une action irréversible/);
  const typed = await manager.execute(s, { action: 'type', text: 'bonjour' });
  assert.equal(typed.blocked, true);
  assert.match(typed.text, /mot de passe/);
  const app = await manager.execute(s, { action: 'activate_app', path: process.platform === 'win32' ? 'notepad' : process.platform === 'darwin' ? 'TextEdit' : 'code' });
  assert.equal(app.error, true);
  assert.match(app.text, /Noms proches : Blender 5\.2/);
  assert.deepEqual(s.events.filter((e) => e.type === 'sensitive_blocked').length, 2);
});

test('wait patiente sans toucher au bureau', async () => {
  const { manager, sent, session: s } = await session({});
  const started = Date.now();
  const result = await manager.execute(s, { action: 'wait', seconds: 0.2 });
  assert.ok(Date.now() - started >= 190);
  assert.match(result.text, /Attente de 0\.2 s terminée/);
  assert.equal(sent.length, 0);
});

test('après une action, l’inspection dit si l’écran a vraiment changé', async () => {
  let signature = '80'.repeat(2304);
  const shot = () => ({ ok: true, image: 'aW1n', target: 'active_window', capture: { x: 0, y: 0, width: 800, height: 600 }, image_width: 800, image_height: 600, signature, ocr: [{ text: 'Titre', frame: [1, 2, 3, 4], center: [2, 4] }], ui: { elements: [{ role: 'Button', label: 'OK', frame: [0, 0, 10, 10], center: [5, 5] }] }, displays: [{ index: 0, primary: true, x: 0, y: 0, width: 800, height: 600 }, { index: 1, primary: false, x: 800, y: 0, width: 1920, height: 1080 }], open_windows: [{ title: 'Bloc-notes', app: 'notepad' }] });
  const { manager, session: s } = await session({ inspect: (body) => ({ ...shot(), target: body.target }) });
  const first = await manager.execute(s, { action: 'inspect' });
  assert.match(first.text, /1 éléments d’interface, 1 lignes de texte OCR/);
  assert.match(first.text, /2 écrans : #0 800×600 \(principal\), #1 1920×1080/);
  assert.match(first.text, /"open_windows":\[\{"title":"Bloc-notes","app":"notepad"\}\]/);
  assert.doesNotMatch(first.text, /signature|8080/);
  await manager.execute(s, { action: 'click', x: 5, y: 5 });
  const unchanged = await manager.execute(s, { action: 'inspect' });
  assert.match(unchanged.text, /Vérification après click : AUCUN changement visible/);
  await manager.execute(s, { action: 'key', key: 'enter' });
  signature = 'f0'.repeat(576) + '80'.repeat(1728);
  const changed = await manager.execute(s, { action: 'inspect' });
  assert.match(changed.text, /Vérification après key : l’écran a changé \(≈ 25 % de l’image\)/);
  // A capture of another target is not compared with this one.
  await manager.execute(s, { action: 'type', text: 'x' });
  const other = await manager.execute(s, { action: 'inspect', target: 'display' });
  assert.match(other.text, /pas de capture précédente de cette cible/);
});
