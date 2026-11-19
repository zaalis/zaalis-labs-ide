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
            description: "Projets connus de l'IDE, terminal visible et création locale de fichiers. memory : input.action list/search/save/delete (recherche plein texte classée ; save est automatique : enregistre sans demander les préférences durables, conventions et faits stables utiles, jamais de secret) ; tasks : input.action list/create/update/run/cancel/delete (planification : runAt ISO, intervalMinutes ou cron « minute heure jour mois jourSemaine ») ; session_search : recherche plein texte dans les conversations du projet actif ; skills : input.action list ou propose (name, description, instructions) pour enregistrer une procédure réutilisable, activée selon le réglage de l'utilisateur ; pentest (skill /pentest) : input.action tools (outils de pentest, commande exacte et exemple ; input.name/names, input.waitMs jusqu'à 25000 pour attendre une installation), install (input.name : installation en arrière-plan sur ce PC dans le dossier d'outils de Zaalis), findings, finding_add / finding_update (title, asset, cvss vecteur 3.1, description, impact, reproduction, remediation, evidence = liste de { command, output }, cwe, references, status draft/confirmed/false_positive/fixed), report (client, authorization, targets, notes : rapport Markdown dans pentest/ du projet). GitHub (compte connecté, accès à tous les dépôts comme GitHub CLI) : action github avec input.action repos (liste), files, read (path), pulls, push (branch), create_pull (title, head, branch base, body), merge (number, sha exact), ou api pour TOUT le reste de l'API REST GitHub (input.method GET/POST/PATCH/PUT/DELETE, input.endpoint ex. /user/repos, /repos/owner/name/issues, /repos/owner/name/releases, /repos/owner/name/actions/runs, input.query, input.body). Dans le terminal, git clone/pull/push et gh sont déjà authentifiés avec ce compte. Ne déduisez jamais le dépôt de son seul nom : vérifiez avec repos. list donne les projets connus. open sélectionne un projet connu et ouvre éventuellement son terminal. create_artifact crée un vrai PDF, DOCX, XLSX ou CSV dans artifacts/ du projet actif (ou de l'espace de chat) ; fournir format, name, title et content pour PDF/DOCX, ou rows/sheets pour XLSX, ou rows pour CSV. N'annonce le fichier créé qu'après le résultat de l'outil. Après open, confirme puis termine le tour : les outils restent dans l'ancien dossier jusqu'au prochain tour. Aucun chemin hôte arbitraire n'est accepté.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":["list","open","create_artifact","github","memory","tasks","session_search","skills","pentest"]},"input":{"type":"object","description":"GitHub : action repos, files, read (path), pulls, push (branch), create_pull (title, head, branch base, body), merge (number, sha exact), api (method, endpoint, query, body : tout l'API REST GitHub). repo=owner/name. Les droits par dépôt sont imposés par le serveur."},"project":{"type":"string"},"terminal":{"type":"boolean"},"format":{"type":"string","enum":["pdf","docx","xlsx","csv"]},"name":{"type":"string"},"title":{"type":"string"},"content":{"type":"string"},"rows":{"type":"array","items":{"type":"array","items":{}}},"sheets":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"rows":{"type":"array","items":{"type":"array","items":{}}}},"required":["rows"],"additionalProperties":false}}},"required":["action"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        let kind = match action { "list" => AccessKind::Read, "open" => AccessKind::Computer,
            "create_artifact" => AccessKind::Write,
            "session_search" => AccessKind::Read,
            "memory" => match input.get("input").and_then(|i|i.get("action")).and_then(Value::as_str) {
                Some("list" | "search") => AccessKind::Read,
                // Saving a memory is IDE bookkeeping, like a todo: automatic
                // capture must not stop the turn. Deleting still asks.
                Some("save") => AccessKind::Session,
                Some("delete") => AccessKind::Write,
                _ => return Err(ZaalisError::invalid("action mémoire inconnue")),
            },
            "skills" => match input.get("input").and_then(|i| i.get("action")).and_then(Value::as_str) {
                Some("list") => AccessKind::Read,
                // A proposal is stored pending; only the user activates it,
                // unless they chose automatic activation.
                Some("propose") => AccessKind::Session,
                _ => return Err(ZaalisError::invalid("action skills inconnue")),
            },
            "pentest" => match input.get("input").and_then(|i| i.get("action")).and_then(Value::as_str) {
                Some("tools" | "findings") => AccessKind::Read,
                // Downloading software onto the PC follows the mode's write rule.
                Some("install") => AccessKind::Write,
                Some("finding_add" | "finding_update") => AccessKind::Session,
                Some("report") => AccessKind::Write,
                _ => return Err(ZaalisError::invalid("action pentest inconnue")),
            },
            "tasks" => match input.get("input").and_then(|i|i.get("action")).and_then(Value::as_str) {
                Some("list") => AccessKind::Read,
                Some("create" | "update" | "run" | "cancel" | "delete") => AccessKind::Write,
                _ => return Err(ZaalisError::invalid("action tâche inconnue")),
            },
            "github" => match input.get("input").and_then(|i| i.get("action")).and_then(Value::as_str) {
                Some("repos" | "files" | "read" | "pulls") => AccessKind::Read,
                Some("push" | "create_pull" | "merge") => AccessKind::Write,
                Some("api") => match github_api(&input) {
                    (method, _) if method == "GET" => AccessKind::Read,
                    (method, endpoint) if method == "DELETE" && deletes_repository(&endpoint) => AccessKind::Delete,
                    _ => AccessKind::Write,
                },
                _ => return Err(ZaalisError::invalid("action GitHub inconnue")),
            },
            _ => return Err(ZaalisError::invalid("action workspace inconnue")) };
        let pentest_action = input.get("input").and_then(|i| i.get("action")).and_then(Value::as_str);
        if action == "github" && pentest_action == Some("api") {
            let (method, endpoint) = github_api(&input);
            let target = if kind == AccessKind::Delete {
                format!("{} {endpoint}", zaalis_guard::GITHUB_REPO_DELETE_MARK)
            } else {
                format!("GitHub API : {method} {endpoint}")
            };
            return Ok(AccessRequest::new(context.agent_id.clone(), "workspace", kind).with_target(target));
        }
        Ok(AccessRequest::new(context.agent_id.clone(), "workspace", kind)
            .with_target(if action == "create_artifact" { "artifacts".into() } else if action == "pentest" { format!("pentest : {} {}", pentest_action.unwrap_or(""), input.get("input").and_then(|i| i.get("name")).and_then(Value::as_str).unwrap_or("")).trim().to_owned() } else { format!("projet IDE : {}", input.get("project").and_then(Value::as_str).unwrap_or(action)) })
            .sensitive(action == "pentest" && pentest_action == Some("install")))
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

/// The method and endpoint of a `github` `api` call, normalised.
fn github_api(input: &Value) -> (String, String) {
    let inner = input.get("input");
    let method = inner.and_then(|i| i.get("method")).and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
    let endpoint = inner
        .and_then(|i| i.get("endpoint").or_else(|| i.get("path")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_start_matches("https://api.github.com")
        .to_owned();
    (method, endpoint)
}

/// `DELETE /repos/{owner}/{repo}`: deleting a whole repository.
fn deletes_repository(endpoint: &str) -> bool {
    let path = endpoint.split('?').next().unwrap_or("").trim_matches('/');
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() == 3 && parts[0].eq_ignore_ascii_case("repos")
}
