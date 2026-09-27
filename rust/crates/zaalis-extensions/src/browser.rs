//! The integrated zaalis Browser, as a tool.
//!
//! The browser runs inside zaalis-server and is displayed in the IDE window
//! (globe panel). This tool drives it through a private loopback endpoint of
//! the server: every action is visible to the user (halo + animated cursor of
//! the browser's own agent). An external browser is only opened on explicit
//! request (`open_external`).

use async_trait::async_trait;
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_store::SecretValue;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

const ACTIONS: [&str; 14] = [
    "tabs", "search", "open", "navigate", "select_tab", "close_tab", "page_text", "read_page",
    "read_console", "read_network", "click", "fill", "execute_js", "open_external",
];

pub struct BrowserTool {
    endpoint: Url,
    token: SecretValue,
    client: reqwest::Client,
}

impl std::fmt::Debug for BrowserTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserTool")
            .field("endpoint", &self.endpoint)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

impl BrowserTool {
    pub fn from_env() -> Result<Option<Self>> {
        let endpoint = match std::env::var("ZAALIS_BROWSER_ENDPOINT") {
            Ok(value) if !value.trim().is_empty() => {
                Url::parse(&value).map_err(|_| ZaalisError::invalid("URL browser invalide"))?
            }
            _ => return Ok(None),
        };
        if endpoint.scheme() != "http"
            || !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost"))
            || endpoint.username() != ""
            || endpoint.password().is_some()
        {
            return Err(ZaalisError::invalid(
                "browser doit utiliser un endpoint loopback HTTP",
            ));
        }
        let token = std::env::var("ZAALIS_BROWSER_TOOL_TOKEN")
            .map_err(|_| ZaalisError::invalid("jeton browser absent"))?;
        if token.len() < 32 {
            return Err(ZaalisError::invalid("jeton browser trop court"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| ZaalisError::io(error.to_string()))?;
        Ok(Some(Self {
            endpoint,
            token: SecretValue::new(token),
            client,
        }))
    }
}

/// Access classification of one browser action: reading and navigating are
/// network accesses (a new host asks once in the confirming modes); acting on
/// a page (click, typing, script) or leaving the IDE for an external browser
/// is a mutation guarded like desktop control.
fn access_for(action: &str, input: &Value) -> (AccessKind, String) {
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    match action {
        "search" => (AccessKind::Network, text("query")),
        "open" | "navigate" if !text("url").is_empty() => (AccessKind::Network, text("url")),
        "click" | "fill" | "execute_js" => (
            AccessKind::Computer,
            format!("navigateur intégré — {action}"),
        ),
        "open_external" => (
            AccessKind::Computer,
            format!("navigateur externe — {}", text("url")),
        ),
        _ => (AccessKind::Network, format!("navigateur intégré — {action}")),
    }
}

#[async_trait]
impl Tool for BrowserTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "browser".into(),
            description: "Navigateur intégré de zaalis IDE (panneau globe), visible par l'utilisateur. \
C'est le navigateur par défaut pour TOUTE navigation ou recherche web visible : search (recherche), open (nouvel onglet), \
navigate (onglet actif : url ou action back|forward|reload), tabs, select_tab/close_tab (id), page_text (texte de la page), \
read_page (arbre d'accessibilité avec refs [ref_N]), read_console, read_network, click (ref|selector|text), \
fill (ref|selector, value, enter?), execute_js (code avec return). Appelle read_page avant click/fill. \
open_external ouvre une URL dans le navigateur externe du PC : UNIQUEMENT si l'utilisateur le demande explicitement."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ACTIONS },
                    "query": { "type": "string" },
                    "url": { "type": "string" },
                    "id": { "type": "integer" },
                    "new_tab": { "type": "boolean" },
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "text": { "type": "string" },
                    "value": { "type": "string" },
                    "enter": { "type": "boolean" },
                    "code": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ZaalisError::invalid("action browser requise"))?;
        if !ACTIONS.contains(&action) {
            return Err(ZaalisError::invalid(format!("action browser inconnue : {action}")));
        }
        let (kind, target) = access_for(action, input);
        Ok(AccessRequest::new(context.agent_id.clone(), "browser", kind).with_target(target))
    }

    async fn execute(
        &self,
        input: Value,
        _context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        if serde_json::to_vec(&input)?.len() > 64 * 1024 {
            return Err(ZaalisError::invalid("action browser trop volumineuse"));
        }
        let request = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.token.expose())
            .json(&input);
        let response = tokio::select! {
            value = request.send() => value.map_err(|error| ZaalisError::io(error.to_string()))?,
            () = cancel.cancelled() => return Err(ZaalisError::cancelled()),
        };
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| ZaalisError::io(error.to_string()))?;
        if !status.is_success() {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("navigateur intégré indisponible");
            return Err(ZaalisError::io(format!("browser HTTP {status} : {message}")));
        }
        Ok(ToolResult {
            summary: value
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("browser termine")
                .into(),
            value,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_and_navigating_are_network_acting_is_guarded() {
        assert_eq!(access_for("read_page", &json!({})).0, AccessKind::Network);
        assert_eq!(access_for("search", &json!({"query":"rust"})), (AccessKind::Network, "rust".into()));
        assert_eq!(
            access_for("open", &json!({"url":"https://docs.rs"})),
            (AccessKind::Network, "https://docs.rs".into())
        );
        assert_eq!(access_for("click", &json!({"ref":"ref_1"})).0, AccessKind::Computer);
        assert_eq!(access_for("fill", &json!({})).0, AccessKind::Computer);
        assert_eq!(access_for("execute_js", &json!({})).0, AccessKind::Computer);
        assert_eq!(access_for("open_external", &json!({"url":"https://x.test"})).0, AccessKind::Computer);
    }
}
