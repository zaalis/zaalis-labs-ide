'use strict';

// Keep the lead response separate from child agents, and preserve paragraph
// boundaries when the runtime opens a new text segment around a tool call.
function createStreamState() {
  const state = { text: '', reasoning: '', sessionId: null, leadId: null, segment: null };
  return {
    state,
    accept(envelope) {
      const frame = envelope?.type === 'rust_event' ? envelope.event : envelope;
      if (!frame) return null;
      if (frame.session_id) state.sessionId = frame.session_id;
      if (frame.type === 'agent_spawned' && frame.agent?.role?.name === 'lead') state.leadId = frame.agent.id;
      if (state.leadId && frame.agent_id && frame.agent_id !== state.leadId) return null;
      if (frame.type === 'text_delta') {
        const segment = String(frame.segment_id || '');
        const gap = state.text && state.segment !== segment && !/\n\s*$/.test(state.text) ? '\n\n' : '';
        const delta = gap + String(frame.text || '');
        state.segment = segment;
        state.text += delta;
        return { kind: 'text', delta, text: state.text };
      }
      if (frame.type === 'reasoning_delta') {
        const delta = String(frame.text || '');
        state.reasoning += delta;
        return { kind: 'reasoning', delta, text: state.reasoning };
      }
      return null;
    },
  };
}

module.exports = { createStreamState };
