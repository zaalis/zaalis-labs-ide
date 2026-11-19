//! Progressive discovery over the live registry. Invocation aliases are expanded
//! before guard evaluation so a dispatcher can never weaken target permissions.
use crate::{ToolDefinition, ToolInvocation, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};
use zaalis_core::{Result, ZaalisError};

pub const NAMES: [&str; 3] = ["tool_search", "tool_describe", "tool_call"];

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition { name: NAMES[0].into(), description: "Chercher les outils réellement actifs par nom ou description.".into(), input_schema: json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":30}},"additionalProperties":false}) },
        ToolDefinition { name: NAMES[1].into(), description: "Lire la description et le schéma exact d'un outil actif.".into(), input_schema: json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}) },
        ToolDefinition { name: NAMES[2].into(), description: "Appeler un outil découvert avec ses arguments typés; les mêmes permissions et validations s'appliquent.".into(), input_schema: json!({"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object"}},"required":["name","arguments"],"additionalProperties":false}) },
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    name: String,
    arguments: Value,
}

pub fn expand(mut invocation: ToolInvocation) -> Result<ToolInvocation> {
    if invocation.name == "tool_call" {
        let call: Call = serde_json::from_value(invocation.input)?;
        if NAMES.contains(&call.name.as_str()) || !call.arguments.is_object() {
            return Err(ZaalisError::invalid(
                "appel récursif ou arguments non objet interdits",
            ));
        }
        invocation.name = call.name;
        invocation.input = call.arguments;
    }
    Ok(invocation)
}

pub fn query(name: &str, input: Value, definitions: Vec<ToolDefinition>) -> Result<ToolResult> {
    let value = if name == "tool_search" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Search {
            #[serde(default)]
            query: String,
            limit: Option<usize>,
        }
        let args: Search = serde_json::from_value(input)?;
        let terms: Vec<_> = args
            .query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        let matches: Vec<_> = definitions
            .into_iter()
            .filter(|definition| {
                let text = format!("{} {}", definition.name, definition.description).to_lowercase();
                terms.iter().all(|term| text.contains(term))
            })
            .take(args.limit.unwrap_or(10).clamp(1, 30))
            .map(|definition| json!({"name":definition.name,"description":definition.description}))
            .collect();
        json!({"tools":matches})
    } else {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Describe {
            name: String,
        }
        let args: Describe = serde_json::from_value(input)?;
        serde_json::to_value(
            definitions
                .into_iter()
                .find(|definition| definition.name == args.name)
                .ok_or_else(|| ZaalisError::not_found(format!("outil inconnu : {}", args.name)))?,
        )?
    };
    Ok(ToolResult {
        summary: "Catalogue des outils actifs".into(),
        value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::ToolCallId;
    #[test]
    fn recursive_dispatch_is_rejected() {
        for name in NAMES {
            assert!(expand(ToolInvocation {
                call_id: ToolCallId::new(),
                name: "tool_call".into(),
                input: json!({"name":name,"arguments":{}})
            })
            .is_err());
        }
    }
}
