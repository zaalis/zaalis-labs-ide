//! Permission vocabulary shared by the guard, the protocol and the runtime.
//!
//! The engine that evaluates these types lives in `zaalis-guard`. They sit here
//! so the protocol can describe a decision without depending on the engine, and
//! so an agent node can carry a permission set without pulling the evaluator in.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The six modes the interface already exposes, with the same wire strings as
/// `state.js` `PERMISSION_MODES`.
///
/// The important change from the JavaScript engine is [`Supervised`]: it now
/// means "ask the user", not "refuse". `mutationAllowed()` used to return a flat
/// denial, so a supervised agent stopped instead of requesting approval.
///
/// [`Supervised`]: PermissionMode::Supervised
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// Nothing may mutate anything. Reads and searches only.
    ReadOnly,
    /// Read-only, except the session plan file.
    Plan,
    /// Every mutation asks the user first.
    #[default]
    Supervised,
    /// Writes are automatic, shell commands ask.
    Semi,
    /// Automatic, except commands classified as risky.
    Auto,
    /// Automatic. Hard prohibitions still apply.
    Bypass,
}

impl PermissionMode {
    pub const ALL: [PermissionMode; 6] = [
        PermissionMode::ReadOnly,
        PermissionMode::Plan,
        PermissionMode::Supervised,
        PermissionMode::Semi,
        PermissionMode::Auto,
        PermissionMode::Bypass,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::ReadOnly => "read-only",
            PermissionMode::Plan => "plan",
            PermissionMode::Supervised => "supervised",
            PermissionMode::Semi => "semi",
            PermissionMode::Auto => "auto",
            PermissionMode::Bypass => "bypass",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        PermissionMode::ALL
            .into_iter()
            .find(|mode| mode.as_str() == value)
    }

    /// Ordering from most to least restrictive. Used when intersecting a child's
    /// permissions with its parent's: the child can never come out looser.
    pub fn restriction_rank(self) -> u8 {
        match self {
            PermissionMode::ReadOnly => 0,
            PermissionMode::Plan => 1,
            PermissionMode::Supervised => 2,
            PermissionMode::Semi => 3,
            PermissionMode::Auto => 4,
            PermissionMode::Bypass => 5,
        }
    }

    /// The stricter of two modes.
    pub fn tighten(self, other: PermissionMode) -> PermissionMode {
        if other.restriction_rank() < self.restriction_rank() {
            other
        } else {
            self
        }
    }

    /// Whether the mode forbids mutations outright, before any rule is consulted.
    pub fn is_read_only(self) -> bool {
        matches!(self, PermissionMode::ReadOnly | PermissionMode::Plan)
    }
}

impl fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a tool call is about to do, independent of which tool asked.
///
/// Rules and audit records key off this rather than the tool name, so adding a
/// tool does not mean revisiting every policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessKind {
    /// Read a file's contents.
    Read,
    /// Search across files.
    Search,
    /// Create or overwrite a file.
    Write,
    /// Modify part of an existing file.
    Edit,
    /// Remove a file or directory.
    Delete,
    /// Run a command or manage a process.
    Execute,
    /// Reach the network (web search, fetch, remote MCP).
    Network,
    /// Call a tool exposed by an MCP server.
    Mcp,
    /// Create a child agent.
    Spawn,
    /// Drive the desktop (Windows computer control).
    Computer,
    /// Bookkeeping with no side effect outside the session (todo, plan writes).
    Session,
}

impl AccessKind {
    /// Whether this access changes something outside the session.
    pub fn is_mutating(self) -> bool {
        matches!(
            self,
            AccessKind::Write
                | AccessKind::Edit
                | AccessKind::Delete
                | AccessKind::Execute
                | AccessKind::Spawn
                | AccessKind::Computer
        )
    }

    /// The rule prefix used in `Tool(pattern)` syntax.
    pub fn rule_prefix(self) -> &'static str {
        match self {
            AccessKind::Read => "Read",
            AccessKind::Search => "Search",
            AccessKind::Write => "Write",
            AccessKind::Edit => "Edit",
            AccessKind::Delete => "Delete",
            AccessKind::Execute => "Exec",
            AccessKind::Network => "Network",
            AccessKind::Mcp => "Mcp",
            AccessKind::Spawn => "Spawn",
            AccessKind::Computer => "Computer",
            AccessKind::Session => "Session",
        }
    }

    pub fn parse_prefix(value: &str) -> Option<Self> {
        const ALL: [AccessKind; 11] = [
            AccessKind::Read,
            AccessKind::Search,
            AccessKind::Write,
            AccessKind::Edit,
            AccessKind::Delete,
            AccessKind::Execute,
            AccessKind::Network,
            AccessKind::Mcp,
            AccessKind::Spawn,
            AccessKind::Computer,
            AccessKind::Session,
        ];
        ALL.into_iter()
            .find(|kind| kind.rule_prefix().eq_ignore_ascii_case(value))
    }
}

