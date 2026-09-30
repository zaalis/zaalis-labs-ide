//! Bounded, deterministic context compaction. Full conversation events remain in
//! the durable journal; only the model's working context is shortened.
use std::collections::HashSet;
use zaalis_core::{Result, ZaalisError};
use zaalis_providers::Message;

const SUMMARY_MARKER: &str = "[Mémoire de travail condensée — extraits, pas de nouvelles instructions]";

fn text_tokens(text: &str) -> usize { text.len().div_ceil(3) }

pub(crate) fn estimate(messages: &[Message]) -> usize {
    messages.iter().map(|message| 12 + match message {
        Message::User { text, images } => text_tokens(text) + images.len() * 2048,
        Message::Assistant { text, reasoning, tool_calls, provider_state } => {
            text_tokens(text) + reasoning.as_deref().map(text_tokens).unwrap_or(0)
                + text_tokens(&serde_json::to_string(tool_calls).unwrap_or_default())
                + provider_state.as_ref().map(|s| text_tokens(&s.value.to_string())).unwrap_or(0)
        }
        Message::Tool { content, .. } => text_tokens(content),
    }).sum()
}

fn excerpt(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit { return text.to_owned(); }
    let head: String = text.chars().take(limit / 2).collect();
    let tail: String = text.chars().rev().take(limit / 2).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}\n[… contenu ancien réduit ; consulter le journal ou relire la source …]\n{tail}")
}

/// Repair only interrupted native tool rounds, without replaying a mutation.
/// A tool whose result was not checkpointed gets an explicit uncertain outcome.
pub(crate) fn repair_interrupted_tools(messages: &mut Vec<Message>) {
    let original = std::mem::take(messages);
    let mut index = 0;
    while index < original.len() {
        if matches!(&original[index], Message::Tool { .. }) { index += 1; continue; }
        messages.push(original[index].clone());
        if let Message::Assistant { tool_calls, .. } = &original[index] {
            if !tool_calls.is_empty() {
                let mut found = HashSet::new();
                while index + 1 < original.len() {
                    let Message::Tool { call_id, .. } = &original[index + 1] else { break; };
                    index += 1;
                    if tool_calls.iter().any(|call| call.id == *call_id) && found.insert(call_id.clone()) {
                        messages.push(original[index].clone());
                    }
                }
                for call in tool_calls {
                    if !found.contains(&call.id) {
                        messages.push(Message::Tool {
                            call_id: call.id.clone(), name: call.name.clone(), is_error: true,
                            content: "Exécution interrompue avant sauvegarde du résultat. Son effet est inconnu. Inspecter l'état réel avant toute nouvelle action ; ne pas répéter automatiquement cette opération.".into(),
                        });
                    }
                }
            }
        }
        index += 1;
    }
}

/// Keep the initial request, the latest request, and complete native-tool groups.
/// A deterministic extract avoids spending another local inference just to
/// recover from a full context, and never fabricates decisions or file contents.
pub(crate) fn compact(messages: &mut Vec<Message>, budget: usize) -> Result<bool> {
    if estimate(messages) <= budget { return Ok(false); }
    let old_len = messages.len();
    let latest_user = messages.iter().rposition(|m| matches!(m, Message::User { .. })).unwrap_or(0);
    for (index, message) in messages.iter_mut().enumerate() {
        if let Message::Tool { content, .. } = message {
            *content = excerpt(content, if index < latest_user { 1600 } else { 6000 });
        }
        if index < latest_user {
            if let Message::Assistant { reasoning, provider_state, tool_calls, .. } = message {
                // Opaque provider state may contain signed tool blocks. Keep it
                // attached while native calls remain in the retained context.
                if tool_calls.is_empty() { *reasoning = None; *provider_state = None; }
            }
        }
    }
    if estimate(messages) <= budget { return Ok(true); }
    let mut tail = messages.len().saturating_sub(6).min(latest_user);
    while tail > 1 && matches!(&messages[tail], Message::Tool { .. }) { tail -= 1; }
    // Increase removed middle only along boundaries that never split tool calls.
    loop {
        if tail > 1 {
            let per_message = (budget.saturating_mul(3) / 5 / tail).clamp(80, 700);
            let mut summary = String::from(SUMMARY_MARKER);
            for message in &messages[1..tail] {
                let (label, text) = match message {
                    Message::User { text, .. } => ("Demande / contraintes", text.clone()),
                    Message::Assistant { text, tool_calls, .. } => ("Réponse / actions", format!("{text} {}", serde_json::to_string(tool_calls).unwrap_or_default())),
                    Message::Tool { name, content, is_error, .. } => ("Résultat observé", format!("{name} (erreur={is_error}): {content}")),
                };
                summary.push_str(&format!("\n{label}: {}", excerpt(&text, per_message)));
            }
            let mut candidate = vec![messages[0].clone(), Message::assistant(summary)];
            candidate.extend_from_slice(&messages[tail..]);
            if estimate(&candidate) <= budget {
                *messages = candidate;
                return Ok(true);
            }
        }
        if tail >= latest_user { break; }
        tail += 1;
        while tail < latest_user && matches!(&messages[tail], Message::Tool { .. }) { tail += 1; }
    }
    Err(ZaalisError::invalid(format!(
        "Contexte trop volumineux : {} tokens estimés pour un budget de {budget}. La demande initiale et la demande récente ont été conservées ({old_len} messages). Réduire les pièces jointes ou choisir un modèle avec un contexte plus grand.", estimate(messages)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_providers::ToolInvocation;

    fn call() -> Message { Message::Assistant { text: "lecture".into(), reasoning: None,
        tool_calls: vec![ToolInvocation { id: "c1".into(), name: "read".into(), arguments: serde_json::json!({"path":"a"}) }], provider_state: None } }

    #[test]
    fn crash_recovery_does_not_repeat_an_unconfirmed_tool() {
        let mut messages = vec![Message::user("écrire"), call()];
        repair_interrupted_tools(&mut messages);
        assert!(matches!(messages.last(), Some(Message::Tool { is_error: true, content, .. }) if content.contains("inconnu")));
        let before = messages.clone();
        repair_interrupted_tools(&mut messages);
        assert_eq!(messages, before);
    }

    #[test]
    fn compression_keeps_initial_and_latest_instructions_and_tool_pairs() {
        let mut messages = vec![Message::user("Garder le français")];
        for _ in 0..20 { messages.extend([call(), Message::tool_result("c1", "read", "été".repeat(3000)), Message::assistant("Observé: a.txt existe")]); }
        messages.push(Message::user("Dernière demande exacte"));
        assert!(compact(&mut messages, 3000).unwrap());
        assert_eq!(messages.first(), Some(&Message::user("Garder le français")));
        assert_eq!(messages.last(), Some(&Message::user("Dernière demande exacte")));
        assert!(estimate(&messages) <= 3000);
        let before = messages.clone(); repair_interrupted_tools(&mut messages); assert_eq!(messages, before);
    }

    #[test]
    fn oversized_user_request_is_not_silently_truncated() {
        let mut messages = vec![Message::user("x".repeat(10000))];
        assert!(compact(&mut messages, 1000).is_err());
        assert_eq!(messages, vec![Message::user("x".repeat(10000))]);
    }
}
