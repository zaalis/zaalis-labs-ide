//! Provider registry construction. Secrets enter as owned values and are never
//! included in Debug output, protocol responses or errors.

use std::collections::HashMap;
use std::sync::Arc;
use zaalis_core::{ProviderId, Result, ZaalisError};
use zaalis_providers::{
    AnthropicConfig, AnthropicProvider, CompatProvider, GeminiConfig, GeminiProvider,
    OpenAiConfig, OpenAiProvider, PoolConfig, ProviderPool,
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
            // Every key the daemon holds is also registered for output masking.
            // Doing it here rather than at each call site means a provider
            // added later cannot forget to do it: holding the key and masking
            // it become the same step.
            zaalis_secrets::register_secret(format!("clé {provider}"), value.clone());
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
    let compat = compat_from_environment(|name| std::env::var(name).ok())?;
    if !compat.is_empty() {
        pool.register(Arc::new(compat));
    }
    Ok(pool)
}

/// OpenAI-compatible endpoints configured in the zaalis settings. The server
/// passes `ZAALIS_COMPAT_ENDPOINTS` as `[{"id","base_url","key_env"}]` and each
/// key in its own variable, so the list itself never contains a secret.
fn compat_from_environment(read: impl Fn(&str) -> Option<String>) -> Result<CompatProvider> {
    #[derive(serde::Deserialize)]
    struct Endpoint {
        id: String,
        base_url: String,
        #[serde(default)]
        key_env: Option<String>,
    }
    let mut provider = CompatProvider::new();
    let Some(raw) = read("ZAALIS_COMPAT_ENDPOINTS").filter(|value| !value.trim().is_empty()) else {
        return Ok(provider);
    };
    let endpoints: Vec<Endpoint> = serde_json::from_str(&raw)
        .map_err(|error| ZaalisError::config(format!("ZAALIS_COMPAT_ENDPOINTS invalide : {error}")))?;
    for endpoint in endpoints {
        let base_url = endpoint.base_url.trim();
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(ZaalisError::config(format!(
                "URL invalide pour le fournisseur {}",
                endpoint.id
            )));
        }
        let key = endpoint
            .key_env
            .as_deref()
            .and_then(&read)
            .filter(|value| !value.trim().is_empty());
        if let Some(value) = &key {
            zaalis_secrets::register_secret(format!("clé {}", endpoint.id), value.clone());
        }
        provider
            .add(endpoint.id, OpenAiConfig::compat(base_url, key))
            .map_err(ZaalisError::from)?;
    }
    Ok(provider)
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
        assert!(!pool.contains(ProviderId::Compat));
    }

    #[test]
    fn compat_endpoints_are_read_without_secrets_in_the_list() {
        let vars = std::collections::HashMap::from([
            (
                "ZAALIS_COMPAT_ENDPOINTS",
                r#"[{"id":"deepseek","base_url":"https://api.deepseek.com/v1","key_env":"ZAALIS_COMPAT_KEY_0"},
                    {"id":"lmstudio","base_url":"http://127.0.0.1:1234/v1"}]"#,
            ),
            ("ZAALIS_COMPAT_KEY_0", "sk-compat-test"),
        ]);
        let compat = compat_from_environment(|name| vars.get(name).map(|v| v.to_string())).unwrap();
        assert!(compat.contains("deepseek"));
        assert!(compat.contains("lmstudio"));
        assert!(!format!("{compat:?}").contains("sk-compat-test"));

        let empty = compat_from_environment(|_| None).unwrap();
        assert!(empty.is_empty());
        let bad = std::collections::HashMap::from([(
            "ZAALIS_COMPAT_ENDPOINTS",
            r#"[{"id":"x","base_url":"file:///etc/passwd"}]"#,
        )]);
        assert!(compat_from_environment(|name| bad.get(name).map(|v| v.to_string())).is_err());
    }
}
