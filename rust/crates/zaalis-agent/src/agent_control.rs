//! Controls for the direct parent's background agents. Tree ownership is checked
//! on every request, including cancellation; no cross-agent control is implied.
use crate::session::SessionInner;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Weak, time::Duration};
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, AgentId, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

#[derive(Debug)]
pub(crate) struct AgentControlTool {
    session: Weak<SessionInner>,
    action: &'static str,
}
impl AgentControlTool {
    pub fn new(session: Weak<SessionInner>, action: &'static str) -> Self {
        Self { session, action }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    agent_id: AgentId,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[async_trait]
impl Tool for AgentControlTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {name:self.action.into(),description:match self.action {
            "agent_wait"=>"Attendre au plus 30 secondes un sous-agent direct, puis renvoyer son état et son rapport disponible.",
            "agent_cancel"=>"Annuler un sous-agent direct et ses descendants.",
            _=>"Lire l'état et le rapport disponible d'un sous-agent direct.",
        }.into(),input_schema:json!({"type":"object","properties":{"agent_id":{"type":"string"},"timeout_ms":{"type":"integer","minimum":0,"maximum":30000}},"required":["agent_id"],"additionalProperties":false})}
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let _: Input = serde_json::from_value(input.clone())?;
        Ok(AccessRequest::new(
            context.agent_id.clone(),
            self.action,
            AccessKind::Session,
        ))
    }
    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let args: Input = serde_json::from_value(input)?;
        let session = self.session.upgrade().ok_or_else(ZaalisError::cancelled)?;
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(args.timeout_ms.unwrap_or(10000).min(30000));
        loop {
            let node = session
                .tree
                .lock()
                .await
                .get(&args.agent_id)
                .cloned()
                .ok_or_else(|| ZaalisError::not_found("sous-agent introuvable"))?;
            if node.parent_id.as_ref() != Some(&context.agent_id) {
                return Err(ZaalisError::denied(
                    "seul le parent direct contrôle ce sous-agent",
                ));
            }
            if self.action == "agent_cancel" {
                let ids = session.tree.lock().await.subtree(&args.agent_id);
                let tokens = session.agent_cancels.lock().await;
                for id in ids {
                    if let Some(token) = tokens.get(&id) {
                        token.cancel();
                    }
                }
            }
            if self.action != "agent_wait"
                || node.state.is_terminal()
                || tokio::time::Instant::now() >= deadline
            {
                let report = session.reports.lock().await.get(&args.agent_id).cloned();
                return Ok(ToolResult {
                    summary: format!("État du sous-agent {}", args.agent_id),
                    value: json!({"agent_id":args.agent_id,"state":node.state,"report":report,"cancel_requested":self.action=="agent_cancel"}),
                });
            }
            tokio::select! { _=cancel.cancelled()=>return Err(ZaalisError::cancelled()), _=tokio::time::sleep(Duration::from_millis(100))=>{} }
        }
    }
}
