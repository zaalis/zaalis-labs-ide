//! Model bindings: which provider and which model a given agent talks to.
//!
//! A binding belongs to an [`crate::agent::AgentNode`], never to a session. Two
//! agents in the same tree can run on different providers, and a session has no
//! "current provider" at all.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The providers zaalis speaks to.
///
/// The wire names are the ones the existing web interface and CLI already use
/// (`state.js` `PROVIDER_NAMES`, `cli.js` `MODEL_LABELS`), so the Rust core is a
/// drop-in for the current `/api/chat` vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    /// OpenAI (historically surfaced as "Codex" in the interface).
    Codex,
    /// Anthropic.
    Claude,
    /// Google.
    Gemini,
    /// xAI. A provider like any other — the core has no dependency on it.
    Grok,
    /// Mistral AI.
    Mistral,
    /// Moonshot AI.
    Kimi,
    /// Ollama, on the local machine.
    Local,
    /// llama.cpp server, on the local machine.
    Gguf,
}

impl ProviderId {
    pub const ALL: [ProviderId; 8] = [
        ProviderId::Codex,
        ProviderId::Claude,
        ProviderId::Gemini,
        ProviderId::Grok,
        ProviderId::Mistral,
        ProviderId::Kimi,
        ProviderId::Local,
        ProviderId::Gguf,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Codex => "codex",
            ProviderId::Claude => "claude",
            ProviderId::Gemini => "gemini",
            ProviderId::Grok => "grok",
            ProviderId::Mistral => "mistral",
            ProviderId::Kimi => "kimi",
            ProviderId::Local => "local",
            ProviderId::Gguf => "gguf",
        }
    }

    /// Human label, matching what the interface already displays.
    pub fn vendor(self) -> &'static str {
        match self {
            ProviderId::Codex => "OpenAI",
            ProviderId::Claude => "Anthropic",
            ProviderId::Gemini => "Google",
            ProviderId::Grok => "xAI",
            ProviderId::Mistral => "Mistral",
            ProviderId::Kimi => "Moonshot AI",
            ProviderId::Local => "Ollama",
            ProviderId::Gguf => "llama.cpp",
        }
    }

    /// Whether the model runs on the user's machine. Local engines hold one
    /// model in memory at a time, which caps how much an agent tree can
    /// actually parallelise on them.
    pub fn is_local(self) -> bool {
        matches!(self, ProviderId::Local | ProviderId::Gguf)
    }

    pub fn parse(value: &str) -> Option<Self> {
        ProviderId::ALL
            .into_iter()
            .find(|candidate| candidate.as_str() == value)
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How much reasoning to ask for, on the 0..=4 scale the interface slider
/// already uses. Each provider adapter maps it onto its own vocabulary
/// (`reasoning_effort`, `thinking.budget_tokens`, `thinkingConfig`…), because no
/// two providers agree on units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ReasoningLevel(pub u8);

impl ReasoningLevel {
    pub const OFF: ReasoningLevel = ReasoningLevel(0);

    pub fn clamped(value: u8) -> Self {
        ReasoningLevel(value.min(4))
    }

    pub fn is_off(self) -> bool {
        self.0 == 0
    }
}

impl Default for ReasoningLevel {
    fn default() -> Self {
        ReasoningLevel::OFF
    }
}

/// Why an agent ended up on the model it runs.
///
/// Recorded rather than inferred so the interface can show "inherited from
/// parent" versus "you chose this", and so a future policy change stays
/// auditable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingOrigin {
    /// The user picked it (classic chat model selector, or an Agents-panel card).
    ExplicitUser,
    /// Inherited from the spawning agent — the default for subagents.
    InheritedFromParent,
    /// Chosen by a [`ModelPolicy`] other than plain inheritance.
    Policy,
    /// Fallback applied because the requested binding was unavailable.
    Fallback,
}

/// Provider + model + reasoning, as bound to one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelBinding {
    pub provider: ProviderId,
    /// The provider-specific model identifier (`mistral-medium-3-5`,
    /// `claude-fable-5`, a `.gguf` filename…). `None` means "the provider's
    /// configured default".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning: ReasoningLevel,
    #[serde(default = "default_origin")]
    pub origin: BindingOrigin,
}

fn default_origin() -> BindingOrigin {
    BindingOrigin::ExplicitUser
}

impl ModelBinding {
    pub fn new(provider: ProviderId, model: Option<String>) -> Self {
        Self {
            provider,
            model,
            reasoning: ReasoningLevel::OFF,
            origin: BindingOrigin::ExplicitUser,
        }
    }

