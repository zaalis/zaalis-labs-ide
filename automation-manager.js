'use strict';

const crypto = require('crypto');

const STATES = new Set(['running', 'waiting_user', 'stopping', 'stopped', 'failed', 'completed']);
const ACTIONS = new Set(['observe', 'menus', 'move', 'click', 'scroll', 'type', 'key', 'open_terminal', 'activate_app', 'ask']);
const ALWAYS_CONFIRM = new Set(['open_terminal']);

function text(v, cap = 8000) { return String(v == null ? '' : v).slice(0, cap); }
function finite(v, min, max) { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; }

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
  if (action === 'scroll') { out.dx = Math.round(finite(input.dx, -120, 120) || 0); out.dy = Math.round(finite(input.dy, -120, 120) || 0); }
  if (action === 'type') { out.text = text(input.text, 8000); if (!out.text) return null; }
  if (action === 'key') {
    out.key = text(input.key, 20).toLowerCase();
    out.modifiers = Array.isArray(input.modifiers) ? input.modifiers.map((v) => text(v, 12).toLowerCase()).filter((v) => ['cmd', 'command', 'meta', 'super', 'ctrl', 'control', 'alt', 'option', 'opt', 'shift'].includes(v)).slice(0, 4) : [];
    if (!out.key) return null;
  }
  if (action === 'activate_app') { out.path = text(input.path, 1024); if (!/^\/.*\.app$/.test(out.path)) return null; }
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
  if (mode === 'supervised') return !['observe', 'menus', 'move', 'scroll'].includes(action.action);
  if (mode === 'semi') return ALWAYS_CONFIRM.has(action.action);
  return false;
}

class AutomationManager {
  constructor({ bridgeUrl = '', bridgeSecret = '' } = {}) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, '');
    this.bridgeSecret = bridgeSecret;
    this.active = null;
  }

  snapshot(session = this.active) {
    if (!session) return { active: false, state: 'idle' };
    return { active: true, id: session.id, state: session.state, permissionMode: session.permissionMode, lastAction: session.lastAction || null, question: session.question || null, events: session.events.slice(-30) };
  }

  async bridge(body) {
    if (!this.bridgeUrl || !this.bridgeSecret) return { ok: false, error: 'computer-bridge-unavailable' };
    try {
      const response = await fetch(`${this.bridgeUrl}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-zaalis-computer': this.bridgeSecret }, body: JSON.stringify(body) });
      return await response.json();
    } catch (error) { return { ok: false, error: error.message || 'computer-bridge-unavailable' }; }
  }

  async status() { return this.bridge({ action: 'status' }); }

  async start({ userId, permissionMode }) {
    if (this.active && ['running', 'waiting_user', 'stopping'].includes(this.active.state)) throw new Error('Une tâche de contrôle macOS est déjà active.');
    const permissions = await this.status();
    if (!permissions.ok) throw new Error(permissions.error || 'Pont macOS indisponible.');
    const session = { id: crypto.randomUUID(), userId, permissionMode, state: 'running', events: [], lastAction: null, question: null, answer: null, answerResolve: null };
    this.active = session;
    await this.bridge({ action: 'overlay_start' });
    this.record(session, 'session_started', 'Contrôle macOS activé');
    if (!permissions.accessibility || !permissions.screenRecording) {
      this.record(session, 'permission_status', 'Autorisations macOS non confirmées : le helper les vérifiera lors de chaque action.');
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
    // into waiting_user (passwords, 2FA, payments, destructive submissions…).
    if (isSensitive(action)) {
      this.record(session, 'sensitive_blocked', `computer ${action.action} bloqué`, action);
      return { name: 'computer', blocked: true, summary: 'computer action sensible bloquée', text: 'computer: action sensible bloquée en contrôle automatique.' };
    }
    this.record(session, 'action', `computer ${action.action}`, action);
    const result = await this.bridge(action);
    if (!result.ok) return { name: 'computer', error: true, summary: `computer ${action.action} échec`, text: `computer: ${result.error || 'échec'}` };
    const images = action.action === 'observe' && result.image ? [{ mime: result.mime || 'image/png', data: result.image }] : undefined;
    const menuText = action.action === 'menus'
      ? `Menus de ${result.application || "l’application active"} : ${JSON.stringify(result.menus || [])}`
      : null;
    const actionText = action.action === 'activate_app'
      ? 'Application activée. Ne rappelle pas activate_app pour cette application : observe une seule fois si nécessaire, puis continue avec key, type, click ou scroll.'
      : action.action === 'observe'
        ? 'Capture d’écran actuelle fournie au modèle. Continue maintenant la tâche demandée ; ne rappelle pas observe sans interaction intermédiaire.'
        : (menuText || `Action ${action.action} effectuée.`);
    return { name: 'computer', summary: `computer ${action.action}`, text: actionText, images };
  }

  async complete(session) {
    if (!session || !this.owns(session, session.userId) || session.state === 'stopped') return;
    session.state = 'completed'; this.record(session, 'completed', 'Tâche terminée'); await this.bridge({ action: 'overlay_stop' });
  }
}

module.exports = { AutomationManager, STATES, normalizeAction, needsApproval, isSensitive };
