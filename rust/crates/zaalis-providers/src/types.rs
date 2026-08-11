//! The provider-neutral conversation model.
//!
//! Nothing in this module names a vendor. An adapter translates these types into
//! its own dialect on the way out and back on the way in, which is what lets the
//! agent runtime stay ignorant of which model it is talking to — and what lets
//! Claude and Gemini use the same tools as Mistral instead of the fenced-block
//! fallback the JavaScript engine limited them to.

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use zaalis_core::{ModelBinding, ProviderId, ReasoningLevel, Usage};

/// A live provider turn. Setup failures are returned by [`ModelProvider`];
/// failures after response headers are represented by [`TurnEvent::Failed`].
pub type ProviderStream = BoxStream<'static, TurnEvent>;

/// The only model interface used by the agent runtime.
#[async_trait]
pub trait ModelProvider: Send + Sync + std::fmt::Debug {
    fn id(&self) -> zaalis_core::ProviderId;

    fn capabilities(&self) -> Capabilities;

    fn default_model(&self) -> &str {
        ""
    }

    /// Start one turn and return as soon as response headers are available.
    async fn stream_turn(
        &self,
        request: TurnRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError>;
}

/// One tool, as advertised to a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub schema: serde_json::Value,
}

/// An image attached to a user turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImagePart {
    pub mime: String,
    /// Base64, matching what the existing interface already sends.
    pub data: String,
}

/// One tool invocation requested by a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInvocation {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Provider-owned assistant state needed to continue a native tool turn.
///
/// The runtime stores this value but never interprets it. The provider tag
/// prevents one vendor's opaque state from being replayed to another.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderState {
    pub provider: ProviderId,
    pub value: serde_json::Value,
}

/// A conversation turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImagePart>,
    },
    Assistant {
        #[serde(default)]
        text: String,
        /// Provider reasoning, replayed only where the provider accepts it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolInvocation>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_state: Option<ProviderState>,
    },
    /// The result of a tool the model asked for.
    Tool {
        call_id: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Message::User {
            text: text.into(),
            images: Vec::new(),
        }
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Message::Assistant {
            text: text.into(),
            reasoning: None,
            tool_calls: Vec::new(),
            provider_state: None,
        }
    }

    pub fn tool_result(
        call_id: impl Into<String>,
        name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Message::Tool {
            call_id: call_id.into(),
            name: name.into(),
            content: content.into(),
            is_error: false,
        }
    }
}

/// Everything needed for one model call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnRequest {
    pub binding: ModelBinding,
    pub system: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    #[serde(default)]
    pub reasoning: ReasoningLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

impl TurnRequest {
    pub fn new(binding: ModelBinding, system: impl Into<String>, messages: Vec<Message>) -> Self {
        Self {
            binding,
            system: system.into(),
            messages,
            tools: Vec::new(),
            reasoning: ReasoningLevel::OFF,
            max_output_tokens: None,
            temperature: None,
        }
    }

    pub fn with_tools(mut self, tools: Vec<ToolSpec>) -> Self {
        self.tools = tools;
        self
    }
}

/// What a provider emits while producing a turn.
///
/// This is the single event vocabulary the whole platform speaks: the runtime
/// maps it onto protocol frames, and the frames map onto what the interface
/// already renders. A provider that cannot stream emits one `TextDelta` and a
/// `Completed`, so the consumer never has two code paths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TurnEvent {
    /// A fragment of user-facing text.
    TextDelta { text: String },
    /// A fragment of reasoning, where the provider exposes it.
    ReasoningDelta { text: String },
    /// A tool call has begun; arguments may still be streaming.
    ToolCallStarted { id: String, name: String },
    /// A fragment of a tool call's JSON arguments.
    ToolCallDelta { id: String, arguments: String },
    /// A tool call is fully parsed.
    ToolCallCompleted { call: ToolInvocation },
    /// Token accounting, when the provider reports it.
    Usage { usage: Usage },
    /// Opaque assistant state to retain for the next native-tool round.
    AssistantState { state: ProviderState },
    /// The turn finished.
    Completed { reason: StopReason },
    /// The turn failed.
    Failed { error: ProviderError },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The model finished its answer.
    EndTurn,
    /// The model wants tools run.
    ToolUse,
    /// The output limit was reached.
    MaxTokens,
    /// The user interrupted.
    Cancelled,
}

