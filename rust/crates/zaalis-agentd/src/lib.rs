//! Stateful JSON-RPC facade shared by the IDE and CLI transports.

pub mod providers;
pub mod transport;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, RwLock};
use zaalis_agent::{
    AgentSession, AgentSessionSnapshot, BudgetAnswer, PlanAnswer, SessionConfig, SessionRunMode,
};
use zaalis_checkpoint::CheckpointStore;
use zaalis_core::{
    now_ms, AgentId, AgentNode, PermissionSet, Result, RoleSpec, SessionId, ZaalisError,
};
use zaalis_exec::ExecRuntime;
use zaalis_fs::Workspace;
use zaalis_protocol::{
    event_notification, AgentAddParams, AgentRemoveParams, AgentResult, AgentUpdateParams,
    BudgetExtendParams, CheckpointRestoreParams, ClientMethod, HealthResult, ModelsListResult,
    PermissionDecideParams, PlanDecisionParams, ProviderCapabilitiesInfo, ProviderInfo, RpcError,
    RpcMessage, RpcRequest, RpcResponse, SandboxCapabilitiesInfo, SessionCancelParams,
    SessionCreateParams, SessionCreateResult, SessionInspectResult, SessionMode,
    SessionPromptParams, SessionResumeParams, SessionUsageResult, ToolInfo, ToolsListParams,
    ToolsListResult, PROTOCOL_VERSION,
};
use zaalis_providers::{PoolConfig, ProviderPool};
use zaalis_store::Store;
use zaalis_tools::{
    register_checkpoint_tools, register_exec_tools, register_filesystem_tools, register_git_tools,
    register_todo_tool, ToolRuntime,
};

#[derive(Debug)]
struct ManagedSession {
    runtime: AgentSession,
    checkpoints: CheckpointStore,
}

#[derive(Debug)]
pub struct DispatchOutput {
    pub response: RpcResponse,
    pub replay: Vec<RpcMessage>,
}

#[derive(Debug)]
pub struct Daemon {
    started: Instant,
    providers: Arc<ProviderPool>,
    store: Arc<Store>,
    checkpoint_root: PathBuf,
    sessions: Arc<RwLock<HashMap<SessionId, Arc<ManagedSession>>>>,
    events: broadcast::Sender<zaalis_protocol::EventFrame>,
}

