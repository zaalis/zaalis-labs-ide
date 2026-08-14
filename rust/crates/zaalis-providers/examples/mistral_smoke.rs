//! Opt-in live Mistral smoke test.
//!
//! Run with `MISTRAL_API_KEY` set. The key is read from the environment and is
//! never printed. This example intentionally uses no other cloud provider.

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;
use zaalis_core::{ModelBinding, ProviderId, ReasoningLevel};
use zaalis_providers::{
    Message, ModelProvider, OpenAiConfig, OpenAiProvider, ProviderState, StopReason,
    ToolInvocation, ToolSpec, TurnEvent, TurnRequest,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = std::env::var("MISTRAL_API_KEY")?;
    let config = OpenAiConfig::for_provider(ProviderId::Mistral, Some(key))
        .ok_or("configuration Mistral absente")?;
    let provider = OpenAiProvider::new(config)?;
    let binding = ModelBinding::new(ProviderId::Mistral, Some("mistral-medium-3-5".to_owned()));
    let tool = ToolSpec {
        name: "read".to_owned(),
        description: "Lire un fichier de test virtuel".to_owned(),
        schema: serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"],
            "additionalProperties": false
        }),
    };
    let mut first = TurnRequest::new(
        binding.clone(),
        "Tu testes un runtime. Utilise obligatoirement l'outil demandé.",
        vec![Message::user(
            "Appelle read exactement avec le chemin live-fixture.txt, sans répondre en texte.",
        )],
    )
    .with_tools(vec![tool.clone()]);
    first.reasoning = ReasoningLevel(2);
    first.max_output_tokens = Some(256);

    let mut stream = provider
        .stream_turn(first.clone(), CancellationToken::new())
        .await?;
    let mut call: Option<ToolInvocation> = None;
    let mut state: Option<ProviderState> = None;
    let mut first_stop = None;
    while let Some(event) = stream.next().await {
        match event {
            TurnEvent::ToolCallCompleted { call: value } => call = Some(value),
            TurnEvent::AssistantState { state: value } => state = Some(value),
            TurnEvent::Completed { reason } => first_stop = Some(reason),
            TurnEvent::Failed { error } => return Err(error.message.into()),
            _ => {}
        }
    }
    let call = call.ok_or("Mistral n'a pas produit de tool call")?;
    if call.name != "read" || call.arguments["path"] != "live-fixture.txt" {
        return Err(format!("tool call inattendu: {} {}", call.name, call.arguments).into());
    }
    if first_stop != Some(StopReason::ToolUse) {
        return Err(format!("arrêt inattendu au premier tour: {first_stop:?}").into());
    }

    let mut messages = first.messages;
    messages.push(Message::Assistant {
        text: String::new(),
        reasoning: None,
        tool_calls: vec![call.clone()],
        provider_state: state,
    });
    messages.push(Message::tool_result(call.id, call.name, "ZAALIS_TOOL_OK"));
    messages.push(Message::user(
        "Réponds maintenant exactement avec la valeur renvoyée par l'outil.",
    ));
    let mut second =
        TurnRequest::new(binding, "Réponds sans explication.", messages).with_tools(vec![tool]);
    second.max_output_tokens = Some(64);

    let mut stream = provider
        .stream_turn(second, CancellationToken::new())
        .await?;
    let mut text = String::new();
    let mut deltas = 0_u32;
    let mut completed = false;
    while let Some(event) = stream.next().await {
        match event {
            TurnEvent::TextDelta { text: delta } => {
                deltas += 1;
                text.push_str(&delta);
            }
            TurnEvent::Completed {
                reason: StopReason::EndTurn,
            } => completed = true,
            TurnEvent::Failed { error } => return Err(error.message.into()),
            _ => {}
        }
    }
    if !completed || !text.contains("ZAALIS_TOOL_OK") {
        return Err(format!("second tour incomplet: {text:?}").into());
    }
    println!("Mistral live OK: tool_call=read, continuation=ok, text_deltas={deltas}");
    Ok(())
}
