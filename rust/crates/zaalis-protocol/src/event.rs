//! Events streamed from the core to every client.
//!
//! All events travel on one `session.event` notification carrying an
//! [`EventFrame`]. The frame stamps `session_id`, `agent_id`, `seq` and `ts_ms`
//! on every payload, which is what lets a single stream describe several agents
//! running at once: the client keys its timelines by `agent_id` and its content
//! by `segment_id`, and never has to decide anything.
//!
//! `seq` is monotonic per session. A client that reconnects sends the last one
//! it saw and the core replays from there.

use serde::{Deserialize, Serialize};
use zaalis_core::{
    AgentId, AgentNode, AgentState, CheckpointId, ProviderId, RequestId, Segment, SegmentId,
    SessionId, ToolCallId, Usage,
};

/// One event, stamped with its position in the session stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    pub session_id: SessionId,
    /// Monotonic per session, starting at 1.
    pub seq: u64,
    pub ts_ms: u64,
    /// The agent this event is about. Absent only for session-level events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(flatten)]
    pub event: Event,
}

impl EventFrame {
    pub fn new(session_id: SessionId, seq: u64, ts_ms: u64, event: Event) -> Self {
        let agent_id = event.agent_id();
        Self {
            session_id,
            seq,
            ts_ms,
            agent_id,
            event,
        }
    }
}

/// Everything the core can tell a client.
///
/// The tag is `type`, matching the shape `interface/script/ai.js` and `cli.js`
/// already switch on today, so both existing renderers extend rather than get
/// rewritten.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    // ── Session ──────────────────────────────────────────────────────────
    /// A turn began.
    TurnStarted { prompt: String },
    /// Every agent has settled and the turn is over.
    TurnCompleted {
        usage: Usage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },

    // ── Agent lifecycle ──────────────────────────────────────────────────
    /// A node joined the tree. Carries the whole node so the client can render
    /// a card without a second round trip.
    AgentSpawned { agent: Box<AgentNode> },
    /// A node changed state.
    AgentStateChanged {
        agent_id: AgentId,
        state: AgentState,
    },
    /// A node finished successfully.
    AgentCompleted {
        agent_id: AgentId,
        report: AgentReport,
    },
    /// A node failed.
    AgentFailed { agent_id: AgentId, error: String },
    /// A node was stopped.
    AgentCancelled { agent_id: AgentId },

    // ── Timeline ─────────────────────────────────────────────────────────
    /// A new stretch of an agent's timeline opened.
    SegmentStarted { segment: Segment },
    /// A stretch closed.
    SegmentCompleted {
        segment_id: SegmentId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    /// A fragment of user-facing text.
    TextDelta { segment_id: SegmentId, text: String },
    /// A fragment of provider reasoning.
    ReasoningDelta { segment_id: SegmentId, text: String },

    // ── Tools ────────────────────────────────────────────────────────────
    ToolStarted {
        segment_id: SegmentId,
        call_id: ToolCallId,
        tool: String,
        input: serde_json::Value,
        /// One-line description for the activity list ("read src/app.js").
        title: String,
    },
    /// Intermediate output: a line of stdout, a download percentage, a partial
    /// match list. Zero or more per call.
    ToolProgress {
        call_id: ToolCallId,
        #[serde(flatten)]
        progress: ToolProgress,
    },
    ToolCompleted {
        call_id: ToolCallId,
        outcome: ToolOutcome,
    },

    // ── Interaction (core asks, client answers) ──────────────────────────
    /// The guard needs a decision. The client answers with `permission.decide`.
    PermissionRequested {
        request_id: RequestId,
        agent_id: AgentId,
        tool: String,
        /// What the tool is about to do, in one line.
        summary: String,
        /// The concrete target: a path, a command, a URL.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        /// Why this is being asked rather than auto-approved.
        reason: String,
        /// Findings from command analysis, when the target is a shell command.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        risks: Vec<String>,
    },
    /// The prompt was resolved — by the user, by a timeout, or by cancellation.
    PermissionResolved {
        request_id: RequestId,
        allowed: bool,
        reason: String,
    },
    /// A budget ran out. The orchestration is paused, not killed: the client
    /// answers with `budget.extend` or `session.cancel`.
    BudgetExhausted {
        request_id: RequestId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        limit: String,
        usage: Usage,
    },

    // ── Plan mode ────────────────────────────────────────────────────────
    /// The plan file changed.
    PlanUpdated { revision: u32, content: String },
    /// The agent is done planning and wants approval.
    PlanReady {
        request_id: RequestId,
        revision: u32,
        content: String,
    },

    // ── Results ──────────────────────────────────────────────────────────
    /// An agent produced a change to review.
    DiffAvailable {
        agent_id: AgentId,
        path: String,
        /// Unified diff.
        diff: String,
        added: u32,
        removed: u32,
    },
    CheckpointCreated {
        checkpoint_id: CheckpointId,
        label: String,
        files: u32,
    },
    UsageUpdated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        usage: Usage,
        /// Roll-up across every agent in the session.
        session_total: Usage,
    },

    // ── Failures ─────────────────────────────────────────────────────────
    /// A provider failed. Scoped to the provider, not the session: agents on
    /// other providers keep running.
    ProviderError {
        provider: ProviderId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        code: String,
        message: String,
        /// Set when the core intends to retry on its own.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_in_ms: Option<u64>,
    },
    /// Something went wrong outside any single agent.
    SessionError { code: String, message: String },
}