/// A provider failure, classified so the pool knows whether to retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub message: String,
    /// Server-suggested wait before retrying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorKind {
    /// No key, or the key was rejected.
    Auth,
    /// 429.
    RateLimited,
    /// 5xx or a transport failure.
    Transient,
    /// The request itself was wrong.
    Invalid,
    /// The model does not exist or is not available.
    ModelUnavailable,
    /// The provider is not reachable at all (local engine down).
    Unavailable,
    /// Timed out.
    Timeout,
    /// Interrupted on purpose.
    Cancelled,
}

impl ProviderError {
    pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry_after_ms: None,
        }
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Auth, message)
    }

    pub fn transient(message: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Transient, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Invalid, message)
    }

    pub fn rate_limited(message: impl Into<String>, retry_after_ms: Option<u64>) -> Self {
        Self {
            kind: ProviderErrorKind::RateLimited,
            message: message.into(),
            retry_after_ms,
        }
    }

    /// Whether the pool should try again.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self.kind,
            ProviderErrorKind::RateLimited
                | ProviderErrorKind::Transient
                | ProviderErrorKind::Timeout
                | ProviderErrorKind::Unavailable
        )
    }

    pub fn code(&self) -> &'static str {
        match self.kind {
            ProviderErrorKind::Auth => "auth",
            ProviderErrorKind::RateLimited => "rate_limited",
            ProviderErrorKind::Transient => "transient",
            ProviderErrorKind::Invalid => "invalid",
            ProviderErrorKind::ModelUnavailable => "model_unavailable",
            ProviderErrorKind::Unavailable => "unavailable",
            ProviderErrorKind::Timeout => "timeout",
            ProviderErrorKind::Cancelled => "cancelled",
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for ProviderError {}

impl From<ProviderError> for zaalis_core::ZaalisError {
    fn from(value: ProviderError) -> Self {
        let code = match value.kind {
            ProviderErrorKind::RateLimited => zaalis_core::ErrorCode::RateLimited,
            ProviderErrorKind::Timeout => zaalis_core::ErrorCode::Timeout,
            ProviderErrorKind::Cancelled => zaalis_core::ErrorCode::Cancelled,
            ProviderErrorKind::Invalid => zaalis_core::ErrorCode::InvalidRequest,
            _ => zaalis_core::ErrorCode::Provider,
        };
        zaalis_core::ZaalisError::new(code, value.message)
    }
}

/// What a provider can do.
///
/// Behaviour is driven by these flags, never by a hardcoded provider list. The
/// old engine kept a `NATIVE_TOOL_MODELS` set of three names, which is why five
/// providers were stuck on a fragile text protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub streaming: bool,
    pub native_tools: bool,
    pub parallel_tool_calls: bool,
    pub reasoning: bool,
    pub streamed_reasoning: bool,
    pub vision: bool,
    pub max_context: u64,
    /// Requests this provider will genuinely serve at once. A local engine holds
    /// one model in memory, so several agents on it serialise no matter how much
    /// parallelism the orchestrator would like.
    pub max_concurrency: u8,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            streaming: true,
            native_tools: true,
            parallel_tool_calls: true,
            reasoning: false,
            streamed_reasoning: false,
            vision: false,
            max_context: 128_000,
            max_concurrency: 4,
        }
    }
}

/// Accumulates streamed tool-call fragments into finished invocations.
///
/// Providers deliver arguments as JSON text in arbitrary chunks, sometimes
/// interleaved across several calls. Collecting them in one place means each
/// adapter only has to say "this fragment belongs to that index".
#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    slots: Vec<Slot>,
}

