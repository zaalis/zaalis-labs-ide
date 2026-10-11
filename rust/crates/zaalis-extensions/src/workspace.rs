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
            description: "Projets connus de l'IDE, terminal visible et création locale de fichiers. GitHub : action github avec input.action (repos, files, read, pulls, push, create_pull, merge), input.repo owner/name ; utilisez repos pour découvrir les dépôts autorisés. Les push et merge exigent le projet associé vérifié ; ne déduisez jamais le dépôt de son seul nom. list donne les projets connus. open sélectionne un projet connu et ouvre éventuellement son terminal. create_artifact crée un vrai PDF, DOCX, XLSX ou CSV dans artifacts/ du projet actif (ou de l'espace de chat) ; fournir format, name, title et content pour PDF/DOCX, ou rows/sheets pour XLSX, ou rows pour CSV. N'annonce le fichier créé qu'après le résultat de l'outil. Après open, confirme puis termine le tour : les outils restent dans l'ancien dossier jusqu'au prochain tour. Aucun chemin hôte arbitraire n'est accepté.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":["list","open","create_artifact","github"]},"input":{"type":"object","description":"GitHub : action repos, files, read (path), pulls, push (branch), create_pull (title, head, branch base, body), merge (number, sha exact). repo=owner/name. Toujours vérifier le dépôt et le projet ; les droits sont imposés par le serveur."},"project":{"type":"string"},"terminal":{"type":"boolean"},"format":{"type":"string","enum":["pdf","docx","xlsx","csv"]},"name":{"type":"string"},"title":{"type":"string"},"content":{"type":"string"},"rows":{"type":"array","items":{"type":"array","items":{}}},"sheets":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"rows":{"type":"array","items":{"type":"array","items":{}}}},"required":["rows"],"additionalProperties":false}}},"required":["action"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        let kind = match action { "list" => AccessKind::Read, "open" => AccessKind::Computer,
            "create_artifact" => AccessKind::Write,
            "github" => match input.get("input").and_then(|i| i.get("action")).and_then(Value::as_str) {
                Some("repos" | "files" | "read" | "pulls") => AccessKind::Read,
                Some("push" | "create_pull" | "merge") => AccessKind::Write,
                _ => return Err(ZaalisError::invalid("action GitHub inconnue")),
            },
            _ => return Err(ZaalisError::invalid("action workspace inconnue")) };
        Ok(AccessRequest::new(context.agent_id.clone(), "workspace", kind)
            .with_target(if action == "create_artifact" { "artifacts".into() } else { format!("projet IDE : {}", input.get("project").and_then(Value::as_str).unwrap_or(action)) }))
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
