//! The agent tree.
//!
//! One data structure covers every surface. A classic chat is a tree with one
//! root; an Agents-panel team is a tree with several roots under an
//! orchestrator; a subagent is a child. There is no separate "multi-agent"
//! representation, because a single agent is just a tree of size one.
//!
//! This module owns the *shape* and its invariants. Scheduling and execution
//! live in `zaalis-agent`.

use crate::ids::{AgentId, SessionId};
use crate::model::ModelBinding;
use crate::permission::PermissionSet;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// Where an agent is in its lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AgentState {
    /// Created, not started, nothing blocking it.
    Pending,
    /// Waiting on other agents to finish first.
    Blocked { waiting_on: Vec<AgentId> },
    /// Currently running a turn.
    Running,
    /// Suspended on a permission prompt.
    WaitingPermission,
    /// Suspended because a budget ran out and an extension was requested.
    WaitingBudget,
    /// Finished successfully.
    Done,
    /// Finished with an error.
    Failed { error: String },
    /// Stopped by the user or by a cancelled ancestor.
    Cancelled,
}

impl AgentState {
    /// Whether the agent will never run again.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            AgentState::Done | AgentState::Failed { .. } | AgentState::Cancelled
        )
    }

    pub fn is_suspended(&self) -> bool {
        matches!(
            self,
            AgentState::WaitingPermission | AgentState::WaitingBudget
        )
    }

    pub fn label(&self) -> &'static str {
        match self {
            AgentState::Pending => "pending",
            AgentState::Blocked { .. } => "blocked",
            AgentState::Running => "running",
            AgentState::WaitingPermission => "waiting_permission",
            AgentState::WaitingBudget => "waiting_budget",
            AgentState::Done => "done",
            AgentState::Failed { .. } => "failed",
            AgentState::Cancelled => "cancelled",
        }
    }
}

/// What an agent is *for*. Deliberately free-form and provider-agnostic:
/// nothing here names a model, and nothing in the runtime may infer a provider
/// from a role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleSpec {
    /// Stable key (`architect`, `explore`, `implement`, `tests`, `review`, or
    /// anything the user types).
    pub name: String,
    /// Shown on the agent card.
    #[serde(default)]
    pub label: String,
    /// Appended to the system prompt.
    #[serde(default)]
    pub instructions: String,
    /// Whether this role is allowed to change files. Read-only roles never get
    /// a worktree, which keeps exploration cheap.
    #[serde(default)]
    pub mutating: bool,
}

impl RoleSpec {
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            label: name.clone(),
            name,
            instructions: String::new(),
            mutating: false,
        }
    }

    pub fn mutating(mut self) -> Self {
        self.mutating = true;
        self
    }

    pub fn with_instructions(mut self, instructions: impl Into<String>) -> Self {
        self.instructions = instructions.into();
        self
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    /// The role a plain chat agent gets when the user did not pick one.
    pub fn general_purpose() -> Self {
        Self::new("general").with_label("Général").mutating()
    }
}

/// Hard ceilings on one agent's work.
///
/// Hitting a limit pauses the agent and raises a request for an extension; it
/// does not kill the session. An abrupt stop mid-edit is worse than asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_wall_time_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    /// Rounds of model calls in one turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    /// How deep below this agent new children may be spawned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u8>,
}

impl Budget {
    pub const UNLIMITED: Budget = Budget {
        max_tokens: None,
        max_wall_time_ms: None,
        max_tool_calls: None,
        max_rounds: None,
        max_depth: None,
    };

    /// Defaults for a top-level agent.
    pub fn default_root() -> Self {
        Budget {
            max_tokens: Some(400_000),
            max_wall_time_ms: Some(30 * 60 * 1_000),
            max_tool_calls: Some(300),
            max_rounds: Some(24),
            max_depth: Some(3),
        }
    }

    /// Defaults for a spawned child: smaller, and one level shallower.
    pub fn default_child(parent: &Budget) -> Self {
        Budget {
            max_tokens: parent.max_tokens.map(|value| value / 3).max(Some(20_000)),
            max_wall_time_ms: parent.max_wall_time_ms.map(|value| value / 2),
            max_tool_calls: parent.max_tool_calls.map(|value| value / 2),
            max_rounds: parent.max_rounds.map(|value| value.min(12)),
            max_depth: parent.max_depth.map(|value| value.saturating_sub(1)),
        }
    }

