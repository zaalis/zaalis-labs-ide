'use strict';

const crypto = require('crypto');

const STATES = new Set(['running', 'waiting_user', 'stopping', 'stopped', 'failed', 'completed']);
const ACTIONS = new Set(['observe', 'inspect', 'menus', 'move', 'click', 'scroll', 'type', 'key', 'open_terminal', 'activate_app', 'ask']);
const ALWAYS_CONFIRM = new Set(['open_terminal']);

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

function normalizeAction(input) {
  const action = text(input && input.action, 40).toLowerCase();
  if (!ACTIONS.has(action)) return null;
  const out = { action };
  if (['move', 'click'].includes(action)) {
    const x = finite(input.x, 0, 20000), y = finite(input.y, 0, 20000);
    if (x == null || y == null) return null;
    out.x = x; out.y = y;
    if (finite(input.duration, 0.05, 1.2) != null) out.duration = Number(input.duration);
    if (action === 'click') out.button = input.button === 'right' ? 'right' : 'left';
  }
  if (action === 'inspect') {
    const target = text(input.target || 'active_window', 24).toLowerCase();
    if (!['active_window', 'display', 'region'].includes(target)) return null;
    out.target = target;
    out.display_index = integer(input.display_index, 0, 15, 0);
    out.include_image = input.include_image !== false;
    out.include_ui = input.include_ui !== false;
    out.include_ocr = input.include_ocr !== false && out.include_image;
    out.max_elements = integer(input.max_elements, 25, 400, 220);
    out.max_dimension = integer(input.max_dimension, 800, 4096, 2560);
    if (target === 'region') {
      const x = finite(input.x, 0, 20000), y = finite(input.y, 0, 20000);
      const width = finite(input.width, 20, 20000), height = finite(input.height, 20, 20000);
      if (x == null || y == null || width == null || height == null) return null;
      out.x = x; out.y = y; out.width = width; out.height = height;
    }
  }
  if (action === 'scroll') { out.dx = Math.round(finite(input.dx, -120, 120) || 0); out.dy = Math.round(finite(input.dy, -120, 120) || 0); }
  if (action === 'type') { out.text = text(input.text, 8000); if (!out.text) return null; }
  if (action === 'key') {
    out.key = text(input.key, 20).toLowerCase();
    out.modifiers = Array.isArray(input.modifiers) ? input.modifiers.map((v) => text(v, 12).toLowerCase()).filter((v) => ['cmd', 'command', 'meta', 'super', 'win', 'windows', 'ctrl', 'control', 'alt', 'option', 'opt', 'shift'].includes(v)).slice(0, 4) : [];
    if (!out.key) return null;
  }
  if (action === 'activate_app') {
    out.path = text(input.path, 1024);
    const validPath = process.platform === 'win32'
      ? (/^(?:[A-Za-z]:\\|\\\\).+\.(?:exe|bat|cmd)$/i.test(out.path) || /^(?:notepad|calc|mspaint|chrome|edge|msedge|firefox|code|explorer|cmd|powershell)(?:\.exe)?$/i.test(out.path))
      : process.platform === 'darwin'
        ? (/^\/.*\.app$/.test(out.path) || /^[A-Za-z0-9._ -]{1,120}$/.test(out.path))
        // Linux (branche specifique a l'edition Linux) : on n'enferme pas
        // l'activation dans une liste blanche d'applications — chaque
        // distribution a les siennes. On accepte tout identifiant sur : un
        // chemin absolu, un nom de commande / id .desktop, ou un alias generique
        // (« text editor », « navigateur web »). La resolution reelle est faite
        // par linux-computer-control.js (PATH + xdg-mime + .desktop), qui passe
        // toujours ces noms en argument, donc sans risque d'injection shell.
        : (/^\/[^\0\r\n]+$/.test(out.path)
          || /^[A-Za-z0-9][A-Za-z0-9._+-]{0,126}$/.test(out.path)
          || /^[A-Za-z][A-Za-z ]{1,48}$/.test(out.path));
    if (!validPath) return null;
  }
  if (action === 'ask') {
    out.question = text(input.question, 1000); out.options = Array.isArray(input.options) ? input.options.map((v) => text(v, 160)).filter(Boolean).slice(0, 5) : [];
    if (!out.question) return null;
  }
  return out;
}

