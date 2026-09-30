'use strict';

const crypto = require('crypto');
const os = require('os');

const STATES = new Set(['running', 'waiting_user', 'stopping', 'stopped', 'failed', 'completed']);
const ACTIONS = new Set(['observe', 'inspect', 'menus', 'move', 'click', 'double_click', 'drag', 'scroll', 'type', 'key', 'wait', 'open_terminal', 'activate_app', 'ask']);
const ALWAYS_CONFIRM = new Set(['open_terminal']);
// Actions that point at the screen: their coordinates are in the pixels of
// the last image the model received.
const POINTING = new Set(['move', 'click', 'double_click', 'drag', 'scroll']);
const CHANGING = new Set(['click', 'double_click', 'drag', 'scroll', 'type', 'key', 'activate_app', 'open_terminal']);
const MODIFIERS = ['cmd', 'command', 'meta', 'super', 'win', 'windows', 'ctrl', 'control', 'alt', 'option', 'opt', 'shift'];

// Labels of the controls whose click cannot be taken back: the native bridge
// reads the name of the button, menu entry or link under the pointer (or with
// the keyboard focus, for Enter/Space) and refuses the action when it matches.
// Written for .NET regular expressions (case-insensitive there by default).
const SENSITIVE_TARGET = String.raw`\b(supprimer|suppression|delete|effacer|vider la corbeille|empty (the )?(recycle bin|trash)|d[ée]finitivement|permanently|envoyer|send|submit|soumettre|publier|publish|payer|pay|paiement|payment|acheter|buy|purchase|commander|place order|checkout|virement|transfer|d[ée]sinstaller|uninstall|formater|r[ée]initialiser ce pc|reset this pc)\b`;

// Nom du bureau piloté, utilisé dans les messages rendus à l'utilisateur. Le
// même module sert les trois éditions (Windows, Linux, macOS) : seule cette
// étiquette et la validation de `activate_app` dépendent de la plateforme.
function desktopLabel() {
  if (process.platform === 'linux') return 'Linux';
  if (process.platform === 'darwin') return 'macOS';
  return 'Windows';
}

function text(v, cap = 8000) { return String(v == null ? '' : v).slice(0, cap); }
function finite(v, min, max) { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; }
function integer(v, min, max, fallback) {
  const n = finite(v, min, max);
  return n == null ? fallback : Math.round(n);
}

function modifierList(value) {
  return Array.isArray(value) ? value.map((v) => text(v, 12).toLowerCase()).filter((v) => MODIFIERS.includes(v)).slice(0, 4) : [];
}

