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
            return Self {
                platform: "windows".into(),
                process_tree: true,
                pty_process_tree: false,
                minimal_environment: true,
                filesystem_isolation: false,
                network_isolation: false,
                kernel_policy: Some(if backends.is_empty() {
                    format!("job_object; strict unavailable: {details}")
                } else {
                    format!(
                        "job_object; strict available: {}",
                        backends
                            .iter()
                            .map(|backend| backend.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }),
                strict_available: !backends.is_empty(),
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
}
