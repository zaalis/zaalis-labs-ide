use async_trait::async_trait;
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_store::SecretValue;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

pub struct ComputerTool {
    endpoint: Url,
    token: SecretValue,
    client: reqwest::Client,
}

impl std::fmt::Debug for ComputerTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComputerTool")
            .field("endpoint", &self.endpoint)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

impl ComputerTool {
    pub fn from_env() -> Result<Option<Self>> {
        let endpoint = match std::env::var("ZAALIS_COMPUTER_ENDPOINT") {
            Ok(value) if !value.trim().is_empty() => {
                Url::parse(&value).map_err(|_| ZaalisError::invalid("URL computer invalide"))?
            }
            _ => return Ok(None),
        };
        if endpoint.scheme() != "http"
            || !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost"))
            || endpoint.username() != ""
            || endpoint.password().is_some()
        {
            return Err(ZaalisError::invalid(
                "computer doit utiliser un endpoint loopback HTTP",
            ));
        }
        let token = std::env::var("ZAALIS_COMPUTER_TOKEN")
            .map_err(|_| ZaalisError::invalid("jeton computer absent"))?;
        if token.len() < 32 {
            return Err(ZaalisError::invalid("jeton computer trop court"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| ZaalisError::io(error.to_string()))?;
        Ok(Some(Self {
            endpoint,
            token: SecretValue::new(token),
            client,
        }))
    }
}

#[async_trait]
impl Tool for ComputerTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "computer".into(),
            description: "Contrôler le bureau Linux lorsque l'utilisateur l'a explicitement activé. Commence par observe ou inspect. Pour ouvrir une application, utilise son chemin absolu ou un nom Linux autorisé. Après activation, inspect vérifie l'écran, puis utilise key/type/click/scroll pour terminer. Aucune donnée sensible ni validation irréversible.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":["observe","inspect","menus","move","click","scroll","type","key","activate_app"]},"target":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"dx":{"type":"number"},"dy":{"type":"number"},"button":{"type":"string"},"text":{"type":"string"},"key":{"type":"string"},"modifiers":{"type":"array","items":{"type":"string"}},"path":{"type":"string"},"include_image":{"type":"boolean"},"include_ui":{"type":"boolean"},"include_ocr":{"type":"boolean"},"max_elements":{"type":"integer"},"max_dimension":{"type":"integer"}},"required":["action"],"additionalProperties":false}),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ZaalisError::invalid("action computer requise"))?;
        Ok(
            AccessRequest::new(context.agent_id.clone(), "computer", AccessKind::Computer)
                .with_target(action),
        )
    }

    async fn execute(
        &self,
        input: Value,
        _context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        if serde_json::to_vec(&input)?.len() > 32 * 1024 {
            return Err(ZaalisError::invalid("action computer trop volumineuse"));
        }
        let request = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.token.expose())
            .json(&input);
        let response = tokio::select! { value = request.send() => value.map_err(|error| ZaalisError::io(error.to_string()))?, () = cancel.cancelled() => return Err(ZaalisError::cancelled()) };
        if !response.status().is_success() {
            return Err(ZaalisError::io(format!(
                "computer HTTP {}",
                response.status()
            )));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| ZaalisError::io(error.to_string()))?;
        Ok(ToolResult {
            summary: value
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("computer termine")
                .into(),
            value,
        })
    }
}
