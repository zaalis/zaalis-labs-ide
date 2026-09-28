use crate::{Tool, ToolContext, ToolDefinition, ToolResult, ToolRuntime};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use zaalis_checkpoint::CheckpointStore;
use zaalis_core::{AccessKind, CheckpointId, Result, ZaalisError};
use zaalis_guard::AccessRequest;

#[derive(Debug, Clone, Copy)]
enum CheckpointKind {
    Create,
    List,
    Restore,
    Delete,
}

#[derive(Debug, Clone)]
pub struct CheckpointTool {
    kind: CheckpointKind,
    store: Arc<CheckpointStore>,
}

impl CheckpointTool {
    fn name(&self) -> &'static str {
        match self.kind {
            CheckpointKind::Create => "checkpoint_create",
            CheckpointKind::List => "checkpoint_list",
            CheckpointKind::Restore => "checkpoint_restore",
            CheckpointKind::Delete => "checkpoint_delete",
        }
    }

    fn verify_workspace(&self, context: &ToolContext) -> Result<()> {
        if self.store.workspace_root() != context.workspace.root() {
            return Err(ZaalisError::outside_workspace(
                "le stockage de checkpoints appartient à un autre workspace",
            ));
        }
        Ok(())
    }
}

pub fn register_checkpoint_tools(runtime: &mut ToolRuntime, store: CheckpointStore) -> Result<()> {
    let store = Arc::new(store);
    for kind in [
        CheckpointKind::Create,
        CheckpointKind::List,
        CheckpointKind::Restore,
        CheckpointKind::Delete,
    ] {
        runtime.register(CheckpointTool {
            kind,
            store: Arc::clone(&store),
        })?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateInput {
    paths: Vec<String>,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdInput {
    checkpoint_id: CheckpointId,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}

#[async_trait]
impl Tool for CheckpointTool {
    fn definition(&self) -> ToolDefinition {
        let (description, input_schema) = match self.kind {
            CheckpointKind::Create => (
                "Créer hors du dépôt un snapshot vérifié des chemins nommés.",
                object(
                    json!({"paths":{"type":"array","minItems":1,"items":{"type":"string"}},"label":{"type":"string"}}),
                    &["paths"],
                ),
            ),
            CheckpointKind::List => (
                "Lister les checkpoints du workspace.",
                object(json!({}), &[]),
            ),
            CheckpointKind::Restore => (
                "Restaurer atomiquement un checkpoint après vérification SHA-256.",
                id_schema(),
            ),
            CheckpointKind::Delete => (
                "Supprimer un checkpoint externe devenu inutile.",
                id_schema(),
            ),
        };
        ToolDefinition {
            name: self.name().into(),
            description: description.into(),
            input_schema,
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        self.verify_workspace(context)?;
        let (kind, target, sensitive) = match self.kind {
            CheckpointKind::Create => {
                let args: CreateInput = serde_json::from_value(input.clone())?;
                if args.paths.is_empty() {
                    return Err(ZaalisError::invalid("paths ne peut pas être vide"));
                }
                let (paths, sensitive) = resolve_paths(context, &args.paths)?;
                (AccessKind::Read, paths.join(", "), sensitive)
            }
            CheckpointKind::List => {
                let _: EmptyInput = serde_json::from_value(input.clone())?;
                (AccessKind::Session, "checkpoints".into(), false)
            }
            CheckpointKind::Restore => {
                let args: IdInput = serde_json::from_value(input.clone())?;
                let manifest = self.store.inspect(&args.checkpoint_id)?;
                let paths: Vec<_> = manifest
                    .files
                    .iter()
                    .map(|file| file.path.clone())
                    .collect();
                let (paths, sensitive) = resolve_paths(context, &paths)?;
                (AccessKind::Write, paths.join(", "), sensitive)
            }
            CheckpointKind::Delete => {
                let args: IdInput = serde_json::from_value(input.clone())?;
                self.store.inspect(&args.checkpoint_id)?;
                (AccessKind::Delete, args.checkpoint_id.to_string(), false)
            }
        };
        Ok(
            AccessRequest::new(context.agent_id.clone(), self.name(), kind)
                .with_target(target)
                .sensitive(sensitive),
        )
    }

    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        self.verify_workspace(&context)?;
        if cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        let (summary, value) = match self.kind {
            CheckpointKind::Create => {
                let args: CreateInput = serde_json::from_value(input)?;
                let manifest = self.store.create(&args.paths, args.label)?;
                (
                    format!("Checkpoint {} créé", manifest.id),
                    serde_json::to_value(manifest)?,
                )
            }
            CheckpointKind::List => {
                let _: EmptyInput = serde_json::from_value(input)?;
                let checkpoints = self.store.list()?;
                (
                    format!("{} checkpoint(s)", checkpoints.len()),
                    serde_json::to_value(checkpoints)?,
                )
            }
            CheckpointKind::Restore => {
                let args: IdInput = serde_json::from_value(input)?;
                let report = self.store.restore(&args.checkpoint_id)?;
                (
                    format!("Checkpoint {} restauré", args.checkpoint_id),
                    serde_json::to_value(report)?,
                )
            }
            CheckpointKind::Delete => {
                let args: IdInput = serde_json::from_value(input)?;
                self.store.delete(&args.checkpoint_id)?;
                (
                    format!("Checkpoint {} supprimé", args.checkpoint_id),
                    json!({"checkpoint_id":args.checkpoint_id}),
                )
            }
        };
        Ok(ToolResult { summary, value })
    }
}

fn resolve_paths(context: &ToolContext, inputs: &[String]) -> Result<(Vec<String>, bool)> {
    let mut paths = Vec::with_capacity(inputs.len());
    let mut sensitive = false;
    for input in inputs {
        let path = context.workspace.resolve(input)?;
        sensitive |= path.is_sensitive();
        paths.push(path.relative().to_owned());
    }
    Ok((paths, sensitive))
}

fn id_schema() -> Value {
    object(
        json!({"checkpoint_id":{"type":"string","pattern":"^ckpt_"}}),
        &["checkpoint_id"],
    )
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
