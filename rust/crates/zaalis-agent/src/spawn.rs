use crate::runner::run_agent;
use crate::session::SessionInner;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;
use zaalis_core::{
    now_ms, AccessKind, AgentNode, AgentState, Budget, ModelBinding, PermissionSet, Result,
    RoleSpec, Workspace as AgentWorkspace, ZaalisError,
};
use zaalis_fs::{read_text, Transaction, Workspace, ALWAYS_SKIPPED_DIRS};
use zaalis_git::GitRepository;
use zaalis_guard::AccessRequest;
use zaalis_providers::Message;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

const MAX_SNAPSHOT_FILES: usize = 20_000;
const MAX_SNAPSHOT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct NativeSpawnTool {
    session: Weak<SessionInner>,
}

#[derive(Debug)]
pub(crate) struct NativeMergeTool {
    session: Weak<SessionInner>,
}

impl NativeMergeTool {
    pub fn new(session: Weak<SessionInner>) -> Self {
        Self { session }
    }
}

impl NativeSpawnTool {
    pub fn new(session: Weak<SessionInner>) -> Self {
        Self { session }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnInput {
    objective: String,
    #[serde(default)]
    role: Option<RoleSpec>,
    #[serde(default)]
    model: Option<ModelBinding>,
    #[serde(default)]
    permissions: Option<PermissionSet>,
    #[serde(default)]
    budget: Option<Budget>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MergeInput {
    agent_id: zaalis_core::AgentId,
}

#[async_trait]
impl Tool for NativeSpawnTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "spawn_agent".into(),
            description: "Créer un sous-agent natif, strictement borné par le parent, et attendre son rapport.".into(),
            input_schema: json!({
                "type":"object",
                "properties":{
                    "objective":{"type":"string"},
                    "role":{"type":"object","properties":{
                        "name":{"type":"string"},"label":{"type":"string"},
                        "instructions":{"type":"string"},"mutating":{"type":"boolean"}
                    },"required":["name","label"],"additionalProperties":false},
                    "model":{"type":"object"},
                    "permissions":{"type":"object"},
                    "budget":{"type":"object"}
                },
                "required":["objective"],
                "additionalProperties":false
            }),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let args: SpawnInput = serde_json::from_value(input.clone())?;
        if args.objective.trim().is_empty() {
            return Err(ZaalisError::invalid("objectif du sous-agent vide"));
        }
        Ok(
            AccessRequest::new(context.agent_id.clone(), "spawn_agent", AccessKind::Spawn)
                .with_target(args.objective),
        )
    }

    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let args: SpawnInput = serde_json::from_value(input)?;
        let session = self.session.upgrade().ok_or_else(ZaalisError::cancelled)?;
        if cancel.is_cancelled() || session.cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        let parent = session
            .tree
            .lock()
            .await
            .get(&context.agent_id)
            .cloned()
            .ok_or_else(|| ZaalisError::not_found("agent parent introuvable"))?;
        if !parent.can_spawn() {
            return Err(ZaalisError::new(
                zaalis_core::ErrorCode::BudgetExceeded,
                "profondeur maximale des sous-agents atteinte",
            ));
        }
        let role = args.role.unwrap_or_else(|| {
            RoleSpec::new("subagent")
                .with_label("Sous-agent")
                .with_instructions("Rends un rapport concis et vérifiable au parent.")
        });
        let model = args.model.unwrap_or_else(|| parent.model.inherited());
        let permissions = args
            .permissions
            .unwrap_or_else(|| parent.permissions.clone());
        let budget = args
            .budget
            .unwrap_or_else(|| Budget::default_child(&parent.budget));
        let mut child = AgentNode::new(
            session.config.session_id.clone(),
            role,
            model,
            permissions,
            now_ms(),
        )
        .with_budget(budget)
        .with_objective(args.objective.clone());
        child.workspace = Some(isolate_workspace(&session.config.workspace, &child)?);
        let child_id = {
            session
                .tree
                .lock()
                .await
                .insert_child(&parent.id, child)
                .map_err(|error| ZaalisError::invalid(error.to_string()))?
        };
        let child = session
            .tree
            .lock()
            .await
            .get(&child_id)
            .cloned()
            .ok_or_else(|| ZaalisError::internal("sous-agent inséré introuvable"))?;
        session.events.emit(zaalis_protocol::Event::AgentSpawned {
            agent: Box::new(child.clone()),
        });
        session.set_state(&child_id, AgentState::Running).await;
        let history = vec![Message::user(args.objective)];
        let child_cancel = cancel.child_token();
        session
            .agent_cancels
            .lock()
            .await
            .insert(child_id.clone(), child_cancel.clone());
        let run = run_agent(Arc::clone(&session), child.clone(), history, child_cancel).await;
        session.agent_cancels.lock().await.remove(&child_id);
        let result_value = match &run {
            Ok(run) => json!({
                "agent_id":child_id,
                "workspace":child.workspace,
                "report":run.report
            }),
            Err(error) => json!({
                "agent_id":child_id,
                "workspace":child.workspace,
                "error":{"code":error.code.as_str(),"message":error.message}
            }),
        };
        let summary = match &run {
            Ok(run) => format!("Sous-agent {} terminé : {}", child_id, run.report.summary),
            Err(error) => format!("Sous-agent {} en échec : {}", child_id, error.message),
        };
        session.finish_agent(&child_id, run).await;
        Ok(ToolResult {
            summary,
            value: result_value,
        })
    }
}

