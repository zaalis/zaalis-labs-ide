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
            description: "Contrôler le bureau Windows lorsque l'utilisateur l'a explicitement activé. Commence par inspect : capture, contrôles de la fenêtre active (UI Automation) et texte lu par l'OCR de Windows, chacun avec frame [x, y, largeur, hauteur] et center [x, y]. Toutes les coordonnées sont en pixels de la DERNIÈRE image reçue (la conversion vers l'écran est automatique) : pour cliquer un élément, vise son center. Actions : observe (capture seule), inspect (target active_window, display ou region ; display_index choisit l'écran), menus, move, click (button left/right/middle, modifiers), double_click, drag (x,y vers to_x,to_y), scroll (dy>0 descend, dy<0 monte, dx horizontal ; x,y facultatifs), type (texte Unicode, presse-papiers intact), key (key + modifiers, repeat), wait (seconds), activate_app (path = chemin .exe complet ou nom affiché dans le menu Démarrer, par ex. « Blender » ; met au premier plan une fenêtre déjà ouverte). Après une action, inspect indique si l'écran a changé. Jamais de mot de passe ni de validation irréversible : ces actions sont bloquées. Pour le web, utilise l'outil browser (navigateur intégré) ; ne pilote un navigateur externe ouvert sur le PC que si l'utilisateur le demande explicitement.".into(),
            input_schema: json!({"type":"object","properties":{"action":{"type":"string","enum":["observe","inspect","menus","move","click","double_click","drag","scroll","type","key","wait","activate_app"]},"target":{"type":"string","enum":["active_window","display","region"]},"display_index":{"type":"integer","minimum":0},"x":{"type":"number"},"y":{"type":"number"},"to_x":{"type":"number"},"to_y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"dx":{"type":"number"},"dy":{"type":"number"},"button":{"type":"string","enum":["left","right","middle"]},"text":{"type":"string"},"key":{"type":"string"},"modifiers":{"type":"array","items":{"type":"string"}},"repeat":{"type":"integer","minimum":1,"maximum":30},"seconds":{"type":"number","minimum":0.1,"maximum":10},"duration":{"type":"number"},"path":{"type":"string"},"include_image":{"type":"boolean"},"include_ui":{"type":"boolean"},"include_ocr":{"type":"boolean"},"max_elements":{"type":"integer"},"max_dimension":{"type":"integer"}},"required":["action"],"additionalProperties":false}),
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
