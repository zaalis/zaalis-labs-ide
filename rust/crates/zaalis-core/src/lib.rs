//! Shared domain types for the zaalis agent platform.
//!
//! This crate is the bottom of the dependency graph: it knows about agents,
//! models, permissions and errors, and nothing else. It has no idea how a tool
//! runs, how a provider is called, or how a client connects. Everything above
//! it — the protocol, the guard, the tool runtime, the runtime itself — depends
//! on these types, which is what keeps them from depending on each other.
//!
//! Three design rules are enforced here rather than by convention:
//!
//! 1. **A single agent is a tree of size one.** [`agent::AgentTree`] is the only
//!    representation; there is no separate "multi-agent" path to drift apart
//!    from the single-agent one.
//! 2. **Role and model are independent.** [`agent::RoleSpec`] contains no
//!    provider, and [`model::ModelBinding`] contains no role. Nothing may infer
//!    one from the other.
//! 3. **A child is never more privileged than its parent.**
//!    [`agent::AgentTree::insert_child`] intersects permissions and clamps
//!    budgets itself, so a caller cannot forget to.

pub mod agent;
pub mod error;
pub mod ids;
pub mod model;
pub mod permission;
pub mod segment;

pub use agent::{
    AgentNode, AgentState, AgentTree, Budget, BudgetLimit, RoleSpec, TreeError, Usage, Workspace,
};
pub use error::{ErrorCode, Result, ZaalisError};
pub use ids::{AgentId, CheckpointId, RequestId, SegmentId, SessionId, ToolCallId};
pub use model::{
    BindingOrigin, InheritFromParent, ModelBinding, ModelPolicy, ProviderId, ReasoningLevel,
};
pub use permission::{
    AccessKind, Decision, DecisionReason, GrantScope, PermissionAnswer, PermissionMode,
    PermissionRule, PermissionSet,
};
pub use segment::{Segment, SegmentKind, SegmentState};

/// Milliseconds since the Unix epoch.
///
/// Timestamps are passed in explicitly everywhere else so the domain types stay
/// deterministic under test; this is the one place that reads the clock.
pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_a_plausible_epoch_millisecond() {
        // Later than 2020-01-01, earlier than 2100-01-01.
        let now = now_ms();
        assert!(now > 1_577_836_800_000);
        assert!(now < 4_102_444_800_000);
    }

    #[test]
    fn a_classic_chat_session_builds_a_one_node_tree() {
        // The shape every surface goes through, spelled out once as a
        // regression guard on the public API.
        let session = SessionId::new();
        let mut tree = AgentTree::new();
        let root = AgentNode::new(
            session,
            RoleSpec::general_purpose(),
            ModelBinding::new(ProviderId::Mistral, Some("mistral-medium-3-5".into())),
            PermissionSet::new(PermissionMode::Supervised),
            now_ms(),
        )
        .with_objective("Corriger le bug d'authentification");

        let root_id = tree.insert_root(root).expect("insert root");
        assert_eq!(tree.len(), 1);
        assert_eq!(tree.ready(), vec![root_id]);
    }
}
