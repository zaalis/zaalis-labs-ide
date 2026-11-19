'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutomationManager, SENSITIVE_TARGET, normalizeAction, isSensitive, visualChange } = require('../src/runtime/automation-manager');

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
    // Known launchers, allowed .desktop files and, as on Windows, the name the
    // applications menu shows (looked up there only, never on PATH).
    for (const path of ['chrome', 'gedit.desktop', '/usr/share/applications/firefox.desktop', '/usr/local/share/applications/code.desktop', '~/.local/share/applications/local.desktop', '/var/lib/flatpak/exports/share/applications/org.example.App.desktop', 'Blender', 'Éditeur de texte', 'notepad']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['/bin/sh', '/tmp/x.sh', '/tmp/x.desktop', '/usr/share/applications/../x.desktop', 'rm -rf /', '$(reboot)', '../bin/sh']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null);
    }
  });
});

test('activate_app limite les applications macOS aux bundles installés et aux noms affichés', () => {
  onPlatform('darwin', () => {
    // As on Windows: the name Launchpad shows ("Blender"), resolved by the bridge
    // among installed bundles, never through PATH.
    for (const path of ['Safari', 'Google Chrome', 'Visual Studio Code', 'Blender', 'Other App', '/Applications/Safari.app', '/System/Applications/Notes.app', '~/Applications/Calculator.app']) {
      assert.equal(normalizeAction({ action: 'activate_app', path })?.path, path);
    }
    for (const path of ['/tmp/Evil.app', '/Applications/../Evil.app', '/bin/sh', 'a/b', ' Safari', 'x'.repeat(81), 'nom;commande']) {
      assert.equal(normalizeAction({ action: 'activate_app', path }), null, path);
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

async function session(replies, permissionMode = 'auto') {
  const sent = [];
  const manager = new AutomationManager({
    actionHandler: async (body) => {
      if (['status', 'overlay_start', 'overlay_stop'].includes(body.action)) return { ok: true, accessibility: true, screenRecording: true };
      sent.push(body);
      const reply = replies[body.action];
      return typeof reply === 'function' ? reply(body) : (reply || { ok: true });
    },
  });
  return { manager, sent, session: await manager.start({ userId: 'u', permissionMode }) };
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
  // Autonomous mode: the bridge is not asked to vet the button.
  assert.equal(sent[3].guard, undefined);
});

test('hors mode autonome, les clics portent le garde et confirm le lève', async () => {
  const { manager, sent, session: s } = await session({}, 'supervised');
  await manager.execute(s, { action: 'triple_click', x: 1, y: 1 });
  await manager.execute(s, { action: 'click', x: 1, y: 1, confirm: true });
  assert.equal(sent[0].guard, SENSITIVE_TARGET);
  assert.equal(sent[1].guard, undefined);
  assert.equal(sent[1].confirm, undefined);
});

test('le mode autonome ne bloque plus les mots sensibles, sauf un numéro de carte', async () => {
  const auto = await session({});
  const typed = await auto.manager.execute(auto.session, { action: 'type', text: 'Mon mot de passe Wi-Fi est dans le coffre' });
  assert.equal(typed.blocked, undefined);
  const card = await auto.manager.execute(auto.session, { action: 'type', text: '4111 1111 1111 1111' });
  assert.equal(card.blocked, true);
  assert.match(card.text, /numéro de carte/);
  const pasted = await auto.manager.execute(auto.session, { action: 'batch', actions: [{ action: 'clipboard_write', text: '4111111111111111' }] });
  assert.equal(pasted.blocked, true);
  const semi = await session({}, 'semi');
  const asked = await semi.manager.execute(semi.session, { action: 'type', text: 'mot de passe : hunter2' });
  assert.equal(asked.blocked, true);
  assert.match(asked.text, /request_user_input.*"confirm": true/);
  const confirmed = await semi.manager.execute(semi.session, { action: 'type', text: 'mot de passe : hunter2', confirm: true });
  assert.equal(confirmed.blocked, undefined);
});

test('ask renvoie vers request_user_input au lieu de bloquer', async () => {
  const { manager, sent, session: s } = await session({});
  const result = await manager.execute(s, { action: 'ask', question: 'On continue ?' });
  assert.equal(result.blocked, undefined);
  assert.match(result.text, /request_user_input/);
  assert.equal(sent.length, 0);
});

test('nouveaux gestes : validation de triple clic, bouton, maintien, presse-papiers, zoom', () => {
  assert.deepEqual(normalizeAction({ action: 'triple_click', x: 3, y: 4, modifiers: ['shift'] }), { action: 'triple_click', x: 3, y: 4, modifiers: ['shift'] });
  assert.deepEqual(normalizeAction({ action: 'mouse_down', button: 'right' }), { action: 'mouse_down', button: 'right' });
  assert.deepEqual(normalizeAction({ action: 'mouse_up', x: 5, y: 6 }), { action: 'mouse_up', button: 'left', x: 5, y: 6 });
  assert.deepEqual(normalizeAction({ action: 'hold_key', key: 'Shift', seconds: 2 }), { action: 'hold_key', key: 'shift', modifiers: [], seconds: 2 });
  assert.equal(normalizeAction({ action: 'hold_key', key: 'a', seconds: 60 }).seconds, 1);
  assert.equal(normalizeAction({ action: 'clipboard_write', text: '' }), null);
  assert.deepEqual(normalizeAction({ action: 'clipboard_read' }), { action: 'clipboard_read' });
  assert.deepEqual(normalizeAction({ action: 'cursor_position' }), { action: 'cursor_position' });
  assert.equal(normalizeAction({ action: 'zoom', x: 1, y: 1 }), null);
  assert.equal(normalizeAction({ action: 'zoom', x: 1, y: 1, width: 100, height: 50 }).max_dimension, 1600);
  // Batches: 1 to 20 gestures, no capture or nested batch, 30 s of waiting at most.
  assert.equal(normalizeAction({ action: 'batch', actions: [] }), null);
  assert.equal(normalizeAction({ action: 'batch', actions: [{ action: 'inspect' }] }), null);
  assert.equal(normalizeAction({ action: 'batch', actions: [{ action: 'batch', actions: [] }] }), null);
  assert.equal(normalizeAction({ action: 'batch', actions: Array.from({ length: 21 }, () => ({ action: 'key', key: 'a' })) }), null);
  assert.equal(normalizeAction({ action: 'batch', actions: [{ action: 'wait', seconds: 10 }, { action: 'wait', seconds: 10 }, { action: 'hold_key', key: 'a', seconds: 10 }, { action: 'wait', seconds: 1 }] }), null);
  assert.equal(normalizeAction({ action: 'batch', actions: [{ action: 'click', x: 1, y: 1 }, { action: 'type', text: 'ok' }, { action: 'key', key: 'enter' }] }).actions.length, 3);
});

test('un batch part en un seul appel, coordonnées converties, et rend chaque étape', async () => {
  const { manager, sent, session: s } = await session({
    observe: { ok: true, image: 'aW1n', target: 'display', capture: { x: 0, y: 0, width: 2000, height: 1000 }, image_width: 1000, image_height: 500 },
    batch: (body) => ({ ok: true, steps: body.actions.map((step) => step.action === 'clipboard_read' ? { ok: true, text: 'copié' } : step.action === 'cursor_position' ? { ok: true, x: 400, y: 200 } : { ok: true }) }),
  });
  await manager.execute(s, { action: 'observe' });
  const result = await manager.execute(s, { action: 'batch', actions: [{ action: 'click', x: 10, y: 10 }, { action: 'type', text: 'Bonjour' }, { action: 'key', key: 'enter' }, { action: 'clipboard_read' }, { action: 'cursor_position' }] });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].action, 'batch');
  assert.deepEqual(sent[1].actions[0], { action: 'click', x: 20, y: 20, button: 'left' });
  assert.match(result.text, /Batch : 5\/5 gestes effectués/);
  assert.match(result.text, /presse-papiers : 5 caractères .*«copié»/);
  assert.match(result.text, /Pointeur en \(200, 100\) dans la dernière image/);
  assert.equal(s.pendingVerification.action, 'batch');
});

test('un batch arrêté dit à quelle étape et pourquoi', async () => {
  const { manager, session: s } = await session({ batch: { ok: false, steps: [{ ok: true }, { ok: false, error: 'password-field' }] } });
  const result = await manager.execute(s, { action: 'batch', actions: [{ action: 'click', x: 1, y: 1 }, { action: 'type', text: 'x' }, { action: 'key', key: 'enter' }] });
  assert.equal(result.blocked, true);
  assert.match(result.text, /1\/3 gestes effectués .* arrêt à l’étape 2 \(type\) — le champ actif est un mot de passe/);
  const invalid = await manager.execute(s, { action: 'batch', actions: [{ action: 'click', x: 1, y: 1 }, { action: 'observe' }] });
  assert.match(invalid.text, /étape 2 « observe » non autorisée/);
});

test('zoom capture une région, garde la vérification en attente et recale les coordonnées', async () => {
  const { manager, sent, session: s } = await session({
    observe: { ok: true, image: 'aW1n', target: 'display', capture: { x: 0, y: 0, width: 2000, height: 1000 }, image_width: 1000, image_height: 500 },
    inspect: (body) => ({ ok: true, image: 'aW1n', target: 'region', capture: { x: body.x, y: body.y, width: body.width, height: body.height }, image_width: 800, image_height: 400, ocr: [{ text: 'petit', frame: [1, 1, 2, 2], center: [2, 2] }] }),
  });
  await manager.execute(s, { action: 'observe' });
  await manager.execute(s, { action: 'click', x: 1, y: 1 });
  const zoom = await manager.execute(s, { action: 'zoom', x: 100, y: 50, width: 200, height: 100 });
  assert.deepEqual([sent[2].action, sent[2].target, sent[2].x, sent[2].y, sent[2].width, sent[2].height, sent[2].include_ui], ['inspect', 'region', 200, 100, 400, 200, false]);
  assert.equal(zoom.images.length, 1);
  assert.match(zoom.text, /Zoom ×2 .* 1 lignes de texte OCR/);
  assert.equal(s.pendingVerification.action, 'click');
  // The next click is in the zoomed image's pixels.
  await manager.execute(s, { action: 'click', x: 400, y: 200 });
  assert.equal(sent[3].x, 400 / 2 + 200);
});

test('un clic irréversible ou un champ mot de passe renvoie un refus clair', async () => {
  const { manager, session: s } = await session({
    click: { ok: false, error: 'sensitive-target', target: 'Supprimer le fichier' },
    type: { ok: false, error: 'password-field' },
    activate_app: { ok: false, error: 'application-not-found', suggestions: ['Blender 5.2'] },
  });
  const click = await manager.execute(s, { action: 'click', x: 1, y: 1 });
  assert.equal(click.blocked, true);
  assert.match(click.text, /« Supprimer le fichier » déclenche une action irréversible.*"confirm": true/);
  const typed = await manager.execute(s, { action: 'type', text: 'bonjour' });
  assert.equal(typed.blocked, true);
  assert.match(typed.text, /mot de passe/);
  const app = await manager.execute(s, { action: 'activate_app', path: 'notepad' });
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