impl Event {
    /// Which agent this event belongs to, if any.
    fn agent_id(&self) -> Option<AgentId> {
        match self {
            Event::AgentSpawned { agent } => Some(agent.id.clone()),
            Event::AgentStateChanged { agent_id, .. }
            | Event::AgentCompleted { agent_id, .. }
            | Event::AgentFailed { agent_id, .. }
            | Event::AgentCancelled { agent_id }
            | Event::PermissionRequested { agent_id, .. }
            | Event::DiffAvailable { agent_id, .. } => Some(agent_id.clone()),
            Event::SegmentStarted { segment } => Some(segment.agent_id.clone()),
            Event::BudgetExhausted { agent_id, .. }
            | Event::UsageUpdated { agent_id, .. }
            | Event::ProviderError { agent_id, .. } => agent_id.clone(),
            _ => None,
        }
    }

    /// The stable discriminant string, matching the `type` field on the wire.
    pub fn kind(&self) -> &'static str {
        match self {
            Event::TurnStarted { .. } => "turn_started",
            Event::TurnCompleted { .. } => "turn_completed",
            Event::AgentSpawned { .. } => "agent_spawned",
            Event::AgentStateChanged { .. } => "agent_state_changed",
            Event::AgentCompleted { .. } => "agent_completed",
            Event::AgentFailed { .. } => "agent_failed",
            Event::AgentCancelled { .. } => "agent_cancelled",
            Event::SegmentStarted { .. } => "segment_started",
            Event::SegmentCompleted { .. } => "segment_completed",
            Event::TextDelta { .. } => "text_delta",
            Event::ReasoningDelta { .. } => "reasoning_delta",
            Event::ToolStarted { .. } => "tool_started",
            Event::ToolProgress { .. } => "tool_progress",
            Event::ToolCompleted { .. } => "tool_completed",
            Event::PermissionRequested { .. } => "permission_requested",
            Event::PermissionResolved { .. } => "permission_resolved",
            Event::BudgetExhausted { .. } => "budget_exhausted",
            Event::PlanUpdated { .. } => "plan_updated",
            Event::PlanReady { .. } => "plan_ready",
            Event::DiffAvailable { .. } => "diff_available",
            Event::CheckpointCreated { .. } => "checkpoint_created",
            Event::UsageUpdated { .. } => "usage_updated",
            Event::ProviderError { .. } => "provider_error",
            Event::SessionError { .. } => "session_error",
        }
    }
}

/// Intermediate output from a running tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "progress", rename_all = "snake_case")]
pub enum ToolProgress {
    /// A chunk of output — a line of stdout, a partial result set.
    Output { text: String },
    /// A quantified step.
    Step {
        done: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// A short status change with nothing to append.
    Status { label: String },
}

/// How a tool call ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolOutcome {
    Ok {
        /// One-line recap for the collapsed activity row.
        summary: String,
        /// Structured result. Tools return typed values, not a wall of text, so
        /// the client can render a diff card or a file list properly.
        result: serde_json::Value,
        duration_ms: u64,
    },
    Error {
        summary: String,
        code: String,
        message: String,
        duration_ms: u64,
    },
    Denied {
        summary: String,
        reason: String,
    },
    Cancelled {
        summary: String,
    },
}

impl ToolOutcome {
    pub fn summary(&self) -> &str {
        match self {
            ToolOutcome::Ok { summary, .. }
            | ToolOutcome::Error { summary, .. }
            | ToolOutcome::Denied { summary, .. }
            | ToolOutcome::Cancelled { summary } => summary,
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, ToolOutcome::Ok { .. })
    }
}

