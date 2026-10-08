use crate::interaction::PlanAnswer;
use crate::prompt::system_prompt;
use crate::session::{SessionInner, SessionRunMode};
use futures_util::StreamExt;
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use zaalis_core::{
    now_ms, AgentNode, AgentState, PermissionAnswer, PermissionMode, RequestId, Result, Segment,
    SegmentId, SegmentKind, ToolCallId, Usage, ZaalisError,
};
use zaalis_extensions::HookEvent;
use zaalis_protocol::{AgentReport, Event, ToolOutcome};
use zaalis_providers::{
    Message, ProviderState, StopReason, ToolInvocation as ProviderToolInvocation, ToolSpec,
    TurnEvent, TurnRequest,
};
use zaalis_tools::{ToolContext, ToolDispatch, ToolInvocation};

const MAX_RUNTIME_ROUNDS: u32 = 128;
const COMPUTER_CAPTURE_PROMPT: &str =
    "[Capture actuelle du bureau — utilise cette image pour poursuivre le contrôle.]";
/// Label of the vision message carrying images that tools other than the
/// desktop capture returned (a Blender render, an image file that was read…).
const TOOL_IMAGES_PROMPT_PREFIX: &str = "[Images renvoyées par les outils";
/// Images one tool call may hand to the model, and one round in total: enough
/// for "before / after" or a few views, bounded so a request stays affordable.
const MAX_IMAGES_PER_CALL: usize = 4;
const MAX_IMAGES_PER_ROUND: usize = 8;
/// The tools a desktop-control turn keeps.
const DESKTOP_TOOLS: [&str; 3] = ["computer", "mcp", "skill"];

/// The desktop-mode instructions, naming the tools the turn actually has.
fn desktop_mode_prompt(tools: &[zaalis_tools::ToolDefinition]) -> String {
    let has = |name: &str| tools.iter().any(|tool| tool.name == name);
    let mut prompt = String::from("\n\nMODE CONTRÔLE DU BUREAU : ");
    if has("mcp") || has("skill") {
        prompt.push_str("outils disponibles : computer");
        if has("mcp") {
            prompt.push_str(", mcp");
        }
        if has("skill") {
            prompt.push_str(", skill");
        }
        prompt.push_str(". Quand un serveur MCP couvre l’application visée (Blender par exemple), passe par lui plutôt que par la souris : c’est plus fiable et plus rapide ; garde computer pour le reste du bureau. ");
    } else {
        prompt.push_str("seul l’outil computer est disponible. ");
    }
    prompt.push_str("Regroupe les actions clavier sûres et déterministes lorsque l’état est déjà connu (par exemple ouvrir une nouvelle note puis saisir son texte), mais observe/inspecte après un changement d’écran important. Termine dès que le résultat demandé est confirmé afin d’économiser les appels au fournisseur.");
    prompt
}

#[derive(Debug)]
struct ToolExecution {
    outcome: ToolOutcome,
    images: Vec<zaalis_providers::ImagePart>,
}

/// How a tool bears on the completion gate.
enum ToolCategory {
    /// Creates, replaces or edits a file (`write`, `apply_patch`, `edit`).
    Mutate,
    /// Reads state back, which counts as verifying a prior mutation.
    Verify,
    /// Everything else — no bearing on the gate.
    Other,
}

fn tool_category(name: &str) -> ToolCategory {
    match name {
        "write" | "apply_patch" | "edit" => ToolCategory::Mutate,
        "read" | "grep" | "code_search" | "list" | "tree" | "glob" => ToolCategory::Verify,
        _ => ToolCategory::Other,
    }
}

#[derive(Debug)]
pub(crate) struct AgentRun {
    pub report: AgentReport,
    pub history: Vec<Message>,
}

#[derive(Debug, Default)]
struct Timeline {
    next_index: u32,
    text: Option<Segment>,
    reasoning: Option<Segment>,
}