/// One policy line: `Exec(npm *)`, `Write(src/**)`, `Network(domain:docs.rs)`.
///
/// A bare prefix with no parentheses matches every access of that kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRule {
    pub kind: AccessKind,
    /// Glob applied to the access target. `None` matches everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

impl PermissionRule {
    pub fn new(kind: AccessKind, pattern: Option<String>) -> Self {
        Self { kind, pattern }
    }

    /// Parse `Prefix(pattern)` or a bare `Prefix`.
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return None;
        }
        match trimmed.split_once('(') {
            Some((prefix, rest)) => {
                let pattern = rest.strip_suffix(')')?;
                let kind = AccessKind::parse_prefix(prefix.trim())?;
                let pattern = pattern.trim();
                Some(Self::new(
                    kind,
                    if pattern.is_empty() {
                        None
                    } else {
                        Some(pattern.to_owned())
                    },
                ))
            }
            None => AccessKind::parse_prefix(trimmed).map(|kind| Self::new(kind, None)),
        }
    }
}

impl fmt::Display for PermissionRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.pattern {
            Some(pattern) => write!(f, "{}({})", self.kind.rule_prefix(), pattern),
            None => f.write_str(self.kind.rule_prefix()),
        }
    }
}

/// The policy attached to one agent.
///
/// A child's set is always [`PermissionSet::intersect`]ed with its parent's, so
/// a subagent can never be granted more than the agent that spawned it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionSet {
    pub mode: PermissionMode,
    /// Rules that auto-approve without prompting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<PermissionRule>,
    /// Rules that refuse outright. Deny always beats allow.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<PermissionRule>,
}

impl PermissionSet {
    pub fn new(mode: PermissionMode) -> Self {
        Self {
            mode,
            allow: Vec::new(),
            deny: Vec::new(),
        }
    }

    pub fn read_only() -> Self {
        Self::new(PermissionMode::ReadOnly)
    }

    pub fn with_allow(mut self, rules: impl IntoIterator<Item = PermissionRule>) -> Self {
        self.allow.extend(rules);
        self
    }

    pub fn with_deny(mut self, rules: impl IntoIterator<Item = PermissionRule>) -> Self {
        self.deny.extend(rules);
        self
    }

    /// Constrain this set by a parent's. The result is never looser than either
    /// input: the mode is the stricter of the two, denials accumulate, and an
    /// allowance survives only if the parent also granted it.
    pub fn intersect(&self, parent: &PermissionSet) -> PermissionSet {
        let mut deny = parent.deny.clone();
        for rule in &self.deny {
            if !deny.contains(rule) {
                deny.push(rule.clone());
            }
        }

        let allow = self
            .allow
            .iter()
            .filter(|rule| parent.allow.contains(rule))
            .cloned()
            .collect();

        PermissionSet {
            mode: self.mode.tighten(parent.mode),
            allow,
            deny,
        }
    }
}

impl Default for PermissionSet {
    fn default() -> Self {
        Self::new(PermissionMode::default())
    }
}

/// What the guard concluded for one access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Decision {
    /// Proceed.
    Allow { reason: DecisionReason },
    /// Refuse, and tell the model why so it can adapt.
    Deny {
        reason: DecisionReason,
        message: String,
    },
    /// Ask the user. The runtime suspends the call and emits a
    /// `permission.request` on the protocol.
    Ask {
        reason: DecisionReason,
        /// One-line summary shown in the approval prompt.
        summary: String,
    },
}

impl Decision {
    pub fn is_allow(&self) -> bool {
        matches!(self, Decision::Allow { .. })
    }

    pub fn reason(&self) -> DecisionReason {
        match self {
            Decision::Allow { reason }
            | Decision::Deny { reason, .. }
            | Decision::Ask { reason, .. } => *reason,
        }
    }
}

