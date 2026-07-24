'use strict';

// Provider-neutral contracts shared by the IDE, CLI and the agent runtime.
// Keeping these values in one module prevents a provider adapter from gaining
// an unvalidated capability merely because another adapter forgot a check.
const crypto = require('crypto');

const TOOL_ERROR_CODES = Object.freeze([
  'invalid_arguments', 'permission_denied', 'approval_required',
  'sandbox_violation', 'timeout', 'tool_failure', 'tool_unavailable',
]);

const MUTATING_TOOLS = new Set(['edit', 'write', 'run', 'git_write', 'image_download']);
// Opening a URL in Zaalis does not alter the project or the operating system.
// Treat it as read-only so supervised mode does not turn a harmless preview
// into an approval request with no useful replay path.
const READ_ONLY_TOOLS = new Set(['todo', 'task', 'read', 'glob', 'grep', 'audit', 'git', 'browser', 'image_search', 'brain', 'mcp', 'lsp', 'computer', 'web_fetch', 'security']);

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function text(value, max = 10000) {
  return String(value == null ? '' : value).slice(0, max);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toolCall({ id: callId, name, input, sessionId, turnId, agentId } = {}) {
  const tool = text(name, 80).toLowerCase();
  if (!tool) throw new Error('ToolCall requires a tool name.');
  return {
    id: callId || id('call'),
    type: 'tool_call',
    tool,
    input: object(input),
    sessionId: text(sessionId, 128) || undefined,
    turnId: text(turnId, 128) || undefined,
    agentId: text(agentId, 128) || undefined,
    createdAt: new Date().toISOString(),
  };
}

function toolResult({ callId, tool, input, code, text: body, blocked = false, error = false, meta } = {}) {
  const safeCode = TOOL_ERROR_CODES.includes(code) ? code : undefined;
  return {
    id: id('result'),
    type: 'tool_result',
    callId: text(callId, 128) || undefined,
    tool: text(tool, 80).toLowerCase() || undefined,
    input: object(input),
    code: safeCode,
    blocked: !!blocked,
    error: !!error,
    text: text(body, 1024 * 1024),
    meta: object(meta),
    completedAt: new Date().toISOString(),
  };
}

function approvalDecision({ approvalId, callId, decision, reason, expiresAt } = {}) {
  const value = ['allow', 'deny', 'expired'].includes(decision) ? decision : 'deny';
  return {
    id: text(approvalId, 128) || id('approval'),
    type: 'approval_decision',
    callId: text(callId, 128) || undefined,
    decision: value,
    reason: text(reason, 500),
    expiresAt: expiresAt || undefined,
    decidedAt: new Date().toISOString(),
  };
}

function agentEvent({ type, sessionId, turnId, agentId, ...rest } = {}) {
  return {
    id: id('event'),
    type: text(type || 'event', 80),
    sessionId: text(sessionId, 128) || undefined,
    turnId: text(turnId, 128) || undefined,
    agentId: text(agentId, 128) || undefined,
    ts: Date.now(),
    ...rest,
  };
}

module.exports = {
  TOOL_ERROR_CODES,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  toolCall,
  toolResult,
  approvalDecision,
  agentEvent,
  id,
};
