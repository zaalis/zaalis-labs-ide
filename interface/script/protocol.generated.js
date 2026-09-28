// Généré depuis rust/crates/zaalis-protocol — ne pas modifier à la main.
// Régénérer : cargo run -p zaalis-protocol --bin generate-bindings
'use strict';

const PROTOCOL_VERSION = 1;

// Méthodes JSON-RPC appelables par un client.
const METHODS = Object.freeze({
  SESSION_CREATE: 'session.create',
  SESSION_RESUME: 'session.resume',
  SESSION_PROMPT: 'session.prompt',
  SESSION_CANCEL: 'session.cancel',
  SESSION_CLOSE: 'session.close',
  SESSION_USAGE: 'session.usage',
  SESSION_INSPECT: 'session.inspect',
  AGENT_ADD: 'agent.add',
  AGENT_UPDATE: 'agent.update',
  AGENT_REMOVE: 'agent.remove',
  PERMISSION_DECIDE: 'permission.decide',
  PLAN_APPROVE: 'plan.approve',
  PLAN_REJECT: 'plan.reject',
  BUDGET_EXTEND: 'budget.extend',
  CHECKPOINT_RESTORE: 'checkpoint.restore',
  TOOLS_LIST: 'tools.list',
  MODELS_LIST: 'models.list',
  HEALTH: 'health',
});

// Valeurs possibles du champ `type` d'un événement.
const EVENTS = Object.freeze({
  TURN_STARTED: 'turn_started',
  TURN_COMPLETED: 'turn_completed',
  AGENT_SPAWNED: 'agent_spawned',
  AGENT_STATE_CHANGED: 'agent_state_changed',
  AGENT_COMPLETED: 'agent_completed',
  AGENT_FAILED: 'agent_failed',
  AGENT_CANCELLED: 'agent_cancelled',
  SEGMENT_STARTED: 'segment_started',
  SEGMENT_COMPLETED: 'segment_completed',
  TEXT_DELTA: 'text_delta',
  REASONING_DELTA: 'reasoning_delta',
  TOOL_STARTED: 'tool_started',
  TOOL_PROGRESS: 'tool_progress',
  TOOL_COMPLETED: 'tool_completed',
  PERMISSION_REQUESTED: 'permission_requested',
  PERMISSION_RESOLVED: 'permission_resolved',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  PLAN_UPDATED: 'plan_updated',
  PLAN_READY: 'plan_ready',
  DIFF_AVAILABLE: 'diff_available',
  CHECKPOINT_CREATED: 'checkpoint_created',
  USAGE_UPDATED: 'usage_updated',
  PROVIDER_ERROR: 'provider_error',
  SESSION_ERROR: 'session_error',
});

const EVENT_TAGS = Object.freeze(Object.values(EVENTS));
const METHOD_NAMES = Object.freeze(Object.values(METHODS));

module.exports = { PROTOCOL_VERSION, METHODS, METHOD_NAMES, EVENTS, EVENT_TAGS };
