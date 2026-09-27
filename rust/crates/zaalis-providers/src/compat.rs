//! User-configured OpenAI-compatible endpoints (OpenRouter, DeepSeek,
//! Fireworks, LM Studio, a private gateway…).
//!
//! They all share [`ProviderId::Compat`]; the binding's model string names the
//! endpoint as `<endpoint>::<model>`. URLs and keys come from the zaalis server
//! at daemon start, so a binding persisted in a session never carries a secret.

use crate::openai::{OpenAiConfig, OpenAiProvider};
use crate::types::{Capabilities, ModelProvider, ProviderError, ProviderStream, TurnRequest};
use async_trait::async_trait;
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;
use zaalis_core::ProviderId;

/// Separator between the endpoint id and the model id in a compat binding.
pub const COMPAT_SEPARATOR: &str = "::";

/// Split `openrouter::anthropic/claude-sonnet-5` into its two halves.
pub fn split_compat_model(model: &str) -> Option<(&str, &str)> {
    let (endpoint, model) = model.split_once(COMPAT_SEPARATOR)?;
    let (endpoint, model) = (endpoint.trim(), model.trim());
    (!endpoint.is_empty() && !model.is_empty()).then_some((endpoint, model))
}

pub struct CompatProvider {
    endpoints: BTreeMap<String, OpenAiProvider>,
}

impl std::fmt::Debug for CompatProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Endpoint ids only: the adapters hold the keys.
        formatter
            .debug_struct("CompatProvider")
            .field("endpoints", &self.endpoints.keys())
            .finish()
    }
}

impl CompatProvider {
    pub fn new() -> Self {
        Self {
            endpoints: BTreeMap::new(),
        }
    }

    pub fn add(&mut self, id: impl Into<String>, config: OpenAiConfig) -> Result<(), ProviderError> {
        let id = id.into();
        if id.trim().is_empty() || id.contains(COMPAT_SEPARATOR) {
            return Err(ProviderError::invalid(format!(
                "identifiant de fournisseur invalide : {id}"
            )));
        }
        self.endpoints.insert(id, OpenAiProvider::new(config)?);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.endpoints.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.endpoints.contains_key(id)
    }
}

impl Default for CompatProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ModelProvider for CompatProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Compat
    }

    fn capabilities(&self) -> Capabilities {
        OpenAiConfig::compat("", None).capabilities
    }

    async fn stream_turn(
        &self,
        mut request: TurnRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let full = request.binding.model.clone().unwrap_or_default();
        let (endpoint, model) = split_compat_model(&full).ok_or_else(|| {
            ProviderError::invalid(format!(
                "modèle compatible attendu sous la forme fournisseur::modèle, reçu « {full} »"
            ))
        })?;
        let adapter = self.endpoints.get(endpoint).ok_or_else(|| {
            ProviderError::auth(format!(
                "fournisseur « {endpoint} » non configuré dans zaalis (clé API manquante ?)"
            ))
        })?;
        request.binding.model = Some(model.to_owned());
        adapter.stream_turn(request, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openai::build_request;
    use crate::types::Message;
    use zaalis_core::ModelBinding;

    #[test]
    fn the_model_string_names_the_endpoint() {
        assert_eq!(
            split_compat_model("openrouter::anthropic/claude-sonnet-5"),
            Some(("openrouter", "anthropic/claude-sonnet-5"))
        );
        assert_eq!(
            split_compat_model("deepseek::deepseek-v4-pro"),
            Some(("deepseek", "deepseek-v4-pro"))
        );
        assert_eq!(split_compat_model("qwen3:8b"), None);
        assert_eq!(split_compat_model("::model"), None);
        assert_eq!(split_compat_model("endpoint::"), None);
    }

    #[test]
    fn a_compat_request_sends_only_the_real_model_id() {
        let config = OpenAiConfig::compat("https://api.deepseek.com/v1/", Some("sk-test".into()));
        assert_eq!(config.endpoint(), "https://api.deepseek.com/v1/chat/completions");
        assert!(!config.needs_key());
        let request = TurnRequest::new(
            ModelBinding::new(ProviderId::Compat, Some("deepseek-v4-pro".into())),
            "système",
            vec![Message::user("bonjour")],
        );
        let body = build_request(&config, &request, true);
        assert_eq!(body["model"], "deepseek-v4-pro");
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("chat_template_kwargs").is_none());
    }

    #[test]
    fn debug_output_never_contains_keys() {
        let mut provider = CompatProvider::new();
        provider
            .add(
                "deepseek",
                OpenAiConfig::compat("https://api.deepseek.com/v1", Some("sk-very-secret".into())),
            )
            .unwrap();
        let debug = format!("{provider:?}");
        assert!(debug.contains("deepseek"));
        assert!(!debug.contains("sk-very-secret"));
        assert!(provider
            .add("bad::id", OpenAiConfig::compat("http://x", None))
            .is_err());
    }

    #[tokio::test]
    async fn an_unconfigured_endpoint_is_an_auth_error() {
        let provider = CompatProvider::new();
        let request = TurnRequest::new(
            ModelBinding::new(ProviderId::Compat, Some("openrouter::x".into())),
            "",
            vec![Message::user("bonjour")],
        );
        let Err(error) = provider.stream_turn(request, CancellationToken::new()).await else {
            panic!("un fournisseur non configuré doit échouer");
        };
        assert!(format!("{error}").contains("openrouter"));
    }
}
