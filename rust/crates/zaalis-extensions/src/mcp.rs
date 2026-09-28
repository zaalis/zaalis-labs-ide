use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;
use zaalis_core::{AccessKind, Result, ZaalisError};
use zaalis_guard::AccessRequest;
use zaalis_store::SecretValue;
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolResult};

const MCP_PROTOCOL: &str = "2025-03-26";
const MAX_MCP_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub enum McpTransport {
    Stdio {
        executable: PathBuf,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    StreamableHttp {
        endpoint: Url,
        oauth_token: Option<Arc<SecretValue>>,
    },
}

impl fmt::Debug for McpTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stdio {
                executable,
                args,
                env,
            } => formatter
                .debug_struct("Stdio")
                .field("executable", executable)
                .field("args", args)
                .field("env_keys", &env.keys())
                .finish(),
            Self::StreamableHttp {
                endpoint,
                oauth_token,
            } => formatter
                .debug_struct("StreamableHttp")
                .field("endpoint", endpoint)
                .field("oauth", &oauth_token.is_some())
                .finish(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    pub allow: BTreeSet<String>,
    pub deny: BTreeSet<String>,
    pub timeout: Duration,
}

impl McpServer {
    pub fn new(id: impl Into<String>, transport: McpTransport) -> Result<Self> {
        let id = id.into();
        if !valid_name(&id) {
            return Err(ZaalisError::invalid("identifiant MCP invalide"));
        }
        validate_transport(&transport)?;
        Ok(Self {
            name: id.clone(),
            id,
            transport,
            allow: BTreeSet::new(),
            deny: BTreeSet::new(),
            timeout: Duration::from_secs(15),
        })
    }
    pub fn allows(&self, tool: &str) -> bool {
        !self.deny.contains(tool) && (self.allow.is_empty() || self.allow.contains(tool))
    }
}

#[derive(Debug)]
enum Connection {
    Stdio(Box<StdioConnection>),
    Http(HttpConnection),
}

#[derive(Debug)]
struct ServerState {
    config: McpServer,
    connection: Mutex<Option<Connection>>,
}

#[derive(Debug, Default)]
pub struct McpRegistry {
    servers: RwLock<BTreeMap<String, Arc<ServerState>>>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn load(workspace: &zaalis_fs::Workspace, user_root: Option<&Path>) -> Result<Self> {
        let registry = Self::new();
        if let Some(root) = user_root {
            registry.load_file(&root.join("mcp.json"), workspace.root())?;
        }
        registry.load_file(
            &workspace.root().join(".zaalis").join("mcp.json"),
            workspace.root(),
        )?;
        Ok(registry)
    }

    fn load_file(&self, path: &Path, workspace: &Path) -> Result<()> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 256 * 1024 {
            return Err(ZaalisError::invalid(
                "configuration MCP non sûre ou trop grande",
            ));
        }
        let config: McpFile = serde_json::from_slice(&fs::read(path)?)?;
        if config.servers.len() > 32 {
            return Err(ZaalisError::invalid("trop de serveurs MCP"));
        }
        for (id, value) in config.servers {
            self.register(value.into_server(id, workspace)?)?;
        }
        Ok(())
    }
    pub fn register(&self, server: McpServer) -> Result<()> {
        validate_transport(&server.transport)?;
        self.servers.write().expect("MCP registry poisoned").insert(
            server.id.clone(),
            Arc::new(ServerState {
                config: server,
                connection: Mutex::new(None),
            }),
        );
        Ok(())
    }
    pub fn list(&self) -> Vec<String> {
        self.servers
            .read()
            .expect("MCP registry poisoned")
            .keys()
            .cloned()
            .collect()
    }
    pub async fn tools(&self, server: &str, cancel: CancellationToken) -> Result<Vec<Value>> {
        let value = self
            .request(server, "tools/list", json!({}), cancel)
            .await?;
        Ok(value
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
    pub async fn call(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let state = self.server(server)?;
        if !valid_name(tool) || !state.config.allows(tool) {
            return Err(ZaalisError::denied("outil MCP refusé par allow/deny"));
        }
        self.request_state(
            &state,
            "tools/call",
            json!({"name":tool,"arguments":arguments}),
            cancel,
        )
        .await
    }
    pub async fn liveness(&self, server: &str, cancel: CancellationToken) -> Result<bool> {
        self.request(server, "ping", json!({}), cancel)
            .await
            .map(|_| true)
    }
    async fn request(
        &self,
        server: &str,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let state = self.server(server)?;
        self.request_state(&state, method, params, cancel).await
    }
    fn server(&self, id: &str) -> Result<Arc<ServerState>> {
        self.servers
            .read()
            .expect("MCP registry poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| ZaalisError::not_found("serveur MCP introuvable"))
    }
    async fn request_state(
        &self,
        state: &Arc<ServerState>,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let mut connection = state.connection.lock().await;
        if connection.is_none() {
            *connection = Some(connect(&state.config, cancel.clone()).await?);
        }
        let result = match connection.as_mut().expect("MCP connection initialized") {
            Connection::Stdio(client) => {
                client
                    .request(method, params, state.config.timeout, cancel)
                    .await
            }
            Connection::Http(client) => {
                client
                    .request(method, params, state.config.timeout, cancel)
                    .await
            }
        };
        if result.is_err() {
            *connection = None;
        }
        result
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct McpFile {
    #[serde(default)]
    servers: BTreeMap<String, McpServerFile>,
}

#[derive(Debug, Deserialize)]
struct McpServerFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(flatten)]
    transport: McpTransportFile,
    #[serde(default)]
    allow: BTreeSet<String>,
    #[serde(default)]
    deny: BTreeSet<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case", deny_unknown_fields)]
enum McpTransportFile {
    Stdio {
        executable: PathBuf,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env_from: BTreeMap<String, String>,
    },
    StreamableHttp {
        endpoint: String,
        #[serde(default)]
        oauth_env: Option<String>,
    },
}

impl McpServerFile {
    fn into_server(self, id: String, workspace: &Path) -> Result<McpServer> {
        let transport = match self.transport {
            McpTransportFile::Stdio {
                executable,
                args,
                env_from,
            } => {
                let executable = if executable.is_absolute() {
                    dunce::canonicalize(executable)?
                } else {
                    dunce::canonicalize(workspace.join(executable))?
                };
                let mut env = BTreeMap::new();
                for (target, source) in env_from {
                    if !valid_env_name(&target) || !valid_env_name(&source) {
                        return Err(ZaalisError::invalid("nom de variable MCP invalide"));
                    }
                    let value = std::env::var(&source).map_err(|_| {
                        ZaalisError::config(format!("variable MCP absente : {source}"))
                    })?;
                    env.insert(target, value);
                }
                McpTransport::Stdio {
                    executable,
                    args,
                    env,
                }
            }
            McpTransportFile::StreamableHttp {
                endpoint,
                oauth_env,
            } => {
                let oauth_token = oauth_env
                    .map(|name| {
                        if !valid_env_name(&name) {
                            return Err(ZaalisError::invalid("variable OAuth MCP invalide"));
                        }
                        std::env::var(&name)
                            .map(SecretValue::new)
                            .map(Arc::new)
                            .map_err(|_| {
                                ZaalisError::config(format!("variable OAuth absente : {name}"))
                            })
                    })
                    .transpose()?;
                McpTransport::StreamableHttp {
                    endpoint: Url::parse(&endpoint)
                        .map_err(|error| ZaalisError::invalid(error.to_string()))?,
                    oauth_token,
                }
            }
        };
        let mut server = McpServer::new(id, transport)?;
        if let Some(name) = self.name {
            if name.trim().is_empty() || name.len() > 256 {
                return Err(ZaalisError::invalid("nom MCP invalide"));
            }
            server.name = name;
        }
        server.allow = self.allow;
        server.deny = self.deny;
        if let Some(timeout) = self.timeout_ms {
            server.timeout = Duration::from_millis(timeout.clamp(100, 120_000));
        }
        Ok(server)
    }
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '_')
}

async fn connect(server: &McpServer, cancel: CancellationToken) -> Result<Connection> {
    let mut connection = match &server.transport {
        McpTransport::Stdio {
            executable,
            args,
            env,
        } => Connection::Stdio(Box::new(StdioConnection::spawn(executable, args, env)?)),
        McpTransport::StreamableHttp {
            endpoint,
            oauth_token,
        } => Connection::Http(HttpConnection::new(endpoint.clone(), oauth_token.clone())?),
    };
    let params = json!({"protocolVersion":MCP_PROTOCOL,"capabilities":{},"clientInfo":{"name":"zaalis","version":env!("CARGO_PKG_VERSION")}});
    match &mut connection {
        Connection::Stdio(client) => {
            client
                .request("initialize", params, server.timeout, cancel)
                .await?;
            client
                .notify("notifications/initialized", json!({}))
                .await?;
        }
        Connection::Http(client) => {
            client
                .request("initialize", params, server.timeout, cancel)
                .await?;
            client
                .notify("notifications/initialized", json!({}), server.timeout)
                .await?;
        }
    }
    Ok(connection)
}

#[derive(Debug)]
struct StdioConnection {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
}
impl StdioConnection {
    fn spawn(
        executable: &PathBuf,
        args: &[String],
        env: &BTreeMap<String, String>,
    ) -> Result<Self> {
        let mut command = Command::new(executable);
        command.args(args).env_clear();
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| ZaalisError::io("stdin MCP indisponible"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| ZaalisError::io("stdout MCP indisponible"))?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            next_id: 1,
        })
    }
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let receive = async {
            loop {
                let line = read_bounded_line(&mut self.output)
                    .await?
                    .ok_or_else(|| ZaalisError::io("serveur MCP fermé"))?;
                if line.len() > MAX_MCP_RESPONSE {
                    return Err(ZaalisError::invalid("réponse MCP trop volumineuse"));
                }
                let value: Value = serde_json::from_str(&line)?;
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(ZaalisError::io(format!(
                        "MCP: {}",
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("erreur")
                    )));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        };
        tokio::select! { result = tokio::time::timeout(timeout, receive) => result.map_err(|_| ZaalisError::timeout("MCP timeout"))?, () = cancel.cancelled() => Err(ZaalisError::cancelled()) }
    }
    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.write(&json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
    async fn write(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
}
impl Drop for StdioConnection {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[derive(Debug)]
struct HttpConnection {
    endpoint: Url,
    token: Option<Arc<SecretValue>>,
    session: Option<String>,
    client: reqwest::Client,
    next_id: u64,
}
impl HttpConnection {
    fn new(endpoint: Url, token: Option<Arc<SecretValue>>) -> Result<Self> {
        validate_http(&endpoint)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| ZaalisError::io(error.to_string()))?;
        Ok(Self {
            endpoint,
            token,
            session: None,
            client,
            next_id: 1,
        })
    }
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let response = self
            .send(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
                timeout,
                cancel,
            )
            .await?;
        if let Some(error) = response.get("error") {
            return Err(ZaalisError::io(format!(
                "MCP: {}",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("erreur")
            )));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
    async fn notify(&mut self, method: &str, params: Value, timeout: Duration) -> Result<()> {
        self.send(
            json!({"jsonrpc":"2.0","method":method,"params":params}),
            timeout,
            CancellationToken::new(),
        )
        .await
        .map(|_| ())
    }
    async fn send(
        &mut self,
        payload: Value,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let mut request = self
            .client
            .post(self.endpoint.clone())
            .timeout(timeout)
            .header("accept", "application/json, text/event-stream")
            .json(&payload);
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session);
        }
        if let Some(token) = &self.token {
            request = request.bearer_auth(token.expose());
        }
        let mut response = tokio::select! { response = request.send() => response.map_err(|error| ZaalisError::io(error.to_string()))?, () = cancel.cancelled() => return Err(ZaalisError::cancelled()) };
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.session = Some(session.to_owned());
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| ZaalisError::io(error.to_string()))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_MCP_RESPONSE {
                return Err(ZaalisError::invalid("reponse MCP trop volumineuse"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() > MAX_MCP_RESPONSE {
            return Err(ZaalisError::invalid("réponse MCP trop volumineuse"));
        }
        if !status.is_success() {
            return Err(ZaalisError::io(format!("MCP HTTP {status}")));
        }
        parse_http(&bytes, &content_type)
    }
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let (take, finished, empty) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                (0, false, true)
            } else if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                (index + 1, true, false)
            } else {
                (available.len(), false, false)
            }
        };
        if empty {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        if bytes.len().saturating_add(take) > MAX_MCP_RESPONSE + 1 {
            return Err(ZaalisError::invalid("reponse MCP trop volumineuse"));
        }
        let available = reader.fill_buf().await?;
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if finished {
            break;
        }
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    if bytes.len() > MAX_MCP_RESPONSE {
        return Err(ZaalisError::invalid("reponse MCP trop volumineuse"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| ZaalisError::invalid("reponse MCP non UTF-8"))
}

fn parse_http(bytes: &[u8], content_type: &str) -> Result<Value> {
    if content_type.contains("text/event-stream") {
        let text =
            std::str::from_utf8(bytes).map_err(|_| ZaalisError::invalid("SSE MCP non UTF-8"))?;
        let data = text
            .lines()
            .rev()
            .find_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .ok_or_else(|| ZaalisError::invalid("SSE MCP sans data"))?;
        return Ok(serde_json::from_str(data)?);
    }
    Ok(serde_json::from_slice(bytes)?)
}

fn validate_transport(transport: &McpTransport) -> Result<()> {
    match transport {
        McpTransport::Stdio {
            executable,
            args,
            env,
        } => {
            if !executable.is_absolute() || !executable.is_file() {
                return Err(ZaalisError::invalid("exécutable MCP absolu requis"));
            }
            if args.len() > 64 || env.len() > 64 {
                return Err(ZaalisError::invalid("configuration MCP trop grande"));
            }
            Ok(())
        }
        McpTransport::StreamableHttp { endpoint, .. } => validate_http(endpoint),
    }
}
fn validate_http(endpoint: &Url) -> Result<()> {
    if endpoint.username() != "" || endpoint.password().is_some() || endpoint.fragment().is_some() {
        return Err(ZaalisError::invalid(
            "URL MCP avec identifiants/fragment refusée",
        ));
    }
    let local = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && local) {
        return Err(ZaalisError::invalid(
            "MCP HTTP non chiffré autorisé seulement en loopback",
        ));
    }
    Ok(())
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

#[derive(Debug)]
pub struct McpTool {
    registry: Arc<McpRegistry>,
}
impl McpTool {
    pub fn new(registry: Arc<McpRegistry>) -> Self {
        Self { registry }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    server: String,
    tool: String,
    #[serde(default)]
    arguments: Value,
}
#[async_trait]
impl Tool for McpTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "mcp".into(),
            description: "Appeler un outil d'un serveur MCP Zaalis autorisé.".into(),
            input_schema: json!({"type":"object","properties":{"server":{"type":"string"},"tool":{"type":"string"},"arguments":{"type":"object"}},"required":["server","tool"],"additionalProperties":false}),
        }
    }
    fn access(&self, input: &Value, context: &ToolContext) -> Result<AccessRequest> {
        let input: Input = serde_json::from_value(input.clone())?;
        Ok(
            AccessRequest::new(context.agent_id.clone(), "mcp", AccessKind::Mcp)
                .with_target(format!("{}:{}", input.server, input.tool)),
        )
    }
    async fn execute(
        &self,
        input: Value,
        _context: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let input: Input = serde_json::from_value(input)?;
        let result = self
            .registry
            .call(&input.server, &input.tool, input.arguments, cancel)
            .await?;
        Ok(ToolResult {
            summary: format!("MCP {}.{}", input.server, input.tool),
            value: result,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    #[test]
    fn plain_remote_http_and_credentials_are_refused() {
        assert!(validate_http(&Url::parse("http://example.com/mcp").unwrap()).is_err());
        assert!(validate_http(&Url::parse("https://user:pass@example.com/mcp").unwrap()).is_err());
        assert!(validate_http(&Url::parse("http://127.0.0.1:39191/mcp").unwrap()).is_ok());
    }
    #[test]
    fn allow_and_deny_are_fail_closed() {
        let mut server = McpServer::new(
            "safe",
            McpTransport::StreamableHttp {
                endpoint: Url::parse("https://example.com/mcp").unwrap(),
                oauth_token: None,
            },
        )
        .unwrap();
        server.allow.insert("read".into());
        server.deny.insert("delete".into());
        assert!(server.allows("read"));
        assert!(!server.allows("write"));
        assert!(!server.allows("delete"));
    }
    #[test]
    fn streamable_http_parses_last_sse_data_frame() {
        let parsed = parse_http(
            b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true}}\n\n",
            "text/event-stream",
        )
        .unwrap();
        assert_eq!(parsed["result"]["ok"], true);
    }

    #[tokio::test]
    async fn stdio_lines_are_rejected_before_exceeding_the_limit() {
        let oversized = vec![b'x'; MAX_MCP_RESPONSE + 2];
        let mut reader = BufReader::new(oversized.as_slice());
        assert!(read_bounded_line(&mut reader).await.is_err());

        let mut reader = BufReader::new(&b"{\"ok\":true}\n"[..]);
        assert_eq!(
            read_bounded_line(&mut reader).await.unwrap().as_deref(),
            Some("{\"ok\":true}")
        );
    }

    #[test]
    fn workspace_config_loads_and_rejects_literal_unknown_fields() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".zaalis")).unwrap();
        fs::write(
            dir.path().join(".zaalis/mcp.json"),
            r#"{"servers":{"local":{"transport":"streamable_http","endpoint":"http://127.0.0.1:39001/mcp","allow":["read"]}}}"#,
        )
        .unwrap();
        let workspace = zaalis_fs::Workspace::open(dir.path()).unwrap();
        let registry = McpRegistry::load(&workspace, None).unwrap();
        assert_eq!(registry.list(), vec!["local"]);

        fs::write(
            dir.path().join(".zaalis/mcp.json"),
            r#"{"servers":{"bad":{"transport":"streamable_http","endpoint":"https://example.com/mcp","oauth_token":"literal-secret"}}}"#,
        )
        .unwrap();
        assert!(McpRegistry::load(&workspace, None).is_err());
    }
}