pub(crate) async fn run_agent(
    session: Arc<SessionInner>,
    mut node: AgentNode,
    mut history: Vec<Message>,
    cancel: CancellationToken,
) -> Result<AgentRun> {
    let started = Instant::now();
    let mut usage = node.usage;
    let mut timeline = Timeline::default();
    let mut tools_used = Vec::new();
    let mut files_changed = Vec::new();
    // Completion-gate bookkeeping. `verified_since_mutation` starts true so a
    // turn that never mutates anything (a chat answer, a read-only agent) can
    // never trip the gate.
    let mut file_mutations = 0_u32;
    let mut verified_since_mutation = true;
    let mut completion_nudged = false;
    let mut planning = session.config.mode == SessionRunMode::Plan;
    let mut plan_revision = 0_u32;
    let mut partial_reason = None;

    if session.hook_agents.lock().await.insert(node.id.clone()) {
        execute_hooks(
            &session,
            &node,
            &mut timeline,
            HookEvent::AgentSpawn,
            serde_json::json!({"agent_id":node.id,"objective":node.objective}),
            cancel.clone(),
        )
        .await?;
    }
    execute_hooks(
        &session,
        &node,
        &mut timeline,
        HookEvent::UserPromptSubmit,
        serde_json::json!({"agent_id":node.id}),
        cancel.clone(),
    )
    .await?;

    loop {
        let requested_plan = session.plan_mode.load(std::sync::atomic::Ordering::SeqCst);
        if requested_plan != planning {
            planning = requested_plan;
            node.permissions.mode = if planning {
                PermissionMode::Plan
            } else {
                PermissionMode::Supervised
            };
            session.update_runtime_limits(&node).await;
        }
        if cancel.is_cancelled() {
            return Err(ZaalisError::cancelled());
        }
        usage.wall_time_ms = started.elapsed().as_millis() as u64;
        if let Some(limit) = usage.exceeded(&node.budget) {
            if !request_budget(&session, &mut node, &mut usage, limit, &cancel).await? {
                partial_reason = Some(format!("budget {} non prolongé", limit.as_str()));
                break;
            }
        }
        if usage.rounds >= MAX_RUNTIME_ROUNDS {
            return Err(ZaalisError::new(
                zaalis_core::ErrorCode::BudgetExceeded,
                "limite de sécurité de 128 rounds atteinte",
            ));
        }

        let mut available_tools = session.tools.definitions();
        let desktop_control = available_tools.iter().any(|tool| tool.name == "computer");
        if desktop_control {
            // A desktop-control turn does not need filesystem, Git, terminal,
            // checkpoint or web schemas. Advertising the whole IDE catalogue
            // costs thousands of input tokens on every observe/click/type
            // round, which is enough to exhaust entry-plan provider limits
            // before the task can finish. The computer tool remains fully
            // typed; only irrelevant choices are removed. MCP servers and
            // Skills stay: an application with its own MCP server (Blender)
            // is driven far more reliably through it than with the mouse.
            available_tools.retain(|tool| DESKTOP_TOOLS.contains(&tool.name.as_str()));
        }
        let mut runtime_system =
            system_prompt(&session, &node, planning, &files_changed, usage.tool_calls);
        if desktop_control {
            runtime_system.push_str(&desktop_mode_prompt(&available_tools));
        }
        let tools: Vec<ToolSpec> = available_tools.into_iter().map(|tool| ToolSpec {
            name: tool.name, description: tool.description, schema: tool.input_schema,
        }).collect();
        let capabilities = session.providers.metadata(node.model.provider)
            .map(|(_, caps)| caps.for_binding(&node.model)).unwrap_or_default();
        let context = capabilities.max_context as usize;
        let output_reserve = (context / 5).clamp(256, 8192);
        let overhead = runtime_system.len().div_ceil(3)
            + serde_json::to_string(&tools)?.len().div_ceil(3) + 256;
        let input_budget = context.saturating_sub(output_reserve + overhead);
        if input_budget < 256 {
            return Err(ZaalisError::invalid("Le contexte du modèle est trop petit pour les instructions et outils actifs. Choisir un contexte plus grand ou réduire les outils."));
        }
        if crate::context::compact(&mut history, input_budget)? {
            usage.context_compactions = usage.context_compactions.saturating_add(1);
            session.update_usage(&node.id, usage).await;
        }
        session.checkpoint_history(&node.id, &history).await;
        let estimated_input=(crate::context::estimate(&history)+overhead) as u64;
        let output=remaining_tokens(&node,&usage).unwrap_or(output_reserve as u32).min(output_reserve as u32);
        let (mut reservation,allowed_output)=crate::envelope::Reservation::acquire(Arc::clone(&session),estimated_input,output).await?;
        let request = TurnRequest {
            binding: node.model.clone(),
            system: runtime_system,
            messages: history.clone(),
            tools,
            reasoning: node.model.reasoning,
            max_output_tokens: Some(allowed_output),
            temperature: None,
        };
        usage.rounds = usage.rounds.saturating_add(1);
        session.update_usage(&node.id, usage).await;
        let mut telemetry = crate::telemetry::ProviderCall::new(session.config.usage_store.clone(), session.config.session_id.to_string(), node.model.provider.to_string(), node.model.model.clone().unwrap_or_default());
        let mut stream = session
            .providers
            .stream_turn(request, cancel.clone())
            .await
            .map_err(ZaalisError::from)?;

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut calls = Vec::new();
        let mut state: Option<ProviderState> = None;
        let mut round_usage = Usage::default();
        let mut usage_reported = false;
        let mut stop_reason = StopReason::EndTurn;
        while let Some(event) = stream.next().await {
            match event {
                TurnEvent::TextDelta { text: delta } => {
                    let segment_id =
                        ensure_segment(&session, &node, &mut timeline, SegmentKind::Text);
                    text.push_str(&delta);
                    session.events.emit(Event::TextDelta {
                        segment_id,
                        text: delta,
                    });
                }
                TurnEvent::ReasoningDelta { text: delta } => {
                    let segment_id =
                        ensure_segment(&session, &node, &mut timeline, SegmentKind::Reasoning);
                    reasoning.push_str(&delta);
                    session.events.emit(Event::ReasoningDelta {
                        segment_id,
                        text: delta,
                    });
                }
                TurnEvent::ToolCallCompleted { call } => calls.push(call),
                TurnEvent::Usage {
                    usage: provider_usage,
                } => { round_usage = provider_usage; usage_reported=true; telemetry.observe(provider_usage); },
                TurnEvent::AssistantState {
                    state: provider_state,
                } => state = Some(provider_state),
                TurnEvent::Completed { reason } => stop_reason = reason,
                TurnEvent::Failed { error } => {
                    session.events.emit(Event::ProviderError {
                        provider: node.model.provider,
                        agent_id: Some(node.id.clone()),
                        code: error.code().into(),
                        message: error.message.clone(),
                        retry_in_ms: error.retry_after_ms,
                    });
                    return Err(error.into());
                }
                TurnEvent::ToolCallStarted { .. } | TurnEvent::ToolCallDelta { .. } => {}
            }
        }
        reservation.settle(usage_reported.then_some(round_usage)).await;
        telemetry.complete();
        close_stream_segments(&session, &mut timeline);
        round_usage.rounds = 0;
        round_usage.context_tokens = if usage_reported {
            round_usage.input_tokens + round_usage.output_tokens
        } else {
            0
        };
        usage.merge(&round_usage);
        usage.wall_time_ms = started.elapsed().as_millis() as u64;
        session.update_usage(&node.id, usage).await;

        history.push(Message::Assistant {
            text: text.clone(),
            reasoning: (!reasoning.is_empty()).then_some(reasoning),
            tool_calls: calls.clone(),
            provider_state: state,
        });
        session.checkpoint_history(&node.id, &history).await;

        if !calls.is_empty() {
            // Images returned during this round, by the tool that returned them.
            let mut round_images: Vec<(String, Vec<zaalis_providers::ImagePart>)> = Vec::new();
            for call in calls {
                usage.tool_calls = usage.tool_calls.saturating_add(1);
                tools_used.push(call.name.clone());
                let execution =
                    execute_tool(&session, &node, &mut timeline, call.clone(), cancel.clone())
                        .await?;
                let mut outcome = execution.outcome;
                let mut images = execution.images;
                if !images.is_empty() && !capabilities.vision {
                    // Say so instead of dropping the picture silently: the
                    // model then relies on the textual part of the result.
                    set_result_field(
                        &mut outcome,
                        "images_not_sent",
                        serde_json::Value::String(format!(
                            "{} image(s) non transmise(s) : le modèle choisi ne lit pas les images. Utilise les données textuelles de ce résultat, ou signale à l’utilisateur qu’un modèle avec vision est nécessaire.",
                            images.len()
                        )),
                    );
                    images.clear();
                }
                collect_web_usage(&call.name, &outcome, &mut usage);
                collect_changed_files(&outcome, &mut files_changed);
                let is_error = !outcome.is_ok();
                if !is_error {
                    match tool_category(&call.name) {
                        ToolCategory::Mutate => {
                            file_mutations = file_mutations.saturating_add(1);
                            verified_since_mutation = false;
                        }
                        ToolCategory::Verify => verified_since_mutation = true,
                        ToolCategory::Other => {}
                    }
                }
                let call_name = call.name.clone();
                history.push(Message::Tool {
                    call_id: call.id,
                    name: call.name,
                    content: serde_json::to_string(&outcome)?,
                    is_error,
                });
                session.checkpoint_history(&node.id, &history).await;
                if !images.is_empty() {
                    // A newer desktop capture makes the previous one stale.
                    if call_name == "computer" {
                        round_images.retain(|(tool, _)| tool != "computer");
                    }
                    round_images.push((call_name, images));
                }
                session.update_usage(&node.id, usage).await;
            }
            if let Some(message) = tool_images_message(round_images) {
                // Images are vision attachments, never text in a tool result.
                // They are appended only once every tool result of this round
                // is in history: OpenAI-compatible and Anthropic APIs reject a
                // user message between an assistant's tool calls and their
                // results. Only the latest round's images are kept, which
                // bounds a long turn to a few images per provider request
                // instead of its whole visual history.
                history.retain(|message| !is_tool_images_message(message));
                history.push(message);
            }
            continue;
        }

        if planning {
            plan_revision = plan_revision.saturating_add(1);
            session.events.emit(Event::PlanUpdated {
                revision: plan_revision,
                content: text.clone(),
            });
            match request_plan(&session, &node, plan_revision, text, &cancel).await? {
                PlanAnswer::Approve => {
                    planning = false;
                    session
                        .plan_mode
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    node.permissions.mode = PermissionMode::Supervised;
                    session.update_runtime_limits(&node).await;
                    history.push(Message::user(
                        "Plan approuvé. Passe maintenant à l'implémentation et vérifie le résultat.",
                    ));
                    continue;
                }
                PlanAnswer::Reject { feedback } => {
                    history.push(Message::user(format!(
                        "Plan refusé. Révise-le avant toute implémentation. Retour : {}",
                        feedback.unwrap_or_else(|| "aucun détail supplémentaire".into())
                    )));
                    continue;
                }
            }
        }

        if stop_reason == StopReason::MaxTokens {
            history.push(Message::user("Continue exactement où tu t'es arrêté."));
            continue;
        }
        // Completion gate: a significant, unverified change should be checked
        // before the agent concludes. Scaled to the task — a single file change
        // is trivial and never trips it; two or more do (a multi-file build
        // like the SpaceX site), and only once (`completion_nudged`), so simple
        // tasks stay light and no loop can form. Scoped to deliverable owners
        // (root and team-lead agents, which are all roots); a spawned child
        // reports back to its parent, whose own verification and merge cover it,
        // so gating children too would only multiply rounds down the tree.
        let significant_change = file_mutations >= 2;
        if node.parent_id.is_none()
            && significant_change
            && !verified_since_mutation
            && !completion_nudged
        {
            completion_nudged = true;
            history.push(Message::user(
                "Avant de conclure : relis les fichiers que tu as créés ou modifiés et vérifie que le résultat correspond réellement à la demande. Corrige si nécessaire, puis fais un court bilan au passé de ce qui a été réellement fait.",
            ));
            continue;
        }
        break;
    }

    usage.wall_time_ms = started.elapsed().as_millis() as u64;
    let summary = last_assistant_text(&history);
    execute_hooks(
        &session,
        &node,
        &mut timeline,
        HookEvent::AgentComplete,
        serde_json::json!({"agent_id":node.id,"summary":summary.clone()}),
        cancel.clone(),
    )
    .await?;
    Ok(AgentRun {
        report: AgentReport {
            summary,
            files_changed,
            tools_used,
            usage,
            partial_reason,
        },
        history,
    })
}

