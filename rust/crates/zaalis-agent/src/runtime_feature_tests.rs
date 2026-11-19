// Included by the scripted runtime fixture to keep feature scenarios separate.
#[tokio::test]
async fn tool_budget_extension_keeps_the_token_ceiling_and_resumes_the_batch() {
    let calls = (0..2).map(|index| TurnEvent::ToolCallCompleted { call: ProviderToolCall {
        id: format!("extension-{index}"), name: "read".into(), arguments: serde_json::json!({"path":"input.txt"}),
    }}).chain(std::iter::once(TurnEvent::Completed { reason: StopReason::ToolUse })).collect();
    let provider = Arc::new(ScriptedProvider::new(ProviderId::Mistral, vec![calls, vec![
        TurnEvent::TextDelta { text: "Lectures terminées".into() }, TurnEvent::Completed { reason: StopReason::EndTurn },
    ]]));
    let f = fixture(SessionRunMode::Chat, vec![provider]);
    let mut root = node(&f.session, ProviderId::Mistral, PermissionMode::ReadOnly);
    root.budget.max_tool_calls = Some(1); root.budget.max_tokens = Some(100_000);
    let id = f.session.add_root(root).await.unwrap();
    let mut events = f.session.subscribe();
    let running = { let session = f.session.clone(); tokio::spawn(async move { session.run_turn("Lis deux fichiers").await }) };
    let frame = next_matching(&mut events, |event| matches!(event, Event::BudgetExhausted { .. })).await;
    let Event::BudgetExhausted { request_id, limit, .. } = frame.event else { unreachable!() };
    assert_eq!(limit, "tool_calls");
    f.session.decide_budget(&request_id, BudgetAnswer { additional_tokens: None, stop: false }).unwrap();
    running.await.unwrap().unwrap();
    let snapshot = f.session.snapshot().await;
    assert_eq!(snapshot.histories.get(&id).unwrap().iter().filter(|m| matches!(m, Message::Tool { is_error: false, .. })).count(), 2);
    let tree = f.session.tree().await;
    assert_eq!(tree.get(&id).unwrap().budget.max_tokens, Some(100_000));
    assert_eq!(tree.get(&id).unwrap().budget.max_tool_calls, Some(101));
}

