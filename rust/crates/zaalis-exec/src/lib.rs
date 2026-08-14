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

    fn drain(&mut self) -> (String, String, bool) {
        let stdout = String::from_utf8_lossy(&self.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&self.stderr).into_owned();
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
        if self.sandbox_policy.required == SandboxLevel::Strict {
            return run_strict(&self.root, command, timeout, cancel).await;
        }
        let started = Instant::now();
        let mut child = spawn_shell(&self.root, command)?;
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
        let mut child = spawn_shell(&self.root, command)?;
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

fn spawn_shell(root: &Path, command: &str) -> Result<Box<dyn ChildWrapper>> {
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
    let sandbox = Sandbox::builder(root)
        .max_memory(2 * 1024 * 1024 * 1024)
        .max_processes(64)
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