async fn execute_tool(
    session: &Arc<SessionInner>,
    node: &AgentNode,
    timeline: &mut Timeline,
    call: ProviderToolInvocation,
    cancel: CancellationToken,
) -> Result<ToolExecution> {
    execute_hooks(
        session,
        node,
        timeline,
        HookEvent::PreToolUse,
        serde_json::json!({"tool":call.name.clone(),"input":call.arguments.clone()}),
        cancel.clone(),
    )
    .await?;
    let outcome = execute_tool_raw(session, node, timeline, call.clone(), cancel.clone()).await?;
    execute_hooks(
        session,
        node,
        timeline,
        HookEvent::PostToolUse,
        serde_json::json!({"tool":call.name,"input":call.arguments,"outcome":outcome.outcome.clone()}),
        cancel,
    )
    .await?;
    Ok(outcome)
}

async fn execute_tool_raw(
    session: &Arc<SessionInner>,
    node: &AgentNode,
    timeline: &mut Timeline,
    call: ProviderToolInvocation,
    cancel: CancellationToken,
) -> Result<ToolExecution> {
    let call_id = ToolCallId::from_raw(call.id.clone());
    let mut segment = Segment::new(
        node.id.clone(),
        SegmentKind::ToolCall {
            call_id: call_id.clone(),
            tool: call.name.clone(),
        },
        timeline.next_index,
        now_ms(),
    );
    timeline.next_index = timeline.next_index.saturating_add(1);
    session.events.emit(Event::SegmentStarted {
        segment: segment.clone(),
    });
    session.events.emit(Event::ToolStarted {
        segment_id: segment.id.clone(),
        call_id: call_id.clone(),
        tool: call.name.clone(),
        input: call.arguments.clone(),
        title: call.name.to_string(),
    });
    let context = ToolContext {
        agent_id: node.id.clone(),
        permissions: node.permissions.clone(),
        workspace: workspace_for_node(session, node)?,
    };
    let dispatch = session
        .tools
        .invoke(
            ToolInvocation {
                call_id: call_id.clone(),
                name: call.name,
                input: call.arguments,
            },
            context,
            cancel.clone(),
        )
        .await;
    let dispatch = match dispatch {
        ToolDispatch::Complete { .. } => dispatch,
        ToolDispatch::PermissionRequired(prompt) => {
            let receiver = session
                .interactions
                .wait_permission(prompt.request_id.clone())?;
            session
                .set_state(&node.id, AgentState::WaitingPermission)
                .await;
            session.events.emit(Event::PermissionRequested {
                request_id: prompt.request_id.clone(),
                agent_id: node.id.clone(),
                tool: prompt.tool,
                summary: prompt.summary,
                target: prompt.target,
                reason: "confirmation requise par la politique".into(),
                risks: prompt.risks,
            });
            let answer = tokio::select! {
                answer = receiver => answer.map_err(|_| ZaalisError::cancelled())?,
                () = cancel.cancelled() => {
                    let dispatch = session.tools.cancel_pending(&prompt.request_id)?;
                    return Ok(ToolExecution { outcome: outcome_from_dispatch(dispatch)?, images: Vec::new() });
                }
            };
            let allowed = matches!(answer, PermissionAnswer::Allow { .. });
            session.events.emit(Event::PermissionResolved {
                request_id: prompt.request_id.clone(),
                allowed,
                reason: if allowed {
                    "autorisé par l'utilisateur"
                } else {
                    "refusé par l'utilisateur"
                }
                .into(),
            });
            session.set_state(&node.id, AgentState::Running).await;
            session.tools.resolve(&prompt.request_id, answer).await?
        }
    };
    let mut outcome = outcome_from_dispatch(dispatch)?;
    let images = detach_tool_images(&mut outcome);
    session.events.emit(Event::ToolCompleted {
        call_id,
        outcome: outcome.clone(),
    });
    segment.complete(now_ms());
    let duration_ms = segment.duration_ms();
    session.events.emit(Event::SegmentCompleted {
        segment_id: segment.id,
        duration_ms,
    });
    Ok(ToolExecution { outcome, images })
}

