//! Bounded command execution and persistent background processes.
//!
//! The permission guard classifies the original command before this crate is
//! called. Here the invariants are operational: fixed workspace cwd, no
//! interactive credential prompts, bounded output, timeout, cancellation and
//! kill-on-drop children.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, RwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zaalis_core::{Result, ZaalisError};

mod pty;
mod sandbox;
pub use pty::{PtyInfo, PtyPoll, PtyRuntime, PtyStarted};
pub use sandbox::{SandboxCapabilities, SandboxLevel, SandboxPolicy};

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessStarted {
    pub process_id: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessPoll {
    pub process_id: String,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub process_id: String,
    pub command: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

#[derive(Debug, Default)]
struct Captured {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

impl Captured {
    fn append(&mut self, stderr: bool, bytes: &[u8]) {
        let used = self.stdout.len() + self.stderr.len();
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(used);
        let visible = &bytes[..bytes.len().min(remaining)];
        if stderr {
            self.stderr.extend_from_slice(visible);
        } else {
            self.stdout.extend_from_slice(visible);
        }
        self.truncated |= visible.len() < bytes.len();
    }

    /// Hand the captured bytes out, with secrets masked.
    ///
    /// This is the single place every one-shot and background process output
    /// leaves the crate, so masking here covers the model, the transcript and
    /// the UI at once. Masking on the way *out* rather than on the way in keeps
    /// the byte budget honest: a truncation decision stays about the real
    /// output size, not the redacted one.
    fn drain(&mut self) -> (String, String, bool) {
        let stdout = zaalis_secrets::sanitize(&String::from_utf8_lossy(&self.stdout)).into_owned();
        let stderr = zaalis_secrets::sanitize(&String::from_utf8_lossy(&self.stderr)).into_owned();
        self.stdout.clear();
        self.stderr.clear();
        (stdout, stderr, self.truncated)
    }
}

#[derive(Debug)]
struct ProcessSession {
    command: String,
    child: AsyncMutex<Box<dyn ChildWrapper>>,
    captured: Arc<Mutex<Captured>>,
    readers: Mutex<Vec<JoinHandle<()>>>,
    started: Instant,
    exit_code: Mutex<Option<i32>>,
}

#[derive(Debug, Clone)]
pub struct ExecRuntime {
    root: PathBuf,
    processes: Arc<RwLock<HashMap<String, Arc<ProcessSession>>>>,
    sandbox_policy: SandboxPolicy,
    network: Arc<NetworkPolicy>,
}

/// The egress policy applied to commands, and the proxy that enforces it.
///
/// The proxy is started on first use rather than in `new`: binding a listener
/// needs an async context, and a runtime created for a workspace nobody ends up
/// running a command in should not have opened a socket.
#[derive(Debug)]
struct NetworkPolicy {
    policy: Option<zaalis_netpolicy::DomainPolicy>,
    proxy: tokio::sync::OnceCell<Option<Arc<zaalis_netpolicy::EgressProxy>>>,
}

impl NetworkPolicy {
    /// Read the policy from the environment.
    ///
    /// Off by default. Turning it on has to be a decision, because a policy
    /// that surprises a user mid-build teaches them to disable it.
    fn from_environment() -> Self {
        let mode = std::env::var("ZAALIS_NET_POLICY").unwrap_or_default();
        let extra: Vec<String> = std::env::var("ZAALIS_NET_ALLOW")
            .unwrap_or_default()
            .split(',')
            .map(|host| host.trim().to_owned())
            .filter(|host| !host.is_empty())
            .collect();
        let policy = match mode.to_ascii_lowercase().as_str() {
            // The registries a build actually needs, and nothing else.
            "dev" | "on" | "1" => {
                Some(zaalis_netpolicy::DomainPolicy::development_default().with_allow(extra))
            }
            // Nothing but what the user named.
            "strict" => Some(zaalis_netpolicy::DomainPolicy::default().with_allow(extra)),
            _ => None,
        };
        Self {
            policy,
            proxy: tokio::sync::OnceCell::new(),
        }
    }

    async fn proxy(&self) -> Option<Arc<zaalis_netpolicy::EgressProxy>> {
        self.proxy
            .get_or_init(|| async {
                let policy = self.policy.clone()?;
                match zaalis_netpolicy::EgressProxy::start(policy).await {
                    Ok(proxy) => Some(Arc::new(proxy)),
                    // Fail closed on the *policy*, not on the command: if the
                    // proxy cannot start, commands run without it, and the
                    // capability report says so rather than pretending.
                    Err(error) => {
                        eprintln!("zaalis: proxy réseau indisponible — {}", error.message);
                        None
                    }
                }
            })
            .await
            .clone()
    }

    async fn environment(&self) -> Vec<(String, String)> {
        match self.proxy().await {
            Some(proxy) => proxy.environment(),
            None => Vec::new(),
        }
    }
}

impl ExecRuntime {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = dunce::canonicalize(root)?;
        if !root.is_dir() {
            return Err(ZaalisError::invalid("cwd d'exécution invalide"));
        }
        let sandbox_policy = SandboxPolicy {
            required: match std::env::var("ZAALIS_SANDBOX_MODE")
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str()
            {
                "strict" => SandboxLevel::Strict,
                _ => SandboxLevel::ProcessTree,
            },
        };
        sandbox_policy.validate()?;
        Ok(Self {
            root,
            processes: Arc::new(RwLock::new(HashMap::new())),
            sandbox_policy,
            network: Arc::new(NetworkPolicy::from_environment()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn sandbox_level(&self) -> SandboxLevel {
        self.sandbox_policy.required
    }

    pub async fn run(
        &self,
        command: &str,
        timeout: Option<Duration>,
        cancel: CancellationToken,
    ) -> Result<CommandOutput> {
        validate_command(command)?;
        #[cfg(windows)]
        let resolved_command = resolve_windows_version_command(command);
        #[cfg(windows)]
        let command = resolved_command.as_deref().unwrap_or(command);
        if self.sandbox_policy.required == SandboxLevel::Strict {
            return run_strict(&self.root, command, timeout, cancel).await;
        }
        let started = Instant::now();
        let mut child = spawn_shell(&self.root, command, &self.network.environment().await)?;
        let captured = Arc::new(Mutex::new(Captured::default()));
        let readers = take_readers(&mut child, Arc::clone(&captured))?;
        let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT).min(MAX_TIMEOUT);
        let mut timed_out = false;

        let status = tokio::select! {
            status = child.wait() => status?,
            () = cancel.cancelled() => {
                child.start_kill()?;
                let _ = child.wait().await;
                join_readers(readers).await;
                return Err(ZaalisError::cancelled());
            }
            () = tokio::time::sleep(timeout) => {
                timed_out = true;
                child.start_kill()?;
                child.wait().await?
            }
        };
        join_readers(readers).await;
        let (stdout, stderr, truncated) = captured.lock().expect("capture lock poisoned").drain();
        Ok(CommandOutput {
            stdout,
            stderr,
            exit_code: status.code(),
            success: status.success() && !timed_out,
            timed_out,
            truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn start(&self, command: &str) -> Result<ProcessStarted> {
        if self.sandbox_policy.required == SandboxLevel::Strict {
            return Err(ZaalisError::unsupported(
                "processus persistant refusé en sandbox strict",
            ));
        }
        validate_command(command)?;
        let mut child = spawn_shell(&self.root, command, &self.network.environment().await)?;
        let captured = Arc::new(Mutex::new(Captured::default()));
        let readers = take_readers(&mut child, Arc::clone(&captured))?;
        let process_id = format!("proc_{}", uuid::Uuid::now_v7().simple());
        let session = Arc::new(ProcessSession {
            command: command.into(),
            child: AsyncMutex::new(child),
            captured,
            readers: Mutex::new(readers),
            started: Instant::now(),
            exit_code: Mutex::new(None),
        });
        self.processes
            .write()
            .await
            .insert(process_id.clone(), session);
        Ok(ProcessStarted {
            process_id,
            command: command.into(),
        })
    }

    pub async fn poll(&self, process_id: &str) -> Result<ProcessPoll> {
        let session = self.session(process_id).await?;
        let status = session.child.lock().await.try_wait()?;
        if let Some(status) = status {
            *session.exit_code.lock().expect("exit lock poisoned") = status.code();
        }
        let exit_code = *session.exit_code.lock().expect("exit lock poisoned");
        let (stdout, stderr, truncated) = session
            .captured
            .lock()
            .expect("capture lock poisoned")
            .drain();
        Ok(ProcessPoll {
            process_id: process_id.into(),
            command: session.command.clone(),
            stdout,
            stderr,
            running: status.is_none(),
            exit_code,
            truncated,
            duration_ms: session.started.elapsed().as_millis() as u64,
        })
    }

    pub async fn write(&self, process_id: &str, input: &str) -> Result<()> {
        let session = self.session(process_id).await?;
        let mut child = session.child.lock().await;
        let stdin = child
            .stdin()
            .as_mut()
            .ok_or_else(|| ZaalisError::tool("stdin du processus fermé"))?;
        stdin.write_all(input.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn kill(&self, process_id: &str) -> Result<ProcessPoll> {
        let session = self.session(process_id).await?;
        let status = {
            let mut child = session.child.lock().await;
            match child.try_wait()? {
                Some(status) => status,
                None => {
                    child.start_kill()?;
                    child.wait().await?
                }
            }
        };
        *session.exit_code.lock().expect("exit lock poisoned") = status.code();
        let readers = std::mem::take(&mut *session.readers.lock().expect("readers lock poisoned"));
        join_readers(readers).await;
        self.poll(process_id).await
    }

    pub async fn list(&self) -> Vec<ProcessInfo> {
        let sessions: Vec<_> = self
            .processes
            .read()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect();
        let mut result = Vec::with_capacity(sessions.len());
        for (process_id, session) in sessions {
            let status = session.child.lock().await.try_wait().ok().flatten();
            if let Some(status) = status {
                *session.exit_code.lock().expect("exit lock poisoned") = status.code();
            }
            let exit_code = *session.exit_code.lock().expect("exit lock poisoned");
            result.push(ProcessInfo {
                process_id,
                command: session.command.clone(),
                running: status.is_none(),
                exit_code,
                duration_ms: session.started.elapsed().as_millis() as u64,
            });
        }
        result.sort_by(|left, right| left.process_id.cmp(&right.process_id));
        result
    }

    pub async fn remove_finished(&self, process_id: &str) -> Result<()> {
        let session = self.session(process_id).await?;
        if session.child.lock().await.try_wait()?.is_none() {
            return Err(ZaalisError::invalid("le processus tourne encore"));
        }
        self.processes.write().await.remove(process_id);
        Ok(())
    }

    async fn session(&self, process_id: &str) -> Result<Arc<ProcessSession>> {
        self.processes
            .read()
            .await
            .get(process_id)
            .cloned()
            .ok_or_else(|| ZaalisError::not_found(format!("processus inconnu : {process_id}")))
    }
}

fn validate_command(command: &str) -> Result<()> {
    if command.trim().is_empty() {
        return Err(ZaalisError::invalid("commande vide"));
    }
    if command.contains('\0') || command.len() > 32_768 {
        return Err(ZaalisError::invalid("commande invalide ou trop longue"));
    }
    Ok(())
}

/// A version probe can use Blender's standard Windows install directory even
/// when the GUI installer did not add blender.exe to PATH. The permission guard
/// has already reviewed the original `blender --version` command.
#[cfg(windows)]
fn resolve_windows_version_command(command: &str) -> Option<String> {
    let mut words = command.split_whitespace();
    let executable = words.next()?;
    let flag = words.next()?;
    if words.next().is_some()
        || !executable.eq_ignore_ascii_case("blender")
        || !["--version", "-v"].iter().any(|option| flag.eq_ignore_ascii_case(option))
    {
        return None;
    }
    if std::env::var_os("PATH").is_some_and(|value| {
        std::env::split_paths(&value).any(|directory| directory.join("blender.exe").is_file())
    }) {
        return None;
    }
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from);
    let path = find_blender_executable(roots)?;
    Some(format!("\"{}\" {flag}", path.display()))
}

#[cfg(windows)]
fn find_blender_executable(roots: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for root in roots {
        for parent in [root.join("Blender Foundation"), root.join("Programs").join("Blender Foundation")] {
            let Ok(entries) = std::fs::read_dir(parent) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(version) = name.strip_prefix("Blender ") else { continue };
                let numbers = version.split('.').map(str::parse::<u32>).collect::<std::result::Result<Vec<_>, _>>();
                let Ok(numbers) = numbers else { continue };
                let executable = entry.path().join("blender.exe");
                if executable.is_file() {
                    candidates.push((numbers, executable));
                }
            }
        }
    }
    candidates.into_iter().max_by(|left, right| left.0.cmp(&right.0)).map(|(_, path)| path)
}

fn spawn_shell(
    root: &Path,
    command: &str,
    proxy_environment: &[(String, String)],
) -> Result<Box<dyn ChildWrapper>> {
    let mut process = platform_shell(command);
    process
        .current_dir(root)
        .env_clear()
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    copy_minimal_environment(&mut process);
    // After the minimal copy, so an inherited HTTP_PROXY can never override the
    // one the policy is enforcing.
    for (name, value) in proxy_environment {
        process.env(name, value);
    }
    let mut wrapped = CommandWrap::from(process);
    wrapped.wrap(KillOnDrop);
    #[cfg(windows)]
    wrapped.wrap(JobObject);
    #[cfg(unix)]
    wrapped.wrap(ProcessGroup::leader());
    wrapped.spawn().map_err(Into::into)
}

fn copy_minimal_environment(process: &mut Command) {
    #[cfg(windows)]
    const ALLOWED: &[&str] = &["SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"];
    #[cfg(not(windows))]
    const ALLOWED: &[&str] = &["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    for name in ALLOWED {
        if let Some(value) = std::env::var_os(name) {
            process.env(name, value);
        }
    }
}

#[cfg(windows)]
fn platform_shell(command: &str) -> Command {
    let mut process = Command::new("cmd.exe");
    process.args(["/d", "/s", "/c", command]);
    process
}

#[cfg(not(windows))]
fn platform_shell(command: &str) -> Command {
    let mut process = Command::new("sh");
    process.args(["-lc", command]);
    process
}

fn take_readers(
    child: &mut Box<dyn ChildWrapper>,
    captured: Arc<Mutex<Captured>>,
) -> Result<Vec<JoinHandle<()>>> {
    let stdout = child
        .stdout()
        .take()
        .ok_or_else(|| ZaalisError::internal("stdout non capturé"))?;
    let stderr = child
        .stderr()
        .take()
        .ok_or_else(|| ZaalisError::internal("stderr non capturé"))?;
    Ok(vec![
        tokio::spawn(capture_reader(stdout, Arc::clone(&captured), false)),
        tokio::spawn(capture_reader(stderr, captured, true)),
    ])
}

async fn capture_reader<R: AsyncRead + Unpin>(
    mut reader: R,
    captured: Arc<Mutex<Captured>>,
    stderr: bool,
) {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => captured
                .lock()
                .expect("capture lock poisoned")
                .append(stderr, &buffer[..read]),
        }
    }
}

async fn join_readers(readers: Vec<JoinHandle<()>>) {
    for reader in readers {
        let _ = reader.await;
    }
}

#[cfg(windows)]
async fn run_strict(
    root: &Path,
    command: &str,
    timeout: Option<Duration>,
    cancel: CancellationToken,
) -> Result<CommandOutput> {
    let (control_tx, control_rx) = std::sync::mpsc::channel();
    let (result_tx, mut result_rx) = tokio::sync::oneshot::channel();
    let root = root.to_path_buf();
    let command = command.to_owned();
    std::thread::Builder::new()
        .name("zaalis-strict-sandbox".into())
        .spawn(move || {
            let _ = result_tx.send(run_strict_blocking(&root, &command, timeout, control_rx));
        })?;
    tokio::select! {
        result = &mut result_rx => result.map_err(|_| ZaalisError::internal("worker sandbox interrompu"))?,
        () = cancel.cancelled() => {
            let _ = control_tx.send(());
            let _ = result_rx.await;
            Err(ZaalisError::cancelled())
        }
    }
}

#[cfg(windows)]
fn run_strict_blocking(
    root: &Path,
    command: &str,
    timeout: Option<Duration>,
    control: std::sync::mpsc::Receiver<()>,
) -> Result<CommandOutput> {
    use sandboxrs_windows::{Sandbox, Stdio};
    use std::io::Read;

    fn capture_blocking(reader: &mut impl Read, captured: Arc<Mutex<Captured>>, stderr: bool) {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => captured
                    .lock()
                    .expect("capture lock poisoned")
                    .append(stderr, &buffer[..read]),
            }
        }
    }

    let started = Instant::now();
    let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT).min(MAX_TIMEOUT);
    let mut builder = Sandbox::builder(root)
        .max_memory(2 * 1024 * 1024 * 1024)
        .max_processes(64);
    // The workspace is read-write by construction; everything a build needs to
    // *read* has to be granted explicitly. Without this the sandbox is airtight
    // and useless: `cargo build` cannot reach its own toolchain, so strict mode
    // would fail on its first command and be switched off.
    for path in sandbox::read_only_roots() {
        builder = builder.read_only(path);
    }
    let sandbox = builder
        .build()
        .map_err(|error| ZaalisError::denied(format!("sandbox strict : {error}")))?;
    let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let mut process = sandbox.command(shell);
    process
        .args(["/d", "/s", "/c", command])
        .current_dir(root)
        .env_clear()
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in ["SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            process.env(name, value);
        }
    }
    let mut child = process
        .spawn()
        .map_err(|error| ZaalisError::tool(format!("lancement sandbox strict : {error}")))?;
    let captured = Arc::new(Mutex::new(Captured::default()));
    let mut readers = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let capture = Arc::clone(&captured);
        readers.push(std::thread::spawn(move || {
            capture_blocking(&mut stdout, capture, false)
        }));
    }
    if let Some(mut stderr) = child.stderr.take() {
        let capture = Arc::clone(&captured);
        readers.push(std::thread::spawn(move || {
            capture_blocking(&mut stderr, capture, true)
        }));
    }
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| ZaalisError::io(error.to_string()))?
        {
            break status;
        }
        if control.try_recv().is_ok() {
            cancelled = true;
            child
                .kill()
                .map_err(|error| ZaalisError::io(error.to_string()))?;
        }
        if !timed_out && started.elapsed() >= timeout {
            timed_out = true;
            child
                .kill()
                .map_err(|error| ZaalisError::io(error.to_string()))?;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    for reader in readers {
        let _ = reader.join();
    }
    if cancelled {
        return Err(ZaalisError::cancelled());
    }
    let (stdout, stderr, truncated) = captured.lock().expect("capture lock poisoned").drain();
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code: status.code(),
        success: status.success() && !timed_out,
        timed_out,
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(unix)]
async fn run_strict(
    root: &Path,
    command: &str,
    timeout: Option<Duration>,
    cancel: CancellationToken,
) -> Result<CommandOutput> {
    let helper = sandbox::sandbox_helper()
        .ok_or_else(|| ZaalisError::denied("helper sandbox strict introuvable"))?;
    let started = Instant::now();
    let mut process = Command::new(helper);
    process
        .arg(root)
        .arg(command)
        .current_dir(root)
        .env_clear()
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    copy_minimal_environment(&mut process);
    let mut wrapped = CommandWrap::from(process);
    wrapped.wrap(KillOnDrop);
    wrapped.wrap(ProcessGroup::leader());
    let mut child = wrapped.spawn()?;
    let captured = Arc::new(Mutex::new(Captured::default()));
    let readers = take_readers(&mut child, Arc::clone(&captured))?;
    let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT).min(MAX_TIMEOUT);
    let mut timed_out = false;
    let status = tokio::select! {
        status = child.wait() => status?,
        () = cancel.cancelled() => {
            child.start_kill()?;
            let _ = child.wait().await;
            join_readers(readers).await;
            return Err(ZaalisError::cancelled());
        }
        () = tokio::time::sleep(timeout) => {
            timed_out = true;
            child.start_kill()?;
            child.wait().await?
        }
    };
    join_readers(readers).await;
    let (stdout, stderr, truncated) = captured.lock().expect("capture lock poisoned").drain();
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code: status.code(),
        success: status.success() && !timed_out,
        timed_out,
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(not(any(windows, unix)))]
async fn run_strict(
    _root: &Path,
    _command: &str,
    _timeout: Option<Duration>,
    _cancel: CancellationToken,
) -> Result<CommandOutput> {
    Err(ZaalisError::unsupported(
        "sandbox strict non implémentée sur cette plateforme",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn echo_command(text: &str) -> String {
        if cfg!(windows) {
            format!("echo {text}")
        } else {
            format!("printf '{text}\\n'")
        }
    }

    fn wait_command() -> &'static str {
        if cfg!(windows) {
            "ping -n 6 127.0.0.1 > nul"
        } else {
            "sleep 5"
        }
    }

    #[cfg(windows)]
    #[test]
    fn installed_blender_is_found_without_a_path_entry() {
        let root = TempDir::new().expect("tempdir");
        for version in ["5.2", "5.10"] {
            let directory = root.path().join("Blender Foundation").join(format!("Blender {version}"));
            std::fs::create_dir_all(&directory).expect("version directory");
            std::fs::write(directory.join("blender.exe"), []).expect("executable fixture");
        }
        let found = find_blender_executable([root.path().to_path_buf()]).expect("installed Blender");
        assert!(found.ends_with(Path::new("Blender 5.10").join("blender.exe")));
    }

    #[tokio::test]
    async fn one_shot_command_captures_output_and_status() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = ExecRuntime::new(dir.path()).expect("runtime");
        let output = runtime
            .run(&echo_command("ZAALIS_OK"), None, CancellationToken::new())
            .await
            .expect("run");
        assert!(output.success);
        assert!(output.stdout.contains("ZAALIS_OK"));
        assert!(!output.truncated);
    }

    #[tokio::test]
    async fn timeout_kills_the_child_and_reports_it() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = ExecRuntime::new(dir.path()).expect("runtime");
        let output = runtime
            .run(
                wait_command(),
                Some(Duration::from_millis(50)),
                CancellationToken::new(),
            )
            .await
            .expect("run");
        assert!(output.timed_out);
        assert!(!output.success);
    }

    #[tokio::test]
    async fn cancellation_is_a_typed_error() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = ExecRuntime::new(dir.path()).expect("runtime");
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            trigger.cancel();
        });
        let error = runtime
            .run(wait_command(), None, cancel)
            .await
            .expect_err("cancelled");
        assert_eq!(error.code, zaalis_core::ErrorCode::Cancelled);
    }

    #[tokio::test]
    async fn background_process_can_be_polled_and_killed() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = ExecRuntime::new(dir.path()).expect("runtime");
        let started = runtime.start(wait_command()).await.expect("start");
        assert!(
            runtime
                .poll(&started.process_id)
                .await
                .expect("poll")
                .running
        );
        let stopped = runtime.kill(&started.process_id).await.expect("kill");
        assert!(!stopped.running);
        runtime
            .remove_finished(&started.process_id)
            .await
            .expect("remove");
        assert!(runtime.list().await.is_empty());
    }

    #[tokio::test]
    async fn a_command_inherits_the_egress_proxy_when_a_policy_is_active() {
        // The variables are what a cooperating tool reads, so asserting on them
        // is asserting on the mechanism: no proxy variables reach the child,
        // no policy is being applied to it.
        let network = NetworkPolicy {
            policy: Some(zaalis_netpolicy::DomainPolicy::development_default()),
            proxy: tokio::sync::OnceCell::new(),
        };
        let environment = network.environment().await;
        assert!(
            environment
                .iter()
                .any(|(name, value)| name == "HTTPS_PROXY" && value.starts_with("http://127.0.0.1:")),
            "la commande doit être pointée vers le proxy local : {environment:?}"
        );
        assert!(environment.iter().any(|(name, _)| name == "NO_PROXY"));
    }

    #[tokio::test]
    async fn no_policy_means_no_proxy_variables_at_all() {
        // The default has to stay invisible: a user who never asked for egress
        // control must not find their build talking to a proxy.
        let network = NetworkPolicy {
            policy: None,
            proxy: tokio::sync::OnceCell::new(),
        };
        assert!(network.environment().await.is_empty());
    }

    #[tokio::test]
    async fn output_is_bounded_in_memory() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = ExecRuntime::new(dir.path()).expect("runtime");
        let command = if cfg!(windows) {
            "for /L %i in (1,1,100000) do @echo 1234567890"
        } else {
            "head -c 1200000 /dev/zero | tr '\\0' x"
        };
        let output = runtime
            .run(command, None, CancellationToken::new())
            .await
            .expect("run");
        assert!(output.truncated);
        assert!(output.stdout.len() <= MAX_OUTPUT_BYTES);
    }
}