#[async_trait]
impl Tool for NativeMergeTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "merge_agent".into(),
            description: "Intégrer atomiquement dans le workspace parent les fichiers validés d'un sous-agent isolé.".into(),
            input_schema: json!({
                "type":"object",
                "properties":{"agent_id":{"type":"string","pattern":"^agt_"}},
                "required":["agent_id"],
                "additionalProperties":false
            }),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let args: MergeInput = serde_json::from_value(input.clone())?;
        Ok(
            AccessRequest::new(context.agent_id.clone(), "merge_agent", AccessKind::Edit)
                .with_target(format!("résultats de {}", args.agent_id))
                // The sync access phase cannot lock the async agent tree to inspect
                // file names. Conservatively require an explicit decision for every
                // isolated merge, including bypass mode.
                .sensitive(true),
        )
    }

    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let args: MergeInput = serde_json::from_value(input)?;
        let session = self.session.upgrade().ok_or_else(ZaalisError::cancelled)?;
        let (child, report) = child_report(&session, &context.agent_id, &args.agent_id).await?;
        let source = match &child.workspace {
            Some(AgentWorkspace::Worktree { path, .. })
            | Some(AgentWorkspace::Snapshot { path }) => Workspace::open(path)?,
            _ => {
                return Err(ZaalisError::invalid(
                    "le sous-agent n'a pas de workspace isolé à fusionner",
                ))
            }
        };
        let mut transaction = Transaction::new();
        for path in &report.files_changed {
            if cancel.is_cancelled() {
                return Err(ZaalisError::cancelled());
            }
            let source_path = source.resolve(path)?;
            if !source_path.is_file() {
                return Err(ZaalisError::not_found(format!(
                    "résultat du sous-agent absent : {path}"
                )));
            }
            let text = read_text(source_path.absolute(), zaalis_fs::edit::MAX_WRITE_BYTES)?;
            let target = context.workspace.resolve(path)?;
            let mut content = text.content;
            if text.trailing_newline {
                content.push('\n');
            }
            transaction.write(&target, &content)?;
        }
        let edits = transaction.commit()?;
        for edit in &edits {
            session.events.emit(zaalis_protocol::Event::DiffAvailable {
                agent_id: context.agent_id.clone(),
                path: edit.path.clone(),
                diff: edit.diff.clone(),
                added: edit.added,
                removed: edit.removed,
            });
        }
        Ok(ToolResult {
            summary: format!(
                "{} fichier(s) du sous-agent {} intégré(s)",
                edits.len(),
                args.agent_id
            ),
            value: serde_json::to_value(edits)?,
        })
    }
}