/// Takes the images out of a tool result so they reach the model as vision
/// attachments rather than as base64 text. Two shapes are understood:
///   - `images: [{mime, data}]`, the IDE's own tools (desktop capture, read);
///   - MCP content items `{type:"image", data, mimeType}`, which any MCP
///     server may return; each is replaced by a short text placeholder.
fn detach_tool_images(outcome: &mut ToolOutcome) -> Vec<zaalis_providers::ImagePart> {
    let ToolOutcome::Ok { result, .. } = outcome else {
        return Vec::new();
    };
    let Some(object) = result.as_object_mut() else {
        return Vec::new();
    };
    let mut detached = Vec::new();
    if let Some(images) = object
        .remove("images")
        .and_then(|value| value.as_array().cloned())
    {
        detached.extend(images.iter().filter_map(|image| {
            image_part(image.get("mime")?.as_str()?, image.get("data")?.as_str()?)
        }));
        detached.truncate(MAX_IMAGES_PER_CALL);
    }
    if let Some(content) = object
        .get_mut("content")
        .and_then(serde_json::Value::as_array_mut)
    {
        for item in content.iter_mut() {
            if item.get("type").and_then(serde_json::Value::as_str) != Some("image") {
                continue;
            }
            let part = item
                .get("mimeType")
                .or_else(|| item.get("mime"))
                .and_then(serde_json::Value::as_str)
                .zip(item.get("data").and_then(serde_json::Value::as_str))
                .and_then(|(mime, data)| image_part(mime, data));
            let placeholder = match part {
                Some(part) if detached.len() < MAX_IMAGES_PER_CALL => {
                    detached.push(part);
                    format!("[image {} jointe au message suivant]", detached.len())
                }
                Some(_) => "[image non transmise : trop d’images pour un seul appel]".to_owned(),
                None => "[image illisible ignorée]".to_owned(),
            };
            *item = serde_json::json!({ "type": "text", "text": placeholder });
        }
    }
    if !detached.is_empty() {
        object.insert("capture_attached".into(), serde_json::Value::Bool(true));
        object.insert(
            "images_attached".into(),
            serde_json::Value::from(detached.len()),
        );
    }
    detached
}

