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
            // A batch of gestures with waits can take over a minute.
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

// The desktop the tool drives: macOS (Accessibility, Vision OCR, .app
// bundles, Command shortcuts) or Windows/Linux (UI Automation, OCR, Start menu).
#[cfg(target_os = "macos")]
const COMPUTER_DESCRIPTION: &str = "Contrôler le bureau macOS (souris, clavier, écran, presse-papiers) lorsque l'utilisateur l'a activé (autorisations Accessibilité et Enregistrement de l'écran). Commence par inspect : capture, contrôles de la fenêtre active (Accessibilité macOS) et texte lu par l'OCR Vision de macOS, chacun avec frame [x, y, largeur, hauteur] et center [x, y]. Toutes les coordonnées sont en pixels de la DERNIÈRE image reçue (conversion vers l'écran automatique) : pour cliquer un élément, vise son center.\n\
Regarder : observe (capture seule ; display_index choisit l'écran), inspect (target active_window, display ou region), zoom (x, y, width, height : agrandit une zone de la dernière image pour lire un petit texte ou viser un petit bouton ; les coordonnées suivantes restent dans cette image zoomée jusqu'à la prochaine capture), menus, cursor_position.\n\
Souris : move, click (button left/right/middle, modifiers ex. [\"cmd\"] pour un cmd+clic, [\"shift\"] pour étendre une sélection), double_click, triple_click (sélectionne une ligne/un paragraphe), drag (x,y vers to_x,to_y, duration), mouse_down / mouse_up (button, x,y facultatifs : glisser en plusieurs étapes, tracer, sélection longue), scroll (dy>0 descend, dy<0 monte, dx horizontal ; x,y facultatifs).\n\
Clavier : type (texte Unicode, n'importe quelle disposition), key (key + modifiers + repeat ; touches nommées : enter, tab, escape, backspace, delete (effacement arrière), forwarddelete, help, home, end, pageup, pagedown, flèches up/down/left/right, space, f1…f20, capslock, cmd, alt (option), ctrl, shift, fn, volumeup/volumedown/volumemute, mediaplaypause/medianext/mediaprev, numpad0…numpad9, ou un caractère ; ex. key \"s\" + [\"cmd\"] ; « win » équivaut à cmd), hold_key (key + modifiers maintenus pendant seconds, max 10).\n\
Presse-papiers : clipboard_read (texte copié), clipboard_write (text) — combine avec key v + [\"cmd\"] pour coller vite un long texte.\n\
Autres : wait (seconds), activate_app (path = chemin .app complet, bundle id ou nom affiché dans le Launchpad et le dossier Applications, par ex. « Blender » ; met au premier plan une fenêtre déjà ouverte), batch (actions = liste de 2 à 20 gestes exécutés à la suite en un appel, ex. clic puis type puis key enter ; s'arrête à la première erreur ; pas de capture dans un batch, fais inspect ensuite).\n\
Après une action, inspect/observe indique si l'écran a VRAIMENT changé (pixels, texte et contrôles comparés). L'IA n'écrit jamais dans un champ mot de passe ni un numéro de carte : demande à l'utilisateur. Pour le web, préfère l'outil browser ; pour une commande, run ; pour un fichier, read/write.";
#[cfg(not(target_os = "macos"))]
const COMPUTER_DESCRIPTION: &str = "Contrôler le bureau (souris, clavier, écran, presse-papiers) lorsque l'utilisateur l'a activé. Commence par inspect : capture, contrôles de la fenêtre active (UI Automation) et texte lu par l'OCR, chacun avec frame [x, y, largeur, hauteur] et center [x, y]. Toutes les coordonnées sont en pixels de la DERNIÈRE image reçue (conversion vers l'écran automatique) : pour cliquer un élément, vise son center.\n\
Regarder : observe (capture seule ; display_index choisit l'écran), inspect (target active_window, display ou region), zoom (x, y, width, height : agrandit une zone de la dernière image pour lire un petit texte ou viser un petit bouton ; les coordonnées suivantes restent dans cette image zoomée jusqu'à la prochaine capture), menus, cursor_position.\n\
Souris : move, click (button left/right/middle, modifiers ex. [\"ctrl\"] pour un ctrl+clic, [\"shift\"] pour étendre une sélection), double_click, triple_click (sélectionne une ligne/un paragraphe), drag (x,y vers to_x,to_y, duration), mouse_down / mouse_up (button, x,y facultatifs : glisser en plusieurs étapes, tracer, sélection longue), scroll (dy>0 descend, dy<0 monte, dx horizontal ; x,y facultatifs).\n\
Clavier : type (texte Unicode, n'importe quelle disposition), key (key + modifiers + repeat ; touches nommées : enter, tab, escape, backspace, delete, insert, home, end, pageup, pagedown, flèches up/down/left/right, space, f1…f24, printscreen, pause, capslock, numlock, scrolllock, menu, win, volumeup/volumedown/volumemute, mediaplaypause/medianext/mediaprev/mediastop, numpad0…numpad9, ou un caractère ; ex. key \"s\" + [\"ctrl\"]), hold_key (key + modifiers maintenus pendant seconds, max 10).\n\
Presse-papiers : clipboard_read (texte copié), clipboard_write (text) — combine avec key v + [\"ctrl\"] pour coller vite un long texte.\n\
Autres : wait (seconds), activate_app (path = chemin .exe complet ou nom affiché dans le menu Démarrer, par ex. « Blender » ; met au premier plan une fenêtre déjà ouverte), batch (actions = liste de 2 à 20 gestes exécutés à la suite en un appel, ex. clic puis type puis key enter ; s'arrête à la première erreur ; pas de capture dans un batch, fais inspect ensuite).\n\
Après une action, inspect/observe indique si l'écran a VRAIMENT changé (pixels, texte et contrôles comparés). L'IA n'écrit jamais dans un champ mot de passe ni un numéro de carte : demande à l'utilisateur. Pour le web, préfère l'outil browser ; pour une commande, run ; pour un fichier, read/write.";

