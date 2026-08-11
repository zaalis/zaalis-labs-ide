//! Provider registry construction. Secrets enter as owned values and are never
//! included in Debug output, protocol responses or errors.

use std::collections::HashMap;
use std::sync::Arc;
use zaalis_core::{ProviderId, Result, ZaalisError};
use zaalis_providers::{
    AnthropicConfig, AnthropicProvider, GeminiConfig, GeminiProvider, OpenAiConfig, OpenAiProvider,
    PoolConfig, ProviderPool,
};

#[derive(Default)]
pub struct ProviderSecrets {
    values: HashMap<ProviderId, String>,
}

impl std::fmt::Debug for ProviderSecrets {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderSecrets")
            .field("configured", &self.values.keys())
            .finish()
    }
}

impl ProviderSecrets {
    pub fn insert(&mut self, provider: ProviderId, value: impl Into<String>) {
        let value = value.into();
        if !value.trim().is_empty() {
            self.values.insert(provider, value);
        }
    }

    pub fn from_environment() -> Self {
        let mut secrets = Self::default();
        for (provider, variable) in [
            (ProviderId::Codex, "OPENAI_API_KEY"),
            (ProviderId::Claude, "ANTHROPIC_API_KEY"),
            (ProviderId::Gemini, "GEMINI_API_KEY"),
            (ProviderId::Grok, "XAI_API_KEY"),
            (ProviderId::Mistral, "MISTRAL_API_KEY"),
            (ProviderId::Kimi, "MOONSHOT_API_KEY"),
        ] {
            if let Ok(value) = std::env::var(variable) {
                secrets.insert(provider, value);
            }
        }
        secrets
    }

    fn take(&mut self, provider: ProviderId) -> Option<String> {
        self.values.remove(&provider)
    }
}

pub fn build_pool(mut secrets: ProviderSecrets) -> Result<Arc<ProviderPool>> {
    let pool = Arc::new(ProviderPool::new(PoolConfig::default()));
    for provider in [
        ProviderId::Codex,
        ProviderId::Grok,
        ProviderId::Mistral,
        ProviderId::Kimi,
        ProviderId::Local,
        ProviderId::Gguf,
    ] {
        let key = secrets.take(provider);
        if !provider.is_local() && key.is_none() {
            continue;
        }
        let mut config = OpenAiConfig::for_provider(provider, key)
            .ok_or_else(|| ZaalisError::config(format!("configuration absente pour {provider}")))?;
        let endpoint_variable = match provider {
            ProviderId::Local => Some("ZAALIS_OLLAMA_URL"),
            ProviderId::Gguf => Some("ZAALIS_GGUF_URL"),
            _ => None,
        };
        if let Some(value) = endpoint_variable.and_then(|name| std::env::var(name).ok()) {
            let value = value.trim_end_matches('/');
            config = config.with_base_url(if value.ends_with("/v1") {
                value.to_owned()
            } else {
                format!("{value}/v1")
            });
        }
        let adapter = OpenAiProvider::new(config).map_err(ZaalisError::from)?;
        pool.register(Arc::new(adapter));
    }
    if let Some(key) = secrets.take(ProviderId::Claude) {
        pool.register(Arc::new(
            AnthropicProvider::new(AnthropicConfig::new(key)).map_err(ZaalisError::from)?,
        ));
    }
    if let Some(key) = secrets.take(ProviderId::Gemini) {
        pool.register(Arc::new(
            GeminiProvider::new(GeminiConfig::new(key)).map_err(ZaalisError::from)?,
        ));
    }
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_providers_exist_without_remote_secrets() {
        let pool = build_pool(ProviderSecrets::default()).unwrap();
        assert!(pool.contains(ProviderId::Local));
        assert!(pool.contains(ProviderId::Gguf));
        assert!(!pool.contains(ProviderId::Mistral));
        assert!(!format!("{:?}", ProviderSecrets::default()).contains("API_KEY"));
    }
}