/// Why a decision came out the way it did.
///
/// Recorded on every audit row. Without it, "denied" is unexplainable after the
/// fact, which is the single most common complaint about permission systems.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionReason {
    /// The access does not mutate anything.
    NonMutating,
    /// An explicit deny rule matched.
    PolicyDeny,
    /// An explicit allow rule matched.
    PolicyAllow,
    /// The mode forbids all mutations.
    ModeReadOnly,
    /// Plan mode: only the plan file may be written.
    PlanModeGuard,
    /// The mode auto-approves this class of access.
    ModeAuto,
    /// The mode requires confirmation for this class of access.
    ModeAsk,
    /// Command analysis flagged the invocation as risky.
    RiskyCommand,
    /// The target resolves outside the workspace.
    OutsideWorkspace,
    /// Hard prohibition; no mode can auto-approve it.
    HardProhibition,
    /// A grant recorded earlier in this session matched.
    SessionGrant,
    /// A persisted grant matched.
    PersistedGrant,
    /// The user answered a prompt.
    UserPrompt,
    /// The user's answer denied it.
    UserDenied,
    /// A parent agent's policy is stricter.
    InheritedRestriction,
}

/// How long an approval lasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
    /// This call only.
    Once,
    /// Every equivalent call until the session ends.
    Session,
    /// Persisted across sessions for this workspace.
    Always,
}

/// The user's answer to a `permission.request`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAnswer {
    Allow { scope: GrantScope },
    Deny,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_wire_strings_match_the_existing_interface() {
        // Contract with state.js PERMISSION_MODES.
        let names: Vec<_> = PermissionMode::ALL.iter().map(|m| m.as_str()).collect();
        assert_eq!(
            names,
            vec!["read-only", "plan", "supervised", "semi", "auto", "bypass"]
        );
    }

    #[test]
    fn tighten_keeps_the_stricter_mode() {
        assert_eq!(
            PermissionMode::Bypass.tighten(PermissionMode::ReadOnly),
            PermissionMode::ReadOnly
        );
        assert_eq!(
            PermissionMode::ReadOnly.tighten(PermissionMode::Bypass),
            PermissionMode::ReadOnly
        );
        assert_eq!(
            PermissionMode::Semi.tighten(PermissionMode::Auto),
            PermissionMode::Semi
        );
    }

    #[test]
    fn rules_parse_both_forms() {
        let bare = PermissionRule::parse("Exec").expect("bare prefix");
        assert_eq!(bare.kind, AccessKind::Execute);
        assert_eq!(bare.pattern, None);

        let scoped = PermissionRule::parse("Write(src/**)").expect("scoped");
        assert_eq!(scoped.kind, AccessKind::Write);
        assert_eq!(scoped.pattern.as_deref(), Some("src/**"));

        assert_eq!(PermissionRule::parse("Nonsense(x)"), None);
        assert_eq!(PermissionRule::parse("Write(unclosed"), None);
        assert_eq!(PermissionRule::parse("   "), None);
    }

    #[test]
    fn rules_round_trip_through_display() {
        for text in ["Exec", "Write(src/**)", "Network(domain:docs.rs)"] {
            let rule = PermissionRule::parse(text).expect("parse");
            assert_eq!(rule.to_string(), text);
        }
    }

    #[test]
    fn a_child_can_never_be_looser_than_its_parent() {
        let parent = PermissionSet::new(PermissionMode::Semi)
            .with_allow([PermissionRule::parse("Exec(npm *)").unwrap()])
            .with_deny([PermissionRule::parse("Write(.env*)").unwrap()]);

        // A child asking for bypass and broad execution.
        let child = PermissionSet::new(PermissionMode::Bypass)
            .with_allow([PermissionRule::parse("Exec").unwrap()]);

        let effective = child.intersect(&parent);

        // Mode is capped by the parent.
        assert_eq!(effective.mode, PermissionMode::Semi);
        // `Exec` was never granted by the parent, so it does not survive.
        assert!(effective.allow.is_empty());
        // Parent denials are inherited.
        assert!(effective
            .deny
            .contains(&PermissionRule::parse("Write(.env*)").unwrap()));
    }

    #[test]
    fn intersection_keeps_allowances_the_parent_also_granted() {
        let rule = PermissionRule::parse("Exec(cargo *)").unwrap();
        let parent = PermissionSet::new(PermissionMode::Auto).with_allow([rule.clone()]);
        let child = PermissionSet::new(PermissionMode::Auto).with_allow([rule.clone()]);

        let effective = child.intersect(&parent);
        assert_eq!(effective.allow, vec![rule]);
    }

    #[test]
    fn intersection_is_idempotent() {
        let parent = PermissionSet::new(PermissionMode::Semi)
            .with_deny([PermissionRule::parse("Exec(rm *)").unwrap()]);
        let once = parent.intersect(&parent);
        let twice = once.intersect(&parent);
        assert_eq!(once, twice);
    }

    #[test]
    fn read_only_and_plan_forbid_mutations() {
        assert!(PermissionMode::ReadOnly.is_read_only());
        assert!(PermissionMode::Plan.is_read_only());
        assert!(!PermissionMode::Supervised.is_read_only());
    }
}