#[tokio::test]
async fn tool_budget_stops_inside_one_batch_without_orphaned_calls() {
    let calls = (0..3).map(|index| TurnEvent::ToolCallCompleted { call: ProviderToolCall {
        id: format!("budget-{index}"), name: "read".into(), arguments: serde_json::json!({"path":"input.txt"}),
    }}).chain(std::iter::once(TurnEvent::Completed { reason: StopReason::ToolUse })).collect();
    let provider = Arc::new(ScriptedProvider::new(ProviderId::Mistral, vec![calls]));
    let f = fixture(SessionRunMode::Chat, vec![provider.clone()]);
    let mut root = node(&f.session, ProviderId::Mistral, PermissionMode::ReadOnly);
    root.budget.max_tool_calls = Some(1);
    let id = f.session.add_root(root).await.unwrap();
    let mut events = f.session.subscribe();
    let running = { let session = f.session.clone(); tokio::spawn(async move { session.run_turn("Lis les trois fichiers").await }) };
    let frame = next_matching(&mut events, |event| matches!(event, Event::BudgetExhausted { .. })).await;
    let Event::BudgetExhausted { request_id, limit, .. } = frame.event else { unreachable!() };
    assert_eq!(limit, "tool_calls");
    f.session.decide_budget(&request_id, BudgetAnswer { additional_tokens: None, stop: true }).unwrap();
    running.await.unwrap().unwrap();
    let snapshot = f.session.snapshot().await;
    let history = snapshot.histories.get(&id).unwrap();
    assert_eq!(history.iter().filter(|m| matches!(m, Message::Tool { is_error: false, .. })).count(), 1);
    assert_eq!(history.iter().filter(|m| matches!(m, Message::Tool { is_error: true, .. })).count(), 2);
    let mut repaired = history.clone(); crate::context::repair_interrupted_tools(&mut repaired);
    assert_eq!(&repaired, history);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn progress_is_bounded_but_detailed_final_and_model_history_are_complete() {
    let progress = "Lecture é🚀 ".repeat(100);
    let final_answer = "Explication détaillée 🧪 ".repeat(100);
    let provider = Arc::new(ScriptedProvider::new(ProviderId::Mistral, vec![
        vec![TurnEvent::TextDelta { text: progress.clone() }, TurnEvent::ToolCallCompleted {
            call: ProviderToolCall { id: "read-progress".into(), name: "read".into(), arguments: serde_json::json!({"path":"input.txt"}) }
        }, TurnEvent::Completed { reason: StopReason::ToolUse }],
        vec![TurnEvent::TextDelta { text: final_answer.clone() }, TurnEvent::Completed { reason: StopReason::EndTurn }],
    ]));
    let f = fixture(SessionRunMode::Chat, vec![provider.clone()]);
    f.session.add_root(node(&f.session, ProviderId::Mistral, PermissionMode::ReadOnly)).await.unwrap();
    let mut events = f.session.subscribe();
    f.session.run_turn("Lis puis explique longuement").await.unwrap();
    let mut before_tool = String::new(); let mut after_tool = String::new(); let mut tool_seen = false;
    while let Ok(frame) = events.try_recv() {
        match frame.event {
            Event::ToolStarted { .. } => tool_seen = true,
            Event::TextDelta { text, .. } if tool_seen => after_tool.push_str(&text),
            Event::TextDelta { text, .. } => before_tool.push_str(&text),
            _ => {}
        }
    }
    assert_eq!(before_tool.chars().count(), 280);
    assert!(before_tool.ends_with('…'));
    assert_eq!(after_tool, final_answer);
    assert!(provider.requests.lock().unwrap()[1].messages.iter().any(|m| matches!(m, Message::Assistant {text,..} if text == &progress)));
}

#[tokio::test]
async fn clarification_rejects_invalid_answers_then_resumes_same_tool() {
    let provider = Arc::new(ScriptedProvider::new(
        ProviderId::Mistral,
        vec![
            vec![
                TurnEvent::ToolCallCompleted {
                    call: ProviderToolCall {
                        id: "question".into(),
                        name: "request_user_input".into(),
                        arguments: serde_json::json!({"questions":[{"id":"choice","prompt":"Quelle couleur ?","allow_free_text":false,"options":[{"label":"Bleu"},{"label":"Vert"}]}]}),
                    },
                },
                TurnEvent::Completed {
                    reason: StopReason::ToolUse,
                },
            ],
            vec![
                TurnEvent::TextDelta {
                    text: "Choix reçu".into(),
                },
                TurnEvent::Completed {
                    reason: StopReason::EndTurn,
                },
            ],
        ],
    ));
    let f = fixture(SessionRunMode::Chat, vec![provider.clone()]);
    f.session
        .add_root(node(
            &f.session,
            ProviderId::Mistral,
            PermissionMode::ReadOnly,
        ))
        .await
        .unwrap();
    let mut events = f.session.subscribe();
    let running = {
        let session = f.session.clone();
        tokio::spawn(async move { session.run_turn("Demande une couleur").await })
    };
    let event = next_matching(&mut events, |event| {
        matches!(event, Event::ClarificationRequested { .. })
    })
    .await;
    let Event::ClarificationRequested { request_id, .. } = event.event else {
        unreachable!()
    };
    assert!(f
        .session
        .decide_clarification(
            &request_id,
            [("choice".into(), "Rouge".into())].into_iter().collect()
        )
        .is_err());
    f.session
        .decide_clarification(
            &request_id,
            [("choice".into(), "Bleu".into())].into_iter().collect(),
        )
        .unwrap();
    running.await.unwrap().unwrap();
    assert!(provider.requests.lock().unwrap()[1]
        .messages
        .iter()
        .any(|message| matches!(message,Message::Tool {content,..} if content.contains("Bleu"))));
}

#[tokio::test]
async fn background_subagent_settles_before_session_turn_completes() {
    let done = || {
        vec![
            TurnEvent::TextDelta {
                text: "Terminé".into(),
            },
            TurnEvent::Completed {
                reason: StopReason::EndTurn,
            },
        ]
    };
    let provider = Arc::new(ScriptedProvider::new(
        ProviderId::Mistral,
        vec![
            vec![
                TurnEvent::ToolCallCompleted {
                    call: ProviderToolCall {
                        id: "background".into(),
                        name: "spawn_agent".into(),
                        arguments: serde_json::json!({"objective":"Inspection","background":true}),
                    },
                },
                TurnEvent::Completed {
                    reason: StopReason::ToolUse,
                },
            ],
            done(),
            done(),
        ],
    ));
    let f = fixture(SessionRunMode::Chat, vec![provider]);
    let parent = f
        .session
        .add_root(node(
            &f.session,
            ProviderId::Mistral,
            PermissionMode::Bypass,
        ))
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        f.session.run_turn("Délègue en parallèle"),
    )
    .await
    .unwrap()
    .unwrap();
    let tree = f.session.tree().await;
    assert_eq!(tree.len(), 2);
    assert!(tree.iter().all(|node| node.state.is_terminal()));
    let child = tree
        .iter()
        .find(|node| node.parent_id.as_ref() == Some(&parent))
        .unwrap();
    let result = f
        .session
        .inner
        .tools
        .invoke(
            ToolInvocation {
                call_id: ToolCallId::new(),
                name: "agent_status".into(),
                input: serde_json::json!({"agent_id":child.id}),
            },
            ToolContext {
                agent_id: parent,
                permissions: PermissionSet::new(PermissionMode::ReadOnly),
                workspace: Workspace::open(&f.root).unwrap(),
            },
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(result,ToolDispatch::Complete {outcome:ToolOutcome::Ok {result,..},..} if result["report"]["summary"]=="Terminé")
    );
}