function isSensitive(action) {
  const value = `${action.text || ''} ${action.question || ''}`.toLowerCase();
  return /password|mot de passe|2fa|one-time|verification code|carte bancaire|credit card|buy|purchase|acheter|paiement|payment|sudo|system settings|reglages systeme|delete|supprimer|effacer|envoyer|submit/.test(value);
}

function needsApproval(action, mode) {
  if (action.action === 'ask') return false;
  if (isSensitive(action)) return true;
  if (mode === 'supervised') return !['observe', 'inspect', 'menus', 'move', 'scroll'].includes(action.action);
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
    if (!capture) return action;
    if (Math.abs(capture.scaleX - 1) < 0.001 && Math.abs(capture.scaleY - 1) < 0.001
      && !capture.x && !capture.y) return action;
    return {
      ...action,
      x: Math.round(capture.x + action.x * capture.scaleX),
      y: Math.round(capture.y + action.y * capture.scaleY),
    };
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
    // Screenshots are downscaled to keep them affordable, so the model points at
    // coordinates in the image it saw.  Map them back to real screen pixels here
    // rather than asking the model to do arithmetic it usually gets wrong.
    const sent = ['move', 'click'].includes(action.action) ? this.toScreenCoordinates(session, action) : action;
    const result = await this.bridge(sent);
    if (['observe', 'inspect'].includes(action.action) && result.ok && result.capture && result.image_width) {
      const scaleX = Number(result.capture.width) / Number(result.image_width);
      const scaleY = Number(result.capture.height) / Number(result.image_height || result.image_width);
      session.lastCapture = Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX > 0 && scaleY > 0
        ? { x: Number(result.capture.x) || 0, y: Number(result.capture.y) || 0, scaleX, scaleY }
        : null;
    }
    if (!result.ok) return { name: 'computer', error: true, summary: `computer ${action.action} échec`, text: `computer: ${result.error || 'échec'}` };
    if (['click', 'scroll', 'type', 'key', 'activate_app', 'open_terminal'].includes(action.action)) {
      session.pendingVerification = { action: action.action, at: new Date().toISOString() };
    }
    const images = ['observe', 'inspect'].includes(action.action) && result.image ? [{ mime: result.mime || 'image/png', data: result.image }] : undefined;
    const menuText = action.action === 'menus'
      ? `Menus de ${result.application || "l’application active"} : ${JSON.stringify(result.menus || [])}`
      : null;
    let inspectionText = null;
    if (action.action === 'inspect') {
      const structured = {
        target: result.target || action.target,
        capture: result.capture || null,
        application: result.application || result.ui?.application || null,
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
      const verification = session.pendingVerification ? {
        afterAction: session.pendingVerification.action,
        changedSincePreviousInspection: session.lastPerception ? session.lastPerception.fingerprint !== fingerprint : null,
      } : null;
      session.lastPerception = { fingerprint, at: new Date().toISOString() };
      session.pendingVerification = null;
      inspectionText = `Inspection hybride fournie (capture et interface accessible ; OCR ${result.ocrError ? 'indisponible' : 'selon disponibilité'}). ${verification ? `Vérification après ${verification.afterAction}: changement depuis l’inspection précédente = ${verification.changedSincePreviousInspection == null ? 'inconnu (première référence)' : verification.changedSincePreviousInspection}. ` : ''}Données structurées : ${encoded}`;
    }
    const actionText = action.action === 'activate_app'
      ? 'Application activée. Ne rappelle pas activate_app pour cette application : utilise inspect une fois pour comprendre la fenêtre, puis continue avec key, type, click ou scroll.'
      : action.action === 'observe'
        ? 'Capture d’écran actuelle fournie au modèle. Continue maintenant la tâche demandée ; ne rappelle pas observe sans interaction intermédiaire.'
        : (inspectionText || menuText || `Action ${action.action} effectuée. Utilise inspect après une étape significative si le résultat doit être vérifié.`);
    return { name: 'computer', summary: `computer ${action.action}`, text: actionText, images };
  }

  async complete(session) {
    if (!session || !this.owns(session, session.userId) || session.state === 'stopped') return;
    session.state = 'completed'; this.record(session, 'completed', 'Tâche terminée'); await this.bridge({ action: 'overlay_stop' });
  }
}

module.exports = { AutomationManager, STATES, normalizeAction, needsApproval, isSensitive };