/// A malformed or unexpectedly enormous reply must never be replayed into a
/// provider request.
fn image_part(mime: &str, data: &str) -> Option<zaalis_providers::ImagePart> {
    if !mime.starts_with("image/") || mime.len() > 64 || data.is_empty() || data.len() > 12_000_000
    {
        return None;
    }
    Some(zaalis_providers::ImagePart {
        mime: mime.into(),
        data: data.into(),
    })
}

fn set_result_field(outcome: &mut ToolOutcome, key: &str, value: serde_json::Value) {
    if let ToolOutcome::Ok { result, .. } = outcome {
        if let Some(object) = result.as_object_mut() {
            object.insert(key.into(), value);
        }
    }
}

/// The vision message for this round's images, labelled with where they come
/// from. A desktop capture alone keeps the wording the desktop mode expects.
fn tool_images_message(
    round_images: Vec<(String, Vec<zaalis_providers::ImagePart>)>,
) -> Option<Message> {
    let mut sources = Vec::new();
    let mut images = Vec::new();
    for (tool, list) in round_images {
        let room = MAX_IMAGES_PER_ROUND.saturating_sub(images.len());
        if room == 0 {
            break;
        }
        let taken = list.len().min(room);
        sources.push((tool, taken));
        images.extend(list.into_iter().take(taken));
    }
    if images.is_empty() {
        return None;
    }
    let text = if sources.len() == 1 && sources[0].0 == "computer" && images.len() == 1 {
        COMPUTER_CAPTURE_PROMPT.to_owned()
    } else {
        let listed = sources
            .iter()
            .map(|(tool, count)| format!("{tool} ({count})"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{TOOL_IMAGES_PROMPT_PREFIX} de ce tour : {listed} — examine-les pour poursuivre la tâche.]")
    };
    Some(Message::User { text, images })
}

fn is_tool_images_message(message: &Message) -> bool {
    matches!(message, Message::User { text, images }
        if !images.is_empty()
            && (text == COMPUTER_CAPTURE_PROMPT || text.starts_with(TOOL_IMAGES_PROMPT_PREFIX)))
}

async fn execute_hooks(
    session: &Arc<SessionInner>,
    node: &AgentNode,
    timeline: &mut Timeline,
    event: HookEvent,
    context: serde_json::Value,
    cancel: CancellationToken,
) -> Result<()> {
    let Some(extensions) = &session.config.extensions else {
        return Ok(());
    };
    for hook in extensions.hooks.invocations(event, context.clone()) {
        let call = ProviderToolInvocation {
            id: format!("hook_{}_{}", now_ms(), timeline.next_index),
            name: "run".into(),
            arguments: serde_json::json!({"command":hook.command,"timeout_ms":hook.timeout_ms}),
        };
        let execution = execute_tool_raw(session, node, timeline, call, cancel.clone()).await?;
        if hook.blocking && !execution.outcome.is_ok() {
            return Err(ZaalisError::new(
                zaalis_core::ErrorCode::ToolFailure,
                format!(
                    "Hook {:?} bloquant en échec : {}",
                    event,
                    execution.outcome.summary()
                ),
            ));
        }
    }
    Ok(())
}

pub(crate) async fn run_lifecycle_hook(
    session: Arc<SessionInner>,
    node: AgentNode,
    event: HookEvent,
    context: serde_json::Value,
) -> Result<()> {
    let previous = node.state.clone();
    let mut timeline = Timeline::default();
    let result = execute_hooks(
        &session,
        &node,
        &mut timeline,
        event,
        context,
        CancellationToken::new(),
    )
    .await;
    if let Some(shared) = session.tree.lock().await.get_mut(&node.id) {
        shared.state = previous;
    }
    result
}

fn outcome_from_dispatch(dispatch: ToolDispatch) -> Result<ToolOutcome> {
    match dispatch {
        ToolDispatch::Complete { outcome, .. } => Ok(outcome),
        ToolDispatch::PermissionRequired(_) => Err(ZaalisError::internal(
            "outil encore suspendu après résolution",
        )),
    }
}

async fn request_plan(
    session: &Arc<SessionInner>,
    node: &AgentNode,
    revision: u32,
    content: String,
    cancel: &CancellationToken,
) -> Result<PlanAnswer> {
    let request_id = RequestId::new();
    let receiver = session.interactions.wait_plan(request_id.clone())?;
    session.events.emit(Event::PlanReady {
        request_id,
        revision,
        content,
    });
    session
        .set_state(&node.id, AgentState::WaitingPermission)
        .await;
    let answer = tokio::select! {
        answer = receiver => answer.map_err(|_| ZaalisError::cancelled())?,
        () = cancel.cancelled() => return Err(ZaalisError::cancelled()),
    };
    session.set_state(&node.id, AgentState::Running).await;
    Ok(answer)
}

async fn request_budget(
    session: &Arc<SessionInner>,
    node: &mut AgentNode,
    usage: &mut Usage,
    limit: zaalis_core::BudgetLimit,
    cancel: &CancellationToken,
) -> Result<bool> {
    let request_id = RequestId::new();
    let receiver = session.interactions.wait_budget(request_id.clone())?;
    session.events.emit(Event::BudgetExhausted {
        request_id,
        agent_id: Some(node.id.clone()),
        limit: limit.as_str().into(),
        usage: *usage,
    });
    session.set_state(&node.id, AgentState::WaitingBudget).await;
    let answer = tokio::select! {
        answer = receiver => answer.map_err(|_| ZaalisError::cancelled())?,
        () = cancel.cancelled() => return Err(ZaalisError::cancelled()),
    };
    if answer.stop {
        return Ok(false);
    }
    match answer.additional_tokens {
        Some(additional) => {
            node.budget.max_tokens = Some(
                node.budget
                    .max_tokens
                    .unwrap_or_else(|| usage.total_tokens())
                    .saturating_add(additional),
            );
        }
        None => node.budget.max_tokens = None,
    }
    // Non-token limits receive one conservative extra tranche as well; the
    // client protocol currently carries token increments only.
    if limit == zaalis_core::BudgetLimit::Rounds {
        node.budget.max_rounds = node.budget.max_rounds.map(|value| value.saturating_add(8));
    }
    if limit == zaalis_core::BudgetLimit::ToolCalls {
        node.budget.max_tool_calls = node
            .budget
            .max_tool_calls
            .map(|value| value.saturating_add(100));
    }
    if limit == zaalis_core::BudgetLimit::WallTime {
        node.budget.max_wall_time_ms = node
            .budget
            .max_wall_time_ms
            .map(|value| value.saturating_add(10 * 60 * 1_000));
    }
    session.update_runtime_limits(node).await;
    session.set_state(&node.id, AgentState::Running).await;
    Ok(true)
}

fn ensure_segment(
    session: &Arc<SessionInner>,
    node: &AgentNode,
    timeline: &mut Timeline,
    kind: SegmentKind,
) -> SegmentId {
    let slot = match kind {
        SegmentKind::Text => &mut timeline.text,
        SegmentKind::Reasoning => &mut timeline.reasoning,
        _ => unreachable!("stream segment kind"),
    };
    if slot.is_none() {
        let segment = Segment::new(node.id.clone(), kind, timeline.next_index, now_ms());
        timeline.next_index = timeline.next_index.saturating_add(1);
        session.events.emit(Event::SegmentStarted {
            segment: segment.clone(),
        });
        *slot = Some(segment);
    }
    slot.as_ref().expect("segment initialized").id.clone()
}

fn close_stream_segments(session: &Arc<SessionInner>, timeline: &mut Timeline) {
    for slot in [&mut timeline.reasoning, &mut timeline.text] {
        if let Some(mut segment) = slot.take() {
            segment.complete(now_ms());
            let duration_ms = segment.duration_ms();
            session.events.emit(Event::SegmentCompleted {
                segment_id: segment.id,
                duration_ms,
            });
        }
    }
}

fn remaining_tokens(node: &AgentNode, usage: &Usage) -> Option<u32> {
    node.budget.max_tokens.map(|limit| {
        limit
            .saturating_sub(usage.total_tokens())
            .clamp(1, u64::from(u32::MAX)) as u32
    })
}

fn collect_changed_files(outcome: &ToolOutcome, files: &mut Vec<String>) {
    let ToolOutcome::Ok { result, .. } = outcome else {
        return;
    };
    let candidates = result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("path").and_then(serde_json::Value::as_str));
    for path in candidates {
        if !files.iter().any(|known| known == path) {
            files.push(path.into());
        }
    }
}

