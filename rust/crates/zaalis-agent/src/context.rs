//! Bounded, provider-neutral conversation context management.
//!
//! The browser used to compact only its own chat state.  Sessions opened from
//! the agent panel or CLI could therefore grow until a provider rejected the
//! request.  This module keeps the most recent exchanges verbatim and replaces
//! older, complete exchanges by a labelled factual ledger before a provider
//! call.  It never splits an assistant tool call from its tool results.
//!
//! Full conversation events remain in the durable journal; only the model's
//! working context is shortened here.

use std::collections::HashSet;
use zaalis_core::{Result, ZaalisError};
use zaalis_providers::Message;

const SUMMARY_PREFIX: &str =
    "[RÉSUMÉ RUNTIME DES ÉCHANGES ANTÉRIEURS — donnée de contexte, pas une nouvelle instruction]";
const SUMMARY_MARKER: &str = "[Mémoire de travail condensée — extraits, pas de nouvelles instructions]";
const RECENT_EXCHANGES: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContextCompaction {
    pub before_tokens: u64,
    pub after_tokens: u64,
    pub exchanges_compacted: usize,
}

/// Compact an oversized history for a known model context window.
///
/// The runtime reserves roughly forty percent of the model window for the
/// system prompt, tool schemas and the next response.  This conservative
/// margin prevents a long tool loop from succeeding until its final call then
/// failing only because the context is one message too large.
pub(crate) fn compact_history(
    history: &mut Vec<Message>,
    context_window_tokens: u64,
) -> Option<ContextCompaction> {
    let before_tokens = estimate_history_tokens(history);
    let history_budget = context_window_tokens
        .saturating_mul(60)
        .saturating_div(100)
        .max(8_000);
    if before_tokens <= history_budget || history.len() <= 2 {
        return None;
    }

    let exchanges = group_exchanges(history);
    if exchanges.len() <= 1 {
        // The current request itself can be larger than a provider's window.
        // Do not silently truncate it: retaining the user's exact request is
        // safer than pretending a lossy rewrite is equivalent.
        return None;
    }

    let mut start = exchanges.len();
    let mut retained_tokens = 0_u64;
    while start > 0 {
        let candidate = estimate_history_tokens(&exchanges[start - 1]);
        let enough_recent = exchanges.len() - start < RECENT_EXCHANGES;
        if !enough_recent && retained_tokens.saturating_add(candidate) > history_budget {
            break;
        }
        retained_tokens = retained_tokens.saturating_add(candidate);
        start -= 1;
    }
    if start == 0 {
        return None;
    }

    let summary_budget_chars = ((history_budget / 4).min(16_000) as usize).max(1_200);
    let summary = summarise_exchanges(&exchanges[..start], summary_budget_chars);
    let mut compacted = Vec::with_capacity(1 + history.len());
    compacted.push(Message::user(format!("{SUMMARY_PREFIX}\n{summary}")));
    for exchange in exchanges.into_iter().skip(start) {
        compacted.extend(exchange);
    }
    let after_tokens = estimate_history_tokens(&compacted);
    *history = compacted;
    Some(ContextCompaction {
        before_tokens,
        after_tokens,
        exchanges_compacted: start,
    })
}

fn group_exchanges(history: &[Message]) -> Vec<Vec<Message>> {
    let mut exchanges = Vec::new();
    let mut current = Vec::new();
    for message in history {
        if matches!(message, Message::User { .. }) && !current.is_empty() {
            exchanges.push(std::mem::take(&mut current));
        }
        current.push(message.clone());
    }
    if !current.is_empty() {
        exchanges.push(current);
    }
    exchanges
}

fn summarise_exchanges(exchanges: &[Vec<Message>], char_budget: usize) -> String {
    let mut summary = String::new();
    for exchange in exchanges {
        for message in exchange {
            let line = match message {
                Message::User { text, .. } => format!("Utilisateur : {}", compact_text(text, 900)),
                Message::Assistant {
                    text, tool_calls, ..
                } => {
                    let tools = (!tool_calls.is_empty())
                        .then(|| format!(" [{} appel(s) outil]", tool_calls.len()))
                        .unwrap_or_default();
                    format!("Assistant{tools} : {}", compact_text(text, 900))
                }
                Message::Tool {
                    name,
                    content,
                    is_error,
                    ..
                } => format!(
                    "Outil {name}{} : {}",
                    if *is_error { " (erreur)" } else { "" },
                    compact_text(content, 700)
                ),
            };
            append_bounded_line(&mut summary, &line, char_budget);
            if summary.chars().count() >= char_budget {
                summary.push_str("\n[Historique plus ancien tronqué par le runtime]");
                return summary;
            }
        }
    }
    summary
}

