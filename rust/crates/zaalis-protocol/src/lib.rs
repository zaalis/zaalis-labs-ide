//! The zaalis client/core protocol.
//!
//! Three clients speak it — the IDE chat, the IDE Agents panel and the CLI —
//! and they all get the same capabilities because they all talk to the same
//! daemon. Nothing here knows how an agent works; it only describes what can be
//! asked and what can be observed.
//!
//! # Shape
//!
//! JSON-RPC 2.0, newline-delimited, over a duplex transport (stdio for the CLI,
//! a local WebSocket for the IDE). Duplex matters: a permission prompt is a
//! question the core asks the client, and a one-way stream cannot carry one.
//!
//! ```text
//! client → core   session.create · session.prompt · session.cancel
//!                 agent.add/update/remove · permission.decide
//!                 plan.approve/reject · budget.extend · checkpoint.restore
//!
//! core → client   session.event  (one notification carrying every event)
//! ```
//!
//! # Why every event is stamped
//!
//! An [`EventFrame`] carries `session_id`, `seq`, `ts_ms` and an optional
//! `agent_id`, and content deltas carry a `segment_id`. Together those let one
//! stream describe ten agents running at once while the client stays a pure
//! renderer: append the delta to the element named by `segment_id`, group by
//! `agent_id`. No buffering, no reordering, no agentic logic in the UI.
//!
//! # Independence
//!
//! This protocol is zaalis' own. It borrows no code and no vocabulary from any
//! third-party agent tool, and the core has no functional dependency on any
//! vendor beyond the model providers a user configures.

pub mod envelope;
pub mod event;
pub mod method;

pub use envelope::{
    JsonRpcVersion, RpcError, RpcId, RpcMessage, RpcNotification, RpcRequest, RpcResponse,
};
pub use event::{AgentReport, Event, EventFrame, ToolOutcome, ToolProgress};
pub use method::{
    AgentAddParams, AgentRemoveParams, AgentResult, AgentSpec, AgentUpdateParams,
    BudgetExtendParams, CheckpointRestoreParams, ClientMethod, HealthResult, HistoryMessage,
    ImageAttachment, ModelsListResult, PermissionDecideParams, PlanDecisionParams,
    ProviderCapabilitiesInfo, ProviderInfo, SandboxCapabilitiesInfo, SessionCancelParams,
    SessionCreateParams, SessionCreateResult, SessionEventParams, SessionInspectResult,
    SessionMode, SessionPromptParams, SessionResumeParams, SessionUsageResult, ToolInfo,
    ToolsListParams, ToolsListResult,
};

/// Protocol version, bumped when a change is not backward compatible.
pub const PROTOCOL_VERSION: u32 = 1;

/// Build the `session.event` notification for one frame.
pub fn event_notification(frame: EventFrame) -> RpcNotification {
    RpcNotification::new(
        method::SESSION_EVENT,
        serde_json::to_value(frame).unwrap_or(serde_json::Value::Null),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::{SegmentId, SessionId};

    #[test]
    fn an_event_becomes_a_well_formed_notification_line() {
        let frame = EventFrame::new(
            SessionId::from_raw("ses_1"),
            1,
            0,
            Event::TextDelta {
                segment_id: SegmentId::from_raw("seg_1"),
                text: "bonjour".into(),
            },
        );
        let line = RpcMessage::Notification(event_notification(frame)).to_line();
        assert!(line.starts_with(r#"{"jsonrpc":"2.0","method":"session.event""#));

        // And it parses back as a notification, not a request.
        match RpcMessage::from_line(&line).expect("parse") {
            RpcMessage::Notification(notification) => {
                assert_eq!(notification.method, method::SESSION_EVENT);
                let params = notification.params.expect("params");
                assert_eq!(params["type"], "text_delta");
                assert_eq!(params["text"], "bonjour");
            }
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn a_full_create_prompt_exchange_round_trips() {
        // The exact sequence every surface performs on its first turn.
        let create = RpcRequest::new(
            1,
            method::SESSION_CREATE,
            serde_json::to_value(SessionCreateParams {
                root: "C:/projet".into(),
                mode: SessionMode::Chat,
                model: Some(zaalis_core::ModelBinding::new(
                    zaalis_core::ProviderId::Mistral,
                    Some("mistral-medium-3-5".into()),
                )),
                agents: Vec::new(),
                permission_mode: zaalis_core::PermissionMode::Supervised,
                budget: None,
                language: "fr".into(),
                session_id: None,
                history: Vec::new(),
                system_prompt: None,
            })
            .expect("serialize"),
        );

        let line = RpcMessage::Request(create.clone()).to_line();
        let back = RpcMessage::from_line(&line).expect("parse");
        assert_eq!(back, RpcMessage::Request(create));
    }

    #[test]
    fn unknown_methods_are_rejected_rather_than_ignored() {
        assert!(ClientMethod::parse("session.evaluate").is_none());
        let error = RpcError::method_not_found("session.evaluate");
        assert_eq!(error.code, RpcError::METHOD_NOT_FOUND);
    }
}
