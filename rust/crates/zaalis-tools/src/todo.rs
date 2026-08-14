use crate::{Tool, ToolContext, ToolDefinition, ToolResult, ToolRuntime};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TodoItem {
    id: String,
    text: String,
    status: TodoStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    #[serde(default)]
    items: Option<Vec<TodoItem>>,
}

#[derive(Debug, Default)]
struct TodoTool {
    lists: Mutex<HashMap<String, Vec<TodoItem>>>,
}

pub fn register_todo_tool(runtime: &mut ToolRuntime) -> Result<()> {
    runtime.register(TodoTool::default())
}

#[async_trait]
impl Tool for TodoTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "todo".into(),
            description: "Lire ou remplacer la liste de travail structuree. Un seul item peut etre in_progress.".into(),
            input_schema: json!({"type":"object","properties":{"items":{"type":"array","maxItems":100,"items":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["id","text","status"],"additionalProperties":false}}},"additionalProperties":false}),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let parsed: Input = serde_json::from_value(input.clone())?;
        Ok(AccessRequest::new(
            context.agent_id.clone(),
            "todo",
            if parsed.items.is_some() {
                AccessKind::Session
            } else {
                AccessKind::Read
            },
        ))
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
        let parsed: Input = serde_json::from_value(input)?;
        let key = format!(
            "{}:{}",
            context.workspace.root().display(),
            context.agent_id
        );
        let mut lists = self
            .lists
            .lock()
            .map_err(|_| ZaalisError::internal("todo lock poisoned"))?;
        if let Some(items) = parsed.items {
            if items
                .iter()
                .filter(|item| item.status == TodoStatus::InProgress)
                .count()
                > 1
            {
                return Err(ZaalisError::invalid("un seul todo peut etre in_progress"));
            }
            if items
                .iter()
                .any(|item| item.id.trim().is_empty() || item.text.trim().is_empty())
            {
                return Err(ZaalisError::invalid("id et text sont requis"));
            }
            lists.insert(key.clone(), items);
        }
        let items = lists.get(&key).cloned().unwrap_or_default();
        Ok(ToolResult {
            summary: format!("{} todo(s)", items.len()),
            value: serde_json::to_value(items)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use zaalis_core::{AgentId, PermissionMode, PermissionSet};
    use zaalis_fs::Workspace;
    use zaalis_guard::Guard;

    #[tokio::test]
    async fn todo_enforces_one_active_item_and_round_trips() {
        let dir = TempDir::new().unwrap();
        let mut runtime = ToolRuntime::new(Guard::new());
        register_todo_tool(&mut runtime).unwrap();
        let context = ToolContext {
            agent_id: AgentId::from_raw("agt_todo"),
            permissions: PermissionSet::new(PermissionMode::Bypass),
            workspace: Workspace::open(dir.path()).unwrap(),
        };
        let dispatch = runtime
            .invoke(
                crate::ToolInvocation {
                    call_id: zaalis_core::ToolCallId::new(),
                    name: "todo".into(),
                    input: json!({"items":[{"id":"1","text":"test","status":"in_progress"}]}),
                },
                context,
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(dispatch, crate::ToolDispatch::Complete { .. }));
    }
}