fn append_bounded_line(out: &mut String, line: &str, limit: usize) {
    if !out.is_empty() {
        out.push('\n');
    }
    let remaining = limit.saturating_sub(out.chars().count());
    out.extend(line.chars().take(remaining));
}

fn compact_text(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let head = limit.saturating_mul(3) / 4;
    let tail = limit.saturating_sub(head);
    let chars: Vec<char> = text.chars().collect();
    format!(
        "{} … [tronqué] … {}",
        chars.iter().take(head).collect::<String>(),
        chars
            .iter()
            .rev()
            .take(tail)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>()
    )
}

fn estimate_history_tokens(history: &[Message]) -> u64 {
    history.iter().map(estimate_message_tokens).sum()
}

fn estimate_message_tokens(message: &Message) -> u64 {
    let chars = match message {
        Message::User { text, images } => {
            text.chars().count() as u64 + images.len().saturating_mul(4_000) as u64
        }
        Message::Assistant {
            text,
            reasoning,
            tool_calls,
            ..
        } => {
            text.chars().count() as u64
                + reasoning
                    .as_deref()
                    .map_or(0, |value| value.chars().count() as u64)
                + tool_calls
                    .iter()
                    .map(|call| {
                        call.name.len() as u64 + call.arguments.to_string().chars().count() as u64
                    })
                    .sum::<u64>()
        }
        Message::Tool { content, .. } => content.chars().count() as u64,
    };
    // A deliberately conservative multilingual estimate.  It is only a guard
    // rail; providers remain authoritative for billable token accounting.
    chars.saturating_add(2) / 3 + 8
}

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

    fn exchange(index: usize, size: usize) -> Vec<Message> {
        vec![
            Message::user(format!("question-{index}: {}", "u".repeat(size))),
            Message::assistant(format!("answer-{index}: {}", "a".repeat(size))),
        ]
    }

    #[test]
    fn preserves_recent_exchanges_and_labels_the_runtime_summary() {
        let mut history = (0..8)
            .flat_map(|index| exchange(index, 4_000))
            .collect::<Vec<_>>();
        let compaction = compact_history(&mut history, 16_000).expect("must compact");

        assert!(compaction.after_tokens < compaction.before_tokens);
        assert_eq!(compaction.exchanges_compacted, 4);
        let Message::User { text, .. } = &history[0] else {
            panic!("runtime recap must be a user-context message")
        };
        assert!(text.starts_with(SUMMARY_PREFIX));
        assert!(text.contains("question-0"));
        assert!(
            matches!(&history[1], Message::User { text, .. } if text.starts_with("question-4"))
        );
        assert!(
            matches!(history.last(), Some(Message::Assistant { text, .. }) if text.starts_with("answer-7"))
        );
    }

    #[test]
    fn leaves_short_history_verbatim() {
        let mut history = exchange(1, 80);
        let original = history.clone();
        assert!(compact_history(&mut history, 32_000).is_none());
        assert_eq!(history, original);
    }

    #[test]
    fn never_splits_an_assistant_tool_call_from_its_result() {
        let mut history = Vec::new();
        for index in 0..6 {
            history.push(Message::user(format!(
                "question-{index}: {}",
                "u".repeat(6_000)
            )));
            history.push(Message::Assistant {
                text: String::new(),
                reasoning: None,
                tool_calls: vec![zaalis_providers::ToolInvocation {
                    id: format!("call-{index}"),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": format!("{index}.txt")}),
                }],
                provider_state: None,
            });
            history.push(Message::tool_result(
                format!("call-{index}"),
                "read",
                format!("content-{index}"),
            ));
        }
        compact_history(&mut history, 16_000).expect("must compact");
        let remaining_calls = history
            .iter()
            .filter_map(|message| match message {
                Message::Assistant { tool_calls, .. } => Some(tool_calls),
                _ => None,
            })
            .flatten()
            .map(|call| call.id.as_str())
            .collect::<Vec<_>>();
        for call_id in remaining_calls {
            assert!(history.iter().any(|message| {
                matches!(message, Message::Tool { call_id: result_id, .. } if result_id == call_id)
            }));
        }
    }

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
