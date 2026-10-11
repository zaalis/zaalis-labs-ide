//! Independently implemented assistant adapters. The loopback service owns
//! credentials; access is evaluated by the same guard as every native tool.
use async_trait::async_trait;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_store::SecretValue;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult, ToolRuntime};

#[derive(Debug, Clone, Deserialize)]
struct Spec {
    name: String,
    description: String,
    input_schema: Value,
    access: String,
    #[serde(default)]
    reads: Vec<String>,
}
pub struct AssistantTool {
    spec: Spec,
    endpoint: Url,
    token: SecretValue,
    client: reqwest::Client,
}
impl std::fmt::Debug for AssistantTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssistantTool")
            .field("name", &self.spec.name)
            .finish()
    }
}
pub fn register(runtime: &ToolRuntime) -> Result<()> {
    let Ok(raw) = std::env::var("ZAALIS_ASSISTANT_ENDPOINT") else {
        return Ok(());
    };
    let endpoint = Url::parse(&raw).map_err(|_| ZaalisError::invalid("assistant URL"))?;
    if endpoint.scheme() != "http"
        || !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost"))
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(ZaalisError::invalid("assistant requires loopback HTTP"));
    }
    let token = std::env::var("ZAALIS_ASSISTANT_TOKEN")
        .map_err(|_| ZaalisError::invalid("assistant token missing"))?;
    if token.len() < 32 {
        return Err(ZaalisError::invalid("assistant token too short"));
    }
    let manifest = if let Ok(file) = std::env::var("ZAALIS_ASSISTANT_MANIFEST") {
        if std::fs::metadata(&file)?.len() > 1024 * 1024 {
            return Err(ZaalisError::invalid("manifest file too large"));
        }
        std::fs::read_to_string(file)?
    } else {
        std::env::var("ZAALIS_ASSISTANT_TOOLS").unwrap_or_default()
    };
    let specs: Vec<Spec> = serde_json::from_str(&manifest)?;
    if specs.len() > 160 {
        return Err(ZaalisError::invalid("assistant manifest too large"));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(660))
        .build()
        .map_err(|e| ZaalisError::io(e.to_string()))?;
    for spec in specs {
        runtime.register_deferred(AssistantTool {
            spec,
            endpoint: endpoint.clone(),
            token: SecretValue::new(token.clone()),
            client: client.clone(),
        })?;
    }
    Ok(())
}
#[async_trait]
impl Tool for AssistantTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.spec.name.clone(),
            description: self.spec.description.clone(),
            input_schema: self.spec.input_schema.clone(),
        }
    }
    fn access(&self, input: &Value, ctx: &ToolContext) -> Result<AccessRequest> {
        if !input.is_object() || serde_json::to_vec(input)?.len() > 128 * 1024 {
            return Err(ZaalisError::invalid("assistant arguments"));
        }
        let action =
            input
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or(match self.spec.name.as_str() {
                    "memory" => "search",
                    "delegate_task" => "start",
                    "cronjob_manage" | "manage_connections" | "manage_catalog" => "list",
                    _ => "",
                });
        let kind = if self.spec.reads.iter().any(|a| a == action) {
            AccessKind::Read
        } else {
            match self.spec.access.as_str() {
                "read" => AccessKind::Read,
                "network" => AccessKind::Network,
                "spawn" => AccessKind::Spawn,
                "computer" => AccessKind::Computer,
                "execute" => AccessKind::Execute,
                _ => AccessKind::Write,
            }
        };
        // A remote/process/code command is still assessed as its actual command.
        let target = if kind == AccessKind::Execute {
            input
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or(&self.spec.name)
                .to_owned()
        } else {
            format!(
                "{}:{}:{}",
                ctx.workspace.root().display(),
                self.spec.name,
                action
            )
        };
        Ok(
            AccessRequest::new(ctx.agent_id.clone(), self.spec.name.clone(), kind)
                .with_target(target),
        )
    }
    async fn execute(
        &self,
        input: Value,
        ctx: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let request=self.client.post(self.endpoint.clone()).bearer_auth(self.token.expose()).json(&json!({"name":self.spec.name,"input":input,"agent_id":ctx.agent_id,"root":ctx.workspace.root(),"permission_mode":ctx.permissions.mode}));
        let mut response = tokio::select! {r=request.send()=>r.map_err(|e|ZaalisError::io(e.to_string()))?,()=cancel.cancelled()=>return Err(ZaalisError::cancelled())};
        let status = response.status();
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {b=response.chunk()=>b.map_err(|e|ZaalisError::io(e.to_string()))?,()=cancel.cancelled()=>return Err(ZaalisError::cancelled())};
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > 24 * 1024 * 1024 {
                return Err(ZaalisError::invalid("assistant result too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if !status.is_success() {
            return Err(ZaalisError::io(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant tool failed"),
            ));
        }
        Ok(ToolResult {
            summary: format!("{} completed", self.spec.name),
            value,
        })
    }
}