    /// Cap this budget by an ancestor's, the same way permissions intersect.
    pub fn clamp_to(&self, parent: &Budget) -> Budget {
        fn tighter<T: Ord + Copy>(a: Option<T>, b: Option<T>) -> Option<T> {
            match (a, b) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (Some(value), None) | (None, Some(value)) => Some(value),
                (None, None) => None,
            }
        }
        Budget {
            max_tokens: tighter(self.max_tokens, parent.max_tokens),
            max_wall_time_ms: tighter(self.max_wall_time_ms, parent.max_wall_time_ms),
            max_tool_calls: tighter(self.max_tool_calls, parent.max_tool_calls),
            max_rounds: tighter(self.max_rounds, parent.max_rounds),
            max_depth: tighter(self.max_depth, parent.max_depth),
        }
    }
}

impl Default for Budget {
    fn default() -> Self {
        Budget::default_root()
    }
}

/// What an agent has actually consumed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cached_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
    pub tool_calls: u32,
    pub rounds: u32,
    pub wall_time_ms: u64,
}

impl Usage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    pub fn merge(&mut self, other: &Usage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cached_tokens += other.cached_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
        self.tool_calls += other.tool_calls;
        self.rounds += other.rounds;
        self.wall_time_ms = self.wall_time_ms.max(other.wall_time_ms);
    }

    /// Which limit, if any, this usage has reached.
    pub fn exceeded(&self, budget: &Budget) -> Option<BudgetLimit> {
        if budget
            .max_tokens
            .is_some_and(|limit| self.total_tokens() >= limit)
        {
            return Some(BudgetLimit::Tokens);
        }
        if budget
            .max_tool_calls
            .is_some_and(|limit| self.tool_calls >= limit)
        {
            return Some(BudgetLimit::ToolCalls);
        }
        if budget.max_rounds.is_some_and(|limit| self.rounds >= limit) {
            return Some(BudgetLimit::Rounds);
        }
        if budget
            .max_wall_time_ms
            .is_some_and(|limit| self.wall_time_ms >= limit)
        {
            return Some(BudgetLimit::WallTime);
        }
        None
    }
}

/// Which ceiling was reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetLimit {
    Tokens,
    ToolCalls,
    Rounds,
    WallTime,
}

impl BudgetLimit {
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetLimit::Tokens => "tokens",
            BudgetLimit::ToolCalls => "tool_calls",
            BudgetLimit::Rounds => "rounds",
            BudgetLimit::WallTime => "wall_time",
        }
    }
}

/// Where an agent's file changes land.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Workspace {
    /// Directly in the project directory. Read-only agents, and the root agent
    /// of a classic chat.
    Direct,
    /// An isolated git worktree. Mutating agents in a git project.
    Worktree { path: String, branch: String },
    /// A content-addressed copy, for mutating agents in a project that is not
    /// under version control. zaalis never runs `git init` on a user's folder.
    Snapshot { path: String },
}

impl Workspace {
    pub fn is_isolated(&self) -> bool {
        !matches!(self, Workspace::Direct)
    }
}

/// One node of the tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentNode {
    pub id: AgentId,
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<AgentId>,
    pub role: RoleSpec,
    /// Provider and model for this node. Independent of `role` — the runtime
    /// must never infer one from the other.
    pub model: ModelBinding,
    pub permissions: PermissionSet,
    pub budget: Budget,
    #[serde(default)]
    pub usage: Usage,
    pub state: AgentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<Workspace>,
    /// Agents that must reach a terminal state before this one may start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<AgentId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AgentId>,
    /// The task handed to this agent.
    #[serde(default)]
    pub objective: String,
    /// Depth below the root; 0 for a root agent.
    #[serde(default)]
    pub depth: u8,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
}