const COMPUTER_ACTIONS: [&str; 21] = [
    "observe", "inspect", "zoom", "menus", "cursor_position", "move", "click", "double_click",
    "triple_click", "drag", "mouse_down", "mouse_up", "scroll", "type", "key", "hold_key",
    "clipboard_read", "clipboard_write", "wait", "activate_app", "batch",
];

fn computer_schema() -> Value {
    let step_actions: Vec<&str> = COMPUTER_ACTIONS
        .iter()
        .copied()
        .filter(|name| !matches!(*name, "batch" | "observe" | "inspect" | "zoom"))
        .collect();
    let mut properties = json!({
        "action":{"type":"string","enum":COMPUTER_ACTIONS},
        "target":{"type":"string","enum":["active_window","display","region"]},
        "display_index":{"type":"integer","minimum":0},
        "x":{"type":"number"},"y":{"type":"number"},"to_x":{"type":"number"},"to_y":{"type":"number"},
        "width":{"type":"number"},"height":{"type":"number"},"dx":{"type":"number"},"dy":{"type":"number"},
        "button":{"type":"string","enum":["left","right","middle"]},
        "text":{"type":"string"},"key":{"type":"string"},
        "modifiers":{"type":"array","items":{"type":"string","enum":["ctrl","alt","shift","win","cmd"]}},
        "repeat":{"type":"integer","minimum":1,"maximum":30},
        "seconds":{"type":"number","minimum":0.1,"maximum":10},
        "duration":{"type":"number"},"path":{"type":"string"},
        "include_image":{"type":"boolean"},"include_ui":{"type":"boolean"},"include_ocr":{"type":"boolean"},
        "max_elements":{"type":"integer"},"max_dimension":{"type":"integer"}
    });
    let mut step = properties.clone();
    step["action"] = json!({"type":"string","enum":step_actions});
    for key in ["target", "display_index", "include_image", "include_ui", "include_ocr", "max_elements", "max_dimension"] {
        step.as_object_mut().expect("object").remove(key);
    }
    properties["actions"] = json!({
        "type":"array","minItems":1,"maxItems":20,
        "description":"batch : gestes à enchaîner, chacun avec ses propres champs (action, x, y, text, key…)",
        "items":{"type":"object","properties":step,"required":["action"],"additionalProperties":false}
    });
    json!({"type":"object","properties":properties,"required":["action"],"additionalProperties":false})
}