/// Record evidence-based web usage in the same `Usage` object consumed by the
/// GUI, the CLI and the agent report.  The counters are deliberately derived
/// from successful typed tool payloads instead of model prose: a citation the
/// model merely mentions is not treated as a source it actually consulted.
fn collect_web_usage(name: &str, outcome: &ToolOutcome, usage: &mut Usage) {
    let ToolOutcome::Ok { result, .. } = outcome else {
        return;
    };
    let count = |key: &str| {
        result
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map_or(0, |items| items.len().min(u32::MAX as usize) as u32)
    };
    match name {
        "web_search" | "image_search" => {
            usage.web_queries = usage.web_queries.saturating_add(1);
            usage.web_results = usage.web_results.saturating_add(count("results"));
        }
        "deep_search" => {
            // `deep_search` performs one search and then reads each returned
            // source itself. Its payload contains `sources`, including failed
            // fetches, so only entries with a page count as pages read.
            usage.web_queries = usage.web_queries.saturating_add(1);
            let sources = result
                .get("sources")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            usage.web_results = usage
                .web_results
                .saturating_add(sources.len().min(u32::MAX as usize) as u32);
            let pages = sources
                .iter()
                .filter(|source| source.get("page").is_some())
                .count()
                .min(u32::MAX as usize) as u32;
            usage.web_pages_read = usage.web_pages_read.saturating_add(pages);
        }
        "web_fetch" | "fetch_asset" | "video_info" => {
            usage.web_pages_read = usage.web_pages_read.saturating_add(1);
        }
        _ => {}
    }
}

