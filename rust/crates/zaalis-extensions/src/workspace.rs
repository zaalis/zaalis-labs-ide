//! Desktop project selection through a scoped loopback capability.
use async_trait::async_trait;
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_store::SecretValue;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

pub struct WorkspaceTool {
    endpoint: Url,
    token: SecretValue,
    client: reqwest::Client,
}
impl std::fmt::Debug for WorkspaceTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceTool").field("endpoint", &self.endpoint)
            .field("token", &"[REDACTED]").finish()
    }
}

impl WorkspaceTool {
    pub fn from_env() -> Result<Option<Self>> {
        let endpoint = match std::env::var("ZAALIS_WORKSPACE_ENDPOINT") {
            Ok(value) if !value.trim().is_empty() => Url::parse(&value)
                .map_err(|_| ZaalisError::invalid("URL workspace invalide"))?,
            _ => return Ok(None),
        };
        if endpoint.scheme() != "http" || !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost"))
            || !endpoint.username().is_empty() || endpoint.password().is_some() {
            return Err(ZaalisError::invalid("workspace doit utiliser un endpoint loopback HTTP"));
        }
        let token = std::env::var("ZAALIS_WORKSPACE_TOKEN")
            .map_err(|_| ZaalisError::invalid("jeton workspace absent"))?;
        if token.len() < 32 { return Err(ZaalisError::invalid("jeton workspace trop court")); }
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30)).build().map_err(|error| ZaalisError::io(error.to_string()))?;
        Ok(Some(Self { endpoint, token: SecretValue::new(token), client }))
    }
}

#[async_trait]
impl Tool for WorkspaceTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "workspace".into(),
            description: "Projets connus de l'IDE et terminal visible. Utilise list pour connaître les chemins complets des projets récents, le projet actif et le dossier du terminal. Si l'utilisateur demande d'ouvrir un projet ou de s'y placer dans le terminal, utilise open avec son nom exact ou son chemin renvoyé par list ; terminal=true ouvre un terminal dans ce dossier. Après open, confirme le résultat et termine le tour : les outils de fichiers du tour actuel restent dans l'ancien dossier, le prochain tour utilise le projet sélectionné. Ne demande pas le chemin d'un projet déjà connu. Ce service ne recherche pas les dossiers arbitraires du PC.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":["list","open"]},"project":{"type":"string"},"terminal":{"type":"boolean"}},"required":["action"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        let kind = match action { "list" => AccessKind::Read, "open" => AccessKind::Computer,
            _ => return Err(ZaalisError::invalid("action workspace inconnue")) };
        Ok(AccessRequest::new(context.agent_id.clone(), "workspace", kind)
            .with_target(format!("projet IDE : {}", input.get("project").and_then(Value::as_str).unwrap_or(action))))
    }
    async fn execute(&self, mut input: Value, context: ToolContext, cancel: CancellationToken) -> Result<ToolResult> {
        input["agent_id"] = json!(context.agent_id);
        let request = self.client.post(self.endpoint.clone()).bearer_auth(self.token.expose()).json(&input);
        let response = tokio::select! {
            value = request.send() => value.map_err(|error| ZaalisError::io(error.to_string()))?,
            () = cancel.cancelled() => return Err(ZaalisError::cancelled()),
        };
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| ZaalisError::io(error.to_string()))?;
        if !status.is_success() { return Err(ZaalisError::io(value.get("error").and_then(Value::as_str).unwrap_or("workspace indisponible"))); }
        Ok(ToolResult { summary: value.get("summary").and_then(Value::as_str).unwrap_or("workspace terminé").into(), value })
    }
}
