//! The method catalogue and every params/result payload.
//!
//! One notification carries all streamed events ([`SESSION_EVENT`]); everything
//! else is a request with an answer. Splitting them this way keeps the client
//! simple: one event handler, plus ordinary request/response for commands.

use crate::event::EventFrame;
use serde::{Deserialize, Serialize};
use zaalis_core::{
    AgentId, AgentNode, Budget, CheckpointId, ModelBinding, PermissionAnswer, PermissionMode,
    PermissionSet, ProviderId, RequestId, RoleSpec, SessionId, Usage,
};

// ── Client → core ────────────────────────────────────────────────────────
pub const SESSION_CREATE: &str = "session.create";
pub const SESSION_RESUME: &str = "session.resume";
pub const SESSION_PROMPT: &str = "session.prompt";
pub const SESSION_CANCEL: &str = "session.cancel";
pub const SESSION_CLOSE: &str = "session.close";
pub const SESSION_USAGE: &str = "session.usage";
pub const SESSION_INSPECT: &str = "session.inspect";
pub const AGENT_ADD: &str = "agent.add";
pub const AGENT_UPDATE: &str = "agent.update";
pub const AGENT_REMOVE: &str = "agent.remove";
pub const PERMISSION_DECIDE: &str = "permission.decide";
pub const PLAN_APPROVE: &str = "plan.approve";
pub const PLAN_REJECT: &str = "plan.reject";
pub const BUDGET_EXTEND: &str = "budget.extend";
pub const CHECKPOINT_RESTORE: &str = "checkpoint.restore";
pub const TOOLS_LIST: &str = "tools.list";
pub const MODELS_LIST: &str = "models.list";
pub const HEALTH: &str = "health";

// ── Core → client ────────────────────────────────────────────────────────
/// Carries an [`EventFrame`]. The only notification the core emits.
pub const SESSION_EVENT: &str = "session.event";

/// Every method a client may call, for exhaustive dispatch on the server side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientMethod {
    SessionCreate,
    SessionResume,
    SessionPrompt,
    SessionCancel,
    SessionClose,
    SessionUsage,
    SessionInspect,
    AgentAdd,
    AgentUpdate,
    AgentRemove,
    PermissionDecide,
    PlanApprove,
    PlanReject,
    BudgetExtend,
    CheckpointRestore,
    ToolsList,
    ModelsList,
    Health,
}

impl ClientMethod {
    pub fn parse(method: &str) -> Option<Self> {
        Some(match method {
            SESSION_CREATE => ClientMethod::SessionCreate,
            SESSION_RESUME => ClientMethod::SessionResume,
            SESSION_PROMPT => ClientMethod::SessionPrompt,
            SESSION_CANCEL => ClientMethod::SessionCancel,
            SESSION_CLOSE => ClientMethod::SessionClose,
            SESSION_USAGE => ClientMethod::SessionUsage,
            SESSION_INSPECT => ClientMethod::SessionInspect,
            AGENT_ADD => ClientMethod::AgentAdd,
            AGENT_UPDATE => ClientMethod::AgentUpdate,
            AGENT_REMOVE => ClientMethod::AgentRemove,
            PERMISSION_DECIDE => ClientMethod::PermissionDecide,
            PLAN_APPROVE => ClientMethod::PlanApprove,
            PLAN_REJECT => ClientMethod::PlanReject,
            BUDGET_EXTEND => ClientMethod::BudgetExtend,
            CHECKPOINT_RESTORE => ClientMethod::CheckpointRestore,
            TOOLS_LIST => ClientMethod::ToolsList,
            MODELS_LIST => ClientMethod::ModelsList,
            HEALTH => ClientMethod::Health,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ClientMethod::SessionCreate => SESSION_CREATE,
            ClientMethod::SessionResume => SESSION_RESUME,
            ClientMethod::SessionPrompt => SESSION_PROMPT,
            ClientMethod::SessionCancel => SESSION_CANCEL,
            ClientMethod::SessionClose => SESSION_CLOSE,
            ClientMethod::SessionUsage => SESSION_USAGE,
            ClientMethod::SessionInspect => SESSION_INSPECT,
            ClientMethod::AgentAdd => AGENT_ADD,
            ClientMethod::AgentUpdate => AGENT_UPDATE,
            ClientMethod::AgentRemove => AGENT_REMOVE,
            ClientMethod::PermissionDecide => PERMISSION_DECIDE,
            ClientMethod::PlanApprove => PLAN_APPROVE,
            ClientMethod::PlanReject => PLAN_REJECT,
            ClientMethod::BudgetExtend => BUDGET_EXTEND,
            ClientMethod::CheckpointRestore => CHECKPOINT_RESTORE,
            ClientMethod::ToolsList => TOOLS_LIST,
            ClientMethod::ModelsList => MODELS_LIST,
            ClientMethod::Health => HEALTH,
        }
    }
}

/// Which surface opened the session.
///
/// The runtime is identical for all three; the mode only says who builds the
/// agent tree — the model (chat) or the user (team).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    /// One root agent on the user's chosen model. It may spawn children, which
    /// inherit its model by default.
    #[default]
    Chat,
    /// Several root agents declared by the user, coordinated by an
    /// orchestrator. Each carries its own model binding.
    Team,
}