fn last_assistant_text(history: &[Message]) -> String {
    history
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant { text, .. } if !text.is_empty() => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn workspace_for_node(session: &SessionInner, node: &AgentNode) -> Result<zaalis_fs::Workspace> {
    match &node.workspace {
        None | Some(zaalis_core::Workspace::Direct) => Ok(session.config.workspace.clone()),
        Some(zaalis_core::Workspace::Worktree { path, .. })
        | Some(zaalis_core::Workspace::Snapshot { path }) => zaalis_fs::Workspace::open(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn computer_capture_is_an_attachment_not_tool_result_text() {
        let screenshot = "a".repeat(2_700_000);
        let mut outcome = ToolOutcome::Ok {
            summary: "computer observe".into(),
            result: json!({
                "name": "computer",
                "text": "Capture d’écran actuelle fournie au modèle.",
                "images": [{ "mime": "image/png", "data": screenshot }]
            }),
            duration_ms: 1,
        };

        let images = detach_tool_images(&mut outcome);

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data.len(), 2_700_000);
        let encoded = serde_json::to_string(&outcome).expect("outcome serializes");
        assert!(!encoded.contains("aaaa"));
        assert_eq!(outcome_result(&outcome)["capture_attached"], true);
        assert_eq!(outcome_result(&outcome)["images_attached"], 1);
    }

    #[test]
    fn mcp_image_content_becomes_attachments_with_text_placeholders() {
        let item = |data: &str| json!({ "type": "image", "mimeType": "image/png", "data": data });
        let mut outcome = ToolOutcome::Ok {
            summary: "MCP blender.viewport_screenshot".into(),
            result: json!({
                "content": [
                    { "type": "text", "text": "Vue 3D" },
                    item("one"), item("two"), item("three"), item("four"), item("five"),
                    { "type": "image", "mimeType": "text/html", "data": "<script>" },
                ],
                "isError": false
            }),
            duration_ms: 1,
        };

        let images = detach_tool_images(&mut outcome);

        assert_eq!(
            images
                .iter()
                .map(|image| image.data.as_str())
                .collect::<Vec<_>>(),
            ["one", "two", "three", "four"]
        );
        let result = outcome_result(&outcome);
        let content = result["content"].as_array().unwrap();
        assert_eq!(content[0]["text"], "Vue 3D");
        assert_eq!(
            content[1],
            json!({ "type": "text", "text": "[image 1 jointe au message suivant]" })
        );
        assert_eq!(
            content[5]["text"],
            "[image non transmise : trop d’images pour un seul appel]"
        );
        assert_eq!(content[6]["text"], "[image illisible ignorée]");
        assert!(content.iter().all(|item| item["type"] == "text"));
        assert_eq!(result["images_attached"], 4);
    }

    #[test]
    fn a_round_of_images_is_one_labelled_vision_message() {
        let part = |data: &str| zaalis_providers::ImagePart {
            mime: "image/png".into(),
            data: data.into(),
        };
        assert!(tool_images_message(Vec::new()).is_none());
        let desktop = tool_images_message(vec![("computer".into(), vec![part("d")])]).unwrap();
        assert!(
            matches!(&desktop, Message::User { text, images } if text == COMPUTER_CAPTURE_PROMPT && images.len() == 1)
        );
        let mixed = tool_images_message(vec![
            ("computer".into(), vec![part("d")]),
            (
                "mcp".into(),
                (0..10).map(|i| part(&i.to_string())).collect(),
            ),
        ])
        .unwrap();
        let Message::User { text, images } = &mixed else {
            panic!("user message")
        };
        assert!(text.starts_with(TOOL_IMAGES_PROMPT_PREFIX));
        assert!(text.contains("computer (1), mcp (7)"));
        assert_eq!(images.len(), MAX_IMAGES_PER_ROUND);
        assert!(is_tool_images_message(&mixed) && is_tool_images_message(&desktop));
        assert!(!is_tool_images_message(&Message::user(
            "[Images renvoyées par les outils, sans image]"
        )));
    }

    #[test]
    fn web_usage_counts_only_successful_typed_evidence() {
        let mut usage = Usage::default();
        let ok = |result| ToolOutcome::Ok {
            summary: "ok".into(),
            result,
            duration_ms: 1,
        };
        collect_web_usage(
            "web_search",
            &ok(json!({"results":[{"url":"https://a.example"},{"url":"https://b.example"}]})),
            &mut usage,
        );
        collect_web_usage(
            "deep_search",
            &ok(json!({"sources":[{"page":{"url":"https://a.example"}},{"error":"timeout"}]})),
            &mut usage,
        );
        collect_web_usage(
            "web_fetch",
            &ok(json!({"url":"https://b.example","text":"read"})),
            &mut usage,
        );
        collect_web_usage(
            "web_search",
            &ToolOutcome::Error {
                summary: "failed".into(),
                code: "network".into(),
                message: "offline".into(),
                duration_ms: 1,
            },
            &mut usage,
        );

        assert_eq!(usage.web_queries, 2);
        assert_eq!(usage.web_results, 4);
        assert_eq!(usage.web_pages_read, 2);
    }

    fn outcome_result(outcome: &ToolOutcome) -> &serde_json::Value {
        match outcome {
            ToolOutcome::Ok { result, .. } => result,
            _ => panic!("expected successful tool outcome"),
        }
    }
}
