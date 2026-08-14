use crate::session::SessionInner;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Weak};
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

#[derive(Debug)]
pub(crate) struct NativePlanTool {
    session: Weak<SessionInner>,
    enter: bool,
}

impl NativePlanTool {
    pub fn new(session: Weak<SessionInner>, enter: bool) -> Self {
        Self { session, enter }
    }
    fn name(&self) -> &'static str {
        if self.enter {
            "enter_plan_mode"
        } else {
            "exit_plan_mode"
        }
    }
}

#[async_trait]
impl Tool for NativePlanTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().into(),
            description: if self.enter {
                "Entrer en mode Plan lecture seule; le plan devra etre approuve avant toute implementation."
            } else {
                "Quitter explicitement le mode Plan."
            }.into(),
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        if input.as_object().is_none_or(|value| !value.is_empty()) {
            return Err(ZaalisError::invalid("aucun argument attendu"));
        }
        Ok(AccessRequest::new(
            context.agent_id.clone(),
            self.name(),
            AccessKind::Session,
        ))
    }

    async fn execute(
        &self,
        _input: Value,
        _context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        if cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        let session = self.session.upgrade().ok_or_else(ZaalisError::cancelled)?;
        if !self.enter && session.plan_mode.load(Ordering::SeqCst) {
            return Err(ZaalisError::denied(
                "la sortie du mode Plan exige une approbation explicite du client",
            ));
        }
        session.plan_mode.store(self.enter, Ordering::SeqCst);
        Ok(ToolResult {
            summary: if self.enter {
                "mode Plan active"
            } else {
                "mode Plan desactive"
            }
            .into(),
            value: json!({"plan_mode":self.enter}),
        })
    }
}