function normalizeAction(input) {
  const action = text(input && input.action, 40).toLowerCase();
  if (!ACTIONS.has(action)) return null;
  const out = { action };
  if (['move', 'click', 'double_click', 'drag'].includes(action)) {
    const x = finite(input.x, 0, 20000), y = finite(input.y, 0, 20000);
    if (x == null || y == null) return null;
    out.x = x; out.y = y;
    if (action === 'drag') {
      const toX = finite(input.to_x, 0, 20000), toY = finite(input.to_y, 0, 20000);
      if (toX == null || toY == null) return null;
      out.to_x = toX; out.to_y = toY;
      if (finite(input.duration, 0.05, 3) != null) out.duration = Number(input.duration);
    } else if (finite(input.duration, 0.05, 1.2) != null) out.duration = Number(input.duration);
    if (action === 'click') out.button = ['right', 'middle'].includes(input.button) ? input.button : 'left';
    if (['click', 'double_click'].includes(action)) {
      const modifiers = modifierList(input.modifiers);
      if (modifiers.length) out.modifiers = modifiers;
    }
  }
  if (action === 'observe' && input.display_index != null) {
    const index = integer(input.display_index, 0, 15, null);
    if (index != null) out.display_index = index;
  }
  if (action === 'inspect') {
    const target = text(input.target || 'active_window', 24).toLowerCase();
    if (!['active_window', 'display', 'region'].includes(target)) return null;
    out.target = target;
    // Without an index, `display` covers every screen at once.
    const index = input.display_index == null ? null : integer(input.display_index, 0, 15, null);
    if (index != null) out.display_index = index;
    out.include_image = input.include_image !== false;
    out.include_ui = input.include_ui !== false;
    // Windows' OCR reads the capture itself: it works for models that cannot
    // see the image, too.
    out.include_ocr = input.include_ocr !== false;
    out.max_elements = integer(input.max_elements, 25, 400, 220);
    out.max_dimension = integer(input.max_dimension, 800, 4096, 2560);
    if (target === 'region') {
      const x = finite(input.x, 0, 20000), y = finite(input.y, 0, 20000);
      const width = finite(input.width, 20, 20000), height = finite(input.height, 20, 20000);
      if (x == null || y == null || width == null || height == null) return null;
      out.x = x; out.y = y; out.width = width; out.height = height;
    }
  }
  if (action === 'scroll') {
    out.dx = Math.round(finite(input.dx, -120, 120) || 0); out.dy = Math.round(finite(input.dy, -120, 120) || 0);
    // Optional: where to scroll. Without it, the wheel turns under the pointer.
    const x = finite(input.x, 0, 20000), y = finite(input.y, 0, 20000);
    if (x != null && y != null) { out.x = x; out.y = y; }
  }
  if (action === 'wait') out.seconds = finite(input.seconds, 0.1, 10) ?? 1;
  if (action === 'type') { out.text = text(input.text, 8000); if (!out.text) return null; }
  if (action === 'key') {
    out.key = text(input.key, 20).toLowerCase();
    out.modifiers = modifierList(input.modifiers);
    const repeat = integer(input.repeat, 1, 30, 1);
    if (repeat > 1) out.repeat = repeat;
    if (!out.key) return null;
  }
  if (action === 'activate_app') {
    out.path = text(input.path, 1024);
    if (out.path.includes('..')) return null;
    const linuxApplications = ['/usr/share/applications/', '/usr/local/share/applications/', `${os.homedir()}/.local/share/applications/`, '~/.local/share/applications/', '/var/lib/flatpak/exports/share/applications/'];
    // On Windows an application may also be named as the Start menu shows it
    // ("Blender", "Paint 3D"): the bridge looks it up there, never on PATH.
    const validPath = process.platform === 'win32'
      ? (/^(?:[A-Za-z]:\\|\\\\).+\.(?:exe|bat|cmd)$/i.test(out.path) || /^(?:notepad|calc|mspaint|chrome|edge|msedge|firefox|code|explorer|cmd|powershell)(?:\.exe)?$/i.test(out.path)
        || /^[\p{L}\p{N}][\p{L}\p{N} ._+&'()-]{0,79}$/u.test(out.path))
      : process.platform === 'darwin'
        ? (/^(?:\/Applications\/|\/System\/Applications\/|~\/Applications\/)[^\0\r\n]+\.app$/.test(out.path) || /^(?:Safari|Google Chrome|Firefox|TextEdit|Notes|Finder|Terminal|Visual Studio Code|Calculator)$/.test(out.path))
        : ((linuxApplications.some((dir) => out.path.startsWith(dir)) && /^[^\0\r\n]+\.desktop$/.test(out.path)) || /^(?:chrome|chromium|firefox|code|terminal|gnome-text-editor|gedit|kate|mousepad|nautilus|dolphin|thunar)(?:\.desktop)?$/i.test(out.path));
    if (!validPath) return null;
  }
  if (action === 'ask') {
    out.question = text(input.question, 1000); out.options = Array.isArray(input.options) ? input.options.map((v) => text(v, 160)).filter(Boolean).slice(0, 5) : [];
    if (!out.question) return null;
  }
  return out;
}

// A card number: 13 to 19 digits (spaces or dashes allowed) passing Luhn.
function hasCardNumber(value) {
  for (const match of value.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
    const digits = match[0].replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let digit = Number(digits[digits.length - 1 - i]);
      if (i % 2) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

// What the agent must never type or trigger on its own: secrets, payment
// details, privilege elevation, permanent deletion. Ordinary words such as
// "supprimer" in a note stay typeable; irreversible *buttons* are caught by
// the bridge from their label (SENSITIVE_TARGET).
function isSensitive(action) {
  const value = `${action.text || ''} ${action.question || ''}`.toLowerCase();
  if (/password|passwd|mot de passe|\b2fa\b|one-time|verification code|code de v[ée]rification|carte bancaire|credit card|\bcvv\b|\bcvc\b|\biban\b|\bsudo\s|system settings|r[ée]glages syst[èe]me/.test(value)) return true;
  if (hasCardNumber(value)) return true;
  // Shift+Delete skips the recycle bin.
  if (action.action === 'key' && ['delete', 'del'].includes(action.key) && (action.modifiers || []).includes('shift')) return true;
  return false;
}

function needsApproval(action, mode) {
  if (action.action === 'ask') return false;
  if (isSensitive(action)) return true;
  if (mode === 'supervised') return !['observe', 'inspect', 'menus', 'move', 'scroll', 'wait'].includes(action.action);
  if (mode === 'semi') return ALWAYS_CONFIRM.has(action.action);
  return false;
}

class AutomationManager {
  constructor({ bridgeUrl = '', bridgeSecret = '', actionHandler = null } = {}) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, '');
    this.bridgeSecret = bridgeSecret;
    this.actionHandler = typeof actionHandler === 'function' ? actionHandler : null;
    this.active = null;
  }

  snapshot(session = this.active) {
    if (!session) return { active: false, state: 'idle' };
    return { active: true, id: session.id, state: session.state, permissionMode: session.permissionMode, lastAction: session.lastAction || null, question: session.question || null, events: session.events.slice(-30) };
  }

  async bridge(body) {
    if (this.actionHandler) return this.actionHandler(body);
    if (!this.bridgeUrl || !this.bridgeSecret) return { ok: false, error: 'computer-bridge-unavailable' };
    try {
      const response = await fetch(`${this.bridgeUrl}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-zaalis-computer': this.bridgeSecret }, body: JSON.stringify(body) });
      return await response.json();
    } catch (error) { return { ok: false, error: error.message || 'computer-bridge-unavailable' }; }
  }

  async status() { return this.bridge({ action: 'status' }); }

  async start({ userId, permissionMode }) {
    const platform = desktopLabel();
    if (this.active && ['running', 'waiting_user', 'stopping'].includes(this.active.state)) throw new Error(`Une tâche de contrôle ${platform} est déjà active.`);
    const permissions = await this.status();
    if (!permissions.ok) throw new Error(permissions.error || `Pont ${platform} indisponible.`);
    const session = { id: crypto.randomUUID(), userId, permissionMode, state: 'running', events: [], lastAction: null, question: null, answer: null, answerResolve: null, lastPerception: null, pendingVerification: null, lastCapture: null };
    this.active = session;
    await this.bridge({ action: 'overlay_start' });
    this.record(session, 'session_started', `Contrôle ${platform} activé`);
    if (!permissions.accessibility || !permissions.screenRecording) {
      this.record(session, 'permission_status', `Autorisations ${platform} non confirmées : le composant natif les vérifiera lors de chaque action.`);
    }
    return session;
  }

  record(session, type, label, input) {
    session.lastAction = label;
    session.events.push({ at: new Date().toISOString(), type, label, input });
  }

  owns(session, userId) { return !!session && session === this.active && session.userId === userId; }

  async stop(session = this.active, reason = 'Arrêt demandé par l’utilisateur.') {
    if (!session || !this.owns(session, session.userId)) return this.snapshot();
    session.state = 'stopping'; this.record(session, 'stopping', reason);
    if (session.answerResolve) { const resolve = session.answerResolve; session.answerResolve = null; resolve({ stopped: true }); }
    await this.bridge({ action: 'overlay_stop' });
    session.state = 'stopped'; this.record(session, 'stopped', reason);
    return this.snapshot(session);
  }

  async answer(userId, id, answer) {
    const session = this.active;
    if (!this.owns(session, userId) || session.id !== id || session.state !== 'waiting_user' || !session.answerResolve) throw new Error('Question d’automatisation introuvable.');
    const resolve = session.answerResolve;
    session.answerResolve = null; session.answer = text(answer, 2000); session.question = null; session.state = 'running';
    this.record(session, 'answer', 'Réponse utilisateur reçue'); resolve({ answer: session.answer });
    return this.snapshot(session);
  }

  async ask(session, question, options = []) {
    if (session.state !== 'running') return { stopped: true };
    session.state = 'waiting_user'; session.question = { question, options }; this.record(session, 'question', question);
    return new Promise((resolve) => { session.answerResolve = resolve; });
  }

  // Translate image-space coordinates into screen pixels using the geometry of
  // the last capture.  With no capture yet the coordinates pass through, which
  // matches the old behaviour exactly.
  toScreenCoordinates(session, action) {
    const capture = session && session.lastCapture;
    if (!capture || action.x == null) return action;
    if (Math.abs(capture.scaleX - 1) < 0.001 && Math.abs(capture.scaleY - 1) < 0.001
      && !capture.x && !capture.y) return action;
    const mapped = {
      ...action,
      x: Math.round(capture.x + action.x * capture.scaleX),
      y: Math.round(capture.y + action.y * capture.scaleY),
    };
    if (action.to_x != null) {
      mapped.to_x = Math.round(capture.x + action.to_x * capture.scaleX);
      mapped.to_y = Math.round(capture.y + action.to_y * capture.scaleY);
    }
    if (action.width != null) {
      mapped.width = Math.max(20, Math.round(action.width * capture.scaleX));
      mapped.height = Math.max(20, Math.round(action.height * capture.scaleY));
    }
    return mapped;
  }

  // Compares a capture with the previous one of the same target. Returns null
  // when there is nothing comparable yet.
  compareCapture(session, action, result, fingerprint) {
    const key = `${result.target || action.target || 'display'}:${action.display_index ?? 'all'}`;
    session.perceptions = session.perceptions || {};
    const previous = session.perceptions[key];
    const current = { capture: result.capture || null, signature: typeof result.signature === 'string' ? result.signature : '', fingerprint };
    session.perceptions[key] = current;
    if (!previous) return null;
    const moved = JSON.stringify(previous.capture) !== JSON.stringify(current.capture);
    const visual = visualChange(previous.signature, current.signature);
    const content = fingerprint != null && previous.fingerprint != null && previous.fingerprint !== fingerprint;
    return { changed: moved || content || (visual != null && visual > 0), visualPercent: visual == null ? null : Math.round(visual * 1000) / 10, moved };
  }

  async execute(session, input) {
    if (!this.owns(session, session.userId) || session.state === 'stopped') return { name: 'computer', blocked: true, summary: 'computer arrêté', text: 'computer: tâche arrêtée' };
    const action = normalizeAction(input);
    if (!action) return { name: 'computer', blocked: true, summary: 'computer invalide', text: 'computer: action invalide' };
    if (action.action === 'ask') {
      // A computer-control session must not leave the model waiting on a dock
      // confirmation: it is frequently used unattended.  The model gets a
      // deterministic result instead and can continue with a safe action.
      this.record(session, 'question_blocked', 'Question interactive indisponible', action);
      return { name: 'computer', blocked: true, summary: 'computer question indisponible', text: 'computer: les confirmations interactives sont désactivées dans ce mode.' };
    }
    // Do not replace automatic work with a confirmation dialog.  Actions that
    // are intrinsically unsafe remain blocked rather than putting the session
    // into waiting_user (passwords, 2FA, payments, destructive submissions?).
    if (isSensitive(action)) {
      this.record(session, 'sensitive_blocked', `computer ${action.action} bloqué`, action);
      return { name: 'computer', blocked: true, summary: 'computer action sensible bloquée', text: 'computer: action sensible bloquée en contrôle automatique.' };
    }
    this.record(session, 'action', `computer ${action.action}`, action);
    if (action.action === 'wait') {
      // Lets an application load or an animation finish without an extra
      // capture; nothing reaches the desktop.
      await new Promise((resolve) => setTimeout(resolve, Math.round(action.seconds * 1000)));
      return { name: 'computer', summary: 'computer wait', text: `Attente de ${action.seconds} s terminée. Observe ou inspecte pour voir le nouvel état.` };
    }
    // Screenshots are downscaled to keep them affordable, so the model points at
    // coordinates in the image it saw.  Map them back to real screen pixels here
    // rather than asking the model to do arithmetic it usually gets wrong.
    let sent = POINTING.has(action.action) || (action.action === 'inspect' && action.target === 'region') ? this.toScreenCoordinates(session, action) : action;
    if (['click', 'double_click', 'key'].includes(action.action)) sent = { ...sent, guard: SENSITIVE_TARGET };
    const result = await this.bridge(sent);
    if (['observe', 'inspect'].includes(action.action) && result.ok && result.capture && result.image_width) {
      const scaleX = Number(result.capture.width) / Number(result.image_width);
      const scaleY = Number(result.capture.height) / Number(result.image_height || result.image_width);
      session.lastCapture = Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX > 0 && scaleY > 0
        ? { x: Number(result.capture.x) || 0, y: Number(result.capture.y) || 0, scaleX, scaleY }
        : null;
    }
    if (!result.ok && result.error === 'sensitive-target') {
      this.record(session, 'sensitive_blocked', `computer ${action.action} bloqué sur « ${text(result.target, 120)} »`, action);
      return { name: 'computer', blocked: true, summary: 'computer action irréversible bloquée', text: `computer: « ${text(result.target, 120)} » déclenche une action irréversible (suppression, envoi, paiement…) : elle est bloquée en contrôle automatique. Termine le reste de la tâche, puis demande à l’utilisateur de faire ce clic lui-même.` };
    }
    if (!result.ok && result.error === 'password-field') {
      this.record(session, 'sensitive_blocked', 'computer type bloqué (champ mot de passe)', { action: 'type' });
      return { name: 'computer', blocked: true, summary: 'computer saisie de mot de passe bloquée', text: 'computer: le champ actif est un mot de passe ; l’IA n’y écrit jamais. Demande à l’utilisateur de le remplir lui-même.' };
    }
    if (!result.ok && result.error === 'application-not-found') {
      const suggestions = Array.isArray(result.suggestions) ? result.suggestions.slice(0, 8).map((name) => text(name, 80)) : [];
      return { name: 'computer', error: true, summary: 'computer application introuvable', text: `computer: aucune application « ${text(action.path, 80)} » dans le menu Démarrer.${suggestions.length ? ` Noms proches : ${suggestions.join(', ')}.` : ''}` };
    }
    if (!result.ok) return { name: 'computer', error: true, summary: `computer ${action.action} échec`, text: `computer: ${result.error || 'échec'}` };
    if (CHANGING.has(action.action)) {
      session.pendingVerification = { action: action.action, at: new Date().toISOString() };
    }
    const images = ['observe', 'inspect'].includes(action.action) && result.image ? [{ mime: result.mime || 'image/png', data: result.image }] : undefined;
    const menuText = action.action === 'menus'
      ? `Menus de ${result.application || "l’application active"} : ${JSON.stringify(result.menus || [])}`
      : null;
    const displays = Array.isArray(result.displays) ? result.displays.slice(0, 16) : [];
    const displayText = displays.length > 1
      ? ` ${displays.length} écrans : ${displays.map((d) => `#${d.index} ${d.width}×${d.height}${d.primary ? ' (principal)' : ''}`).join(', ')} — display_index choisit l’écran.`
      : '';
    // Tells the model whether its last action visibly did something, from the
    // pixels as well as from the text and controls.
    const verificationText = (fingerprint) => {
      const pending = session.pendingVerification;
      const comparison = this.compareCapture(session, action, result, fingerprint);
      session.pendingVerification = null;
      if (!pending) return '';
      if (!comparison) return `Vérification après ${pending.action} : pas de capture précédente de cette cible pour comparer. `;
      if (!comparison.changed) return `Vérification après ${pending.action} : AUCUN changement visible depuis la capture précédente — l’action n’a probablement pas eu d’effet (mauvaise cible, fenêtre non active, chargement en cours ?). `;
      return `Vérification après ${pending.action} : l’écran a changé${comparison.moved ? ' (fenêtre déplacée, redimensionnée ou différente)' : comparison.visualPercent != null ? ` (≈ ${comparison.visualPercent} % de l’image)` : ''}. `;
    };
    let inspectionText = null;
    if (action.action === 'inspect') {
      const structured = {
        target: result.target || action.target,
        capture: result.capture || null,
        image: result.image_width ? { width: result.image_width, height: result.image_height } : null,
        application: result.application || result.ui?.application || null,
        displays: displays.length > 1 ? displays : undefined,
        open_windows: Array.isArray(result.open_windows) ? result.open_windows.slice(0, 25).map((w) => ({ title: text(w?.title, 160), app: text(w?.app, 60) })) : undefined,
        errors: { capture: result.captureError || null, ocr: result.ocrError || null, ui: result.uiError || null },
        ocr: Array.isArray(result.ocr) ? result.ocr.slice(0, 100).map((line) => ({ ...line, text: text(line?.text, 400) })) : [],
        ui: result.ui && typeof result.ui === 'object' ? {
          application: result.ui.application || null,
          bundleId: result.ui.bundleId || null,
          focusedWindow: result.ui.focusedWindow || null,
          truncated: !!result.ui.truncated,
          elements: Array.isArray(result.ui.elements) ? result.ui.elements.slice(0, 180).map((element) => ({
            ...element,
            title: element.title == null ? undefined : text(element.title, 240),
            label: element.label == null ? undefined : text(element.label, 240),
            help: element.help == null ? undefined : text(element.help, 240),
            value: element.value == null ? undefined : text(element.value, 500),
          })) : [],
        } : null,
      };
      let encoded = JSON.stringify(structured);
      while (encoded.length > 36_000 && structured.ui?.elements?.length > 10) {
        structured.ui.elements = structured.ui.elements.slice(0, Math.max(10, Math.floor(structured.ui.elements.length * 0.65)));
        structured.ui.truncated = true;
        encoded = JSON.stringify(structured);
      }
      while (encoded.length > 36_000 && structured.ocr.length > 10) {
        structured.ocr = structured.ocr.slice(0, Math.max(10, Math.floor(structured.ocr.length * 0.65)));
        encoded = JSON.stringify(structured);
      }
      const fingerprintSource = JSON.stringify({
        application: structured.application,
        ocr: structured.ocr.map((line) => line.text),
        elements: (structured.ui?.elements || []).map((element) => [element.role, element.title, element.label, element.value, element.frame]),
      });
      const fingerprint = crypto.createHash('sha256').update(fingerprintSource).digest('hex');
      const found = `${structured.ui?.elements?.length || 0} éléments d’interface, ${structured.ocr.length} lignes de texte OCR${result.ocrError ? ' (OCR indisponible)' : ''}${result.uiError ? ' (arbre d’interface indisponible)' : ''}`;
      inspectionText = `Inspection : ${images ? 'capture, ' : ''}${found}.${displayText} Les frame [x, y, largeur, hauteur] et center [x, y] sont en pixels de l’image : pour cliquer un élément, utilise son center. ${verificationText(fingerprint)}Données structurées : ${encoded}`;
    }
    const activated = result.activated
      ? `Fenêtre « ${text(result.application, 160)} » mise au premier plan.`
      : `Application ${result.resolved ? `« ${text(result.resolved, 120)} » ` : ''}lancée${result.application ? ` ; fenêtre active : « ${text(result.application, 160)} »` : ''}.`;
    const actionText = action.action === 'activate_app'
      ? `${activated} Ne rappelle pas activate_app pour cette application : utilise inspect une fois pour comprendre la fenêtre, puis continue avec key, type, click ou scroll.`
      : action.action === 'observe'
        ? `Capture d’écran actuelle fournie au modèle.${displayText} ${verificationText(null)}Continue maintenant la tâche demandée ; ne rappelle pas observe sans interaction intermédiaire.`
        : (inspectionText || menuText || `Action ${action.action} effectuée. Utilise inspect après une étape significative si le résultat doit être vérifié.`);
    return { name: 'computer', summary: `computer ${action.action}`, text: actionText, images };
  }

  async complete(session) {
    if (!session || !this.owns(session, session.userId) || session.state === 'stopped') return;
    session.state = 'completed'; this.record(session, 'completed', 'Tâche terminée'); await this.bridge({ action: 'overlay_stop' });
  }
}

// Share of the thumbnail cells whose grey level moved noticeably, between
// two signatures of the same size (null when they cannot be compared).
function visualChange(before, after) {
  if (!before || !after || before.length !== after.length || before.length % 2) return null;
  let changed = 0;
  const cells = before.length / 2;
  for (let i = 0; i < before.length; i += 2) {
    if (Math.abs(parseInt(before.slice(i, i + 2), 16) - parseInt(after.slice(i, i + 2), 16)) >= 6) changed++;
  }
  return changed / cells;
}

module.exports = { AutomationManager, STATES, SENSITIVE_TARGET, normalizeAction, needsApproval, isSensitive, visualChange };