async fn child_report(
    session: &SessionInner,
    parent_id: &zaalis_core::AgentId,
    child_id: &zaalis_core::AgentId,
) -> Result<(AgentNode, zaalis_protocol::AgentReport)> {
    let child = session
        .tree
        .lock()
        .await
        .get(child_id)
        .cloned()
        .ok_or_else(|| ZaalisError::not_found("sous-agent introuvable"))?;
    if child.parent_id.as_ref() != Some(parent_id) {
        return Err(ZaalisError::denied(
            "seul le parent direct peut intégrer ce sous-agent",
        ));
    }
    let report = session
        .reports
        .lock()
        .await
        .get(child_id)
        .cloned()
        .ok_or_else(|| ZaalisError::invalid("rapport du sous-agent indisponible"))?;
    Ok((child, report))
}

fn isolate_workspace(workspace: &Workspace, child: &AgentNode) -> Result<AgentWorkspace> {
    if !child.role.mutating {
        return Ok(AgentWorkspace::Direct);
    }
    let suffix = child
        .id
        .as_str()
        .strip_prefix("agt_")
        .unwrap_or(child.id.as_str());
    let short = &suffix[..suffix.len().min(12)];
    if let Ok(repository) = GitRepository::open(workspace.root()) {
        let name = format!("agent-{short}");
        let branch = format!("zaalis/agent/{short}");
        let path = repository.add_worktree(&name, &branch, true)?;
        return Ok(AgentWorkspace::Worktree {
            path: path.to_string_lossy().into_owned(),
            branch,
        });
    }
    let repo_name = workspace
        .root()
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");
    let parent = workspace.root().parent().unwrap_or(workspace.root());
    let destination = parent
        .join(".zaalis-snapshots")
        .join(repo_name)
        .join(format!("agent-{short}"));
    copy_snapshot(workspace.root(), &destination)?;
    Ok(AgentWorkspace::Snapshot {
        path: destination.to_string_lossy().into_owned(),
    })
}

fn copy_snapshot(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(ZaalisError::invalid("snapshot d'agent déjà présent"));
    }
    std::fs::create_dir_all(destination)?;
    let mut files = 0_usize;
    let mut bytes = 0_u64;
    let result = copy_directory(source, destination, &mut files, &mut bytes);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(destination);
    }
    result
}

fn copy_directory(
    source: &Path,
    destination: &Path,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if ALWAYS_SKIPPED_DIRS.contains(&name_text.as_ref()) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let target = destination.join(&name);
        if file_type.is_dir() {
            std::fs::create_dir_all(&target)?;
            copy_directory(&entry.path(), &target, files, bytes)?;
        } else if file_type.is_file() {
            *files = files.saturating_add(1);
            *bytes = bytes.saturating_add(entry.metadata()?.len());
            if *files > MAX_SNAPSHOT_FILES || *bytes > MAX_SNAPSHOT_BYTES {
                return Err(ZaalisError::invalid(
                    "snapshot d'agent supérieur aux limites (20 000 fichiers / 512 Mio)",
                ));
            }
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;
    use zaalis_core::{PermissionMode, ProviderId, SessionId};

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn mutating_child_uses_a_managed_git_worktree() {
        let outer = TempDir::new().expect("tempdir");
        let root = outer.path().join("project");
        std::fs::create_dir(&root).expect("project");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "test@zaalis.local"]);
        git(&root, &["config", "user.name", "Zaalis Test"]);
        std::fs::write(root.join("tracked.txt"), "base\n").expect("fixture");
        git(&root, &["add", "tracked.txt"]);
        git(&root, &["commit", "-qm", "initial"]);
        let workspace = Workspace::open(&root).expect("workspace");
        let child = AgentNode::new(
            SessionId::new(),
            RoleSpec::new("implement").mutating(),
            ModelBinding::new(ProviderId::Mistral, None),
            PermissionSet::new(PermissionMode::Supervised),
            now_ms(),
        );
        let isolated = isolate_workspace(&workspace, &child).expect("isolate");
        let AgentWorkspace::Worktree { path, branch } = isolated else {
            panic!("expected worktree");
        };
        assert!(Path::new(&path).join("tracked.txt").exists());
        assert!(branch.starts_with("zaalis/agent/"));
        assert!(path.contains(".zaalis-worktrees"));
    }
}
