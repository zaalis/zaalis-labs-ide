//! Scoped VM capability. Never accepts host commands or arbitrary host paths.
use async_trait::async_trait;
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_store::SecretValue;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};
#[derive(Debug)]
pub struct VmTool { endpoint: Url, token: SecretValue, client: reqwest::Client }
impl VmTool {
    pub fn from_env() -> Result<Option<Self>> {
        let raw = match std::env::var("ZAALIS_WORKSPACE_ENDPOINT") { Ok(v) if !v.is_empty() => v, _ => return Ok(None) };
        let mut endpoint = Url::parse(&raw).map_err(|_| ZaalisError::invalid("URL VM invalide"))?;
        if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1") || !endpoint.username().is_empty() || endpoint.password().is_some() { return Err(ZaalisError::invalid("VM doit utiliser le loopback")); }
        endpoint.set_path("/api/internal/rust-vm");
        let token = std::env::var("ZAALIS_WORKSPACE_TOKEN").map_err(|_| ZaalisError::invalid("jeton VM absent"))?;
        if token.len() < 32 { return Err(ZaalisError::invalid("jeton VM invalide")); }
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(130)).build().map_err(|e| ZaalisError::io(e.to_string()))?;
        Ok(Some(Self { endpoint, token: SecretValue::new(token), client }))
    }
}
#[async_trait]
impl Tool for VmTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "vm".into(),
            description: "Machines virtuelles de l'IDE. Toujours autonome dans la VM, indépendamment du mode du PC hôte. Utilise list, create (linux ou windows), status, import_project (copie du projet actif sans .env, clés, .git ni dépendances locales), exec et stop. create démarre en arrière-plan : attends status=ready avant exec. Linux est Debian via SSH, Windows est PowerShell dans Windows Sandbox. exec renvoie stdout/stderr et exitCode. Linux : chaque exec ouvre un shell séparé, utilise cd /home/zaalis/workspace && ... ; Windows : le répertoire persiste. network=isolated par défaut ; internet donne accès au réseau hôte et à Internet. Ne lance pas des commandes de test sur le PC quand l'utilisateur demande la Sandbox. Aucun clic UI requis. Pas d'activation système ou de chemins hôte arbitraires.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":["list","create","status","import_project","export_file","reset","exec","stop"]},"system":{"type":"string","enum":["linux","windows"]},"id":{"type":"string"},"name":{"type":"string"},"command":{"type":"string"},"path":{"type":"string","description":"Chemin invité pour export_file (fichier de 32 Mo maximum)"},"network":{"type":"string","enum":["isolated","internet"]},"memoryMB":{"type":"integer","minimum":1024,"maximum":8192},"cpus":{"type":"integer","minimum":1,"maximum":4}},"required":["action"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        if !["list","create","status","import_project","export_file","reset","exec","stop"].contains(&action) { return Err(ZaalisError::invalid("action VM inconnue")); }
        Ok(AccessRequest::new(context.agent_id.clone(), "vm", if ["list","status"].contains(&action) { AccessKind::Read } else { AccessKind::Sandbox }).with_target(format!("VM : {action}")))
    }
    async fn execute(&self, mut input: Value, context: ToolContext, cancel: CancellationToken) -> Result<ToolResult> {
        input["agent_id"] = json!(context.agent_id);
        let response = tokio::select! { r = self.client.post(self.endpoint.clone()).bearer_auth(self.token.expose()).json(&input).send() => r.map_err(|e| ZaalisError::io(e.to_string()))?, () = cancel.cancelled() => return Err(ZaalisError::cancelled()) };
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| ZaalisError::io(e.to_string()))?;
        if !status.is_success() { return Err(ZaalisError::io(value.get("error").and_then(Value::as_str).unwrap_or("VM indisponible"))); }
        Ok(ToolResult { summary: value.get("summary").and_then(Value::as_str).unwrap_or("VM").into(), value })
    }
}