impl AgentNode {
    pub fn new(
        session_id: SessionId,
        role: RoleSpec,
        model: ModelBinding,
        permissions: PermissionSet,
        now_ms: u64,
    ) -> Self {
        Self {
            id: AgentId::new(),
            session_id,
            parent_id: None,
            role,
            model,
            permissions,
            budget: Budget::default_root(),
            usage: Usage::default(),
            state: AgentState::Pending,
            workspace: None,
            depends_on: Vec::new(),
            children: Vec::new(),
            objective: String::new(),
            depth: 0,
            created_at_ms: now_ms,
            started_at_ms: None,
            finished_at_ms: None,
        }
    }

    pub fn with_objective(mut self, objective: impl Into<String>) -> Self {
        self.objective = objective.into();
        self
    }

    pub fn with_budget(mut self, budget: Budget) -> Self {
        self.budget = budget;
        self
    }

    pub fn with_dependencies(mut self, deps: impl IntoIterator<Item = AgentId>) -> Self {
        self.depends_on.extend(deps);
        self
    }

    /// Whether this agent may create children given its depth allowance.
    pub fn can_spawn(&self) -> bool {
        self.budget.max_depth.is_none_or(|max| max > 0)
    }

    /// Whether the role needs an isolated workspace. Read-only roles do not:
    /// isolating them would cost a copy for nothing.
    pub fn needs_isolation(&self) -> bool {
        self.role.mutating && self.parent_id.is_some()
    }
}

/// Errors raised when a tree edit would break an invariant.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TreeError {
    #[error("agent {0} is not in this tree")]
    UnknownAgent(AgentId),
    #[error("agent {0} is already in this tree")]
    DuplicateAgent(AgentId),
    #[error("adding this dependency would create a cycle: {0} -> {1}")]
    DependencyCycle(AgentId, AgentId),
    #[error("agent {0} depends on {1}, which is not in this tree")]
    UnknownDependency(AgentId, AgentId),
    #[error("maximum depth {0} reached")]
    DepthExceeded(u8),
    #[error("agent {0} is currently running or waiting")]
    AgentBusy(AgentId),
}

/// The whole tree for one session.
///
/// Nodes are held in a flat map keyed by id; parent and child links are ids,
/// not references, so the structure serialises directly and survives a restart.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentTree {
    nodes: BTreeMap<AgentId, AgentNode>,
    roots: Vec<AgentId>,
}

impl AgentTree {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn roots(&self) -> &[AgentId] {
        &self.roots
    }

    pub fn get(&self, id: &AgentId) -> Option<&AgentNode> {
        self.nodes.get(id)
    }

