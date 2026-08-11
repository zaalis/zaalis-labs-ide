use crate::{Tool, ToolContext, ToolDefinition, ToolResult, ToolRuntime};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_exec::{ExecRuntime, PtyRuntime, SandboxLevel};
use zaalis_guard::AccessRequest;

#[derive(Debug, Clone, Copy)]
enum ExecKind {
    Run,
    Process,
    Pty,
}

#[derive(Debug, Clone)]
pub struct ExecTool {
    kind: ExecKind,
    runtimes: Arc<ExecRuntimes>,
}

#[derive(Debug)]
struct ExecRuntimes {
    entries: Mutex<HashMap<PathBuf, RuntimePair>>,
}

type RuntimePair = (Arc<ExecRuntime>, Arc<PtyRuntime>);

impl ExecRuntimes {
    fn new(exec: ExecRuntime) -> Result<Self> {
        let root = exec.root().to_path_buf();
        let pty = Arc::new(PtyRuntime::new(&root)?);
        let mut entries = HashMap::new();
        entries.insert(root, (Arc::new(exec), pty));
        Ok(Self {
            entries: Mutex::new(entries),
        })
    }

    fn for_root(&self, root: &Path) -> Result<(Arc<ExecRuntime>, Arc<PtyRuntime>)> {
        let root = root.to_path_buf();
        let mut entries = self.entries.lock().expect("exec runtimes lock poisoned");
        if let Some(entry) = entries.get(&root) {
            return Ok((Arc::clone(&entry.0), Arc::clone(&entry.1)));
        }
        let exec = Arc::new(ExecRuntime::new(&root)?);
        let pty = Arc::new(PtyRuntime::new(&root)?);
        entries.insert(root, (Arc::clone(&exec), Arc::clone(&pty)));
        Ok((exec, pty))
    }
}

impl ExecTool {
    fn name(&self) -> &'static str {
        match self.kind {
            ExecKind::Run => "run",
            ExecKind::Process => "process",
            ExecKind::Pty => "pty",
        }
    }

    fn runtimes(&self, context: &ToolContext) -> Result<(Arc<ExecRuntime>, Arc<PtyRuntime>)> {
        let runtimes = self.runtimes.for_root(context.workspace.root())?;
        if runtimes.0.sandbox_level() == SandboxLevel::Strict && !matches!(self.kind, ExecKind::Run)
        {
            return Err(zaalis_core::ZaalisError::unsupported(
                "processus persistant et PTY refusés en sandbox strict",
            ));
        }
        Ok(runtimes)
    }
}

