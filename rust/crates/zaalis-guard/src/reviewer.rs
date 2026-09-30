//! A second opinion on the decisions the deterministic engine cannot settle.
//!
//! [`Guard::evaluate`] answers three ways: allow, deny, or ask. The first two
//! are policy and stay untouched. The third is where prompt fatigue is made:
//! in `semi` and `auto` the agent is meant to work with light supervision, yet
//! every unfamiliar binary and every risky-looking command stops it dead until
//! a human looks. Users answer those prompts reflexively, which is the failure
//! the prompt existed to prevent.
//!
//! So a reviewer may be consulted *only* on [`Decision::Ask`], and only in the
//! modes that asked for less supervision. Four rules keep that from becoming a
//! way around the engine:
//!
//! 1. **It can never turn a refusal into an approval.** Hard prohibitions and
//!    policy denials never reach a reviewer at all.
//! 2. **It can only ever be as permissive as the mode.** `supervised` means the
//!    user wants to see every mutation, so it is never delegated.
//! 3. **Silence means ask.** A reviewer that errors, times out or is absent
//!    escalates to the human. The safe direction is the default direction.
//! 4. **It can always refuse.** A reviewer that spots something the pattern
//!    matcher missed turns an "ask" into a "deny", never the reverse.
//!
//! [`Guard::evaluate`]: crate::Guard::evaluate
//! [`Decision::Ask`]: zaalis_core::Decision

use crate::command::Finding;
use serde::{Deserialize, Serialize};
use zaalis_core::{AccessKind, PermissionMode};

/// What the reviewer is being asked about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewRequest {
    pub tool: String,
    pub kind: AccessKind,
    pub target: String,
    /// Why the engine hesitated, in words.
    pub risks: Vec<String>,
    /// The wording the user would have seen.
    pub summary: String,
    pub mode: PermissionMode,
}

/// The reviewer's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum ReviewVerdict {
    /// Safe in this context; proceed without stopping the user.
    Approve { reason: String },
    /// Not safe. Refuse outright.
    Refuse { reason: String },
    /// Cannot tell. Ask the human, which is what would have happened anyway.
    Escalate { reason: String },
}

impl ReviewVerdict {
    pub fn reason(&self) -> &str {
        match self {
            ReviewVerdict::Approve { reason }
            | ReviewVerdict::Refuse { reason }
            | ReviewVerdict::Escalate { reason } => reason,
        }
    }
}

/// A second opinion on a grey-zone action.
///
/// Implementations live outside this crate — the model-backed one is in
/// `zaalis-agent`, because the guard must not depend on a provider to decide
/// anything.
#[async_trait::async_trait]
pub trait Reviewer: Send + Sync + std::fmt::Debug {
    async fn review(&self, request: &ReviewRequest) -> ReviewVerdict;
}

/// Whether a reviewer may be consulted at all for this decision.
///
/// The gate is deliberately narrow, and it is here rather than at the call site
/// so every surface answers the question the same way.
pub fn may_delegate(mode: PermissionMode, findings: &[Finding]) -> bool {
    // `supervised` is a request to be shown every mutation. Delegating it would
    // silently change what the mode means.
    if matches!(
        mode,
        PermissionMode::Supervised | PermissionMode::ReadOnly | PermissionMode::Plan
    ) {
        return false;
    }
    // Anything that can never be auto-approved is not a grey zone.
    !findings.iter().any(|finding| finding.is_hard_prohibition())
}

/// A reviewer that always escalates. The behaviour when none is configured.
#[derive(Debug, Default)]
pub struct AlwaysAsk;

#[async_trait::async_trait]
impl Reviewer for AlwaysAsk {
    async fn review(&self, _request: &ReviewRequest) -> ReviewVerdict {
        ReviewVerdict::Escalate {
            reason: "aucun relecteur configuré".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervised_is_never_delegated() {
        // The mode's whole meaning is "show me everything".
        assert!(!may_delegate(PermissionMode::Supervised, &[]));
        assert!(!may_delegate(PermissionMode::ReadOnly, &[]));
        assert!(!may_delegate(PermissionMode::Plan, &[]));
    }

    #[test]
    fn the_lighter_modes_may_delegate() {
        for mode in [
            PermissionMode::Semi,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            assert!(may_delegate(mode, &[Finding::UnknownBinary]));
        }
    }

    #[test]
    fn a_hard_prohibition_is_never_delegated() {
        // These never produce an Ask in the first place; the gate refuses them
        // anyway, so a future caller cannot route one here by mistake.
        for finding in [
            Finding::PrivilegeEscalation,
            Finding::Obfuscated,
            Finding::RemoteExecution,
        ] {
            assert!(!may_delegate(PermissionMode::Auto, &[finding]));
        }
    }

    #[tokio::test]
    async fn the_default_reviewer_escalates() {
        let verdict = AlwaysAsk
            .review(&ReviewRequest {
                tool: "run".into(),
                kind: AccessKind::Execute,
                target: "npm test".into(),
                risks: Vec::new(),
                summary: "exécuter : npm test".into(),
                mode: PermissionMode::Auto,
            })
            .await;
        assert!(matches!(verdict, ReviewVerdict::Escalate { .. }));
    }
}