    pub fn get_mut(&mut self, id: &AgentId) -> Option<&mut AgentNode> {
        self.nodes.get_mut(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &AgentNode> {
        self.nodes.values()
    }

    /// Insert a root agent. A classic chat inserts exactly one.
    pub fn insert_root(&mut self, node: AgentNode) -> Result<AgentId, TreeError> {
        if self.nodes.contains_key(&node.id) {
            return Err(TreeError::DuplicateAgent(node.id));
        }
        for dependency in &node.depends_on {
            if !self.nodes.contains_key(dependency) {
                return Err(TreeError::UnknownDependency(
                    node.id.clone(),
                    dependency.clone(),
                ));
            }
        }
        let id = node.id.clone();
        self.roots.push(id.clone());
        self.nodes.insert(id.clone(), node);
        Ok(id)
    }

    /// Attach a child to `parent`, inheriting the parent's constraints.
    ///
    /// Permissions are intersected and the budget clamped here rather than at
    /// the call site, so no caller can accidentally hand a child more authority
    /// than its parent has.
    pub fn insert_child(
        &mut self,
        parent: &AgentId,
        mut node: AgentNode,
    ) -> Result<AgentId, TreeError> {
        let (parent_permissions, parent_budget, parent_depth) = {
            let parent_node = self
                .nodes
                .get(parent)
                .ok_or_else(|| TreeError::UnknownAgent(parent.clone()))?;
            (
                parent_node.permissions.clone(),
                parent_node.budget,
                parent_node.depth,
            )
        };

        if let Some(max_depth) = parent_budget.max_depth {
            if max_depth == 0 {
                return Err(TreeError::DepthExceeded(parent_depth));
            }
        }

        if self.nodes.contains_key(&node.id) {
            return Err(TreeError::DuplicateAgent(node.id));
        }
        for dependency in &node.depends_on {
            if !self.nodes.contains_key(dependency) {
                return Err(TreeError::UnknownDependency(
                    node.id.clone(),
                    dependency.clone(),
                ));
            }
        }

        node.parent_id = Some(parent.clone());
        node.depth = parent_depth.saturating_add(1);
        node.permissions = node.permissions.intersect(&parent_permissions);
        node.budget = node.budget.clamp_to(&parent_budget);

        let id = node.id.clone();
        self.nodes.insert(id.clone(), node);
        if let Some(parent_node) = self.nodes.get_mut(parent) {
            parent_node.children.push(id.clone());
        }
        Ok(id)
    }

    /// Add an execution dependency, refusing anything that would create a cycle.
    pub fn add_dependency(
        &mut self,
        agent: &AgentId,
        depends_on: &AgentId,
    ) -> Result<(), TreeError> {
        if !self.nodes.contains_key(agent) {
            return Err(TreeError::UnknownAgent(agent.clone()));
        }
        if !self.nodes.contains_key(depends_on) {
            return Err(TreeError::UnknownDependency(
                agent.clone(),
                depends_on.clone(),
            ));
        }
        if agent == depends_on || self.reaches(depends_on, agent) {
            return Err(TreeError::DependencyCycle(
                agent.clone(),
                depends_on.clone(),
            ));
        }
        let node = self
            .nodes
            .get_mut(agent)
            .ok_or_else(|| TreeError::UnknownAgent(agent.clone()))?;
        if !node.depends_on.contains(depends_on) {
            node.depends_on.push(depends_on.clone());
        }
        Ok(())
    }

    /// Whether `from` transitively depends on `to`.
    fn reaches(&self, from: &AgentId, to: &AgentId) -> bool {
        let mut seen = BTreeSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(from.clone());
        while let Some(current) = queue.pop_front() {
            if &current == to {
                return true;
            }
            if !seen.insert(current.clone()) {
                continue;
            }
            if let Some(node) = self.nodes.get(&current) {
                for dependency in &node.depends_on {
                    queue.push_back(dependency.clone());
                }
            }
        }
        false
    }

    /// Agents that can start right now: pending, with every dependency in a
    /// terminal state.
    ///
    /// A dependency that failed still unblocks its dependants — the orchestrator
    /// decides what to do with a partial result rather than deadlocking.
    pub fn ready(&self) -> Vec<AgentId> {
        self.nodes
            .values()
            .filter(|node| matches!(node.state, AgentState::Pending))
            .filter(|node| {
                node.depends_on.iter().all(|dependency| {
                    self.nodes
                        .get(dependency)
                        .is_some_and(|dep| dep.state.is_terminal())
                })
            })
            .map(|node| node.id.clone())
            .collect()
    }

    /// Dependencies of `agent` that have not finished yet.
    pub fn blockers(&self, agent: &AgentId) -> Vec<AgentId> {
        let Some(node) = self.nodes.get(agent) else {
            return Vec::new();
        };
        node.depends_on
            .iter()
            .filter(|dependency| {
                self.nodes
                    .get(*dependency)
                    .is_none_or(|dep| !dep.state.is_terminal())
            })
            .cloned()
            .collect()
    }

    /// `agent` plus every descendant, parents before children.
    pub fn subtree(&self, agent: &AgentId) -> Vec<AgentId> {
        let mut out = Vec::new();
        let mut queue = VecDeque::new();
        queue.push_back(agent.clone());
        while let Some(current) = queue.pop_front() {
            let Some(node) = self.nodes.get(&current) else {
                continue;
            };
            out.push(current.clone());
            for child in &node.children {
                queue.push_back(child.clone());
            }
        }
        out
    }

    /// Cancel an agent and everything under it. Returns the agents whose state
    /// actually changed.
    pub fn cancel_subtree(&mut self, agent: &AgentId) -> Vec<AgentId> {
        let mut changed = Vec::new();
        for id in self.subtree(agent) {
            if let Some(node) = self.nodes.get_mut(&id) {
                if !node.state.is_terminal() {
                    node.state = AgentState::Cancelled;
                    changed.push(id);
                }
            }
        }
        changed
    }

    /// Remove an idle node and all its descendants. Running nodes must be
    /// cancelled and settled first so no task can retain a dangling identity.
    pub fn remove_subtree(&mut self, agent: &AgentId) -> Result<Vec<AgentId>, TreeError> {
        let ids = self.subtree(agent);
        if ids.is_empty() {
            return Err(TreeError::UnknownAgent(agent.clone()));
        }
        if ids.iter().any(|id| {
            self.nodes.get(id).is_some_and(|node| {
                !matches!(
                    node.state,
                    AgentState::Pending
                        | AgentState::Done
                        | AgentState::Failed { .. }
                        | AgentState::Cancelled
                )
            })
        }) {
            return Err(TreeError::AgentBusy(agent.clone()));
        }
        if let Some(parent) = self
            .nodes
            .get(agent)
            .and_then(|node| node.parent_id.clone())
        {
            if let Some(parent_node) = self.nodes.get_mut(&parent) {
                parent_node.children.retain(|id| id != agent);
            }
        }
        self.roots.retain(|id| id != agent);
        for node in self.nodes.values_mut() {
            node.depends_on.retain(|id| !ids.contains(id));
        }
        for id in &ids {
            self.nodes.remove(id);
        }
        Ok(ids)
    }

    /// Roll every node's usage up into one total.
    pub fn total_usage(&self) -> Usage {
        let mut total = Usage::default();
        for node in self.nodes.values() {
            total.input_tokens += node.usage.input_tokens;
            total.output_tokens += node.usage.output_tokens;
            total.cached_tokens += node.usage.cached_tokens;
            total.reasoning_tokens += node.usage.reasoning_tokens;
            total.tool_calls += node.usage.tool_calls;
            total.rounds += node.usage.rounds;
            total.wall_time_ms = total.wall_time_ms.max(node.usage.wall_time_ms);
        }
        total
    }

    /// Whether every agent has reached a terminal state.
    pub fn is_settled(&self) -> bool {
        self.nodes.values().all(|node| node.state.is_terminal())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderId;
    use crate::permission::PermissionMode;

    fn tree_with_root() -> (AgentTree, AgentId, SessionId) {
        let session = SessionId::new();
        let mut tree = AgentTree::new();
        let root = AgentNode::new(
            session.clone(),
            RoleSpec::general_purpose(),
            ModelBinding::new(ProviderId::Mistral, Some("mistral-medium-3-5".into())),
            PermissionSet::new(PermissionMode::Semi),
            0,
        );
        let root_id = tree.insert_root(root).expect("insert root");
        (tree, root_id, session)
    }

    #[test]
    fn a_single_agent_is_just_a_tree_of_size_one() {
        let (tree, root, _) = tree_with_root();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree.roots(), std::slice::from_ref(&root));
        assert_eq!(tree.ready(), vec![root]);
    }

    #[test]
    fn a_child_inherits_the_parent_model_and_tighter_permissions() {
        let (mut tree, root, session) = tree_with_root();
        let parent_binding = tree.get(&root).unwrap().model.clone();

        let child = AgentNode::new(
            session,
            RoleSpec::new("explore"),
            parent_binding.inherited(),
            // Asks for more than the parent has.
            PermissionSet::new(PermissionMode::Bypass),
            0,
        );
        let child_id = tree.insert_child(&root, child).expect("insert child");

        let child = tree.get(&child_id).unwrap();
        assert_eq!(child.model.provider, ProviderId::Mistral);
        assert_eq!(child.permissions.mode, PermissionMode::Semi);
        assert_eq!(child.depth, 1);
        assert_eq!(child.parent_id.as_ref(), Some(&root));
        assert_eq!(tree.get(&root).unwrap().children, vec![child_id]);
    }

    #[test]
    fn different_agents_can_run_different_providers() {
        let session = SessionId::new();
        let mut tree = AgentTree::new();
        for (role, provider) in [
            ("architect", ProviderId::Claude),
            ("explore", ProviderId::Gemini),
            ("implement", ProviderId::Codex),
            ("review", ProviderId::Claude),
        ] {
            let node = AgentNode::new(
                session.clone(),
                RoleSpec::new(role),
                ModelBinding::new(provider, None),
                PermissionSet::new(PermissionMode::Semi),
                0,
            );
            tree.insert_root(node).expect("insert");
        }
        assert_eq!(tree.len(), 4);
        // Two agents on the same provider with different roles: the thing the
        // current provider-keyed Agents panel cannot express.
        let claude_roles: Vec<_> = tree
            .iter()
            .filter(|node| node.model.provider == ProviderId::Claude)
            .map(|node| node.role.name.as_str())
            .collect();
        assert_eq!(claude_roles, vec!["architect", "review"]);
    }

    #[test]
    fn dependencies_gate_readiness() {
        let session = SessionId::new();
        let mut tree = AgentTree::new();
        let explore = tree
            .insert_root(AgentNode::new(
                session.clone(),
                RoleSpec::new("explore"),
                ModelBinding::new(ProviderId::Gemini, None),
                PermissionSet::read_only(),
                0,
            ))
            .unwrap();
        let implement = tree
            .insert_root(
                AgentNode::new(
                    session,
                    RoleSpec::new("implement").mutating(),
                    ModelBinding::new(ProviderId::Mistral, None),
                    PermissionSet::new(PermissionMode::Semi),
                    0,
                )
                .with_dependencies([explore.clone()]),
            )
            .unwrap();

        assert_eq!(tree.ready(), vec![explore.clone()]);
        assert_eq!(tree.blockers(&implement), vec![explore.clone()]);

        tree.get_mut(&explore).unwrap().state = AgentState::Done;
        assert_eq!(tree.ready(), vec![implement.clone()]);
        assert!(tree.blockers(&implement).is_empty());
    }

    #[test]
    fn a_failed_dependency_still_unblocks_instead_of_deadlocking() {
        let session = SessionId::new();
        let mut tree = AgentTree::new();
        let first = tree
            .insert_root(AgentNode::new(
                session.clone(),
                RoleSpec::new("a"),
                ModelBinding::new(ProviderId::Mistral, None),
                PermissionSet::read_only(),
                0,
            ))
            .unwrap();
        let second = tree
            .insert_root(
                AgentNode::new(
                    session,
                    RoleSpec::new("b"),
                    ModelBinding::new(ProviderId::Mistral, None),
                    PermissionSet::read_only(),
                    0,
                )
                .with_dependencies([first.clone()]),
            )
            .unwrap();

        tree.get_mut(&first).unwrap().state = AgentState::Failed {
            error: "provider down".into(),
        };
        assert_eq!(tree.ready(), vec![second]);
    }

    #[test]
    fn cycles_are_refused() {
        let session = SessionId::new();
        let mut tree = AgentTree::new();
        let a = tree
            .insert_root(AgentNode::new(
                session.clone(),
                RoleSpec::new("a"),
                ModelBinding::new(ProviderId::Mistral, None),
                PermissionSet::read_only(),
                0,
            ))
            .unwrap();
        let b = tree
            .insert_root(AgentNode::new(
                session,
                RoleSpec::new("b"),
                ModelBinding::new(ProviderId::Mistral, None),
                PermissionSet::read_only(),
                0,
            ))
            .unwrap();

        tree.add_dependency(&b, &a).expect("b after a");
        let err = tree
            .add_dependency(&a, &b)
            .expect_err("a after b is a cycle");
        assert!(matches!(err, TreeError::DependencyCycle(_, _)));
        assert!(matches!(
            tree.add_dependency(&a, &a),
            Err(TreeError::DependencyCycle(_, _))
        ));
    }

    #[test]
    fn cancelling_a_parent_cancels_every_descendant() {
        let (mut tree, root, session) = tree_with_root();
        let child = tree
            .insert_child(
                &root,
                AgentNode::new(
                    session.clone(),
                    RoleSpec::new("explore"),
                    ModelBinding::new(ProviderId::Mistral, None),
                    PermissionSet::read_only(),
                    0,
                ),
            )
            .unwrap();
        let grandchild = tree
            .insert_child(
                &child,
                AgentNode::new(
                    session,
                    RoleSpec::new("deep"),
                    ModelBinding::new(ProviderId::Mistral, None),
                    PermissionSet::read_only(),
                    0,
                ),
            )
            .unwrap();

        let cancelled = tree.cancel_subtree(&root);
        assert_eq!(cancelled.len(), 3);
        for id in [&root, &child, &grandchild] {
            assert_eq!(tree.get(id).unwrap().state, AgentState::Cancelled);
        }
        assert!(tree.is_settled());
    }

    #[test]
    fn depth_allowance_shrinks_with_each_generation() {
        let (mut tree, root, session) = tree_with_root();
        tree.get_mut(&root).unwrap().budget = Budget {
            max_depth: Some(1),
            ..Budget::UNLIMITED
        };
        let child = tree
            .insert_child(
                &root,
                AgentNode::new(
                    session.clone(),
                    RoleSpec::new("explore"),
                    ModelBinding::new(ProviderId::Mistral, None),
                    PermissionSet::read_only(),
                    0,
                )
                .with_budget(Budget {
                    max_depth: Some(0),
                    ..Budget::UNLIMITED
                }),
            )
            .unwrap();

        // The child's allowance is exhausted, so it cannot spawn further.
        assert!(!tree.get(&child).unwrap().can_spawn());
        let err = tree.insert_child(
            &child,
            AgentNode::new(
                session,
                RoleSpec::new("too-deep"),
                ModelBinding::new(ProviderId::Mistral, None),
                PermissionSet::read_only(),
                0,
            ),
        );
        assert!(matches!(err, Err(TreeError::DepthExceeded(_))));
    }

    #[test]
    fn usage_rolls_up_across_the_tree() {
        let (mut tree, root, session) = tree_with_root();
        let child = tree
            .insert_child(
                &root,
                AgentNode::new(
                    session,
                    RoleSpec::new("explore"),
                    ModelBinding::new(ProviderId::Mistral, None),
                    PermissionSet::read_only(),
                    0,
                ),
            )
            .unwrap();

        tree.get_mut(&root).unwrap().usage = Usage {
            input_tokens: 100,
            output_tokens: 50,
            wall_time_ms: 900,
            ..Usage::default()
        };
        tree.get_mut(&child).unwrap().usage = Usage {
            input_tokens: 30,
            output_tokens: 20,
            wall_time_ms: 400,
            ..Usage::default()
        };

        let total = tree.total_usage();
        assert_eq!(total.total_tokens(), 200);
        // Wall time is concurrent, so it is a max rather than a sum.
        assert_eq!(total.wall_time_ms, 900);
    }

    #[test]
    fn budget_limits_are_detected() {
        let budget = Budget {
            max_tokens: Some(100),
            max_rounds: Some(3),
            ..Budget::UNLIMITED
        };
        let usage = Usage {
            input_tokens: 90,
            output_tokens: 20,
            ..Usage::default()
        };
        assert_eq!(usage.exceeded(&budget), Some(BudgetLimit::Tokens));

        let usage = Usage {
            rounds: 3,
            ..Usage::default()
        };
        assert_eq!(usage.exceeded(&budget), Some(BudgetLimit::Rounds));
        assert_eq!(Usage::default().exceeded(&budget), None);
    }

    #[test]
    fn read_only_roles_do_not_need_isolation() {
        let session = SessionId::new();
        let mut explore = AgentNode::new(
            session.clone(),
            RoleSpec::new("explore"),
            ModelBinding::new(ProviderId::Mistral, None),
            PermissionSet::read_only(),
            0,
        );
        explore.parent_id = Some(AgentId::new());
        assert!(!explore.needs_isolation());

        let mut implement = AgentNode::new(
            session,
            RoleSpec::new("implement").mutating(),
            ModelBinding::new(ProviderId::Mistral, None),
            PermissionSet::default(),
            0,
        );
        implement.parent_id = Some(AgentId::new());
        assert!(implement.needs_isolation());
    }
}
