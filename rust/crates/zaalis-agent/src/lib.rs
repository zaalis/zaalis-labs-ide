//! The provider-neutral zaalis agent runtime.
//!
//! A classic chat and a team both execute an [`AgentTree`]. Every model turn,
//! tool invocation, permission prompt and budget pause is emitted as a typed
//! protocol event, and the same loop serves all eight providers.

mod control;
mod event_bus;
mod interaction;
mod runner;
mod session;
mod spawn;

pub use event_bus::EventBus;
pub use interaction::{BudgetAnswer, InteractionHub, PlanAnswer};
pub use session::{AgentSession, AgentSessionSnapshot, SessionConfig, SessionRunMode};

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures_util::stream::{self, StreamExt};
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;
    use zaalis_core::{
        now_ms, AgentNode, Budget, ModelBinding, PermissionMode, PermissionSet, ProviderId,
        RoleSpec, ToolCallId, Usage,
    };
    use zaalis_fs::Workspace;
    use zaalis_guard::Guard;
    use zaalis_protocol::{Event, ToolOutcome};
    use zaalis_providers::{
        Capabilities, ModelProvider, PoolConfig, ProviderError, ProviderPool, ProviderStream,
        StopReason, ToolInvocation as ProviderToolCall, TurnEvent, TurnRequest,
    };
    use zaalis_tools::{
        register_filesystem_tools, ToolContext, ToolDispatch, ToolInvocation, ToolRuntime,
    };

    #[derive(Debug)]
    struct ScriptedProvider {
        id: ProviderId,
        turns: Mutex<VecDeque<Vec<TurnEvent>>>,
        requests: Mutex<Vec<TurnRequest>>,
    }

    impl ScriptedProvider {
        fn new(id: ProviderId, turns: Vec<Vec<TurnEvent>>) -> Self {
            Self {
                id,
                turns: Mutex::new(turns.into()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl ModelProvider for ScriptedProvider {
        fn id(&self) -> ProviderId {
            self.id
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        async fn stream_turn(
            &self,
            request: TurnRequest,
            _cancel: CancellationToken,
        ) -> std::result::Result<ProviderStream, ProviderError> {
            self.requests.lock().expect("requests lock").push(request);
            let events = self
                .turns
                .lock()
                .expect("turns lock")
                .pop_front()
                .ok_or_else(|| ProviderError::invalid("script épuisé"))?;
            Ok(stream::iter(events).boxed())
        }
    }

    struct Fixture {
        _dir: TempDir,
        root: PathBuf,
        session: AgentSession,
    }

    fn fixture(mode: SessionRunMode, providers: Vec<Arc<dyn ModelProvider>>) -> Fixture {
        let dir = TempDir::new().expect("tempdir");
        let root = dir.path().join("workspace");
        fs::create_dir(&root).expect("workspace dir");
        fs::write(root.join("input.txt"), "fixture\n").expect("fixture");
        let workspace = Workspace::open(&root).expect("workspace");
        let pool = Arc::new(ProviderPool::new(PoolConfig {
            max_retries: 0,
            ..PoolConfig::default()
        }));
        for provider in providers {
            pool.register(provider);
        }
        let mut tools = ToolRuntime::new(Guard::new());
        register_filesystem_tools(&mut tools).expect("tools");
        let config = SessionConfig::new(workspace, mode);
        Fixture {
            _dir: dir,
            root,
            session: AgentSession::new(config, pool, Arc::new(tools)),
        }
    }

    fn node(session: &AgentSession, provider: ProviderId, mode: PermissionMode) -> AgentNode {
        AgentNode::new(
            session.id().clone(),
            RoleSpec::general_purpose(),
            ModelBinding::new(provider, Some("test-model".into())),
            PermissionSet::new(mode),
            now_ms(),
        )
        .with_objective("Tester la boucle")
    }

    async fn next_matching(
        receiver: &mut tokio::sync::broadcast::Receiver<zaalis_protocol::EventFrame>,
        predicate: impl Fn(&Event) -> bool,
    ) -> zaalis_protocol::EventFrame {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let frame = receiver.recv().await.expect("event");
                if predicate(&frame.event) {
                    return frame;
                }
            }
        })
        .await
        .expect("event timeout")
    }

    #[tokio::test]
    async fn one_agent_streams_typed_segments_and_completes() {
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![vec![
                TurnEvent::ReasoningDelta {
                    text: "analyse".into(),
                },
                TurnEvent::TextDelta {
                    text: "bonjour".into(),
                },
                TurnEvent::Usage {
                    usage: Usage {
                        input_tokens: 10,
                        output_tokens: 2,
                        ..Usage::default()
                    },
                },
                TurnEvent::Completed {
                    reason: StopReason::EndTurn,
                },
            ]],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider]);
        let agent = fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::ReadOnly,
            ))
            .await
            .unwrap();
        let mut events = fixture.session.subscribe();
        let usage = fixture.session.run_turn("Salut").await.unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (10, 2));
        let tree = fixture.session.tree().await;
        assert!(matches!(
            tree.get(&agent).unwrap().state,
            zaalis_core::AgentState::Done
        ));
        let mut kinds = Vec::new();
        while let Ok(frame) = events.try_recv() {
            if matches!(
                frame.event,
                Event::TextDelta { .. } | Event::ReasoningDelta { .. }
            ) {
                assert_eq!(frame.agent_id.as_ref(), Some(&agent));
            }
            kinds.push(frame.event.kind());
        }
        assert!(kinds.contains(&"reasoning_delta"));
        assert!(kinds.contains(&"text_delta"));
        assert!(kinds.contains(&"agent_completed"));
        assert_eq!(kinds.last(), Some(&"turn_completed"));
    }

    #[tokio::test]
    async fn supervised_tool_call_pauses_then_resumes_after_permission() {
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "call_write".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({"path":"created.txt","content":"ok\n"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Terminé".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider]);
        fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Supervised,
            ))
            .await
            .unwrap();
        let mut events = fixture.session.subscribe();
        let running = {
            let session = fixture.session.clone();
            tokio::spawn(async move { session.run_turn("Crée le fichier").await })
        };
        let frame = next_matching(&mut events, |event| {
            matches!(event, Event::PermissionRequested { .. })
        })
        .await;
        let Event::PermissionRequested { request_id, .. } = frame.event else {
            unreachable!()
        };
        fixture
            .session
            .decide_permission(
                &request_id,
                zaalis_core::PermissionAnswer::Allow {
                    scope: zaalis_core::GrantScope::Once,
                },
            )
            .unwrap();
        running.await.unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("created.txt")).unwrap(),
            "ok\n"
        );
        let completed = next_matching(&mut events, |event| {
            matches!(
                event,
                Event::ToolCompleted {
                    outcome: ToolOutcome::Ok { .. },
                    ..
                }
            )
        })
        .await;
        assert!(matches!(completed.event, Event::ToolCompleted { .. }));
    }

    #[tokio::test]
    async fn completion_gate_asks_a_root_to_verify_a_multi_file_change_once() {
        // A root agent creates two files in one turn, then tries to conclude
        // without reading anything back. The gate injects exactly one
        // verification nudge; after the agent verifies, it finishes — and the
        // nudge never fires a second time, so no loop can form.
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "w1".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({"path":"a.txt","content":"a\n"}),
                        },
                    },
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "w2".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({"path":"b.txt","content":"b\n"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                // The model narrates as if the work were still ahead of it.
                vec![
                    TurnEvent::TextDelta {
                        text: "Je vais créer les fichiers.".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
                // After the nudge it reads one file back (verification)…
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "r1".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({"path":"a.txt"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                // …then concludes for real.
                vec![
                    TurnEvent::TextDelta {
                        text: "Fait : a.txt et b.txt créés et vérifiés.".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider.clone()]);
        let agent = fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Bypass,
            ))
            .await
            .unwrap();
        fixture.session.run_turn("Crée a et b").await.unwrap();
        // Four provider turns: write ×2 → (nudge) narration → read → final.
        assert_eq!(provider.requests.lock().unwrap().len(), 4);
        let tree = fixture.session.tree().await;
        assert!(matches!(
            tree.get(&agent).unwrap().state,
            zaalis_core::AgentState::Done
        ));
        assert!(fixture.root.join("a.txt").exists());
        assert!(fixture.root.join("b.txt").exists());
    }

    #[tokio::test]
    async fn task_state_and_grounding_rule_reach_the_model_each_round() {
        // The mechanism behind the Mistral fix: after a write, the next request's
        // system prompt states the file is already created and forbids narrating
        // it as future work — and the rule is present from the very first round.
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "w".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({"path":"index.html","content":"<h1>ok</h1>\n"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Fait : index.html créé.".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider.clone()]);
        fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Bypass,
            ))
            .await
            .unwrap();
        fixture.session.run_turn("Crée index.html").await.unwrap();

        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        // The grounding rule is in every round, including the first.
        assert!(requests[0].system.contains("Ne présente jamais"));
        // No task state before anything is written…
        assert!(!requests[0].system.contains("index.html"));
        // …and after the write, the second round's system prompt carries the
        // real state, exactly once (it replaces rather than accumulates).
        let after = &requests[1].system;
        assert!(after.contains("Fichiers déjà créés/modifiés"));
        assert!(after.contains("index.html"));
        assert_eq!(after.matches("Fichiers déjà créés/modifiés").count(), 1);
    }

    #[tokio::test]
    async fn a_single_file_change_never_trips_the_completion_gate() {
        // The trivial case must stay light: one edit, then a conclusion, and the
        // agent stops without an extra verification round.
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "e".into(),
                            name: "edit".into(),
                            arguments: serde_json::json!({
                                "path":"input.txt",
                                "hunks":[{"search":"fixture","replace":"modifie"}]
                            }),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Ligne modifiée.".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider.clone()]);
        fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Bypass,
            ))
            .await
            .unwrap();
        fixture.session.run_turn("Modifie une ligne").await.unwrap();
        // Two rounds only: no gate nudge for a single change.
        assert_eq!(provider.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_gate_does_not_loop_once_the_work_is_verified() {
        // Two writes then a read (verification) then a conclusion: the gate is
        // satisfied and adds no further round.
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "w1".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({"path":"a.txt","content":"a\n"}),
                        },
                    },
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "w2".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({"path":"b.txt","content":"b\n"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "r".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({"path":"a.txt"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Fait et vérifié.".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider.clone()]);
        fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Bypass,
            ))
            .await
            .unwrap();
        fixture.session.run_turn("Crée a et b").await.unwrap();
        // Exactly three rounds — no spurious verification loop.
        assert_eq!(provider.requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_failed_tool_result_is_delivered_to_the_model_with_its_error_flag() {
        // The runtime feeds a structured error back rather than swallowing it, so
        // the model can see the failure instead of assuming success.
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "x".into(),
                            name: "outil_inexistant".into(),
                            arguments: serde_json::json!({}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "L'outil a échoué, je le signale.".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider]);
        let agent = fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Bypass,
            ))
            .await
            .unwrap();
        fixture.session.run_turn("Utilise un outil").await.unwrap();
        let snapshot = fixture.session.snapshot().await;
        let history = snapshot.histories.get(&agent).expect("history");
        let json = serde_json::to_string(history).unwrap();
        assert!(json.contains("\"is_error\":true"));
        assert!(json.contains("\"role\":\"tool\""));
    }

    #[tokio::test]
    async fn plan_mode_waits_for_approval_before_implementation_round() {
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::TextDelta {
                        text: "1. Lire\n2. Modifier".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Implémentation terminée".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Plan, vec![provider]);
        fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Plan,
            ))
            .await
            .unwrap();
        let mut events = fixture.session.subscribe();
        let running = {
            let session = fixture.session.clone();
            tokio::spawn(async move { session.run_turn("Prépare puis exécute").await })
        };
        let frame = next_matching(&mut events, |event| {
            matches!(event, Event::PlanReady { .. })
        })
        .await;
        let Event::PlanReady {
            request_id,
            content,
            ..
        } = frame.event
        else {
            unreachable!()
        };
        assert!(content.contains("Modifier"));
        fixture
            .session
            .decide_plan(&request_id, PlanAnswer::Approve)
            .unwrap();
        running.await.unwrap().unwrap();
        assert!(fixture
            .session
            .tree()
            .await
            .iter()
            .all(|agent| agent.state.is_terminal()));
    }

    #[tokio::test]
    async fn dag_dependency_runs_after_its_predecessor_even_on_another_provider() {
        let mistral = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![vec![
                TurnEvent::TextDelta { text: "A".into() },
                TurnEvent::Completed {
                    reason: StopReason::EndTurn,
                },
            ]],
        ));
        let claude = Arc::new(ScriptedProvider::new(
            ProviderId::Claude,
            vec![vec![
                TurnEvent::TextDelta { text: "B".into() },
                TurnEvent::Completed {
                    reason: StopReason::EndTurn,
                },
            ]],
        ));
        let fixture = fixture(SessionRunMode::Team, vec![mistral, claude]);
        let first = fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::ReadOnly,
            ))
            .await
            .unwrap();
        let second_node = node(
            &fixture.session,
            ProviderId::Claude,
            PermissionMode::ReadOnly,
        )
        .with_dependencies([first.clone()]);
        let second = fixture.session.add_root(second_node).await.unwrap();
        let mut events = fixture.session.subscribe();
        fixture.session.run_turn("Travail en équipe").await.unwrap();
        let mut first_done = None;
        let mut second_running = None;
        while let Ok(frame) = events.try_recv() {
            match frame.event {
                Event::AgentCompleted { agent_id, .. } if agent_id == first => {
                    first_done = Some(frame.seq)
                }
                Event::AgentStateChanged {
                    agent_id,
                    state: zaalis_core::AgentState::Running,
                } if agent_id == second => second_running = Some(frame.seq),
                _ => {}
            }
        }
        assert!(first_done.unwrap() < second_running.unwrap());
    }

    #[tokio::test]
    async fn budget_limit_pauses_and_extension_resumes() {
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "read_1".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({"path":"input.txt"}),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "après extension".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider]);
        let mut limited = node(
            &fixture.session,
            ProviderId::Mistral,
            PermissionMode::ReadOnly,
        );
        limited.budget = Budget {
            max_rounds: Some(1),
            ..Budget::default_root()
        };
        fixture.session.add_root(limited).await.unwrap();
        let mut events = fixture.session.subscribe();
        let running = {
            let session = fixture.session.clone();
            tokio::spawn(async move { session.run_turn("Lis puis réponds").await })
        };
        let frame = next_matching(&mut events, |event| {
            matches!(event, Event::BudgetExhausted { .. })
        })
        .await;
        let Event::BudgetExhausted {
            request_id, limit, ..
        } = frame.event
        else {
            unreachable!()
        };
        assert_eq!(limit, "rounds");
        fixture
            .session
            .decide_budget(
                &request_id,
                BudgetAnswer {
                    additional_tokens: Some(10_000),
                    stop: false,
                },
            )
            .unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn native_spawn_inherits_limits_runs_child_and_uses_snapshot_off_git() {
        let provider = Arc::new(ScriptedProvider::new(
            ProviderId::Mistral,
            vec![
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "spawn_1".into(),
                            name: "spawn_agent".into(),
                            arguments: serde_json::json!({
                                "objective":"Inspecte le projet",
                                "role":{"name":"inspect","label":"Inspection","instructions":"Lis précisément.","mutating":true}
                            }),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::ToolCallCompleted {
                        call: ProviderToolCall {
                            id: "child_write".into(),
                            name: "write".into(),
                            arguments: serde_json::json!({
                                "path":"child.txt","content":"depuis enfant\n"
                            }),
                        },
                    },
                    TurnEvent::Completed {
                        reason: StopReason::ToolUse,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Rapport enfant".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
                vec![
                    TurnEvent::TextDelta {
                        text: "Rapport parent".into(),
                    },
                    TurnEvent::Completed {
                        reason: StopReason::EndTurn,
                    },
                ],
            ],
        ));
        let fixture = fixture(SessionRunMode::Chat, vec![provider.clone()]);
        let parent = fixture
            .session
            .add_root(node(
                &fixture.session,
                ProviderId::Mistral,
                PermissionMode::Bypass,
            ))
            .await
            .unwrap();
        fixture
            .session
            .run_turn("Délègue l'inspection")
            .await
            .unwrap();
        let tree = fixture.session.tree().await;
        assert_eq!(tree.len(), 2);
        let child = tree
            .iter()
            .find(|agent| agent.parent_id.as_ref() == Some(&parent))
            .expect("child");
        assert!(matches!(
            child.workspace,
            Some(zaalis_core::Workspace::Snapshot { .. })
        ));
        assert!(matches!(child.state, zaalis_core::AgentState::Done));
        assert_eq!(child.model.provider, ProviderId::Mistral);
        assert!(
            child.permissions.mode.restriction_rank() <= PermissionMode::Bypass.restriction_rank()
        );
        assert!(child.depth == 1 && child.budget.max_depth <= Some(2));
        assert_eq!(provider.requests.lock().unwrap().len(), 4);
        let child_id = child.id.clone();
        let child_workspace = match child.workspace.as_ref().unwrap() {
            zaalis_core::Workspace::Snapshot { path } => PathBuf::from(path),
            other => panic!("expected snapshot, got {other:?}"),
        };
        assert_eq!(
            fs::read_to_string(child_workspace.join("child.txt")).unwrap(),
            "depuis enfant\n"
        );
        assert!(!fixture.root.join("child.txt").exists());

        let dispatch = fixture
            .session
            .inner
            .tools
            .invoke(
                ToolInvocation {
                    call_id: ToolCallId::from_raw("merge_1"),
                    name: "merge_agent".into(),
                    input: serde_json::json!({"agent_id":child_id}),
                },
                ToolContext {
                    agent_id: parent,
                    permissions: PermissionSet::new(PermissionMode::Bypass),
                    workspace: Workspace::open(&fixture.root).unwrap(),
                },
                CancellationToken::new(),
            )
            .await;
        let ToolDispatch::PermissionRequired(prompt) = dispatch else {
            panic!("merge should require explicit approval: {dispatch:?}");
        };
        let merged = fixture
            .session
            .inner
            .tools
            .resolve(
                &prompt.request_id,
                zaalis_core::PermissionAnswer::Allow {
                    scope: zaalis_core::GrantScope::Once,
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            merged,
            ToolDispatch::Complete {
                outcome: ToolOutcome::Ok { .. },
                ..
            }
        ));
        assert_eq!(
            fs::read_to_string(fixture.root.join("child.txt")).unwrap(),
            "depuis enfant\n"
        );
    }
}