/// One agent as declared by the user in the Agents panel or by `--team` on the
/// CLI. Role and model are separate fields, on purpose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSpec {
    pub role: RoleSpec,
    pub model: ModelBinding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    /// Roles this agent waits for, by role name. Names rather than ids because
    /// the user declares a team before any id exists.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// Whether this agent may spawn children of its own.
    #[serde(default)]
    pub may_spawn: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCreateParams {
    /// Absolute path to the project directory.
    pub root: String,
    #[serde(default)]
    pub mode: SessionMode,
    /// Root agent model. Required for [`SessionMode::Chat`]; ignored for a team.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelBinding>,
    /// The declared team. Required for [`SessionMode::Team`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentSpec>,
    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    /// `fr` or `en`, matching the interface language selector.
    #[serde(default = "default_language")]
    pub language: String,
    /// Resume an existing session id instead of minting one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<HistoryMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum HistoryMessage {
    User { content: String },
    Assistant { content: String },
}

fn default_language() -> String {
    "fr".to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCreateResult {
    pub session_id: SessionId,
    /// Every node created up front. A chat session returns one.
    pub agents: Vec<AgentNode>,
    /// Sequence number the event stream will start from.
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionResumeParams {
    pub session_id: SessionId,
    /// Replay events after this sequence number. `0` replays everything the
    /// core still holds.
    #[serde(default)]
    pub from_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionPromptParams {
    pub session_id: SessionId,
    pub text: String,
    /// Which agent receives it. Defaults to the root, or the orchestrator in a
    /// team session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageAttachment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub mime: String,
    /// Base64, as the existing `/api/chat` route already sends it.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCancelParams {
    pub session_id: SessionId,
    /// Cancel one agent and its descendants. Absent cancels the whole session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAddParams {
    pub session_id: SessionId,
    pub spec: AgentSpec,
    /// Attach under this agent. Absent creates another root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentUpdateParams {
    pub session_id: SessionId,
    pub agent_id: AgentId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<RoleSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentRemoveParams {
    pub session_id: SessionId,
    pub agent_id: AgentId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentResult {
    pub agent: AgentNode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionDecideParams {
    pub session_id: SessionId,
    pub request_id: RequestId,
    pub answer: PermissionAnswer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanDecisionParams {
    pub session_id: SessionId,
    pub request_id: RequestId,
    /// Sent with a rejection: what the agent should change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetExtendParams {
    pub session_id: SessionId,
    pub request_id: RequestId,
    /// Grant this much more. Absent means "keep going without a token ceiling
    /// for this turn".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_tokens: Option<u64>,
    /// Refuse the extension and wind the session down cleanly, keeping whatever
    /// has already been produced.
    #[serde(default)]
    pub stop: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRestoreParams {
    pub session_id: SessionId,
    pub checkpoint_id: CheckpointId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    /// Restrict to what this agent may actually call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub schema: serde_json::Value,
    pub access: String,
    pub mutating: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolsListResult {
    pub tools: Vec<ToolInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelsListResult {
    pub providers: Vec<ProviderInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: ProviderId,
    pub vendor: String,
    /// Whether a key or a local engine is actually available right now.
    pub available: bool,
    pub models: Vec<String>,
    pub capabilities: ProviderCapabilitiesInfo,
}

/// What a provider can actually do.
///
/// Behaviour is driven by these flags rather than by hardcoded provider lists,
/// which is what lets Claude and Gemini get native tool calling instead of the
/// fenced-block fallback the JavaScript engine restricted them to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ProviderCapabilitiesInfo {
    pub streaming: bool,
    pub native_tools: bool,
    pub parallel_tool_calls: bool,
    pub reasoning: bool,
    /// Whether reasoning arrives as a stream rather than in one block at the end.
    pub streamed_reasoning: bool,
    pub vision: bool,
    pub max_context: u64,
    /// How many requests this provider will genuinely serve at once. Local
    /// engines hold a single model in memory, so a team of agents on them
    /// serialises no matter how much parallelism the orchestrator wants.
    pub max_concurrency: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthResult {
    pub version: String,
    pub sessions: u32,
    pub uptime_ms: u64,
    pub sandbox: SandboxCapabilitiesInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCapabilitiesInfo {
    pub platform: String,
    pub process_tree: bool,
    pub pty_process_tree: bool,
    pub minimal_environment: bool,
    pub filesystem_isolation: bool,
    pub network_isolation: bool,
    pub kernel_policy: Option<String>,
    pub strict_available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionUsageResult {
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInspectResult {
    pub tree: zaalis_core::AgentTree,
}

/// Convenience wrapper for the single notification the core emits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionEventParams(pub EventFrame);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_client_method_round_trips_through_its_name() {
        let all = [
            ClientMethod::SessionCreate,
            ClientMethod::SessionResume,
            ClientMethod::SessionPrompt,
            ClientMethod::SessionCancel,
            ClientMethod::SessionClose,
            ClientMethod::SessionUsage,
            ClientMethod::SessionInspect,
            ClientMethod::AgentAdd,
            ClientMethod::AgentUpdate,
            ClientMethod::AgentRemove,
            ClientMethod::PermissionDecide,
            ClientMethod::PlanApprove,
            ClientMethod::PlanReject,
            ClientMethod::BudgetExtend,
            ClientMethod::CheckpointRestore,
            ClientMethod::ToolsList,
            ClientMethod::ModelsList,
            ClientMethod::Health,
        ];
        for method in all {
            assert_eq!(ClientMethod::parse(method.as_str()), Some(method));
        }
        assert_eq!(ClientMethod::parse("session.explode"), None);
    }

    #[test]
    fn a_chat_session_needs_only_a_root_model() {
        let json = serde_json::json!({
            "root": "C:/projet",
            "model": { "provider": "mistral", "model": "mistral-medium-3-5" }
        });
        let params: SessionCreateParams = serde_json::from_value(json).expect("parse");
        assert_eq!(params.mode, SessionMode::Chat);
        assert_eq!(params.language, "fr");
        assert_eq!(params.permission_mode, PermissionMode::Supervised);
        assert!(params.agents.is_empty());
    }

    #[test]
    fn a_team_can_place_two_agents_on_the_same_provider() {
        // The case the provider-keyed Agents panel cannot express today.
        let json = serde_json::json!({
            "root": "C:/projet",
            "mode": "team",
            "agents": [
                {
                    "role": { "name": "architect", "label": "Architecture", "mutating": false },
                    "model": { "provider": "claude" }
                },
                {
                    "role": { "name": "review", "label": "Review", "mutating": false },
                    "model": { "provider": "claude" },
                    "depends_on": ["architect"]
                }
            ]
        });
        let params: SessionCreateParams = serde_json::from_value(json).expect("parse");
        assert_eq!(params.mode, SessionMode::Team);
        assert_eq!(params.agents.len(), 2);
        assert_eq!(params.agents[0].model.provider, ProviderId::Claude);
        assert_eq!(params.agents[1].model.provider, ProviderId::Claude);
        assert_ne!(params.agents[0].role.name, params.agents[1].role.name);
        assert_eq!(params.agents[1].depends_on, vec!["architect".to_string()]);
    }

    #[test]
    fn a_role_carries_no_provider() {
        // Structural guarantee for "role and model are separate": RoleSpec has
        // no field that could hold one.
        let value = serde_json::to_value(RoleSpec::new("security-reviewer")).expect("serialize");
        let object = value.as_object().expect("object");
        for forbidden in ["model", "provider", "submodel"] {
            assert!(
                !object.contains_key(forbidden),
                "RoleSpec must not carry `{forbidden}`"
            );
        }
    }

    #[test]
    fn permission_answers_round_trip() {
        let allow = PermissionAnswer::Allow {
            scope: zaalis_core::GrantScope::Session,
        };
        let json = serde_json::to_string(&allow).expect("serialize");
        let back: PermissionAnswer = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, allow);
    }

    #[test]
    fn budget_extension_can_either_grant_or_stop() {
        let grant: BudgetExtendParams = serde_json::from_value(serde_json::json!({
            "session_id": "ses_1",
            "request_id": "req_1",
            "additional_tokens": 50000
        }))
        .expect("parse");
        assert_eq!(grant.additional_tokens, Some(50_000));
        assert!(!grant.stop);

        let stop: BudgetExtendParams = serde_json::from_value(serde_json::json!({
            "session_id": "ses_1",
            "request_id": "req_1",
            "stop": true
        }))
        .expect("parse");
        assert!(stop.stop);
    }
}
