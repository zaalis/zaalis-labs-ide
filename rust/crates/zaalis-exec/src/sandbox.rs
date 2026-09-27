//! Explicit sandbox capability reporting.
//!
//! Process-tree containment is always applied by `ExecRuntime`. Strong
//! filesystem/kernel confinement is deliberately fail-closed until the native
//! backend for the current OS is available and tested.

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::process::{Command, Stdio};
use zaalis_core::{Result, ZaalisError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxLevel {
    ProcessTree,
    Strict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCapabilities {
    pub platform: String,
    pub process_tree: bool,
    pub pty_process_tree: bool,
    pub minimal_environment: bool,
    pub filesystem_isolation: bool,
    pub network_isolation: bool,
    pub kernel_policy: Option<String>,
    pub strict_available: bool,
}

/// Paths a sandboxed command must be able to read.
///
/// A confined build still has to reach its compiler, its runtime and its
/// package caches. These are granted read-only, so the toolchain works while
/// the sandbox keeps the only writable place the workspace itself.
#[cfg(windows)]
pub(crate) fn read_only_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    let mut push = |value: Option<std::ffi::OsString>| {
        if let Some(value) = value {
            let path = std::path::PathBuf::from(value);
            if path.is_dir() && !roots.contains(&path) {
                roots.push(path);
            }
        }
    };
    for variable in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        push(std::env::var_os(variable));
    }
    // Per-user toolchains: rustup, cargo, npm, pnpm, pip and friends all live
    // under the profile rather than under Program Files.
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let profile = std::path::PathBuf::from(profile);
        for relative in [".cargo", ".rustup", ".nvm", ".pyenv", ".dotnet", ".gradle", ".m2"] {
            push(Some(profile.join(relative).into_os_string()));
        }
    }
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        push(std::env::var_os(variable));
    }
    roots
}

impl SandboxCapabilities {
    pub fn detect() -> Self {
        #[cfg(windows)]
        {
            let probe = sandboxrs_windows::Sandbox::probe();
            let backends = probe
                .entries
                .iter()
                .filter(|entry| entry.usable)
                .map(|entry| entry.backend)
                .collect::<Vec<_>>();
            let details = probe
                .entries
                .iter()
                .map(|entry| format!("{}={}", entry.backend.as_str(), entry.detail))
                .collect::<Vec<_>>()
                .join("; ");
            let strict_available = !backends.is_empty();
            // Report what the selected backend actually enforces rather than a
            // blanket `false`. An AppContainer has no network capability unless
            // one is granted, so it isolates the network as well as the
            // filesystem; the Windows Sandbox API confines the filesystem. Both
            // are worth saying out loud — a capability reported as absent is a
            // capability nobody will rely on.
            let appcontainer = backends.contains(&sandboxrs_windows::BackendKind::AppContainer);
            return Self {
                platform: "windows".into(),
                process_tree: true,
                pty_process_tree: false,
                minimal_environment: true,
                filesystem_isolation: strict_available,
                network_isolation: appcontainer,
                kernel_policy: Some(if strict_available {
                    format!(
                        "job_object; strict available: {}",
                        backends
                            .iter()
                            .map(|backend| backend.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                } else {
                    format!("job_object; strict unavailable: {details}")
                }),
                strict_available,
            };
        }
        #[cfg(target_os = "linux")]
        return unix_capabilities("linux", "process_group; landlock+seccomp");
        #[cfg(target_os = "macos")]
        return unix_capabilities("macos", "process_group; seatbelt");
        #[allow(unreachable_code)]
        Self {
            platform: std::env::consts::OS.into(),
            process_tree: true,
            pty_process_tree: false,
            minimal_environment: true,
            filesystem_isolation: false,
            network_isolation: false,
            kernel_policy: None,
            strict_available: false,
        }
    }
}

#[cfg(unix)]
pub(crate) fn sandbox_helper() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("ZAALIS_SANDBOX_HELPER") {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let mut candidates = vec![directory.join("zaalis-sandbox")];
    if let Some(parent) = directory.parent() {
        candidates.push(parent.join("zaalis-sandbox"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(unix)]
fn unix_capabilities(platform: &str, policy: &str) -> SandboxCapabilities {
    let probe = sandbox_helper().as_ref().and_then(|path| {
        Command::new(path)
            .arg("--probe")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
    });
    let available = probe.is_some_and(|status| status.success());
    SandboxCapabilities {
        platform: platform.into(),
        process_tree: true,
        pty_process_tree: false,
        minimal_environment: true,
        filesystem_isolation: available,
        network_isolation: available,
        kernel_policy: Some(if available {
            policy.into()
        } else {
            format!("process_group; strict unavailable ({policy})")
        }),
        strict_available: available,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPolicy {
    pub required: SandboxLevel,
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        Self {
            required: SandboxLevel::ProcessTree,
        }
    }
}

impl SandboxPolicy {
    pub fn validate(&self) -> Result<SandboxCapabilities> {
        let capabilities = SandboxCapabilities::detect();
        if self.required == SandboxLevel::Strict && !capabilities.strict_available {
            return Err(ZaalisError::denied(format!(
                "sandbox strict indisponible sur {} : confinement filesystem/reseau non actif",
                capabilities.platform
            )));
        }
        Ok(capabilities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_is_explicit_and_strict_fails_closed() {
        let baseline = SandboxPolicy::default().validate().expect("baseline");
        assert!(baseline.process_tree);
        assert!(baseline.minimal_environment);
        let strict = SandboxPolicy {
            required: SandboxLevel::Strict,
        };
        if !baseline.strict_available {
            assert!(strict.validate().is_err());
        }
    }

    #[test]
    fn reported_isolation_never_exceeds_what_a_backend_provides() {
        // The invariant that makes this report trustworthy: claiming isolation
        // that is not there is worse than claiming none, because the modes
        // above it are chosen on the strength of this answer.
        let capabilities = SandboxCapabilities::detect();
        if !capabilities.strict_available {
            assert!(!capabilities.filesystem_isolation);
            assert!(!capabilities.network_isolation);
        }
        // Whatever the outcome, the reason is always stated.
        assert!(capabilities.kernel_policy.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn the_toolchain_is_readable_from_inside_a_strict_sandbox() {
        // Without these, a confined `cargo build` cannot reach its own
        // toolchain and strict mode fails on its first command.
        let roots = read_only_roots();
        assert!(!roots.is_empty());
        let system_root =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"));
        assert!(roots.contains(&system_root), "{roots:?}");
    }
}
