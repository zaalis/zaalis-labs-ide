//! Python orchestration through a per-invocation loopback broker. Nested tools
//! retain the original agent context and guard. Python has the same execution
//! authority as `run`, with bounded output, timeout and process-tree containment.
use crate::{discovery::guarded_call, session::SessionInner};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Weak;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use zaalis_core::{AccessKind, Result, ToolCallId, ZaalisError};
use zaalis_exec::{ExecRuntime, SandboxCapabilities, SandboxLevel};
use zaalis_guard::AccessRequest;
use zaalis_protocol::ToolOutcome;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

#[derive(Debug)]
pub(crate) struct CodeTool {
    session: Weak<SessionInner>,
}
impl CodeTool {
    pub fn new(session: Weak<SessionInner>) -> Self {
        Self { session }
    }
}
#[async_trait]
impl Tool for CodeTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition{name:"execute_code".into(),description:"Run Python with bounded output/time and scrubbed environment. tools.<name>(**arguments) calls the complete guarded registry; result is returned as JSON. Default sandbox contains the process tree, not filesystem/network. strict=true requests OS confinement and disables the tool broker; fails closed if unavailable. Dependencies must already be installed; install them only via an approved terminal command.".into(),input_schema:json!({"type":"object","properties":{"code":{"type":"string"},"timeout_ms":{"type":"integer"},"strict":{"type":"boolean"}},"required":["code"],"additionalProperties":false})}
    }
    fn access(&self, input: &Value, ctx: &ToolContext) -> Result<AccessRequest> {
        let code = input
            .get("code")
            .and_then(Value::as_str)
            .ok_or_else(|| ZaalisError::invalid("Python code required"))?;
        if code.len() > 128000 {
            return Err(ZaalisError::invalid("code too large"));
        }
        Ok(
            AccessRequest::new(ctx.agent_id.clone(), "execute_code", AccessKind::Execute)
                .with_target(format!("python code in {}", ctx.workspace.root().display())),
        )
    }
    async fn execute(
        &self,
        input: Value,
        ctx: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let code = input
            .get("code")
            .and_then(Value::as_str)
            .ok_or_else(|| ZaalisError::invalid("code required"))?;
        let strict = input
            .get("strict")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let exec = ExecRuntime::new(ctx.workspace.root())?.with_sandbox_level(if strict {
            SandboxLevel::Strict
        } else {
            SandboxLevel::ProcessTree
        })?;
        let id = ToolCallId::new().to_string();
        let relative = format!(".zaalis/code/{id}.py");
        let resolved = ctx.workspace.resolve(&relative)?;
        let file = resolved.absolute();
        std::fs::create_dir_all(
            file.parent()
                .ok_or_else(|| ZaalisError::invalid("code directory"))?,
        )?;
        let token = format!("{}{}", ToolCallId::new(), ToolCallId::new());
        let broker_cancel = cancel.child_token();
        let mut broker = None;
        let mut endpoint = String::new();
        if !strict {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            endpoint = format!("http://127.0.0.1:{}/call", listener.local_addr()?.port());
            let weak = self.session.clone();
            let context = ctx.clone();
            let scope = broker_cancel.clone();
            let secret = token.clone();
            broker = Some(tokio::spawn(async move {
                for _ in 0..64 {
                    let socket = tokio::select! {s=listener.accept()=>match s{Ok((s,_))=>s,Err(_)=>break},()=scope.cancelled()=>break};
                    let Some(session) = weak.upgrade() else { break };
                    let call = handle(socket, &secret, &session, context.clone(), scope.clone());
                    tokio::select! {_=call=>{},()=scope.cancelled()=>break}
                }
            }));
        }
        let source = PYTHON.replace(
            "__CONFIG__",
            &serde_json::to_string(&serde_json::to_string(
                &json!({"endpoint":endpoint,"token":token,"code":code}),
            )?)?,
        );
        std::fs::write(file, source)?;
        let python = std::env::var("ZAALIS_PYTHON_EXECUTABLE").unwrap_or_else(|_| {
            if cfg!(windows) {
                "python".into()
            } else {
                "python3".into()
            }
        });
        if python.contains([
            '"', '\'', '&', '|', '<', '>', '%', '^', '\n', '\r', '`', '$',
        ]) {
            let _ = std::fs::remove_file(file);
            broker_cancel.cancel();
            if let Some(b) = broker {
                b.abort();
            }
            return Err(ZaalisError::invalid("invalid configured Python executable"));
        }
        let command = format!("\"{python}\" -I \"{relative}\"");
        let timeout = Duration::from_millis(
            input
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(120000)
                .clamp(1000, 1800000),
        );
        let output = if strict {
            exec.run(&command, Some(timeout), cancel).await
        } else {
            exec.run_program(&python, &["-I".into(), relative.clone()], timeout, cancel)
                .await
        };
        broker_cancel.cancel();
        if let Some(b) = broker {
            let _ = b.await;
        }
        let _ = std::fs::remove_file(file);
        let output = output?;
        let mut result = Value::Null;
        let marker = "ZAALIS_RESULT:";
        for line in output.stdout.lines().rev() {
            if let Some(raw) = line.strip_prefix(marker) {
                result = serde_json::from_str(raw).unwrap_or(Value::Null);
                break;
            }
        }
        Ok(ToolResult {
            summary: if output.success {
                "Python completed"
            } else {
                "Python failed"
            }
            .into(),
            value: json!({"execution":output,"result":result,"sandbox":SandboxCapabilities::detect(),"level":exec.sandbox_level()}),
        })
    }
}
async fn handle(
    mut socket: TcpStream,
    token: &str,
    session: &std::sync::Arc<SessionInner>,
    ctx: ToolContext,
    cancel: CancellationToken,
) -> Result<()> {
    let request = tokio::time::timeout(Duration::from_secs(5), read_request(&mut socket))
        .await
        .map_err(|_| ZaalisError::invalid("broker request timeout"))??;
    let (header, body) = request;
    let authenticated = header
        .lines()
        .any(|line| line.trim() == format!("Authorization: Bearer {token}"));
    let result = if !authenticated {
        json!({"error":"unauthorized"})
    } else {
        let input: Value = serde_json::from_slice(&body)?;
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        if matches!(
            name,
            "execute_code" | "tool_call" | "delegate_task" | "spawn_agent"
        ) {
            json!({"error":"recursive agent/code dispatch refused"})
        } else {
            match guarded_call(
                session,
                name,
                input.get("arguments").cloned().unwrap_or(json!({})),
                ctx,
                cancel,
            )
            .await
            {
                Ok(ToolOutcome::Ok { result, .. }) => json!({"result":result}),
                Ok(other) => json!({"error":other}),
                Err(e) => json!({"error":e.to_string()}),
            }
        }
    };
    let data = serde_json::to_vec(&result)?;
    let header=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",data.len());
    socket.write_all(header.as_bytes()).await?;
    socket.write_all(&data).await?;
    Ok(())
}
async fn read_request(socket: &mut TcpStream) -> Result<(String, Vec<u8>)> {
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let n = socket.read(&mut buffer).await?;
        if n == 0 {
            return Err(ZaalisError::invalid("incomplete broker request"));
        }
        data.extend_from_slice(&buffer[..n]);
        if data.len() > 256 * 1024 {
            return Err(ZaalisError::invalid("broker input limit"));
        }
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&data[..end]).to_string();
            let length = header
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    if k.eq_ignore_ascii_case("content-length") {
                        v.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .ok_or_else(|| ZaalisError::invalid("content length required"))?;
            if length > 128 * 1024 {
                return Err(ZaalisError::invalid("broker body limit"));
            }
            if data.len() >= end + 4 + length {
                return Ok((header, data[end + 4..end + 4 + length].to_vec()));
            }
        }
    }
}
const PYTHON: &str = r#"import json, urllib.request, traceback
config=json.loads(__CONFIG__)
class Tools:
    def __getattr__(self,name):
        def invoke(**arguments):
            if not config['endpoint']: raise RuntimeError('Tool broker disabled in strict sandbox')
            data=json.dumps({'name':name,'arguments':arguments}).encode()
            request=urllib.request.Request(config['endpoint'],data=data,headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=600) as response: value=json.load(response)
            if 'error' in value: raise RuntimeError(str(value['error']))
            return value.get('result')
        return invoke
scope={'tools':Tools(),'__name__':'__zaalis_code__'}
exec(compile(config['code'],'<zaalis code>','exec'),scope)
print('ZAALIS_RESULT:'+json.dumps(scope.get('result'),default=str))
"#;
