use clap::Parser;
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use zaalis_core::{GrantScope, PermissionAnswer, PermissionMode, ProviderId, SessionId};
use zaalis_protocol::method;
use zaalis_protocol::{Event, EventFrame, RpcId, RpcMessage, RpcRequest, RpcResponse};

const CYAN: &str = "\x1b[38;5;45m";
const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const RESET: &str = "\x1b[0m";

#[derive(Debug, Parser)]
#[command(name = "zaalis", version, about = "Client agentique Zaalis")]
struct Args {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "mistral")]
    provider: String,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    plan: bool,
    #[arg(long)]
    team: Option<PathBuf>,
    #[arg(long, default_value = "supervised")]
    permissions: String,
    #[arg(long)]
    agentd: Option<PathBuf>,
}

#[derive(Debug)]
struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: i64,
}

impl Client {
    fn spawn(path: &Path) -> Result<Self, String> {
        let mut child = Command::new(path)
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("impossible de lancer agentd : {error}"))?;
        let input = child.stdin.take().ok_or("stdin agentd indisponible")?;
        let output = BufReader::new(child.stdout.take().ok_or("stdout agentd indisponible")?);
        Ok(Self {
            child,
            input,
            output,
            next_id: 1,
        })
    }

    fn send(&mut self, method: &str, params: Value) -> Result<RpcId, String> {
        let id = RpcId::Number(self.next_id);
        self.next_id += 1;
        let line = RpcMessage::Request(RpcRequest::new(id.clone(), method, params)).to_line();
        writeln!(self.input, "{line}").map_err(|error| error.to_string())?;
        self.input.flush().map_err(|error| error.to_string())?;
        Ok(id)
    }

    fn next(&mut self) -> Result<RpcMessage, String> {
        let mut line = String::new();
        let read = self
            .output
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("agentd s'est arrêté".into());
        }
        RpcMessage::from_line(&line).map_err(|error| format!("réponse agentd invalide : {error}"))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send(method, params)?;
        loop {
            match self.next()? {
                RpcMessage::Response(response) if response.id == id => {
                    return response_value(response)
                }
                RpcMessage::Notification(notification)
                    if notification.method == method::SESSION_EVENT =>
                {
                    if let Some(value) = notification.params {
                        let frame: EventFrame =
                            serde_json::from_value(value).map_err(|error| error.to_string())?;
                        render_event(&frame);
                    }
                }
                _ => {}
            }
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.input.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{RED}Erreur : {error}{RESET}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = Args::parse();
    let root =
        std::fs::canonicalize(&args.root).map_err(|error| format!("projet invalide : {error}"))?;
    let provider = ProviderId::parse(&args.provider)
        .ok_or_else(|| format!("fournisseur inconnu : {}", args.provider))?;
    let permission = parse_permission(&args.permissions)?;
    let agentd = args
        .agentd
        .or_else(|| std::env::var_os("ZAALIS_AGENTD_PATH").map(PathBuf::from))
        .unwrap_or_else(default_agentd_path);
    let mut client = Client::spawn(&agentd)?;
    let create = if let Some(team) = args.team {
        let agents: Value =
            serde_json::from_slice(&std::fs::read(team).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        json!({"root":root,"mode":"team","agents":agents,"permission_mode":permission})
    } else {
        json!({"root":root,"mode":"chat","model":{"provider":provider,"model":args.model},"permission_mode":if args.plan { PermissionMode::Plan } else { permission }})
    };
    let result = client.request(method::SESSION_CREATE, create)?;
    let session: SessionId =
        serde_json::from_value(result["session_id"].clone()).map_err(|error| error.to_string())?;
    println!(
        "{CYAN}ZAALIS{RESET}  {DIM}session {} · /aide pour les commandes{RESET}",
        session
    );
    let mut editor = DefaultEditor::new().map_err(|error| error.to_string())?;
    loop {
        match editor.readline("\x1b[38;5;45m› \x1b[0m") {
            Ok(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let _ = editor.add_history_entry(line);
                if line.starts_with('/') {
                    if !slash(&mut client, &session, line)? {
                        break;
                    }
                } else {
                    run_prompt(&mut client, &mut editor, &session, line)?;
                }
            }
            Err(ReadlineError::Interrupted) => {
                let _ = client.request(method::SESSION_CANCEL, json!({"session_id":session}));
            }
            Err(ReadlineError::Eof) => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    let _ = client.request(method::SESSION_CLOSE, json!({"session_id":session}));
    Ok(())
}

fn run_prompt(
    client: &mut Client,
    editor: &mut DefaultEditor,
    session: &SessionId,
    text: &str,
) -> Result<(), String> {
    let id = client.send(
        method::SESSION_PROMPT,
        json!({"session_id":session,"text":text}),
    )?;
    let mut accepted = false;
    loop {
        match client.next()? {
            RpcMessage::Response(response) if response.id == id => {
                response_value(response)?;
                accepted = true;
            }
            RpcMessage::Notification(notification)
                if notification.method == method::SESSION_EVENT =>
            {
                let Some(value) = notification.params else {
                    continue;
                };
                let frame: EventFrame =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                match &frame.event {
                    Event::PermissionRequested {
                        request_id,
                        summary,
                        risks,
                        ..
                    } => {
                        let details = if risks.is_empty() {
                            String::new()
                        } else {
                            format!("\n  {}", risks.join("\n  "))
                        };
                        let answer = editor
                            .readline(&format!(
                                "\n{CYAN}Autoriser{RESET} {summary} ? [o/n/t] {details}"
                            ))
                            .map_err(|error| error.to_string())?;
                        let answer = match answer.trim().to_lowercase().as_str() {
                            "o" | "oui" => PermissionAnswer::Allow {
                                scope: GrantScope::Once,
                            },
                            "t" | "toujours" => PermissionAnswer::Allow {
                                scope: GrantScope::Session,
                            },
                            _ => PermissionAnswer::Deny,
                        };
                        client.request(
                            method::PERMISSION_DECIDE,
                            json!({"session_id":session,"request_id":request_id,"answer":answer}),
                        )?;
                    }
                    Event::PlanReady { request_id, .. } => {
                        let answer = editor
                            .readline("\nApprouver ce plan ? [o/n] ")
                            .map_err(|error| error.to_string())?;
                        let method_name =
                            if matches!(answer.trim().to_lowercase().as_str(), "o" | "oui") {
                                method::PLAN_APPROVE
                            } else {
                                method::PLAN_REJECT
                            };
                        client.request(
                            method_name,
                            json!({"session_id":session,"request_id":request_id}),
                        )?;
                    }
                    Event::BudgetExhausted { request_id, .. } => {
                        let answer = editor
                            .readline("\nBudget atteint. Tokens supplémentaires (vide=arrêt) : ")
                            .map_err(|error| error.to_string())?;
                        let extra = answer.trim().parse::<u64>().ok();
                        client.request(method::BUDGET_EXTEND, json!({"session_id":session,"request_id":request_id,"additional_tokens":extra,"stop":extra.is_none()}))?;
                    }
                    Event::TurnCompleted { .. } => {
                        render_event(&frame);
                        println!();
                        break;
                    }
                    _ => render_event(&frame),
                }
            }
            _ => {}
        }
        if !accepted {
            continue;
        }
    }
    Ok(())
}

fn slash(client: &mut Client, session: &SessionId, line: &str) -> Result<bool, String> {
    let mut parts = line.split_whitespace();
    match parts.next().unwrap_or_default() {
        "/q" | "/quit" | "/exit" => return Ok(false),
        "/aide" | "/help" => println!(
            "/usage · /outils · /agents · /stop <agent> · /checkpoint <id> · /annuler · /quit"
        ),
        "/usage" => {
            let value = client.request(method::SESSION_USAGE, json!({"session_id":session}))?;
            println!("{DIM}{}{RESET}", value["usage"]);
        }
        "/agents" => {
            let value = client.request(method::SESSION_INSPECT, json!({"session_id":session}))?;
            for agent in value["tree"]["nodes"]
                .as_object()
                .into_iter()
                .flat_map(|nodes| nodes.values())
            {
                println!(
                    "{CYAN}{}{RESET} · {} · {}",
                    agent["id"].as_str().unwrap_or("?"),
                    agent["role"]["label"].as_str().unwrap_or("Agent"),
                    agent["state"]["state"].as_str().unwrap_or("?")
                );
            }
        }
        "/outils" => {
            let value = client.request(method::TOOLS_LIST, json!({"session_id":session}))?;
            for tool in value["tools"].as_array().into_iter().flatten() {
                println!(
                    "{CYAN}{}{RESET} — {}",
                    tool["name"].as_str().unwrap_or("?"),
                    tool["description"].as_str().unwrap_or("")
                );
            }
        }
        "/stop" => {
            let id = parts.next().ok_or("usage : /stop <agent_id>")?;
            client.request(
                method::SESSION_CANCEL,
                json!({"session_id":session,"agent_id":id}),
            )?;
        }
        "/checkpoint" => {
            let id = parts.next().ok_or("usage : /checkpoint <checkpoint_id>")?;
            let result = client.request(
                method::CHECKPOINT_RESTORE,
                json!({"session_id":session,"checkpoint_id":id}),
            )?;
            println!("{GREEN}Checkpoint restauré{RESET} {result}");
        }
        "/annuler" | "/cancel" => {
            client.request(method::SESSION_CANCEL, json!({"session_id":session}))?;
        }
        other => println!("commande inconnue : {other}"),
    }
    Ok(true)
}

fn render_event(frame: &EventFrame) {
    match &frame.event {
        Event::TextDelta { text, .. } => {
            print!("{}", render_markdown(text));
            let _ = std::io::stdout().flush();
        }
        Event::ReasoningDelta { text, .. } => {
            eprint!("{DIM}{text}{RESET}");
        }
        Event::AgentSpawned { agent } => {
            println!("\n{CYAN}＋ {}{RESET} {}", agent.role.label, agent.id)
        }
        Event::AgentStateChanged { agent_id, state } => {
            eprintln!("{DIM}[{agent_id}] {}{RESET}", state.label())
        }
        Event::DiffAvailable {
            path,
            added,
            removed,
            ..
        } => println!("\n{CYAN}Δ {path}{RESET} {GREEN}+{added}{RESET} {RED}-{removed}{RESET}"),
        Event::CheckpointCreated {
            checkpoint_id,
            label,
            ..
        } => println!("\n{GREEN}Checkpoint{RESET} {label} ({checkpoint_id})"),
        Event::UsageUpdated { session_total, .. }
        | Event::TurnCompleted {
            usage: session_total,
            ..
        } => eprintln!(
            "{DIM}{} tokens · {} outils · {} rounds{RESET}",
            session_total.total_tokens(),
            session_total.tool_calls,
            session_total.rounds
        ),
        Event::AgentFailed { agent_id, error } => eprintln!("{RED}[{agent_id}] {error}{RESET}"),
        Event::ProviderError {
            provider, message, ..
        } => eprintln!("{RED}{provider}: {message}{RESET}"),
        _ => {}
    }
}

fn render_markdown(text: &str) -> String {
    text.replace("**", "\x1b[1m").replace('`', "\x1b[38;5;214m") + RESET
}

fn response_value(response: RpcResponse) -> Result<Value, String> {
    match (response.result, response.error) {
        (Some(value), None) => Ok(value),
        (_, Some(error)) => Err(format!("{} ({})", error.message, error.code)),
        _ => Err("réponse JSON-RPC vide".into()),
    }
}

fn parse_permission(value: &str) -> Result<PermissionMode, String> {
    serde_json::from_value(Value::String(value.into()))
        .map_err(|_| format!("mode de permission inconnu : {value}"))
}

fn default_agentd_path() -> PathBuf {
    let sibling = std::env::current_exe().ok().and_then(|path| {
        path.parent().map(|parent| {
            parent.join(if cfg!(windows) {
                "zaalis-agentd.exe"
            } else {
                "zaalis-agentd"
            })
        })
    });
    sibling.filter(|path| path.exists()).unwrap_or_else(|| {
        PathBuf::from(if cfg!(windows) {
            "zaalis-agentd.exe"
        } else {
            "zaalis-agentd"
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_parser_uses_protocol_wire_names() {
        assert_eq!(
            parse_permission("read-only").unwrap(),
            PermissionMode::ReadOnly
        );
        assert!(parse_permission("unsafe").is_err());
    }

    #[test]
    fn markdown_renderer_keeps_text_and_adds_terminal_style() {
        let rendered = render_markdown("**Zaalis** utilise `Rust`");
        assert!(
            rendered.contains("Zaalis") && rendered.contains("Rust") && rendered.contains("\x1b[")
        );
    }
}