pub fn register_exec_tools(runtime: &mut ToolRuntime, exec: ExecRuntime) -> Result<()> {
    let runtimes = Arc::new(ExecRuntimes::new(exec)?);
    runtime.register(ExecTool {
        kind: ExecKind::Run,
        runtimes: Arc::clone(&runtimes),
    })?;
    runtime.register(ExecTool {
        kind: ExecKind::Process,
        runtimes: Arc::clone(&runtimes),
    })?;
    runtime.register(ExecTool {
        kind: ExecKind::Pty,
        runtimes,
    })?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunInput {
    command: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum ProcessInput {
    Start { command: String },
    Poll { process_id: String },
    Write { process_id: String, input: String },
    Kill { process_id: String },
    List,
    Remove { process_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum PtyInput {
    Start {
        #[serde(default)]
        command: Option<String>,
        #[serde(default = "default_rows")]
        rows: u16,
        #[serde(default = "default_cols")]
        cols: u16,
    },
    Poll {
        pty_id: String,
    },
    Write {
        pty_id: String,
        input: String,
    },
    Resize {
        pty_id: String,
        rows: u16,
        cols: u16,
    },
    Kill {
        pty_id: String,
    },
    List,
    Remove {
        pty_id: String,
    },
}

fn default_rows() -> u16 {
    24
}
fn default_cols() -> u16 {
    80
}

#[async_trait]
impl Tool for ExecTool {
    fn definition(&self) -> ToolDefinition {
        let (description, input_schema) = match self.kind {
            ExecKind::Run => (
                "Exécuter une commande bornée dans le workspace et attendre son résultat.",
                object(
                    json!({"command":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1,"maximum":1800000}}),
                    &["command"],
                ),
            ),
            ExecKind::Process => (
                "Démarrer, interroger, alimenter ou arrêter un processus persistant.",
                json!({"type":"object","oneOf":[
                    object(json!({"action":{"const":"start"},"command":{"type":"string"}}), &["action","command"]),
                    object(json!({"action":{"const":"poll"},"process_id":{"type":"string"}}), &["action","process_id"]),
                    object(json!({"action":{"const":"write"},"process_id":{"type":"string"},"input":{"type":"string"}}), &["action","process_id","input"]),
                    object(json!({"action":{"const":"kill"},"process_id":{"type":"string"}}), &["action","process_id"]),
                    object(json!({"action":{"const":"list"}}), &["action"]),
                    object(json!({"action":{"const":"remove"},"process_id":{"type":"string"}}), &["action","process_id"])
                ]}),
            ),
            ExecKind::Pty => (
                "Piloter une vraie pseudo-console interactive avec redimensionnement.",
                json!({"type":"object","oneOf":[
                    object(json!({"action":{"const":"start"},"command":{"type":"string"},"rows":{"type":"integer","minimum":2,"maximum":500},"cols":{"type":"integer","minimum":10,"maximum":1000}}), &["action"]),
                    object(json!({"action":{"const":"poll"},"pty_id":{"type":"string"}}), &["action","pty_id"]),
                    object(json!({"action":{"const":"write"},"pty_id":{"type":"string"},"input":{"type":"string"}}), &["action","pty_id","input"]),
                    object(json!({"action":{"const":"resize"},"pty_id":{"type":"string"},"rows":{"type":"integer"},"cols":{"type":"integer"}}), &["action","pty_id","rows","cols"]),
                    object(json!({"action":{"const":"kill"},"pty_id":{"type":"string"}}), &["action","pty_id"]),
                    object(json!({"action":{"const":"list"}}), &["action"]),
                    object(json!({"action":{"const":"remove"},"pty_id":{"type":"string"}}), &["action","pty_id"])
                ]}),
            ),
        };
        ToolDefinition {
            name: self.name().into(),
            description: description.into(),
            input_schema,
        }
    }

    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        self.runtimes(context)?;
        let (kind, target) = match self.kind {
            ExecKind::Run => {
                let args: RunInput = serde_json::from_value(input.clone())?;
                (AccessKind::Execute, args.command)
            }
            ExecKind::Process => match serde_json::from_value(input.clone())? {
                ProcessInput::Start { command } => (AccessKind::Execute, command),
                ProcessInput::Write { process_id, input } => {
                    validate_interactive_input(&input)?;
                    (
                        AccessKind::Execute,
                        format!("process {process_id} input: {input}"),
                    )
                }
                ProcessInput::Kill { process_id } => {
                    (AccessKind::Execute, format!("process kill {process_id}"))
                }
                ProcessInput::Poll { process_id } => {
                    (AccessKind::Session, format!("process poll {process_id}"))
                }
                ProcessInput::Remove { process_id } => {
                    (AccessKind::Session, format!("process remove {process_id}"))
                }
                ProcessInput::List => (AccessKind::Session, "process list".into()),
            },
            ExecKind::Pty => match serde_json::from_value(input.clone())? {
                PtyInput::Start { command, .. } => (
                    AccessKind::Execute,
                    command.unwrap_or_else(|| "interactive shell".into()),
                ),
                PtyInput::Write { pty_id, input } => {
                    validate_interactive_input(&input)?;
                    (AccessKind::Execute, format!("pty {pty_id} input: {input}"))
                }
                PtyInput::Kill { pty_id } => (AccessKind::Execute, format!("pty kill {pty_id}")),
                PtyInput::Poll { pty_id } => (AccessKind::Session, format!("pty poll {pty_id}")),
                PtyInput::Resize { pty_id, .. } => {
                    (AccessKind::Session, format!("pty resize {pty_id}"))
                }
                PtyInput::Remove { pty_id } => {
                    (AccessKind::Session, format!("pty remove {pty_id}"))
                }
                PtyInput::List => (AccessKind::Session, "pty list".into()),
            },
        };
        Ok(AccessRequest::new(context.agent_id.clone(), self.name(), kind).with_target(target))
    }

    async fn execute(
        &self,
        input: Value,
        context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let (runtime, pty) = self.runtimes(&context)?;
        let (summary, value) = match self.kind {
            ExecKind::Run => {
                let args: RunInput = serde_json::from_value(input)?;
                let timeout = args.timeout_ms.map(Duration::from_millis);
                let output = runtime.run(&args.command, timeout, cancel).await?;
                let summary = if output.timed_out {
                    "Commande interrompue après expiration du délai".into()
                } else {
                    format!("Commande terminée avec le code {:?}", output.exit_code)
                };
                (summary, serde_json::to_value(output)?)
            }
            ExecKind::Process => match serde_json::from_value(input)? {
                ProcessInput::Start { command } => {
                    let started = runtime.start(&command).await?;
                    (
                        format!("Processus {} démarré", started.process_id),
                        serde_json::to_value(started)?,
                    )
                }
                ProcessInput::Poll { process_id } => {
                    let poll = runtime.poll(&process_id).await?;
                    (
                        if poll.running {
                            "Processus en cours"
                        } else {
                            "Processus terminé"
                        }
                        .into(),
                        serde_json::to_value(poll)?,
                    )
                }
                ProcessInput::Write { process_id, input } => {
                    runtime.write(&process_id, &input).await?;
                    (
                        "Entrée envoyée au processus".into(),
                        json!({"process_id":process_id,"bytes":input.len()}),
                    )
                }
                ProcessInput::Kill { process_id } => {
                    let poll = runtime.kill(&process_id).await?;
                    ("Processus arrêté".into(), serde_json::to_value(poll)?)
                }
                ProcessInput::List => {
                    let processes = runtime.list().await;
                    (
                        format!("{} processus", processes.len()),
                        serde_json::to_value(processes)?,
                    )
                }
                ProcessInput::Remove { process_id } => {
                    runtime.remove_finished(&process_id).await?;
                    (
                        "Processus retiré de l'historique".into(),
                        json!({"process_id":process_id}),
                    )
                }
            },
            ExecKind::Pty => match serde_json::from_value(input)? {
                PtyInput::Start {
                    command,
                    rows,
                    cols,
                } => {
                    let started = pty.start(command.as_deref(), rows, cols)?;
                    (
                        format!("PTY {} démarré", started.pty_id),
                        serde_json::to_value(started)?,
                    )
                }
                PtyInput::Poll { pty_id } => {
                    let poll = pty.poll(&pty_id)?;
                    (
                        if poll.running {
                            "PTY en cours"
                        } else {
                            "PTY terminé"
                        }
                        .into(),
                        serde_json::to_value(poll)?,
                    )
                }
                PtyInput::Write { pty_id, input } => {
                    pty.write(&pty_id, &input)?;
                    (
                        "Entrée envoyée au PTY".into(),
                        json!({"pty_id":pty_id,"bytes":input.len()}),
                    )
                }
                PtyInput::Resize { pty_id, rows, cols } => {
                    pty.resize(&pty_id, rows, cols)?;
                    (
                        "PTY redimensionné".into(),
                        json!({"pty_id":pty_id,"rows":rows.clamp(2,500),"cols":cols.clamp(10,1000)}),
                    )
                }
                PtyInput::Kill { pty_id } => {
                    let poll = pty.kill(&pty_id)?;
                    ("PTY arrêté".into(), serde_json::to_value(poll)?)
                }
                PtyInput::List => {
                    let sessions = pty.list();
                    (
                        format!("{} PTY", sessions.len()),
                        serde_json::to_value(sessions)?,
                    )
                }
                PtyInput::Remove { pty_id } => {
                    pty.remove_finished(&pty_id)?;
                    (
                        "PTY retiré de l'historique".into(),
                        json!({"pty_id":pty_id}),
                    )
                }
            },
        };
        Ok(ToolResult { summary, value })
    }
}

fn validate_interactive_input(input: &str) -> Result<()> {
    if input.contains('\0') || input.len() > 32_768 {
        return Err(ZaalisError::invalid(
            "entree interactive invalide ou trop longue",
        ));
    }
    Ok(())
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
