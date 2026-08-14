use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Instant;
use zaalis_core::{Result, ZaalisError};

const MAX_PTY_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyStarted {
    pub pty_id: String,
    pub command: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyPoll {
    pub pty_id: String,
    pub output: String,
    pub running: bool,
    pub exit_code: Option<u32>,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyInfo {
    pub pty_id: String,
    pub command: Option<String>,
    pub running: bool,
    pub exit_code: Option<u32>,
    pub rows: u16,
    pub cols: u16,
    pub duration_ms: u64,
}

#[derive(Default)]
struct PtyCapture {
    bytes: Vec<u8>,
    truncated: bool,
}

impl PtyCapture {
    fn append(&mut self, bytes: &[u8]) {
        let remaining = MAX_PTY_OUTPUT_BYTES.saturating_sub(self.bytes.len());
        let visible = &bytes[..bytes.len().min(remaining)];
        self.bytes.extend_from_slice(visible);
        self.truncated |= visible.len() < bytes.len();
    }

    fn drain(&mut self) -> (String, bool) {
        let output = String::from_utf8_lossy(&self.bytes).into_owned();
        self.bytes.clear();
        (output, self.truncated)
    }
}

struct PtySession {
    command: Option<String>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    reader_done: Arc<AtomicBool>,
    capture: Arc<Mutex<PtyCapture>>,
    size: Mutex<(u16, u16)>,
    exit_code: Mutex<Option<u32>>,
    started: Instant,
}

impl std::fmt::Debug for PtySession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PtySession")
            .field("command", &self.command)
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct PtyRuntime {
    root: PathBuf,
    sessions: Arc<RwLock<HashMap<String, Arc<PtySession>>>>,
}

impl std::fmt::Debug for PtyRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PtyRuntime")
            .field("root", &self.root)
            .field(
                "sessions",
                &self
                    .sessions
                    .read()
                    .expect("pty sessions lock poisoned")
                    .len(),
            )
            .finish()
    }
}

