use crate::{Tool, ToolContext, ToolDefinition, ToolResult, ToolRuntime};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_git::GitRepository;
use zaalis_guard::AccessRequest;

#[derive(Debug, Clone, Copy)]
enum GitKind {
    Status,
    Diff,
    Branch,
    Worktree,
}

#[derive(Debug, Clone)]
pub struct GitTool {
    kind: GitKind,
}

impl GitTool {
    fn name(&self) -> &'static str {
        match self.kind {
            GitKind::Status => "git_status",
            GitKind::Diff => "git_diff",
            GitKind::Branch => "git_branch",
            GitKind::Worktree => "git_worktree",
        }
    }
}

pub fn register_git_tools(runtime: &mut ToolRuntime) -> Result<()> {
    for kind in [
        GitKind::Status,
        GitKind::Diff,
        GitKind::Branch,
        GitKind::Worktree,
    ] {
        runtime.register(GitTool { kind })?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiffInput {
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum BranchInput {
    List,
    Create {
        name: String,
        #[serde(default)]
        start_point: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum WorktreeInput {
    List,
    Create {
        name: String,
        branch: String,
        #[serde(default)]
        create_branch: bool,
    },
    Remove {
        name: String,
    },
}

#[async_trait]
impl Tool for GitTool {
    fn definition(&self) -> ToolDefinition {
        let (description, input_schema) = match self.kind {
            GitKind::Status => (
                "Retourner l'état Git structuré du workspace.",
                object(json!({}), &[]),
            ),
            GitKind::Diff => (
                "Retourner un diff Git borné, staged ou non.",
                object(
                    json!({"staged":{"type":"boolean"},"path":{"type":"string"}}),
                    &[],
                ),
            ),
            GitKind::Branch => (
                "Lister ou créer une branche Git sans changer la branche courante.",
                json!({
                    "type":"object",
                    "oneOf":[
                        object(json!({"action":{"const":"list"}}), &["action"]),
                        object(json!({"action":{"const":"create"},"name":{"type":"string"},"start_point":{"type":"string"}}), &["action","name"])
                    ]
                }),
            ),
            GitKind::Worktree => (
                "Lister, créer ou retirer un worktree géré et isolé pour un agent.",
                json!({
                    "type":"object",
                    "oneOf":[
                        object(json!({"action":{"const":"list"}}), &["action"]),
                        object(json!({"action":{"const":"create"},"name":{"type":"string"},"branch":{"type":"string"},"create_branch":{"type":"boolean"}}), &["action","name","branch"]),
                        object(json!({"action":{"const":"remove"},"name":{"type":"string"}}), &["action","name"])
                    ]
                }),
            ),
        };
        ToolDefinition {
            name: self.name().into(),
            description: description.into(),
            input_schema,
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        GitRepository::open(context.workspace.root())?;
        let (kind, target) = match self.kind {
            GitKind::Status => {
                let _: EmptyInput = serde_json::from_value(input.clone())?;
                (AccessKind::Read, "git status".to_owned())
            }
            GitKind::Diff => {
                let args: DiffInput = serde_json::from_value(input.clone())?;
                (
                    AccessKind::Read,
                    args.path.unwrap_or_else(|| "git diff".into()),
                )
            }
            GitKind::Branch => match serde_json::from_value(input.clone())? {
                BranchInput::List => (AccessKind::Read, "git branches".into()),
                BranchInput::Create { name, start_point } => (
                    AccessKind::Execute,
                    format!("git branch {name} {}", start_point.unwrap_or_default()),
                ),
            },
            GitKind::Worktree => match serde_json::from_value(input.clone())? {
                WorktreeInput::List => (AccessKind::Read, "git worktrees".into()),
                WorktreeInput::Create { name, branch, .. } => (
                    AccessKind::Execute,
                    format!("git worktree add {name} {branch}"),
                ),
                WorktreeInput::Remove { name } => {
                    (AccessKind::Execute, format!("git worktree remove {name}"))
                }
            },
        };
        Ok(AccessRequest::new(context.agent_id.clone(), self.name(), kind).with_target(target))
    }

    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        if cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        let repo = GitRepository::open(context.workspace.root())?;
        let (summary, value) = match self.kind {
            GitKind::Status => {
                let _: EmptyInput = serde_json::from_value(input)?;
                let status = repo.status()?;
                let summary = if status.clean {
                    "Workspace Git propre".into()
                } else {
                    format!("{} changement(s) Git", status.entries.len())
                };
                (summary, serde_json::to_value(status)?)
            }
            GitKind::Diff => {
                let args: DiffInput = serde_json::from_value(input)?;
                let diff = repo.diff(args.staged, args.path.as_deref())?;
                (
                    format!("Diff Git de {} octet(s)", diff.bytes),
                    serde_json::to_value(diff)?,
                )
            }
            GitKind::Branch => match serde_json::from_value(input)? {
                BranchInput::List => {
                    let branches = repo.branches()?;
                    (
                        format!("{} branche(s)", branches.len()),
                        serde_json::to_value(branches)?,
                    )
                }
                BranchInput::Create { name, start_point } => {
                    repo.create_branch(&name, start_point.as_deref())?;
                    (format!("Branche {name} créée"), json!({"name":name}))
                }
            },
            GitKind::Worktree => match serde_json::from_value(input)? {
                WorktreeInput::List => {
                    let worktrees = repo.worktrees()?;
                    (
                        format!("{} worktree(s)", worktrees.len()),
                        serde_json::to_value(worktrees)?,
                    )
                }
                WorktreeInput::Create {
                    name,
                    branch,
                    create_branch,
                } => {
                    let path = repo.add_worktree(&name, &branch, create_branch)?;
                    (
                        format!("Worktree {name} créé"),
                        json!({"name":name,"branch":branch,"path":path}),
                    )
                }
                WorktreeInput::Remove { name } => {
                    repo.remove_worktree(&name)?;
                    (format!("Worktree {name} retiré"), json!({"name":name}))
                }
            },
        };
        Ok(ToolResult { summary, value })
    }
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type":"object", "properties":properties, "required":required,
        "additionalProperties":false
    })
}
