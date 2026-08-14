//! Timeline segments.
//!
//! An agent turn is not "a string with some tool calls around it". It is an
//! ordered list of typed segments: the model reasons, calls a tool, reasons
//! again, answers. Deltas carry a `segment_id`, so a client receiving several
//! agents interleaved on one stream can render each timeline correctly by
//! appending to the element that matches the id — no ordering logic, no
//! buffering, no agentic decisions in the UI.

use crate::ids::{AgentId, SegmentId, ToolCallId};
use serde::{Deserialize, Serialize};

/// What a segment holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SegmentKind {
    /// Provider-emitted reasoning / thinking.
    Reasoning,
    /// Text meant for the user.
    Text,
    /// One tool invocation and its result.
    ToolCall { call_id: ToolCallId, tool: String },
    /// The orchestrator handing work to a child.
    Delegation { child: AgentId },
    /// The orchestrator waiting on dependencies.
    Wait { waiting_on: Vec<AgentId> },
    /// Bringing a child's work back into the parent's workspace.
    Merge { source: AgentId },
    /// One agent reviewing another's output.
    Review { target: AgentId },
    /// A permission prompt, kept in the timeline so the transcript shows what
    /// was asked and what the user answered.
    Permission { request: String },
}

impl SegmentKind {
    pub fn label(&self) -> &'static str {
        match self {
            SegmentKind::Reasoning => "reasoning",
            SegmentKind::Text => "text",
            SegmentKind::ToolCall { .. } => "tool_call",
            SegmentKind::Delegation { .. } => "delegation",
            SegmentKind::Wait { .. } => "wait",
            SegmentKind::Merge { .. } => "merge",
            SegmentKind::Review { .. } => "review",
            SegmentKind::Permission { .. } => "permission",
        }
    }
}

/// Lifecycle of a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SegmentState {
    /// Receiving deltas.
    Streaming,
    /// Finished normally.
    Complete,
    /// Finished with an error.
    Failed,
    /// Interrupted.
    Cancelled,
}

/// One stretch of an agent's timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub id: SegmentId,
    pub agent_id: AgentId,
    #[serde(flatten)]
    pub kind: SegmentKind,
    pub state: SegmentState,
    /// Position within the agent's timeline. Monotonic per agent, so a client
    /// that reconnects mid-turn can place late-arriving segments correctly.
    pub index: u32,
    pub started_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
}

impl Segment {
    pub fn new(agent_id: AgentId, kind: SegmentKind, index: u32, now_ms: u64) -> Self {
        Self {
            id: SegmentId::new(),
            agent_id,
            kind,
            state: SegmentState::Streaming,
            index,
            started_at_ms: now_ms,
            finished_at_ms: None,
        }
    }

    pub fn complete(&mut self, now_ms: u64) {
        self.state = SegmentState::Complete;
        self.finished_at_ms = Some(now_ms);
    }

    pub fn fail(&mut self, now_ms: u64) {
        self.state = SegmentState::Failed;
        self.finished_at_ms = Some(now_ms);
    }

    pub fn duration_ms(&self) -> Option<u64> {
        self.finished_at_ms
            .map(|end| end.saturating_sub(self.started_at_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_segment_records_its_own_duration() {
        let mut segment = Segment::new(AgentId::new(), SegmentKind::Reasoning, 0, 1_000);
        assert_eq!(segment.duration_ms(), None);
        segment.complete(1_450);
        assert_eq!(segment.duration_ms(), Some(450));
        assert_eq!(segment.state, SegmentState::Complete);
    }

    #[test]
    fn segment_kind_flattens_onto_the_segment_in_json() {
        let segment = Segment::new(
            AgentId::from_raw("agt_x"),
            SegmentKind::ToolCall {
                call_id: ToolCallId::from_raw("tc_1"),
                tool: "read".into(),
            },
            2,
            0,
        );
        let value = serde_json::to_value(&segment).expect("serialize");
        // `kind` sits next to `agent_id` rather than nested, which keeps the
        // JavaScript client's switch statement flat.
        assert_eq!(value["kind"], "tool_call");
        assert_eq!(value["tool"], "read");
        assert_eq!(value["agent_id"], "agt_x");
        assert_eq!(value["index"], 2);
    }

    #[test]
    fn every_segment_kind_round_trips() {
        let kinds = vec![
            SegmentKind::Reasoning,
            SegmentKind::Text,
            SegmentKind::ToolCall {
                call_id: ToolCallId::from_raw("tc_1"),
                tool: "grep".into(),
            },
            SegmentKind::Delegation {
                child: AgentId::from_raw("agt_child"),
            },
            SegmentKind::Wait {
                waiting_on: vec![AgentId::from_raw("agt_a")],
            },
            SegmentKind::Merge {
                source: AgentId::from_raw("agt_a"),
            },
            SegmentKind::Review {
                target: AgentId::from_raw("agt_b"),
            },
            SegmentKind::Permission {
                request: "req_1".into(),
            },
        ];
        for kind in kinds {
            let json = serde_json::to_string(&kind).expect("serialize");
            let back: SegmentKind = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, kind);
        }
    }
}