/// What an agent hands back when it finishes.
///
/// Structured rather than a concatenated string, because the orchestrator has
/// to decide what to do with it and the client has to render it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentReport {
    /// The agent's answer.
    pub summary: String,
    /// Files it touched, relative to the project root.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files_changed: Vec<String>,
    /// Tools it ran, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools_used: Vec<String>,
    pub usage: Usage,
    /// Set when the agent stopped early but still produced something usable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::{ModelBinding, PermissionSet, RoleSpec, SegmentKind, SegmentState};

    fn sample_node() -> AgentNode {
        AgentNode::new(
            SessionId::from_raw("ses_1"),
            RoleSpec::new("explore"),
            ModelBinding::new(ProviderId::Mistral, None),
            PermissionSet::read_only(),
            0,
        )
    }

    #[test]
    fn the_frame_derives_agent_id_from_the_event() {
        let node = sample_node();
        let expected = node.id.clone();
        let frame = EventFrame::new(
            SessionId::from_raw("ses_1"),
            1,
            0,
            Event::AgentSpawned {
                agent: Box::new(node),
            },
        );
        assert_eq!(frame.agent_id, Some(expected));
    }

    #[test]
    fn session_level_events_carry_no_agent_id() {
        let frame = EventFrame::new(
            SessionId::from_raw("ses_1"),
            1,
            0,
            Event::TurnStarted {
                prompt: "salut".into(),
            },
        );
        assert_eq!(frame.agent_id, None);
        let value = serde_json::to_value(&frame).expect("serialize");
        assert!(value.get("agent_id").is_none());
    }

    #[test]
    fn the_wire_shape_is_flat_with_a_type_discriminant() {
        let frame = EventFrame::new(
            SessionId::from_raw("ses_1"),
            42,
            1_700_000_000_000,
            Event::TextDelta {
                segment_id: SegmentId::from_raw("seg_1"),
                text: "bonjour".into(),
            },
        );
        let value = serde_json::to_value(&frame).expect("serialize");
        // The existing renderers switch on `event.type`; keeping it at the top
        // level is what makes them extendable instead of replaceable.
        assert_eq!(value["type"], "text_delta");
        assert_eq!(value["segment_id"], "seg_1");
        assert_eq!(value["seq"], 42);
        assert_eq!(value["session_id"], "ses_1");
    }

    #[test]
    fn interleaved_agents_stay_separable_from_one_stream() {
        let a = AgentId::from_raw("agt_a");
        let b = AgentId::from_raw("agt_b");
        let frames = [
            EventFrame::new(
                SessionId::from_raw("ses_1"),
                1,
                0,
                Event::SegmentStarted {
                    segment: Segment::new(a.clone(), SegmentKind::Reasoning, 0, 0),
                },
            ),
            EventFrame::new(
                SessionId::from_raw("ses_1"),
                2,
                0,
                Event::SegmentStarted {
                    segment: Segment::new(b.clone(), SegmentKind::Text, 0, 0),
                },
            ),
            EventFrame::new(
                SessionId::from_raw("ses_1"),
                3,
                0,
                Event::AgentStateChanged {
                    agent_id: a.clone(),
                    state: AgentState::Running,
                },
            ),
        ];

        // A client filtering by agent_id reconstructs each timeline with no
        // ordering logic of its own — the whole point of stamping the frame.
        let for_a: Vec<u64> = frames
            .iter()
            .filter(|frame| frame.agent_id.as_ref() == Some(&a))
            .map(|frame| frame.seq)
            .collect();
        assert_eq!(for_a, vec![1, 3]);

        let for_b: Vec<u64> = frames
            .iter()
            .filter(|frame| frame.agent_id.as_ref() == Some(&b))
            .map(|frame| frame.seq)
            .collect();
        assert_eq!(for_b, vec![2]);
    }

    #[test]
    fn every_event_round_trips() {
        let events = vec![
            Event::TurnStarted { prompt: "p".into() },
            Event::TurnCompleted {
                usage: Usage::default(),
                summary: Some("fini".into()),
            },
            Event::AgentSpawned {
                agent: Box::new(sample_node()),
            },
            Event::AgentStateChanged {
                agent_id: AgentId::from_raw("agt_a"),
                state: AgentState::Blocked {
                    waiting_on: vec![AgentId::from_raw("agt_b")],
                },
            },
            Event::AgentCompleted {
                agent_id: AgentId::from_raw("agt_a"),
                report: AgentReport::default(),
            },
            Event::AgentFailed {
                agent_id: AgentId::from_raw("agt_a"),
                error: "boom".into(),
            },
            Event::AgentCancelled {
                agent_id: AgentId::from_raw("agt_a"),
            },
            Event::SegmentStarted {
                segment: Segment::new(AgentId::from_raw("agt_a"), SegmentKind::Reasoning, 0, 0),
            },
            Event::SegmentCompleted {
                segment_id: SegmentId::from_raw("seg_1"),
                duration_ms: Some(12),
            },
            Event::TextDelta {
                segment_id: SegmentId::from_raw("seg_1"),
                text: "x".into(),
            },
            Event::ReasoningDelta {
                segment_id: SegmentId::from_raw("seg_1"),
                text: "y".into(),
            },
            Event::ToolStarted {
                segment_id: SegmentId::from_raw("seg_1"),
                call_id: ToolCallId::from_raw("tc_1"),
                tool: "read".into(),
                input: serde_json::json!({"path": "a.js"}),
                title: "read a.js".into(),
            },
            Event::ToolProgress {
                call_id: ToolCallId::from_raw("tc_1"),
                progress: ToolProgress::Output {
                    text: "line".into(),
                },
            },
            Event::ToolCompleted {
                call_id: ToolCallId::from_raw("tc_1"),
                outcome: ToolOutcome::Ok {
                    summary: "read a.js".into(),
                    result: serde_json::json!({"lines": 3}),
                    duration_ms: 4,
                },
            },
            Event::PermissionRequested {
                request_id: RequestId::from_raw("req_1"),
                agent_id: AgentId::from_raw("agt_a"),
                tool: "run".into(),
                summary: "npm test".into(),
                target: Some("npm test".into()),
                reason: "mode supervised".into(),
                risks: vec!["réseau".into()],
            },
            Event::PermissionResolved {
                request_id: RequestId::from_raw("req_1"),
                allowed: true,
                reason: "user_prompt".into(),
            },
            Event::BudgetExhausted {
                request_id: RequestId::from_raw("req_2"),
                agent_id: None,
                limit: "tokens".into(),
                usage: Usage::default(),
            },
            Event::PlanUpdated {
                revision: 1,
                content: "# Plan".into(),
            },
            Event::PlanReady {
                request_id: RequestId::from_raw("req_3"),
                revision: 1,
                content: "# Plan".into(),
            },
            Event::DiffAvailable {
                agent_id: AgentId::from_raw("agt_a"),
                path: "src/a.js".into(),
                diff: "@@".into(),
                added: 2,
                removed: 1,
            },
            Event::CheckpointCreated {
                checkpoint_id: CheckpointId::from_raw("ckpt_1"),
                label: "avant refactor".into(),
                files: 12,
            },
            Event::UsageUpdated {
                agent_id: None,
                usage: Usage::default(),
                session_total: Usage::default(),
            },
            Event::ProviderError {
                provider: ProviderId::Mistral,
                agent_id: None,
                code: "rate_limited".into(),
                message: "429".into(),
                retry_in_ms: Some(2_000),
            },
            Event::SessionError {
                code: "internal".into(),
                message: "boom".into(),
            },
        ];

        for event in events {
            let kind = event.kind();
            let json = serde_json::to_string(&event).expect("serialize");
            let value: serde_json::Value = serde_json::from_str(&json).expect("value");
            assert_eq!(
                value["type"], kind,
                "kind() must match the serialised discriminant"
            );
            let back: Event = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, event);
        }
    }

    #[test]
    fn tool_outcomes_expose_a_summary_whatever_the_status() {
        let outcomes = [
            ToolOutcome::Ok {
                summary: "a".into(),
                result: serde_json::Value::Null,
                duration_ms: 0,
            },
            ToolOutcome::Error {
                summary: "b".into(),
                code: "io".into(),
                message: "m".into(),
                duration_ms: 0,
            },
            ToolOutcome::Denied {
                summary: "c".into(),
                reason: "r".into(),
            },
            ToolOutcome::Cancelled {
                summary: "d".into(),
            },
        ];
        let summaries: Vec<_> = outcomes.iter().map(|o| o.summary()).collect();
        assert_eq!(summaries, vec!["a", "b", "c", "d"]);
        assert!(outcomes[0].is_ok());
        assert!(!outcomes[1].is_ok());
    }

    #[test]
    fn a_streaming_segment_is_not_yet_complete() {
        let segment = Segment::new(AgentId::from_raw("agt_a"), SegmentKind::Text, 0, 0);
        assert_eq!(segment.state, SegmentState::Streaming);
    }
}
