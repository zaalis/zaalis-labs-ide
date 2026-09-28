//! Identifier newtypes.
//!
//! Every id is a distinct type so a `SessionId` can never be passed where an
//! `AgentId` is expected. They are transparent strings on the wire, which keeps
//! the protocol readable in a log and lets the JavaScript client treat them as
//! opaque keys.

use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Mint a fresh identifier. UUIDv7 keeps ids sortable by creation
            /// time, which makes a raw event log readable without a join.
            pub fn new() -> Self {
                Self(format!("{}_{}", $prefix, uuid::Uuid::now_v7().simple()))
            }

            /// Adopt an externally supplied identifier (resume, replay, tests).
            pub fn from_raw(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

define_id!(
    /// One conversation, owning one agent tree.
    SessionId,
    "ses"
);
define_id!(
    /// One node of the agent tree. The root agent has one too — a single-agent
    /// chat is a tree of size 1, not a special case.
    AgentId,
    "agt"
);
define_id!(
    /// One tool invocation requested by a model.
    ToolCallId,
    "tc"
);
define_id!(
    /// One contiguous stretch of an agent timeline (reasoning, text, a tool
    /// call…). Deltas reference their segment so a client can render several
    /// interleaved agents without any ordering logic of its own.
    SegmentId,
    "seg"
);
define_id!(
    /// One core → client question awaiting an answer (permission, plan
    /// approval, budget extension).
    RequestId,
    "req"
);
define_id!(
    /// One restorable workspace snapshot.
    CheckpointId,
    "ckpt"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_prefixed_and_unique() {
        let a = AgentId::new();
        let b = AgentId::new();
        assert!(a.as_str().starts_with("agt_"));
        assert_ne!(a, b);
    }

    #[test]
    fn ids_round_trip_as_transparent_strings() {
        let id = SessionId::from_raw("ses_fixed");
        let json = serde_json::to_string(&id).expect("serialize");
        assert_eq!(json, "\"ses_fixed\"");
        let back: SessionId = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, id);
    }

    #[test]
    fn uuid_v7_keeps_ids_ordered_by_creation() {
        let first = SegmentId::new();
        let second = SegmentId::new();
        // v7 embeds a millisecond timestamp in the high bits, so lexical order
        // matches creation order for ids minted in the same process.
        assert!(first.as_str() <= second.as_str());
    }
}