#[derive(Debug, Default, Clone)]
struct Slot {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAccumulator {
    /// Record a fragment for the call at `index`.
    pub fn push(
        &mut self,
        index: usize,
        id: Option<&str>,
        name: Option<&str>,
        arguments: Option<&str>,
    ) {
        while self.slots.len() <= index {
            self.slots.push(Slot::default());
        }
        let slot = &mut self.slots[index];
        if let Some(id) = id {
            if !id.is_empty() {
                slot.id = id.to_owned();
            }
        }
        if let Some(name) = name {
            if !name.is_empty() {
                slot.name = name.to_owned();
            }
        }
        if let Some(arguments) = arguments {
            slot.arguments.push_str(arguments);
        }
    }

    pub(crate) fn identity(&self, index: usize) -> Option<(&str, &str)> {
        let slot = self.slots.get(index)?;
        (!slot.id.is_empty() && !slot.name.is_empty())
            .then_some((slot.id.as_str(), slot.name.as_str()))
    }

    /// Finish, turning every slot into an invocation.
    ///
    /// Unparseable arguments become an empty object rather than dropping the
    /// call: the tool then fails with a clear validation error the model can
    /// act on, instead of the turn silently losing a step.
    pub fn finish(self) -> Vec<ToolInvocation> {
        self.slots
            .into_iter()
            .filter(|slot| !slot.name.is_empty())
            .enumerate()
            .map(|(index, slot)| ToolInvocation {
                id: if slot.id.is_empty() {
                    format!("call_{index}")
                } else {
                    slot.id
                },
                name: slot.name,
                arguments: serde_json::from_str(slot.arguments.trim())
                    .unwrap_or_else(|_| serde_json::json!({})),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_call_fragments_are_reassembled_in_order() {
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(0, Some("call_1"), Some("read"), Some(r#"{"pa"#));
        accumulator.push(0, None, None, Some(r#"th":"a.js"}"#));

        let calls = accumulator.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "read");
        assert_eq!(calls[0].arguments["path"], "a.js");
    }

    #[test]
    fn several_parallel_calls_stay_separate() {
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(0, Some("a"), Some("read"), Some(r#"{"path":"1"}"#));
        accumulator.push(1, Some("b"), Some("grep"), Some(r#"{"pattern":"x"}"#));

        let calls = accumulator.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read");
        assert_eq!(calls[1].name, "grep");
    }

    #[test]
    fn a_call_with_broken_arguments_is_kept_so_the_model_sees_the_error() {
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(0, Some("a"), Some("read"), Some("{not json"));
        let calls = accumulator.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments, serde_json::json!({}));
    }

    #[test]
    fn a_call_with_no_name_is_dropped() {
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(0, Some("a"), None, Some("{}"));
        assert!(accumulator.finish().is_empty());
    }

    #[test]
    fn a_call_with_no_id_gets_a_generated_one() {
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(0, None, Some("read"), Some("{}"));
        assert_eq!(accumulator.finish()[0].id, "call_0");
    }

    #[test]
    fn errors_are_classified_for_retry() {
        assert!(ProviderError::rate_limited("429", Some(1_000)).is_retryable());
        assert!(ProviderError::transient("502").is_retryable());
        assert!(!ProviderError::auth("no key").is_retryable());
        assert!(!ProviderError::invalid("bad schema").is_retryable());
    }

    #[test]
    fn messages_round_trip_through_json() {
        let messages = vec![
            Message::user("bonjour"),
            Message::Assistant {
                text: "je lis".into(),
                reasoning: Some("réflexion".into()),
                tool_calls: vec![ToolInvocation {
                    id: "c1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": "a.js"}),
                }],
                provider_state: None,
            },
            Message::tool_result("c1", "read", "contenu"),
        ];
        for message in messages {
            let json = serde_json::to_string(&message).expect("serialize");
            let back: Message = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, message);
        }
    }
}