impl PtyRuntime {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = dunce::canonicalize(root)?;
        if !root.is_dir() {
            return Err(ZaalisError::invalid("cwd PTY invalide"));
        }
        Ok(Self {
            root,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn start(&self, command: Option<&str>, rows: u16, cols: u16) -> Result<PtyStarted> {
        if command.is_some_and(|value| value.trim().is_empty() || value.contains('\0')) {
            return Err(ZaalisError::invalid("commande PTY invalide"));
        }
        let rows = rows.clamp(2, 500);
        let cols = cols.clamp(10, 1_000);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(pty_error)?;
        // Always start an interactive shell. ConPTY performs a terminal
        // handshake first; `/c command` can otherwise race its initial screen
        // reset and lose the command's output.
        let mut builder = shell_builder();
        builder.cwd(&self.root);
        builder.env_clear();
        copy_minimal_environment(&mut builder);
        builder.env("GIT_TERMINAL_PROMPT", "0");
        let child = pair.slave.spawn_command(builder).map_err(pty_error)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(pty_error)?));
        let capture = Arc::new(Mutex::new(PtyCapture::default()));
        let reader_capture = Arc::clone(&capture);
        let terminal_writer = Arc::clone(&writer);
        let initial_command = command.map(str::to_owned);
        let reader_done = Arc::new(AtomicBool::new(false));
        let thread_done = Arc::clone(&reader_done);
        #[cfg(windows)]
        let terminal_ready = Arc::new(AtomicBool::new(false));
        #[cfg(windows)]
        let thread_ready = Arc::clone(&terminal_ready);
        #[cfg(not(windows))]
        if let Some(command) = &initial_command {
            let mut initial_writer = writer.lock().expect("pty writer lock poisoned");
            initial_writer.write_all(command.as_bytes())?;
            initial_writer.write_all(b"\nexit\n")?;
            initial_writer.flush()?;
        }
        let reader_thread = std::thread::Builder::new()
            .name("zaalis-pty-reader".into())
            .spawn(move || {
                let mut buffer = [0_u8; 8 * 1024];
                #[cfg(windows)]
                let mut initial_dispatched = false;
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let chunk = &buffer[..read];
                            // Windows ConPTY asks the host terminal for its
                            // cursor position before cmd.exe starts rendering.
                            // A headless daemon must answer that control query
                            // just like a terminal emulator would.
                            if chunk.windows(4).any(|window| window == b"\x1b[6n") {
                                let mut writer =
                                    terminal_writer.lock().expect("pty writer lock poisoned");
                                let _ = writer.write_all(b"\x1b[1;1R");
                                let _ = writer.flush();
                                #[cfg(windows)]
                                if !initial_dispatched {
                                    drop(writer);
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    let mut writer =
                                        terminal_writer.lock().expect("pty writer lock poisoned");
                                    if let Some(command) = &initial_command {
                                        let _ = writer.write_all(command.as_bytes());
                                        let _ = writer.write_all(b"\r\nexit\r\n");
                                    }
                                    initial_dispatched = true;
                                    let _ = writer.flush();
                                    thread_ready.store(true, Ordering::Release);
                                }
                            }
                            reader_capture
                                .lock()
                                .expect("pty capture lock poisoned")
                                .append(chunk);
                        }
                    }
                }
                thread_done.store(true, Ordering::Release);
            })?;
        #[cfg(windows)]
        for _ in 0..100 {
            if terminal_ready.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let pty_id = format!("pty_{}", uuid::Uuid::now_v7().simple());
        self.sessions
            .write()
            .expect("pty sessions lock poisoned")
            .insert(
                pty_id.clone(),
                Arc::new(PtySession {
                    command: command.map(str::to_owned),
                    master: Mutex::new(pair.master),
                    writer,
                    child: Mutex::new(child),
                    reader: Mutex::new(Some(reader_thread)),
                    reader_done,
                    capture,
                    size: Mutex::new((rows, cols)),
                    exit_code: Mutex::new(None),
                    started: Instant::now(),
                }),
            );
        Ok(PtyStarted {
            pty_id,
            command: command.map(str::to_owned),
            rows,
            cols,
        })
    }

    pub fn poll(&self, pty_id: &str) -> Result<PtyPoll> {
        let session = self.session(pty_id)?;
        let status = session
            .child
            .lock()
            .expect("pty child lock poisoned")
            .try_wait()
            .map_err(pty_error)?;
        if let Some(ref status) = status {
            *session.exit_code.lock().expect("pty exit lock poisoned") = Some(status.exit_code());
        }
        let exit_code = *session.exit_code.lock().expect("pty exit lock poisoned");
        let (output, truncated) = session
            .capture
            .lock()
            .expect("pty capture lock poisoned")
            .drain();
        Ok(PtyPoll {
            pty_id: pty_id.into(),
            output,
            running: status.is_none(),
            exit_code,
            truncated,
            duration_ms: session.started.elapsed().as_millis() as u64,
        })
    }

    pub fn write(&self, pty_id: &str, input: &str) -> Result<()> {
        let session = self.session(pty_id)?;
        let mut writer = session.writer.lock().expect("pty writer lock poisoned");
        writer.write_all(input.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, pty_id: &str, rows: u16, cols: u16) -> Result<()> {
        let session = self.session(pty_id)?;
        let rows = rows.clamp(2, 500);
        let cols = cols.clamp(10, 1_000);
        session
            .master
            .lock()
            .expect("pty master lock poisoned")
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(pty_error)?;
        *session.size.lock().expect("pty size lock poisoned") = (rows, cols);
        Ok(())
    }

    pub fn kill(&self, pty_id: &str) -> Result<PtyPoll> {
        let session = self.session(pty_id)?;
        session
            .child
            .lock()
            .expect("pty child lock poisoned")
            .kill()
            .map_err(pty_error)?;
        // Dropping a JoinHandle detaches the reader. Joining here can deadlock
        // on Windows because ConPTY keeps the pipe open until the master side
        // itself is dropped; that happens when the finished session is removed.
        session
            .reader
            .lock()
            .expect("pty reader lock poisoned")
            .take();
        self.poll(pty_id)
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let sessions: Vec<_> = self
            .sessions
            .read()
            .expect("pty sessions lock poisoned")
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect();
        let mut result = Vec::with_capacity(sessions.len());
        for (pty_id, session) in sessions {
            let status = session
                .child
                .lock()
                .expect("pty child lock poisoned")
                .try_wait()
                .ok()
                .flatten();
            if let Some(ref status) = status {
                *session.exit_code.lock().expect("pty exit lock poisoned") =
                    Some(status.exit_code());
                // The child can be reaped a few milliseconds before the ConPTY
                // reader delivers its final screen update. Give that reader a
                // small bounded window so a terminal poll does not lose the last
                // command output.
                for _ in 0..20 {
                    if session.reader_done.load(Ordering::Acquire) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
            let exit_code = *session.exit_code.lock().expect("pty exit lock poisoned");
            let (rows, cols) = *session.size.lock().expect("pty size lock poisoned");
            result.push(PtyInfo {
                pty_id,
                command: session.command.clone(),
                running: status.is_none(),
                exit_code,
                rows,
                cols,
                duration_ms: session.started.elapsed().as_millis() as u64,
            });
        }
        result.sort_by(|left, right| left.pty_id.cmp(&right.pty_id));
        result
    }

    pub fn remove_finished(&self, pty_id: &str) -> Result<()> {
        let session = self.session(pty_id)?;
        if session
            .child
            .lock()
            .expect("pty child lock poisoned")
            .try_wait()
            .map_err(pty_error)?
            .is_none()
        {
            return Err(ZaalisError::invalid("le PTY tourne encore"));
        }
        self.sessions
            .write()
            .expect("pty sessions lock poisoned")
            .remove(pty_id);
        Ok(())
    }

    fn session(&self, pty_id: &str) -> Result<Arc<PtySession>> {
        self.sessions
            .read()
            .expect("pty sessions lock poisoned")
            .get(pty_id)
            .cloned()
            .ok_or_else(|| ZaalisError::not_found(format!("PTY inconnu : {pty_id}")))
    }
}

fn copy_minimal_environment(builder: &mut CommandBuilder) {
    #[cfg(windows)]
    const ALLOWED: &[&str] = &["SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"];
    #[cfg(not(windows))]
    const ALLOWED: &[&str] = &["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    for name in ALLOWED {
        if let Some(value) = std::env::var_os(name) {
            builder.env(name, value);
        }
    }
}

#[cfg(windows)]
fn shell_builder() -> CommandBuilder {
    let mut builder = CommandBuilder::new("cmd.exe");
    builder.args(["/d", "/q"]);
    builder
}

#[cfg(not(windows))]
fn shell_builder() -> CommandBuilder {
    CommandBuilder::new("sh")
}

fn pty_error(error: impl std::fmt::Display) -> ZaalisError {
    ZaalisError::io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn pty_captures_output_and_can_be_resized() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = PtyRuntime::new(dir.path()).expect("runtime");
        let command = if cfg!(windows) {
            "echo ZAALIS_PTY_OK"
        } else {
            "printf ZAALIS_PTY_OK"
        };
        let started = runtime.start(Some(command), 24, 80).expect("start");
        let mut output = String::new();
        for _ in 0..100 {
            let poll = runtime.poll(&started.pty_id).expect("poll");
            output.push_str(&poll.output);
            if !poll.running {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(output.contains("ZAALIS_PTY_OK"), "captured: {output:?}");
        runtime.resize(&started.pty_id, 40, 120).expect("resize");
        let info = runtime.list();
        assert_eq!((info[0].rows, info[0].cols), (40, 120));
        runtime
            .remove_finished(&started.pty_id)
            .expect("remove finished");
    }

    #[test]
    fn interactive_pty_accepts_input_and_kill() {
        let dir = TempDir::new().expect("tempdir");
        let runtime = PtyRuntime::new(dir.path()).expect("runtime");
        let started = runtime.start(None, 24, 80).expect("start");
        let input = if cfg!(windows) {
            "echo ZAALIS_INPUT_OK\r\n"
        } else {
            "echo ZAALIS_INPUT_OK\n"
        };
        runtime.write(&started.pty_id, input).expect("write");
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(runtime
            .poll(&started.pty_id)
            .expect("poll")
            .output
            .contains("ZAALIS_INPUT_OK"));
        let stopped = runtime.kill(&started.pty_id).expect("kill");
        assert!(!stopped.running);
    }
}
