//! Typed, cancellable user questions shared by CLI and IDE.
use crate::session::SessionInner;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Weak};
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, RequestId, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_protocol::{ClarificationQuestion, Event};
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

#[derive(Debug)]
pub(crate) struct ClarifyTool(pub Weak<SessionInner>);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    questions: Vec<ClarificationQuestion>,
}

fn parse(input: Value) -> Result<Input> {
    let args: Input = serde_json::from_value(input)?;
    if !(1..=3).contains(&args.questions.len()) {
        return Err(ZaalisError::invalid("1 à 3 questions attendues"));
    }
    let mut ids = HashSet::new();
    for question in &args.questions {
        if question.id.trim().is_empty()
            || question.prompt.trim().is_empty()
            || question.prompt.len() > 2000
            || question.id.len() > 80
            || !ids.insert(question.id.clone())
            || question.options.len() > 6
            || (!question.allow_free_text && question.options.is_empty())
            || question.options.iter().any(|option| {
                option.label.trim().is_empty()
                    || option.label.len() > 200
                    || option.description.len() > 1000
            })
        {
            return Err(ZaalisError::invalid(
                "question invalide, dupliquée ou trop longue",
            ));
        }
    }
    Ok(args)
}

#[async_trait]
impl Tool for ClarifyTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition { name:"request_user_input".into(),description:"Demander 1 à 3 précisions structurées à l'utilisateur puis attendre sa réponse. Ne pas utiliser pour contourner une permission.".into(),input_schema:json!({"type":"object","properties":{"questions":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","properties":{"id":{"type":"string"},"prompt":{"type":"string"},"options":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label"],"additionalProperties":false}},"allow_free_text":{"type":"boolean"}},"required":["id","prompt"],"additionalProperties":false}}},"required":["questions"],"additionalProperties":false}) }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        parse(input.clone())?;
        Ok(AccessRequest::new(
            context.agent_id.clone(),
            "request_user_input",
            AccessKind::Session,
        ))
    }
    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let args = parse(input)?;
        let session = self.0.upgrade().ok_or_else(ZaalisError::cancelled)?;
        let id = RequestId::new();
        let receiver = session
            .interactions
            .wait_clarification(id.clone(), args.questions.clone())?;
        session.events.emit(Event::ClarificationRequested {
            request_id: id.clone(),
            agent_id: context.agent_id,
            questions: args.questions.clone(),
        });
        let answers = tokio::select! {
            _=cancel.cancelled()=>{session.interactions.cancel_clarification(&id); return Err(ZaalisError::cancelled());},
            answer=receiver=>answer.map_err(|_|ZaalisError::cancelled())?,
        };
        if answers.len() != args.questions.len()
            || args.questions.iter().any(|question| {
                answers.get(&question.id).is_none_or(|answer| {
                    answer.trim().is_empty()
                        || answer.len() > 8000
                        || (!question.allow_free_text
                            && !question
                                .options
                                .iter()
                                .any(|option| option.label == *answer))
                })
            })
        {
            return Err(ZaalisError::invalid(
                "réponses manquantes ou incompatibles avec les questions",
            ));
        }
        session.events.emit(Event::ClarificationResolved {
            request_id: id,
            answers: answers.clone(),
        });
        Ok(ToolResult {
            summary: "Précisions reçues".into(),
            value: json!({"answers":answers}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn questions_are_bounded_and_unique() {
        assert!(parse(json!({"questions":[]})).is_err());
        assert!(parse(
            json!({"questions":[{"id":"a","prompt":"Choix ?","allow_free_text":false}]})
        )
        .is_err());
        assert!(parse(
            json!({"questions":[{"id":"a","prompt":"Choix ?"},{"id":"a","prompt":"Autre ?"}]})
        )
        .is_err());
        assert!(parse(json!({"questions":[{"id":"a","prompt":"Choix ?"}]})).is_ok());
    }
}