impl Daemon {
    pub fn new(
        providers: Arc<ProviderPool>,
        store: Arc<Store>,
        checkpoint_root: impl AsRef<Path>,
    ) -> Result<Self> {
        std::fs::create_dir_all(checkpoint_root.as_ref())?;
        let checkpoint_root = dunce::canonicalize(checkpoint_root)?;
        let (events, _) = broadcast::channel(16_384);
        Ok(Self {
            started: Instant::now(),
            providers,
            store,
            checkpoint_root,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            events,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<zaalis_protocol::EventFrame> {
        self.events.subscribe()
    }

    pub async fn dispatch(&self, request: RpcRequest) -> DispatchOutput {
        let id = request.id.clone();
        let result = self.dispatch_inner(&request).await;
        match result {
            Ok((value, replay)) => DispatchOutput {
                response: RpcResponse::ok(id, value),
                replay,
            },
            Err(error) => DispatchOutput {
                response: RpcResponse::err(id, error),
                replay: Vec::new(),
            },
        }
    }

    async fn dispatch_inner(
        &self,
        request: &RpcRequest,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let method = ClientMethod::parse(&request.method)
            .ok_or_else(|| RpcError::method_not_found(&request.method))?;
        match method {
            ClientMethod::Health => Ok((
                serde_json::to_value(HealthResult {
                    version: format!("{};protocol={PROTOCOL_VERSION}", env!("CARGO_PKG_VERSION")),
                    sessions: self.sessions.read().await.len() as u32,
                    uptime_ms: self.started.elapsed().as_millis() as u64,
                    sandbox: sandbox_info(),
                })
                .map_err(internal)?,
                Vec::new(),
            )),
            ClientMethod::SessionCreate => self.create(params(request)?).await,
            ClientMethod::SessionResume => self.resume(params(request)?).await,
            ClientMethod::SessionPrompt => self.prompt(params(request)?).await,
            ClientMethod::SessionCancel => self.cancel(params(request)?).await,
            ClientMethod::SessionClose => self.close(params(request)?).await,
            ClientMethod::SessionUsage => self.usage(params(request)?).await,
            ClientMethod::SessionInspect => self.inspect(params(request)?).await,
            ClientMethod::AgentAdd => self.agent_add(params(request)?).await,
            ClientMethod::AgentUpdate => self.agent_update(params(request)?).await,
            ClientMethod::AgentRemove => self.agent_remove(params(request)?).await,
            ClientMethod::PermissionDecide => self.permission(params(request)?).await,
            ClientMethod::PlanApprove => self.plan(params(request)?, true).await,
            ClientMethod::PlanReject => self.plan(params(request)?, false).await,
            ClientMethod::BudgetExtend => self.budget(params(request)?).await,
            ClientMethod::CheckpointRestore => self.restore(params(request)?).await,
            ClientMethod::ToolsList => self.tools(params(request)?).await,
            ClientMethod::ModelsList => self.models().await,
        }
    }

    async fn create(
        &self,
        input: SessionCreateParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let workspace = Workspace::open(&input.root).map_err(RpcError::from)?;
        let id = input.session_id.unwrap_or_default();
        if self.sessions.read().await.contains_key(&id) {
            return Err(RpcError::invalid_params("session déjà active"));
        }
        let mode = if input.permission_mode == zaalis_core::PermissionMode::Plan {
            SessionRunMode::Plan
        } else if input.mode == SessionMode::Team {
            SessionRunMode::Team
        } else {
            SessionRunMode::Chat
        };
        let (runtime, checkpoints) =
            self.build_runtime(workspace, mode, id.clone(), input.system_prompt.clone())?;
        let mut created = Vec::new();
        match input.mode {
            SessionMode::Chat => {
                let model = input
                    .model
                    .ok_or_else(|| RpcError::invalid_params("model requis en mode chat"))?;
                let mut node = AgentNode::new(
                    id.clone(),
                    RoleSpec::new("assistant").with_label("Assistant"),
                    model,
                    PermissionSet::new(input.permission_mode),
                    now_ms(),
                );
                if let Some(budget) = input.budget {
                    node.budget = budget;
                }
                runtime
                    .add_root(node.clone())
                    .await
                    .map_err(RpcError::from)?;
                created.push(node);
            }
            SessionMode::Team => {
                if input.agents.is_empty() {
                    return Err(RpcError::invalid_params("équipe vide"));
                }
                let mut role_ids = HashMap::<String, AgentId>::new();
                for spec in &input.agents {
                    if role_ids.contains_key(&spec.role.name) {
                        return Err(RpcError::invalid_params("noms de rôles dupliqués"));
                    }
                    let permissions = spec
                        .permissions
                        .clone()
                        .unwrap_or_else(|| PermissionSet::new(input.permission_mode));
                    let mut node = AgentNode::new(
                        id.clone(),
                        spec.role.clone(),
                        spec.model.clone(),
                        permissions,
                        now_ms(),
                    );
                    if let Some(budget) = spec.budget {
                        node.budget = budget;
                    }
                    runtime
                        .add_root(node.clone())
                        .await
                        .map_err(RpcError::from)?;
                    role_ids.insert(spec.role.name.clone(), node.id.clone());
                    created.push(node);
                }
                for (index, spec) in input.agents.iter().enumerate() {
                    for dependency in &spec.depends_on {
                        let dep = role_ids.get(dependency).ok_or_else(|| {
                            RpcError::invalid_params(format!(
                                "rôle dépendance inconnu : {dependency}"
                            ))
                        })?;
                        runtime
                            .add_dependency(&created[index].id, dep)
                            .await
                            .map_err(RpcError::from)?;
                    }
                }
            }
        }
        if let Some(root) = created.first() {
            let history = input
                .history
                .into_iter()
                .map(|message| match message {
                    zaalis_protocol::HistoryMessage::User { content } => {
                        zaalis_providers::Message::user(content)
                    }
                    zaalis_protocol::HistoryMessage::Assistant { content } => {
                        zaalis_providers::Message::assistant(content)
                    }
                })
                .collect();
            runtime
                .seed_history(&root.id, history)
                .await
                .map_err(RpcError::from)?;
        }
        let snapshot = runtime.snapshot().await;
        self.store
            .save_session(
                &id,
                &serde_json::to_value(&snapshot).map_err(internal)?,
                "idle",
            )
            .map_err(RpcError::from)?;
        let managed = Arc::new(ManagedSession {
            runtime: runtime.clone(),
            checkpoints,
        });
        self.sessions.write().await.insert(id.clone(), managed);
        Ok((
            serde_json::to_value(SessionCreateResult {
                session_id: id,
                agents: created,
                seq: 0,
            })
            .map_err(internal)?,
            Vec::new(),
        ))
    }

    fn build_runtime(
        &self,
        workspace: Workspace,
        mode: SessionRunMode,
        id: SessionId,
        system_prompt: Option<String>,
    ) -> std::result::Result<(AgentSession, CheckpointStore), RpcError> {
        let mut config = SessionConfig::new(workspace.clone(), mode);
        config.session_id = id;
        if let Some(system_prompt) = system_prompt {
            if system_prompt.len() > 200_000 {
                return Err(RpcError::invalid_params("system prompt trop volumineux"));
            }
            config.system_prompt = system_prompt;
        }
        let user_extensions = std::env::var_os("ZAALIS_USER_CONFIG_DIR").map(PathBuf::from);
        let extensions = Arc::new(
            zaalis_extensions::ExtensionRuntime::load(&workspace, user_extensions.as_deref())
                .map_err(RpcError::from)?,
        );
        config.extensions = Some(Arc::clone(&extensions));
        let mut tools = ToolRuntime::new(zaalis_guard::Guard::new());
        register_filesystem_tools(&mut tools).map_err(RpcError::from)?;
        register_todo_tool(&mut tools).map_err(RpcError::from)?;
        register_git_tools(&mut tools).map_err(RpcError::from)?;
        register_exec_tools(
            &mut tools,
            ExecRuntime::new(workspace.root()).map_err(RpcError::from)?,
        )
        .map_err(RpcError::from)?;
        let checkpoints =
            CheckpointStore::open(&self.checkpoint_root, workspace).map_err(RpcError::from)?;
        register_checkpoint_tools(&mut tools, checkpoints.clone()).map_err(RpcError::from)?;
        extensions.register_tools(&tools).map_err(RpcError::from)?;
        let runtime = AgentSession::new(config, Arc::clone(&self.providers), Arc::new(tools));
        self.forward_events(runtime.subscribe());
        Ok((runtime, checkpoints))
    }

    fn forward_events(&self, mut receiver: broadcast::Receiver<zaalis_protocol::EventFrame>) {
        let store = Arc::clone(&self.store);
        let sender = self.events.clone();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(frame) => {
                        let _ = store.append_event(&frame);
                        let _ = sender.send(frame);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn managed(&self, id: &SessionId) -> std::result::Result<Arc<ManagedSession>, RpcError> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::from(ZaalisError::not_found("session introuvable")))
    }

    async fn managed_or_restore(
        &self,
        id: &SessionId,
    ) -> std::result::Result<Arc<ManagedSession>, RpcError> {
        if let Some(managed) = self.sessions.read().await.get(id).cloned() {
            return Ok(managed);
        }
        let stored = self
            .store
            .session(id)
            .map_err(RpcError::from)?
            .ok_or_else(|| RpcError::from(ZaalisError::not_found("session introuvable")))?;
        if stored.status == "closed" {
            return Err(RpcError::from(ZaalisError::invalid("session fermée")));
        }
        let snapshot: AgentSessionSnapshot =
            serde_json::from_value(stored.payload).map_err(internal)?;
        if &snapshot.session_id != id {
            return Err(RpcError::from(ZaalisError::invalid(
                "identifiant de snapshot incohérent",
            )));
        }
        let workspace = Workspace::open(&snapshot.workspace).map_err(RpcError::from)?;
        let (runtime, checkpoints) = self.build_runtime(
            workspace,
            snapshot.mode,
            snapshot.session_id.clone(),
            Some(snapshot.system_prompt.clone()),
        )?;
        runtime.restore(snapshot).await.map_err(RpcError::from)?;
        let managed = Arc::new(ManagedSession {
            runtime,
            checkpoints,
        });
        let mut sessions = self.sessions.write().await;
        Ok(sessions
            .entry(id.clone())
            .or_insert_with(|| Arc::clone(&managed))
            .clone())
    }

    async fn persist(
        &self,
        managed: &ManagedSession,
        status: &str,
    ) -> std::result::Result<(), RpcError> {
        let snapshot = managed.runtime.snapshot().await;
        self.store
            .save_session(
                managed.runtime.id(),
                &serde_json::to_value(snapshot).map_err(internal)?,
                status,
            )
            .map_err(RpcError::from)
    }

    async fn resume(
        &self,
        input: SessionResumeParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        self.managed_or_restore(&input.session_id).await?;
        let replay = self
            .store
            .events_after(&input.session_id, input.from_seq)
            .map_err(RpcError::from)?
            .into_iter()
            .map(|frame| RpcMessage::Notification(event_notification(frame)))
            .collect();
        Ok((json!({"resumed":true}), replay))
    }

    async fn prompt(
        &self,
        input: SessionPromptParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let managed = self.managed(&input.session_id).await?;
        if let Some(agent) = &input.agent_id {
            if managed.runtime.tree().await.get(agent).is_none() {
                return Err(RpcError::from(ZaalisError::not_found("agent introuvable")));
            }
        }
        let runtime = managed.runtime.clone();
        let images = input
            .images
            .into_iter()
            .map(|image| zaalis_providers::ImagePart {
                mime: image.mime,
                data: image.data,
            })
            .collect();
        let store = Arc::clone(&self.store);
        tokio::spawn(async move {
            let result = runtime
                .run_turn_with(input.text, images, input.agent_id)
                .await;
            let snapshot = runtime.snapshot().await;
            let status = if result.is_ok() { "idle" } else { "failed" };
            if let Ok(value) = serde_json::to_value(snapshot) {
                let _ = store.save_session(runtime.id(), &value, status);
            }
        });
        Ok((json!({"accepted":true}), Vec::new()))
    }

    async fn cancel(
        &self,
        input: SessionCancelParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let managed = self.managed(&input.session_id).await?;
        if let Some(agent) = input.agent_id {
            let cancelled = managed
                .runtime
                .cancel_agent(&agent)
                .await
                .map_err(RpcError::from)?;
            return Ok((json!({"cancelled":cancelled}), Vec::new()));
        }
        managed.runtime.cancel().await;
        self.persist(&managed, "cancelled").await?;
        Ok((json!({"cancelled":true}), Vec::new()))
    }

    async fn close(
        &self,
        input: SessionCancelParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let managed = self
            .sessions
            .write()
            .await
            .remove(&input.session_id)
            .ok_or_else(|| RpcError::from(ZaalisError::not_found("session introuvable")))?;
        managed.runtime.cancel().await;
        managed.runtime.end().await.map_err(RpcError::from)?;
        self.persist(&managed, "closed").await?;
        Ok((json!({"closed":true}), Vec::new()))
    }

    async fn usage(
        &self,
        input: SessionResumeParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let tree = self.managed(&input.session_id).await?.runtime.tree().await;
        Ok((
            serde_json::to_value(SessionUsageResult {
                usage: tree.total_usage(),
            })
            .map_err(internal)?,
            Vec::new(),
        ))
    }

    async fn inspect(
        &self,
        input: SessionResumeParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let tree = self.managed(&input.session_id).await?.runtime.tree().await;
        Ok((
            serde_json::to_value(SessionInspectResult { tree }).map_err(internal)?,
            Vec::new(),
        ))
    }

    async fn agent_add(
        &self,
        input: AgentAddParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let managed = self.managed(&input.session_id).await?;
        let permissions = input.spec.permissions.unwrap_or_default();
        let mut node = AgentNode::new(
            input.session_id,
            input.spec.role,
            input.spec.model,
            permissions,
            now_ms(),
        );
        if let Some(budget) = input.spec.budget {
            node.budget = budget;
        }
        if !input.spec.depends_on.is_empty() {
            return Err(RpcError::invalid_params(
                "agent.add attend des identifiants via agent.update",
            ));
        }
        if let Some(parent) = input.parent_id {
            managed
                .runtime
                .add_child(&parent, node.clone())
                .await
                .map_err(RpcError::from)?;
        } else {
            managed
                .runtime
                .add_root(node.clone())
                .await
                .map_err(RpcError::from)?;
        }
        self.persist(&managed, "idle").await?;
        Ok((
            serde_json::to_value(AgentResult { agent: node }).map_err(internal)?,
            Vec::new(),
        ))
    }

    async fn agent_update(
        &self,
        input: AgentUpdateParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let managed = self.managed(&input.session_id).await?;
        let agent = managed
            .runtime
            .update_agent(
                &input.agent_id,
                input.role,
                input.model,
                input.permissions,
                input.budget,
            )
            .await
            .map_err(RpcError::from)?;
        self.persist(&managed, "idle").await?;
        Ok((
            serde_json::to_value(AgentResult { agent }).map_err(internal)?,
            Vec::new(),
        ))
    }

    async fn agent_remove(
        &self,
        input: AgentRemoveParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let managed = self.managed(&input.session_id).await?;
        let removed = managed
            .runtime
            .remove_agent(&input.agent_id)
            .await
            .map_err(RpcError::from)?;
        self.persist(&managed, "idle").await?;
        Ok((json!({"removed":removed}), Vec::new()))
    }

    async fn permission(
        &self,
        input: PermissionDecideParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        self.managed(&input.session_id)
            .await?
            .runtime
            .decide_permission(&input.request_id, input.answer)
            .map_err(RpcError::from)?;
        Ok((json!({"resolved":true}), Vec::new()))
    }

    async fn plan(
        &self,
        input: PlanDecisionParams,
        approve: bool,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let answer = if approve {
            PlanAnswer::Approve
        } else {
            PlanAnswer::Reject {
                feedback: input.feedback,
            }
        };
        self.managed(&input.session_id)
            .await?
            .runtime
            .decide_plan(&input.request_id, answer)
            .map_err(RpcError::from)?;
        Ok((json!({"resolved":true}), Vec::new()))
    }

    async fn budget(
        &self,
        input: BudgetExtendParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        self.managed(&input.session_id)
            .await?
            .runtime
            .decide_budget(
                &input.request_id,
                BudgetAnswer {
                    additional_tokens: input.additional_tokens,
                    stop: input.stop,
                },
            )
            .map_err(RpcError::from)?;
        Ok((json!({"resolved":true}), Vec::new()))
    }

    async fn restore(
        &self,
        input: CheckpointRestoreParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let report = self
            .managed(&input.session_id)
            .await?
            .checkpoints
            .restore(&input.checkpoint_id)
            .map_err(RpcError::from)?;
        Ok((serde_json::to_value(report).map_err(internal)?, Vec::new()))
    }

    async fn tools(
        &self,
        input: ToolsListParams,
    ) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let session_id = input
            .session_id
            .ok_or_else(|| RpcError::invalid_params("session_id requis"))?;
        let managed = self.managed(&session_id).await?;
        let tools = managed
            .runtime
            .tool_definitions()
            .into_iter()
            .map(|tool| {
                let mutating = !matches!(
                    tool.name.as_str(),
                    "read"
                        | "list"
                        | "tree"
                        | "glob"
                        | "grep"
                        | "code_search"
                        | "git_status"
                        | "git_diff"
                        | "checkpoint_list"
                        | "web_search"
                        | "web_fetch"
                        | "deep_search"
                        | "image_search"
                        | "fetch_asset"
                        | "video_info"
                        | "skill"
                );
                ToolInfo {
                    name: tool.name,
                    description: tool.description,
                    schema: tool.input_schema,
                    access: "guarded".into(),
                    mutating,
                }
            })
            .collect();
        Ok((
            serde_json::to_value(ToolsListResult { tools }).map_err(internal)?,
            Vec::new(),
        ))
    }

    async fn models(&self) -> std::result::Result<(Value, Vec<RpcMessage>), RpcError> {
        let providers = zaalis_core::ProviderId::ALL
            .into_iter()
            .map(|id| {
                let metadata = self.providers.metadata(id);
                let (models, capabilities) = metadata.map_or_else(
                    || (Vec::new(), ProviderCapabilitiesInfo::default()),
                    |(model, caps)| {
                        (
                            (!model.is_empty()).then_some(model).into_iter().collect(),
                            ProviderCapabilitiesInfo {
                                streaming: caps.streaming,
                                native_tools: caps.native_tools,
                                parallel_tool_calls: caps.parallel_tool_calls,
                                reasoning: caps.reasoning,
                                streamed_reasoning: caps.streamed_reasoning,
                                vision: caps.vision,
                                max_context: caps.max_context,
                                max_concurrency: caps.max_concurrency,
                            },
                        )
                    },
                );
                ProviderInfo {
                    id,
                    vendor: id.vendor().into(),
                    available: self.providers.contains(id),
                    models,
                    capabilities,
                }
            })
            .collect();
        Ok((
            serde_json::to_value(ModelsListResult { providers }).map_err(internal)?,
            Vec::new(),
        ))
    }
}

fn sandbox_info() -> SandboxCapabilitiesInfo {
    let caps = zaalis_exec::SandboxCapabilities::detect();
    SandboxCapabilitiesInfo {
        platform: caps.platform,
        process_tree: caps.process_tree,
        pty_process_tree: caps.pty_process_tree,
        minimal_environment: caps.minimal_environment,
        filesystem_isolation: caps.filesystem_isolation,
        network_isolation: caps.network_isolation,
        kernel_policy: caps.kernel_policy,
        strict_available: caps.strict_available,
    }
}

pub fn empty_provider_pool() -> Arc<ProviderPool> {
    Arc::new(ProviderPool::new(PoolConfig::default()))
}

fn params<T: DeserializeOwned>(request: &RpcRequest) -> std::result::Result<T, RpcError> {
    serde_json::from_value(request.params.clone().unwrap_or(Value::Null))
        .map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn internal(error: serde_json::Error) -> RpcError {
    RpcError::new(RpcError::INTERNAL_ERROR, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use zaalis_protocol::method;

    fn request(id: i64, method: &str, params: Value) -> RpcRequest {
        RpcRequest::new(id, method, params)
    }

    #[tokio::test]
    async fn health_create_resume_and_close_are_protocol_complete() {
        let dir = TempDir::new().unwrap();
        let workspace = dir.path().join("workspace");
        let checkpoints = dir.path().join("checkpoints");
        std::fs::create_dir_all(&workspace).unwrap();
        let daemon = Daemon::new(
            empty_provider_pool(),
            Arc::new(Store::open(dir.path().join("state.db")).unwrap()),
            &checkpoints,
        )
        .unwrap();
        let health = daemon.dispatch(request(1, method::HEALTH, json!({}))).await;
        assert!(health.response.is_ok());
        let created = daemon
            .dispatch(request(
                2,
                method::SESSION_CREATE,
                json!({
                "root": workspace, "model":{"provider":"mistral"}, "permission_mode":"read-only"
                    }),
            ))
            .await;
        assert!(created.response.is_ok(), "{:?}", created.response.error);
        let id: SessionId =
            serde_json::from_value(created.response.result.unwrap()["session_id"].clone()).unwrap();
        let resumed = daemon
            .dispatch(request(
                3,
                method::SESSION_RESUME,
                json!({"session_id":id,"from_seq":0}),
            ))
            .await;
        assert!(resumed.response.is_ok());
        let closed = daemon
            .dispatch(request(4, method::SESSION_CLOSE, json!({"session_id":id})))
            .await;
        assert!(closed.response.is_ok());
    }

    #[tokio::test]
    async fn unknown_methods_and_invalid_roots_are_structured_errors() {
        let dir = TempDir::new().unwrap();
        let daemon = Daemon::new(
            empty_provider_pool(),
            Arc::new(Store::open(dir.path().join("state.db")).unwrap()),
            dir.path().join("cp"),
        )
        .unwrap();
        let unknown = daemon.dispatch(request(1, "explode", json!({}))).await;
        assert_eq!(
            unknown.response.error.unwrap().code,
            RpcError::METHOD_NOT_FOUND
        );
        let invalid = daemon
            .dispatch(request(
                2,
                method::SESSION_CREATE,
                json!({"root":dir.path().join("missing"),"model":{"provider":"mistral"}}),
            ))
            .await;
        assert!(!invalid.response.is_ok());
    }

    #[tokio::test]
    async fn resume_rehydrates_a_session_after_daemon_restart() {
        let dir = TempDir::new().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let store = Arc::new(Store::open(dir.path().join("state.db")).unwrap());
        let session_id = {
            let daemon = Daemon::new(
                empty_provider_pool(),
                Arc::clone(&store),
                dir.path().join("checkpoints"),
            )
            .unwrap();
            let created = daemon
                .dispatch(request(
                    1,
                    method::SESSION_CREATE,
                    json!({"root":workspace,"model":{"provider":"mistral"}}),
                ))
                .await;
            serde_json::from_value::<SessionId>(
                created.response.result.unwrap()["session_id"].clone(),
            )
            .unwrap()
        };
        let restarted =
            Daemon::new(empty_provider_pool(), store, dir.path().join("checkpoints")).unwrap();
        let resumed = restarted
            .dispatch(request(
                2,
                method::SESSION_RESUME,
                json!({"session_id":session_id,"from_seq":0}),
            ))
            .await;
        assert!(resumed.response.is_ok(), "{:?}", resumed.response.error);
        let inspected = restarted
            .dispatch(request(
                3,
                method::SESSION_INSPECT,
                json!({"session_id":session_id}),
            ))
            .await;
        assert!(inspected.response.is_ok());
    }
}
