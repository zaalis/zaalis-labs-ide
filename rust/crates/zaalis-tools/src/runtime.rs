use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use zaalis_core::{
    now_ms, AgentId, Decision, ErrorCode, GrantScope, PermissionAnswer, PermissionSet, RequestId,
    Result, ToolCallId, ZaalisError,
};
use zaalis_fs::Workspace;
use zaalis_guard::{AccessRequest, Guard};
use zaalis_protocol::ToolOutcome;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone)]
pub struct ToolContext {
    pub agent_id: AgentId,
    pub permissions: PermissionSet,
    pub workspace: Workspace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInvocation {
    pub call_id: ToolCallId,
    pub name: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub summary: String,
    pub value: Value,
}

#[async_trait]
pub trait Tool: Send + Sync + std::fmt::Debug {
    fn definition(&self) -> ToolDefinition;
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest>;
    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionPrompt {
    pub request_id: RequestId,
    pub call_id: ToolCallId,
    pub agent_id: AgentId,
    pub tool: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub risks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ToolDispatch {
    Complete {
        call_id: ToolCallId,
        outcome: ToolOutcome,
    },
    PermissionRequired(PermissionPrompt),
}

#[derive(Debug)]
struct PendingCall {
    call_id: ToolCallId,
    tool: Arc<dyn Tool>,
    input: Value,
    context: ToolContext,
    access: AccessRequest,
    cancel: CancellationToken,
}

#[derive(Debug, Default)]
pub struct ToolRuntime {
    tools: RwLock<HashMap<String, Arc<dyn Tool>>>,
    guard: Mutex<Guard>,
    pending: Mutex<HashMap<RequestId, PendingCall>>,
}

impl ToolRuntime {
    pub fn new(guard: Guard) -> Self {
        Self {
            guard: Mutex::new(guard),
            ..Self::default()
        }
    }

    pub fn register<T: Tool + 'static>(&self, tool: T) -> Result<()> {
        let definition = tool.definition();
        if definition.name.trim().is_empty() {
            return Err(ZaalisError::invalid("nom d'outil vide"));
        }
        let mut tools = self.tools.write().expect("tools lock poisoned");
        if tools.contains_key(&definition.name) {
            return Err(ZaalisError::invalid(format!(
                "outil déjà enregistré : {}",
                definition.name
            )));
        }
        tools.insert(definition.name, Arc::new(tool));
        Ok(())
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions: Vec<_> = self
            .tools
            .read()
            .expect("tools lock poisoned")
            .values()
            .map(|tool| tool.definition())
            .collect();
        definitions.sort_by(|left, right| left.name.cmp(&right.name));
        definitions
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("pending lock poisoned").len()
    }

    pub async fn invoke(
        &self,
        invocation: ToolInvocation,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> ToolDispatch {
        let tool = self
            .tools
            .read()
            .expect("tools lock poisoned")
            .get(&invocation.name)
            .cloned();
        let Some(tool) = tool else {
            return complete_error(
                invocation.call_id,
                ZaalisError::not_found(format!("outil inconnu : {}", invocation.name)),
                0,
            );
        };

        let access = match tool.access(&invocation.input, &context) {
            Ok(access) => access,
            Err(error) => return complete_error(invocation.call_id, error, 0),
        };
        let evaluation = self.guard.lock().expect("guard lock poisoned").evaluate(
            &access,
            &context.permissions,
            now_ms(),
        );
        let risks = evaluation.risk_descriptions();

        match evaluation.decision {
            Decision::Allow { .. } => {
                run_tool(tool, invocation.call_id, invocation.input, context, cancel).await
            }
            Decision::Deny { message, .. } => ToolDispatch::Complete {
                call_id: invocation.call_id,
                outcome: ToolOutcome::Denied {
                    summary: format!("{} refusé", invocation.name),
                    reason: message,
                },
            },
            Decision::Ask { summary, .. } => {
                let request_id = RequestId::new();
                let prompt = PermissionPrompt {
                    request_id: request_id.clone(),
                    call_id: invocation.call_id.clone(),
                    agent_id: context.agent_id.clone(),
                    tool: invocation.name,
                    summary,
                    target: access.target.clone(),
                    risks,
                };
                self.pending.lock().expect("pending lock poisoned").insert(
                    request_id,
                    PendingCall {
                        call_id: invocation.call_id,
                        tool,
                        input: invocation.input,
                        context,
                        access,
                        cancel,
                    },
                );
                ToolDispatch::PermissionRequired(prompt)
            }
        }
    }

    pub async fn resolve(
        &self,
        request_id: &RequestId,
        answer: PermissionAnswer,
    ) -> Result<ToolDispatch> {
        let pending = self
            .pending
            .lock()
            .expect("pending lock poisoned")
            .remove(request_id)
            .ok_or_else(|| ZaalisError::not_found(format!("demande inconnue : {request_id}")))?;

        match answer {
            PermissionAnswer::Deny => {
                self.guard
                    .lock()
                    .expect("guard lock poisoned")
                    .record_answer(&pending.access, false, GrantScope::Once);
                Ok(ToolDispatch::Complete {
                    call_id: pending.call_id,
                    outcome: ToolOutcome::Denied {
                        summary: format!("{} refusé", pending.access.tool),
                        reason: "Refusé par l'utilisateur.".into(),
                    },
                })
            }
            PermissionAnswer::Allow { scope } => {
                self.guard
                    .lock()
                    .expect("guard lock poisoned")
                    .record_answer(&pending.access, true, scope);
                Ok(run_tool(
                    pending.tool,
                    pending.call_id,
                    pending.input,
                    pending.context,
                    pending.cancel,
                )
                .await)
            }
        }
    }

    /// Remove a suspended call when its agent/session is cancelled. Unlike a
    /// denial this does not create a session-wide deny grant.
    pub fn cancel_pending(&self, request_id: &RequestId) -> Result<ToolDispatch> {
        let pending = self
            .pending
            .lock()
            .expect("pending lock poisoned")
            .remove(request_id)
            .ok_or_else(|| ZaalisError::not_found(format!("demande inconnue : {request_id}")))?;
        pending.cancel.cancel();
        Ok(ToolDispatch::Complete {
            call_id: pending.call_id,
            outcome: ToolOutcome::Cancelled {
                summary: "Outil interrompu".into(),
            },
        })
    }
}

async fn run_tool(
    tool: Arc<dyn Tool>,
    call_id: ToolCallId,
    input: Value,
    context: ToolContext,
    cancel: CancellationToken,
) -> ToolDispatch {
    if cancel.is_cancelled() {
        return ToolDispatch::Complete {
            call_id,
            outcome: ToolOutcome::Cancelled {
                summary: "Outil interrompu".into(),
            },
        };
    }
    let started = Instant::now();
    let result = tool.execute(input, context, cancel.clone()).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    if cancel.is_cancelled() {
        return ToolDispatch::Complete {
            call_id,
            outcome: ToolOutcome::Cancelled {
                summary: "Outil interrompu".into(),
            },
        };
    }
    match result {
        Ok(result) => ToolDispatch::Complete {
            call_id,
            outcome: ToolOutcome::Ok {
                summary: result.summary,
                result: result.value,
                duration_ms,
            },
        },
        Err(error) if error.code == ErrorCode::Cancelled => ToolDispatch::Complete {
            call_id,
            outcome: ToolOutcome::Cancelled {
                summary: error.message,
            },
        },
        Err(error) => complete_error(call_id, error, duration_ms),
    }
}

fn complete_error(call_id: ToolCallId, error: ZaalisError, duration_ms: u64) -> ToolDispatch {
    ToolDispatch::Complete {
        call_id,
        outcome: ToolOutcome::Error {
            summary: "Échec de l'outil".into(),
            code: error.code.as_str().into(),
            message: error.message,
            duration_ms,
        },
    }
}
