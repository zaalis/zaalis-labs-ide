use crate::control::NativePlanTool;
use crate::event_bus::EventBus;
use crate::interaction::{BudgetAnswer, InteractionHub, PlanAnswer};
use crate::runner::{run_agent, run_lifecycle_hook, AgentRun};
use crate::spawn::{NativeMergeTool, NativeSpawnTool};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use zaalis_core::{
    now_ms, AgentId, AgentNode, AgentState, AgentTree, Budget, PermissionAnswer, PermissionSet,
    Result, RoleSpec, SessionId, TreeError, Usage, ZaalisError,
};
use zaalis_fs::Workspace;
use zaalis_protocol::{AgentReport, Event, EventFrame};
use zaalis_providers::{Message, ProviderPool};
use zaalis_tools::ToolRuntime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRunMode {
    Chat,
    Team,
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionSnapshot {
    pub session_id: SessionId,
    pub workspace: PathBuf,
    pub mode: SessionRunMode,
    pub system_prompt: String,
    pub tree: AgentTree,
    pub histories: HashMap<AgentId, Vec<Message>>,
    pub reports: HashMap<AgentId, AgentReport>,
    #[serde(default)]
    pub plan_mode: bool,
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_id: SessionId,
    pub workspace: Workspace,
    pub mode: SessionRunMode,
    pub system_prompt: String,
    pub max_concurrency: usize,
    pub extensions: Option<Arc<zaalis_extensions::ExtensionRuntime>>,
}

impl SessionConfig {
    pub fn new(workspace: Workspace, mode: SessionRunMode) -> Self {
        Self {
            session_id: SessionId::new(),
            workspace,
            mode,
            system_prompt:
                "Tu es un agent Zaalis. Utilise les outils typés, vérifie ton travail, et rapporte au passé ce que tu as réellement fait."
                    .into(),
            max_concurrency: 8,
            extensions: None,
        }
    }
}

#[derive(Debug)]
pub(crate) struct SessionInner {
    pub config: SessionConfig,
    pub tree: Mutex<AgentTree>,
    pub histories: Mutex<HashMap<AgentId, Vec<Message>>>,
    pub reports: Mutex<HashMap<AgentId, AgentReport>>,
    pub providers: Arc<ProviderPool>,
    pub tools: Arc<ToolRuntime>,
    pub interactions: Arc<InteractionHub>,
    pub events: Arc<EventBus>,
    pub cancel: CancellationToken,
    pub concurrency: Arc<Semaphore>,
    pub agent_cancels: Mutex<HashMap<AgentId, CancellationToken>>,
    pub hook_agents: Mutex<HashSet<AgentId>>,
    pub plan_mode: AtomicBool,
    hook_session_started: AtomicBool,
    hook_stopped: AtomicBool,
    hook_session_ended: AtomicBool,
    turn_lock: Mutex<()>,
}

#[derive(Debug, Clone)]
pub struct AgentSession {
    pub(crate) inner: Arc<SessionInner>,
}

impl AgentSession {
    pub fn new(
        config: SessionConfig,
        providers: Arc<ProviderPool>,
        tools: Arc<ToolRuntime>,
    ) -> Self {
        let events = Arc::new(EventBus::new(config.session_id.clone(), 4_096));
        let max_concurrency = config.max_concurrency.max(1);
        let initial_plan = config.mode == SessionRunMode::Plan;
        let inner = Arc::new(SessionInner {
            config,
            tree: Mutex::new(AgentTree::new()),
            histories: Mutex::new(HashMap::new()),
            reports: Mutex::new(HashMap::new()),
            providers,
            tools,
            interactions: Arc::new(InteractionHub::default()),
            events,
            cancel: CancellationToken::new(),
            concurrency: Arc::new(Semaphore::new(max_concurrency)),
            agent_cancels: Mutex::new(HashMap::new()),
            hook_agents: Mutex::new(HashSet::new()),
            plan_mode: AtomicBool::new(initial_plan),
            hook_session_started: AtomicBool::new(false),
            hook_stopped: AtomicBool::new(false),
            hook_session_ended: AtomicBool::new(false),
            turn_lock: Mutex::new(()),
        });
        inner
            .tools
            .register(NativeSpawnTool::new(Arc::downgrade(&inner)))
            .expect("register native spawn_agent tool");
        inner
            .tools
            .register(NativeMergeTool::new(Arc::downgrade(&inner)))
            .expect("register native merge_agent tool");
        inner
            .tools
            .register(NativePlanTool::new(Arc::downgrade(&inner), true))
            .expect("register enter_plan_mode tool");
        inner
            .tools
            .register(NativePlanTool::new(Arc::downgrade(&inner), false))
            .expect("register exit_plan_mode tool");
        Self { inner }
    }

    pub fn id(&self) -> &SessionId {
        &self.inner.config.session_id
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<EventFrame> {
        self.inner.events.subscribe()
    }

    pub async fn tree(&self) -> AgentTree {
        self.inner.tree.lock().await.clone()
    }

    pub async fn snapshot(&self) -> AgentSessionSnapshot {
        AgentSessionSnapshot {
            session_id: self.inner.config.session_id.clone(),
            workspace: self.inner.config.workspace.root().to_path_buf(),
            mode: self.inner.config.mode,
            system_prompt: self.inner.config.system_prompt.clone(),
            tree: self.inner.tree.lock().await.clone(),
            histories: self.inner.histories.lock().await.clone(),
            reports: self.inner.reports.lock().await.clone(),
            plan_mode: self.inner.plan_mode.load(Ordering::SeqCst),
        }
    }

    pub async fn restore(&self, snapshot: AgentSessionSnapshot) -> Result<()> {
        if snapshot.session_id != self.inner.config.session_id
            || snapshot.workspace != self.inner.config.workspace.root()
            || snapshot.mode != self.inner.config.mode
            || snapshot.system_prompt != self.inner.config.system_prompt
        {
            return Err(ZaalisError::invalid("snapshot de session incompatible"));
        }
        if snapshot
            .tree
            .iter()
            .any(|node| node.session_id != snapshot.session_id)
        {
            return Err(ZaalisError::invalid("snapshot avec identités incohérentes"));
        }
        *self.inner.tree.lock().await = snapshot.tree;
        *self.inner.histories.lock().await = snapshot.histories;
        *self.inner.reports.lock().await = snapshot.reports;
        self.inner
            .plan_mode
            .store(snapshot.plan_mode, Ordering::SeqCst);
        Ok(())
    }

    pub async fn add_root(&self, node: AgentNode) -> Result<AgentId> {
        let agent = node.clone();
        let id = self
            .inner
            .tree
            .lock()
            .await
            .insert_root(node)
            .map_err(tree_error)?;
        self.inner.events.emit(Event::AgentSpawned {
            agent: Box::new(agent),
        });
        Ok(id)
    }

    pub async fn add_child(&self, parent: &AgentId, node: AgentNode) -> Result<AgentId> {
        let id = self
            .inner
            .tree
            .lock()
            .await
            .insert_child(parent, node)
            .map_err(tree_error)?;
        let agent = self
            .inner
            .tree
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| ZaalisError::internal("agent inséré introuvable"))?;
        self.inner.events.emit(Event::AgentSpawned {
            agent: Box::new(agent),
        });
        Ok(id)
    }

    pub async fn update_agent(
        &self,
        id: &AgentId,
        role: Option<RoleSpec>,
        model: Option<zaalis_core::ModelBinding>,
        permissions: Option<PermissionSet>,
        budget: Option<Budget>,
    ) -> Result<AgentNode> {
        let mut tree = self.inner.tree.lock().await;
        let parent = tree.get(id).and_then(|node| node.parent_id.clone());
        let parent_limits = parent
            .as_ref()
            .and_then(|parent| tree.get(parent))
            .map(|node| (node.permissions.clone(), node.budget));
        let node = tree
            .get_mut(id)
            .ok_or_else(|| ZaalisError::not_found("agent introuvable"))?;
        if !matches!(
            node.state,
            AgentState::Pending
                | AgentState::Done
                | AgentState::Failed { .. }
                | AgentState::Cancelled
        ) {
            return Err(ZaalisError::invalid("agent actif non modifiable"));
        }
        if let Some(role) = role {
            node.role = role;
        }
        if let Some(model) = model {
            node.model = model;
        }
        if let Some(value) = permissions {
            node.permissions = parent_limits
                .as_ref()
                .map_or(value.clone(), |limits| value.intersect(&limits.0));
        }
        if let Some(value) = budget {
            node.budget = parent_limits
                .as_ref()
                .map_or(value, |limits| value.clamp_to(&limits.1));
        }
        Ok(node.clone())
    }

    pub async fn remove_agent(&self, id: &AgentId) -> Result<Vec<AgentId>> {
        let removed = self
            .inner
            .tree
            .lock()
            .await
            .remove_subtree(id)
            .map_err(tree_error)?;
        let mut histories = self.inner.histories.lock().await;
        let mut reports = self.inner.reports.lock().await;
        for id in &removed {
            histories.remove(id);
            reports.remove(id);
        }
        Ok(removed)
    }

    pub async fn add_dependency(&self, agent: &AgentId, dependency: &AgentId) -> Result<()> {
        self.inner
            .tree
            .lock()
            .await
            .add_dependency(agent, dependency)
            .map_err(tree_error)
    }

    pub fn tool_definitions(&self) -> Vec<zaalis_tools::ToolDefinition> {
        self.inner.tools.definitions()
    }

    pub async fn seed_history(&self, id: &AgentId, history: Vec<Message>) -> Result<()> {
        if self.inner.tree.lock().await.get(id).is_none() {
            return Err(ZaalisError::not_found("agent introuvable"));
        }
        self.inner
            .histories
            .lock()
            .await
            .insert(id.clone(), history);
        Ok(())
    }

    pub async fn run_turn(&self, prompt: impl Into<String>) -> Result<Usage> {
        self.run_turn_with(prompt.into(), Vec::new(), None).await
    }

    pub async fn run_turn_with(
        &self,
        prompt: String,
        images: Vec<zaalis_providers::ImagePart>,
        target: Option<AgentId>,
    ) -> Result<Usage> {
        let _turn = self.inner.turn_lock.lock().await;
        if prompt.trim().is_empty() {
            return Err(ZaalisError::invalid("prompt vide"));
        }
        self.inner.events.emit(Event::TurnStarted {
            prompt: prompt.clone(),
        });
        self.prepare_turn(&prompt, images, target).await?;

        let hook_root = {
            let tree = self.inner.tree.lock().await;
            tree.roots().first().and_then(|id| tree.get(id)).cloned()
        };
        let first_session_turn = !self.inner.hook_session_started.swap(true, Ordering::AcqRel);
        if first_session_turn {
            if let Some(root) = hook_root {
                run_lifecycle_hook(
                    Arc::clone(&self.inner),
                    root,
                    zaalis_extensions::HookEvent::SessionStart,
                    serde_json::json!({"prompt":prompt}),
                )
                .await?;
            }
        }

        let mut tasks: JoinSet<(AgentId, Result<AgentRun>)> = JoinSet::new();
        loop {
            self.refresh_blocked_states().await;
            let ready = self.inner.tree.lock().await.ready();
            for id in ready {
                let permit = match Arc::clone(&self.inner.concurrency).try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => break,
                };
                let node = {
                    let mut tree = self.inner.tree.lock().await;
                    let node = tree
                        .get_mut(&id)
                        .ok_or_else(|| ZaalisError::internal("agent prêt introuvable"))?;
                    node.state = AgentState::Running;
                    node.started_at_ms = Some(now_ms());
                    node.clone()
                };
                self.inner.events.emit(Event::AgentStateChanged {
                    agent_id: id.clone(),
                    state: AgentState::Running,
                });
                let mut history = self
                    .inner
                    .histories
                    .lock()
                    .await
                    .get(&id)
                    .cloned()
                    .unwrap_or_default();
                let dependency_reports = {
                    let reports = self.inner.reports.lock().await;
                    node.depends_on
                        .iter()
                        .filter_map(|dependency| {
                            reports
                                .get(dependency)
                                .map(|report| format!("[{dependency}] {}", report.summary))
                        })
                        .collect::<Vec<_>>()
                };
                if !dependency_reports.is_empty() {
                    history.push(Message::user(format!(
                        "Contributions vérifiées des agents dont tu dépends :\n\n{}\n\nUtilise-les pour produire ton propre résultat.",
                        dependency_reports.join("\n\n")
                    )));
                }
                let inner = Arc::clone(&self.inner);
                let cancel = self.inner.cancel.child_token();
                self.inner
                    .agent_cancels
                    .lock()
                    .await
                    .insert(id.clone(), cancel.clone());
                tasks.spawn(async move {
                    let _permit = permit;
                    let result = run_agent(Arc::clone(&inner), node, history, cancel).await;
                    (id, result)
                });
            }

            if tasks.is_empty() {
                if self.inner.tree.lock().await.is_settled() {
                    break;
                }
                return Err(ZaalisError::internal(
                    "ordonnanceur bloqué sans agent exécutable",
                ));
            }

            let Some(joined) = tasks.join_next().await else {
                continue;
            };
            let (id, result) = joined.map_err(|error| {
                ZaalisError::internal(format!("tâche agent interrompue : {error}"))
            })?;
            self.inner.finish_agent(&id, result).await;
            self.inner.agent_cancels.lock().await.remove(&id);
        }

        let usage = self.inner.tree.lock().await.total_usage();
        self.inner.events.emit(Event::TurnCompleted {
            usage,
            summary: None,
        });
        Ok(usage)
    }

    pub fn decide_permission(
        &self,
        id: &zaalis_core::RequestId,
        answer: PermissionAnswer,
    ) -> Result<()> {
        self.inner.interactions.decide_permission(id, answer)
    }

    pub fn decide_plan(&self, id: &zaalis_core::RequestId, answer: PlanAnswer) -> Result<()> {
        self.inner.interactions.decide_plan(id, answer)
    }

    pub fn decide_budget(&self, id: &zaalis_core::RequestId, answer: BudgetAnswer) -> Result<()> {
        self.inner.interactions.decide_budget(id, answer)
    }

    pub async fn cancel(&self) {
        let first_stop = !self.inner.hook_stopped.swap(true, Ordering::AcqRel);
        let roots = {
            let tree = self.inner.tree.lock().await;
            tree.roots()
                .iter()
                .filter_map(|id| tree.get(id))
                .cloned()
                .collect::<Vec<_>>()
        };
        if first_stop {
            for root in roots {
                let _ = run_lifecycle_hook(
                    Arc::clone(&self.inner),
                    root,
                    zaalis_extensions::HookEvent::Stop,
                    serde_json::json!({"reason":"cancelled"}),
                )
                .await;
            }
        }
        self.inner.cancel.cancel();
        self.inner.interactions.cancel_all();
        let changed = {
            let mut tree = self.inner.tree.lock().await;
            let roots = tree.roots().to_vec();
            roots
                .into_iter()
                .flat_map(|root| tree.cancel_subtree(&root))
                .collect::<Vec<_>>()
        };
        for agent_id in changed {
            self.inner.events.emit(Event::AgentCancelled { agent_id });
        }
    }

    pub async fn end(&self) -> Result<()> {
        if self.inner.hook_session_ended.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let (root, usage) = {
            let tree = self.inner.tree.lock().await;
            (
                tree.roots().first().and_then(|id| tree.get(id)).cloned(),
                tree.total_usage(),
            )
        };
        if let Some(root) = root {
            run_lifecycle_hook(
                Arc::clone(&self.inner),
                root,
                zaalis_extensions::HookEvent::SessionEnd,
                serde_json::json!({"usage":usage}),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn cancel_agent(&self, id: &AgentId) -> Result<Vec<AgentId>> {
        let ids = self.inner.tree.lock().await.subtree(id);
        if ids.is_empty() {
            return Err(ZaalisError::not_found("agent introuvable"));
        }
        let cancels = self.inner.agent_cancels.lock().await;
        for id in &ids {
            if let Some(cancel) = cancels.get(id) {
                cancel.cancel();
            }
        }
        drop(cancels);
        let changed = self.inner.tree.lock().await.cancel_subtree(id);
        for agent_id in &changed {
            self.inner.events.emit(Event::AgentCancelled {
                agent_id: agent_id.clone(),
            });
        }
        Ok(changed)
    }

    async fn prepare_turn(
        &self,
        prompt: &str,
        images: Vec<zaalis_providers::ImagePart>,
        target: Option<AgentId>,
    ) -> Result<()> {
        let targets = match target {
            Some(id) => vec![id],
            None => self.inner.tree.lock().await.roots().to_vec(),
        };
        if targets.is_empty() {
            return Err(ZaalisError::invalid("session sans agent racine"));
        }
        let mut tree = self.inner.tree.lock().await;
        let mut histories = self.inner.histories.lock().await;
        for id in targets {
            let node = tree
                .get_mut(&id)
                .ok_or_else(|| ZaalisError::internal("racine introuvable"))?;
            node.state = AgentState::Pending;
            node.finished_at_ms = None;
            histories.entry(id).or_default().push(Message::User {
                text: prompt.to_owned(),
                images: images.clone(),
            });
        }
        Ok(())
    }

    async fn refresh_blocked_states(&self) {
        let changes = {
            let mut tree = self.inner.tree.lock().await;
            let ids: Vec<_> = tree.iter().map(|node| node.id.clone()).collect();
            let mut changes = Vec::new();
            for id in ids {
                let blockers = tree.blockers(&id);
                let Some(node) = tree.get_mut(&id) else {
                    continue;
                };
                let next = match (&node.state, blockers.is_empty()) {
                    (AgentState::Blocked { .. }, true) => Some(AgentState::Pending),
                    (AgentState::Pending, false) => Some(AgentState::Blocked {
                        waiting_on: blockers,
                    }),
                    _ => None,
                };
                if let Some(state) = next {
                    node.state = state.clone();
                    changes.push((id, state));
                }
            }
            changes
        };
        for (agent_id, state) in changes {
            self.inner
                .events
                .emit(Event::AgentStateChanged { agent_id, state });
        }
    }
}

impl SessionInner {
    pub(crate) async fn finish_agent(&self, id: &AgentId, result: Result<AgentRun>) {
        match result {
            Ok(run) => {
                {
                    let mut tree = self.tree.lock().await;
                    if let Some(node) = tree.get_mut(id) {
                        node.state = AgentState::Done;
                        node.finished_at_ms = Some(now_ms());
                        node.usage = run.report.usage;
                    }
                }
                self.histories.lock().await.insert(id.clone(), run.history);
                self.reports
                    .lock()
                    .await
                    .insert(id.clone(), run.report.clone());
                self.events.emit(Event::AgentCompleted {
                    agent_id: id.clone(),
                    report: run.report,
                });
            }
            Err(error) if error.code == zaalis_core::ErrorCode::Cancelled => {
                if let Some(node) = self.tree.lock().await.get_mut(id) {
                    node.state = AgentState::Cancelled;
                    node.finished_at_ms = Some(now_ms());
                }
                self.events.emit(Event::AgentCancelled {
                    agent_id: id.clone(),
                });
            }
            Err(error) => {
                if let Some(node) = self.tree.lock().await.get_mut(id) {
                    node.state = AgentState::Failed {
                        error: error.message.clone(),
                    };
                    node.finished_at_ms = Some(now_ms());
                }
                self.events.emit(Event::AgentFailed {
                    agent_id: id.clone(),
                    error: error.to_string(),
                });
            }
        }
    }
    pub async fn set_state(&self, agent_id: &AgentId, state: AgentState) {
        if let Some(node) = self.tree.lock().await.get_mut(agent_id) {
            node.state = state.clone();
        }
        self.events.emit(Event::AgentStateChanged {
            agent_id: agent_id.clone(),
            state,
        });
    }

    pub async fn update_usage(&self, agent_id: &AgentId, usage: Usage) {
        let session_total = {
            let mut tree = self.tree.lock().await;
            if let Some(node) = tree.get_mut(agent_id) {
                node.usage = usage;
            }
            tree.total_usage()
        };
        self.events.emit(Event::UsageUpdated {
            agent_id: Some(agent_id.clone()),
            usage,
            session_total,
        });
    }

    pub async fn update_runtime_limits(&self, node: &AgentNode) {
        if let Some(shared) = self.tree.lock().await.get_mut(&node.id) {
            shared.permissions = node.permissions.clone();
            shared.budget = node.budget;
        }
    }
}

fn tree_error(error: TreeError) -> ZaalisError {
    ZaalisError::invalid(error.to_string())
}
