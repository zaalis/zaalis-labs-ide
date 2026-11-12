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
const ACTIONS: [&str; 12] = ["list","create","status","import_project","export_file","reset","exec","stop","delete","templates","save_template","hosts"];

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
            description: "Machines virtuelles et environnements d'exécution de l'IDE. Toujours autonome dans une machine isolée, indépendamment du mode du PC hôte. Actions : list, create, status, import_project (copie du projet actif sans .env, clés, .git ni dépendances locales), exec, export_file, stop, delete, reset, templates, save_template, hosts. system : linux (Debian QEMU via SSH), windows (Windows Sandbox, PowerShell), docker (conteneur jetable, image optionnelle, aucun dossier hôte monté) ou ssh (serveur enregistré et vérifié par l'utilisateur : host = id renvoyé par hosts ; chaque exec y suit les règles de commandes de l'hôte). create démarre en arrière-plan : appelle ensuite status avec waitMs=30000 (répète tant que status=starting) et n'utilise exec que lorsque status=ready. exec renvoie output (stdout+stderr), exitCode et timedOut ; timeoutMs (1000 à 120000, défaut 120000) borne la commande — sous Windows un dépassement arrête la Sandbox. Linux : chaque exec ouvre un shell séparé, utilise cd /home/zaalis/workspace && ... ; Windows : le répertoire courant persiste. network=isolated par défaut ; internet (confirmé par l'utilisateur) donne accès à Internet et au réseau local, les services du PC hôte restant bloqués par le pare-feu invité. stop arrête la machine ; delete l'arrête si besoin puis libère son disque : supprime celles dont tu n'as plus besoin. reset remplace la machine par une neuve et renvoie son nouvel id. Ne lance pas des commandes de test sur le PC quand l'utilisateur demande une machine isolée. Pas d'activation système ni de chemins hôte arbitraires.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":ACTIONS},"system":{"type":"string","enum":["linux","windows","docker","ssh"]},"image":{"type":"string","description":"docker : image (défaut debian:12-slim)"},"host":{"type":"string","description":"ssh : identifiant d'un hôte renvoyé par hosts"},"templateId":{"type":"string"},"id":{"type":"string"},"name":{"type":"string"},"command":{"type":"string"},"timeoutMs":{"type":"integer","minimum":1000,"maximum":120000,"description":"Durée maximale de exec"},"waitMs":{"type":"integer","minimum":0,"maximum":30000,"description":"status : attendre jusqu'à ce délai que la VM ne soit plus en démarrage"},"path":{"type":"string","description":"Chemin invité pour export_file (fichier de 32 Mo maximum)"},"network":{"type":"string","enum":["isolated","internet"]},"memoryMB":{"type":"integer","minimum":1024,"maximum":8192},"cpus":{"type":"integer","minimum":1,"maximum":4}},"required":["action"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        if !ACTIONS.contains(&action) { return Err(ZaalisError::invalid("action VM inconnue")); }
        let field = |name: &str| input.get(name).and_then(Value::as_str);
        // A command on a registered SSH server runs on a real machine: it goes
        // through the host command rules (analysis, confirmation by mode).
        if action == "exec" && field("id").is_some_and(|id| id.starts_with("ssh-")) {
            let command = field("command").ok_or_else(|| ZaalisError::invalid("commande absente"))?;
            return Ok(AccessRequest::new(context.agent_id.clone(), "vm", AccessKind::Execute).with_target(command.to_owned()));
        }
        // A connected machine reaches the Internet and the local network; an
        // SSH session drives a real server. Neither starts without the user.
        let remote = action == "create" && field("system") == Some("ssh");
        let connected = action == "create" && field("network") == Some("internet");
        let target = if remote {
            format!("VM : create · {} {}", zaalis_guard::VM_REMOTE_MARK, field("host").unwrap_or("?"))
        } else if connected {
            format!("VM : {action} · {}", zaalis_guard::VM_NETWORK_MARK)
        } else { format!("VM : {action}") };
        let kind = if ["list","status","templates","hosts"].contains(&action) { AccessKind::Read } else { AccessKind::Sandbox };
        Ok(AccessRequest::new(context.agent_id.clone(), "vm", kind).with_target(target).sensitive(connected || remote))
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

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::{AgentId, PermissionMode, PermissionSet};

    fn tool() -> VmTool {
        VmTool { endpoint: Url::parse("http://127.0.0.1:1/api/internal/rust-vm").unwrap(), token: SecretValue::new("x".repeat(32)), client: reqwest::Client::new() }
    }
    fn context() -> ToolContext {
        ToolContext { agent_id: AgentId::new(), permissions: PermissionSet::new(PermissionMode::Auto), workspace: zaalis_fs::Workspace::open(std::env::temp_dir()).unwrap() }
    }

    #[test]
    fn connected_and_ssh_sessions_need_the_user_and_ssh_commands_follow_host_rules() {
        let vm = tool();
        let access = |input: Value| vm.access(&input, &context()).unwrap();
        let isolated = access(json!({"action":"create","system":"docker"}));
        assert_eq!(isolated.kind, AccessKind::Sandbox);
        assert!(!isolated.sensitive);
        for input in [
            json!({"action":"create","system":"linux","network":"internet"}),
            json!({"action":"create","system":"docker","network":"internet"}),
        ] {
            let request = access(input);
            assert!(request.sensitive && request.target.clone().unwrap_or_default().contains(zaalis_guard::VM_NETWORK_MARK));
        }
        let remote = access(json!({"action":"create","system":"ssh","host":"h1"}));
        assert!(remote.sensitive && remote.target.clone().unwrap_or_default().contains(zaalis_guard::VM_REMOTE_MARK));
        let command = access(json!({"action":"exec","id":"ssh-0000","command":"rm -rf /var/www"}));
        assert_eq!(command.kind, AccessKind::Execute);
        assert_eq!(command.target.as_deref(), Some("rm -rf /var/www"));
        assert_eq!(access(json!({"action":"exec","id":"1234","command":"ls"})).kind, AccessKind::Sandbox);
        assert_eq!(access(json!({"action":"hosts"})).kind, AccessKind::Read);
        assert!(vm.access(&json!({"action":"format_host"}), &context()).is_err());
    }
}