#[async_trait]
impl Tool for ComputerTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "computer".into(),
            description: COMPUTER_DESCRIPTION.into(),
            input_schema: computer_schema(),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ZaalisError::invalid("action computer requise"))?;
        // Keyboard input and the clipboard can carry secrets: the confirming
        // modes ask, the autonomous ones go straight through.
        let typing = |name: &str| matches!(name, "type" | "key" | "hold_key" | "clipboard_write" | "clipboard_read");
        let sensitive = typing(action)
            || (action == "batch"
                && input
                    .get("actions")
                    .and_then(Value::as_array)
                    .is_some_and(|steps| {
                        steps.iter().any(|step| step.get("action").and_then(Value::as_str).is_some_and(typing))
                    }));
        Ok(
            AccessRequest::new(context.agent_id.clone(), "computer", AccessKind::Computer)
                .with_target(action)
                .sensitive(sensitive),
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
        let status = response.status();
        if !status.is_success() {
            // The bridge explains its refusal in JSON: pass that on, so the
            // model can react to the cause instead of a bare status code.
            let detail = response
                .json::<Value>()
                .await
                .ok()
                .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            let detail: String = detail.chars().take(600).collect();
            return Err(ZaalisError::io(if detail.is_empty() {
                format!("computer HTTP {status}")
            } else {
                format!("computer HTTP {status} : {detail}")
            }));
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

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::{AgentId, PermissionMode, PermissionSet};

    fn tool() -> ComputerTool {
        ComputerTool {
            endpoint: Url::parse("http://127.0.0.1:1/api/internal/rust-computer").unwrap(),
            token: SecretValue::new("x".repeat(32)),
            client: reqwest::Client::new(),
        }
    }
    fn context() -> ToolContext {
        ToolContext {
            agent_id: AgentId::new(),
            permissions: PermissionSet::new(PermissionMode::Auto),
            workspace: zaalis_fs::Workspace::open(std::env::temp_dir()).unwrap(),
        }
    }

    #[test]
    fn the_schema_offers_every_gesture_and_a_typed_batch() {
        let schema = tool().definition().input_schema;
        let actions: Vec<&str> = schema["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for gesture in ["triple_click", "mouse_down", "mouse_up", "hold_key", "cursor_position", "clipboard_read", "clipboard_write", "zoom", "batch"] {
            assert!(actions.contains(&gesture), "{gesture}");
        }
        let step = &schema["properties"]["actions"]["items"];
        let step_actions = step["properties"]["action"]["enum"].as_array().unwrap();
        assert!(step_actions.iter().any(|value| value == "click"));
        assert!(!step_actions.iter().any(|value| value == "batch" || value == "inspect"));
        assert!(step["properties"].get("target").is_none());
    }

    #[test]
    fn keyboard_and_clipboard_steps_are_marked_sensitive() {
        let access = |input: Value| tool().access(&input, &context()).unwrap();
        assert!(access(json!({"action":"clipboard_read"})).sensitive);
        assert!(!access(json!({"action":"triple_click","x":1,"y":1})).sensitive);
        let batch = access(json!({"action":"batch","actions":[{"action":"click","x":1,"y":1},{"action":"type","text":"a"}]}));
        assert!(batch.sensitive);
        assert_eq!(batch.target.as_deref(), Some("batch"));
        assert!(!access(json!({"action":"batch","actions":[{"action":"move","x":1,"y":1}]})).sensitive);
    }
}