    pub fn with_reasoning(mut self, reasoning: ReasoningLevel) -> Self {
        self.reasoning = reasoning;
        self
    }

    pub fn with_origin(mut self, origin: BindingOrigin) -> Self {
        self.origin = origin;
        self
    }

    /// The binding a child gets when it simply follows its parent.
    pub fn inherited(&self) -> Self {
        Self {
            provider: self.provider,
            model: self.model.clone(),
            reasoning: self.reasoning,
            origin: BindingOrigin::InheritedFromParent,
        }
    }

    pub fn label(&self) -> String {
        match &self.model {
            Some(model) => format!("{}/{}", self.provider, model),
            None => self.provider.to_string(),
        }
    }
}

/// How a spawned child picks its model.
///
/// Kept as a trait from the start so a future "use a small fast model for
/// read-only exploration" policy is a new implementation rather than a rewrite
/// of the runtime. Today only [`InheritFromParent`] ships.
pub trait ModelPolicy: Send + Sync + std::fmt::Debug {
    /// `requested` is what the spawning model asked for, when it asked at all.
    fn resolve(&self, parent: &ModelBinding, requested: Option<&ModelBinding>) -> ModelBinding;
}

/// The default: a child runs on its parent's model unless the caller was
/// explicit. Gemini spawns Gemini, Claude spawns Claude.
#[derive(Debug, Clone, Copy, Default)]
pub struct InheritFromParent;

impl ModelPolicy for InheritFromParent {
    fn resolve(&self, parent: &ModelBinding, requested: Option<&ModelBinding>) -> ModelBinding {
        match requested {
            Some(binding) => binding.clone().with_origin(BindingOrigin::ExplicitUser),
            None => parent.inherited(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_wire_names_match_the_existing_interface() {
        // These strings are a contract with interface/script/state.js and
        // cli.js. Changing one silently breaks the model selector.
        assert_eq!(ProviderId::Codex.as_str(), "codex");
        assert_eq!(ProviderId::Claude.as_str(), "claude");
        assert_eq!(ProviderId::Gemini.as_str(), "gemini");
        assert_eq!(ProviderId::Grok.as_str(), "grok");
        assert_eq!(ProviderId::Mistral.as_str(), "mistral");
        assert_eq!(ProviderId::Kimi.as_str(), "kimi");
        assert_eq!(ProviderId::Local.as_str(), "local");
        assert_eq!(ProviderId::Gguf.as_str(), "gguf");
    }

    #[test]
    fn provider_round_trips_through_json() {
        for provider in ProviderId::ALL {
            let json = serde_json::to_string(&provider).expect("serialize");
            assert_eq!(json, format!("\"{}\"", provider.as_str()));
            let back: ProviderId = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, provider);
        }
    }

    #[test]
    fn parse_rejects_unknown_providers() {
        assert_eq!(ProviderId::parse("mistral"), Some(ProviderId::Mistral));
        assert_eq!(ProviderId::parse("openai"), None);
    }

    #[test]
    fn only_ollama_and_gguf_are_local() {
        let local: Vec<_> = ProviderId::ALL
            .into_iter()
            .filter(|p| p.is_local())
            .collect();
        assert_eq!(local, vec![ProviderId::Local, ProviderId::Gguf]);
    }

    #[test]
    fn subagents_inherit_the_parent_model_by_default() {
        let parent = ModelBinding::new(ProviderId::Gemini, Some("gemini-3.5-flash".into()))
            .with_reasoning(ReasoningLevel(2));
        let child = InheritFromParent.resolve(&parent, None);

        assert_eq!(child.provider, ProviderId::Gemini);
        assert_eq!(child.model.as_deref(), Some("gemini-3.5-flash"));
        assert_eq!(child.reasoning, ReasoningLevel(2));
        assert_eq!(child.origin, BindingOrigin::InheritedFromParent);
    }

    #[test]
    fn an_explicit_request_overrides_inheritance() {
        let parent = ModelBinding::new(ProviderId::Claude, None);
        let wanted = ModelBinding::new(ProviderId::Mistral, Some("mistral-small".into()));
        let child = InheritFromParent.resolve(&parent, Some(&wanted));

        assert_eq!(child.provider, ProviderId::Mistral);
        assert_eq!(child.origin, BindingOrigin::ExplicitUser);
    }

    #[test]
    fn reasoning_level_is_clamped_to_the_slider_range() {
        assert_eq!(ReasoningLevel::clamped(9), ReasoningLevel(4));
        assert!(ReasoningLevel::default().is_off());
    }
}
