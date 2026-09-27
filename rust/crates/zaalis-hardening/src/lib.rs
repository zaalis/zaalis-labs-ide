//! Process hardening applied once, at daemon startup.
//!
//! The daemon holds every provider key the user configured, in plain text, in
//! its own address space — it has to, in order to sign requests. That makes the
//! process itself the last copy of the vault, and two ordinary operating-system
//! conveniences will happily hand that copy to someone else:
//!
//! * **Crash dumps.** A dump written by Windows Error Reporting or a Unix core
//!   file is a full memory image. It lands in a world-readable directory, it is
//!   uploaded by crash reporters, and it contains every key verbatim.
//! * **Debuggers and code injection.** Any process running as the same user can
//!   attach a debugger and read the keys out, or inject a DLL that does it from
//!   the inside. Neither needs elevation.
//!
//! Each step is best-effort and reported: a policy an older OS refuses must not
//! stop the daemon from starting, but it must not silently pass for applied
//! either, because "hardened" is a claim someone will rely on.

use serde::{Deserialize, Serialize};

/// What hardening actually took effect on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardeningReport {
    pub platform: String,
    /// Measures confirmed active.
    pub applied: Vec<String>,
    /// Measures the OS refused, with the reason, so `doctor` can show it.
    pub skipped: Vec<String>,
}

impl HardeningReport {
    fn new() -> Self {
        Self {
            platform: std::env::consts::OS.to_owned(),
            applied: Vec::new(),
            skipped: Vec::new(),
        }
    }

    fn record(&mut self, measure: &str, outcome: Result<(), String>) {
        match outcome {
            Ok(()) => self.applied.push(measure.to_owned()),
            Err(reason) => self.skipped.push(format!("{measure} : {reason}")),
        }
    }

    /// Whether the memory-disclosure measures are all in place.
    pub fn is_fully_hardened(&self) -> bool {
        self.skipped.is_empty()
    }
}

/// Harden the current process. Safe to call more than once.
pub fn harden_current_process() -> HardeningReport {
    let mut report = HardeningReport::new();
    platform::apply(&mut report);
    report
}

#[cfg(windows)]
mod platform {
    // Every call here is a Win32 API that takes a pointer and a length. There
    // is no safe wrapper for process mitigation policies, and adding a crate
    // that provides one would be a larger trusted surface than the twenty
    // lines it would replace. Each block below documents the contract it
    // upholds.
    #![allow(unsafe_code)]

    use super::HardeningReport;
    use std::ffi::c_void;
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
    };
    use windows_sys::Win32::System::ErrorReporting::{
        WerSetFlags, WER_FAULT_REPORTING_DISABLE_SNAPSHOT_CRASH, WER_FAULT_REPORTING_FLAG_NOHEAP,
        WER_FAULT_REPORTING_NO_UI,
    };
    use windows_sys::Win32::System::Threading::{
        SetProcessMitigationPolicy, ProcessExtensionPointDisablePolicy, ProcessImageLoadPolicy,
        PROCESS_MITIGATION_POLICY,
    };

    /// `PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY.DisableExtensionPoints`
    const DISABLE_EXTENSION_POINTS: u32 = 0x0000_0001;
    /// `PROCESS_MITIGATION_IMAGE_LOAD_POLICY.NoRemoteImages`
    const NO_REMOTE_IMAGES: u32 = 0x0000_0001;
    /// `…​.NoLowMandatoryLabelImages`
    const NO_LOW_LABEL_IMAGES: u32 = 0x0000_0002;
    /// `…​.PreferSystem32Images`
    const PREFER_SYSTEM32_IMAGES: u32 = 0x0000_0004;

    pub(super) fn apply(report: &mut HardeningReport) {
        report.record("pas de boîte de dialogue ni de dump système", no_crash_dialog());
        report.record("rapport d'erreur Windows sans vidage mémoire", no_wer_dump());
        report.record(
            "points d'extension désactivés (injection de DLL héritée)",
            set_policy(
                ProcessExtensionPointDisablePolicy,
                DISABLE_EXTENSION_POINTS,
            ),
        );
        report.record(
            "chargement d'images restreint (distantes, bas niveau)",
            set_policy(
                ProcessImageLoadPolicy,
                NO_REMOTE_IMAGES | NO_LOW_LABEL_IMAGES | PREFER_SYSTEM32_IMAGES,
            ),
        );
    }

    /// Suppress the crash dialog and the hard-error popups.
    ///
    /// `SetErrorMode` has no failure mode: it returns the previous mask.
    fn no_crash_dialog() -> Result<(), String> {
        // SAFETY: `SetErrorMode` takes a bit mask by value, touches no memory
        // the caller owns and cannot fail.
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
        Ok(())
    }

    /// Keep the heap out of anything Windows Error Reporting collects.
    ///
    /// The keys live on the heap, so `NOHEAP` is what turns a crash report from
    /// a full copy of the vault into a stack trace. `DISABLE_SNAPSHOT_CRASH`
    /// closes the other door: a crash snapshot is a whole second memory image,
    /// taken before the report is even written.
    fn no_wer_dump() -> Result<(), String> {
        // SAFETY: `WerSetFlags` takes a flag value by value and returns an
        // HRESULT; no pointers are involved.
        let result = unsafe {
            WerSetFlags(
                WER_FAULT_REPORTING_FLAG_NOHEAP
                    | WER_FAULT_REPORTING_NO_UI
                    | WER_FAULT_REPORTING_DISABLE_SNAPSHOT_CRASH,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("WerSetFlags a renvoyé 0x{result:08x}"))
        }
    }

    /// Apply one mitigation policy expressed as a flags word.
    ///
    /// Every `PROCESS_MITIGATION_*_POLICY` struct in the Win32 headers is a
    /// union over a single `DWORD Flags`, so passing the word directly is the
    /// same four bytes the struct would have carried — and it keeps this code
    /// independent of how a binding crate chooses to model the bitfields.
    fn set_policy(policy: PROCESS_MITIGATION_POLICY, flags: u32) -> Result<(), String> {
        let value = flags;
        // SAFETY: the buffer is a live `u32` and the length passed is exactly
        // its size, which is the contract `SetProcessMitigationPolicy`
        // documents for every policy whose payload is a flags word. The call
        // borrows the buffer only for its duration.
        let ok = unsafe {
            SetProcessMitigationPolicy(
                policy,
                std::ptr::addr_of!(value) as *const c_void,
                std::mem::size_of::<u32>(),
            )
        };
        if ok != 0 {
            Ok(())
        } else {
            Err(format!(
                "refusé par le système (erreur {})",
                std::io::Error::last_os_error()
            ))
        }
    }
}

#[cfg(unix)]
mod platform {
    // Same reasoning as the Windows module: `setrlimit` and `prctl` have no
    // safe wrapper in `libc`, and both calls are a handful of lines.
    #![allow(unsafe_code)]

    use super::HardeningReport;

    pub(super) fn apply(report: &mut HardeningReport) {
        report.record("aucun fichier core", no_core_dumps());
        #[cfg(target_os = "linux")]
        report.record("processus non traçable (ptrace refusé)", not_dumpable());
    }

    /// Set the core-file size limit to zero.
    fn no_core_dumps() -> Result<(), String> {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: `limit` is a fully initialised `rlimit` living on this
        // stack frame; `setrlimit` reads it and does not retain the pointer.
        let code = unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) };
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    /// Clear the dumpable flag.
    ///
    /// This is the measure that matters most on Linux: it stops core dumps and,
    /// with the default Yama policy, also stops a same-user process from
    /// attaching `ptrace` and reading the keys straight out of memory.
    #[cfg(target_os = "linux")]
    fn not_dumpable() -> Result<(), String> {
        // SAFETY: `PR_SET_DUMPABLE` takes an integer argument by value; the
        // remaining varargs are ignored for this option.
        let code = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    use super::HardeningReport;

    pub(super) fn apply(report: &mut HardeningReport) {
        report
            .skipped
            .push("durcissement non implémenté sur cette plateforme".to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardening_reports_what_it_did_and_stays_idempotent() {
        let first = harden_current_process();
        assert_eq!(first.platform, std::env::consts::OS);
        assert!(
            !first.applied.is_empty() || !first.skipped.is_empty(),
            "le durcissement doit rendre compte de quelque chose"
        );

        // Called twice on purpose: startup paths get re-entered (a daemon
        // restarted in-process, a test harness), and a second call must not
        // start failing.
        let second = harden_current_process();
        assert_eq!(first.applied, second.applied);
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn the_memory_disclosure_measures_are_active_on_a_supported_platform() {
        let report = harden_current_process();
        assert!(
            report
                .applied
                .iter()
                .any(|measure| measure.contains("dump") || measure.contains("core")),
            "le blocage des vidages mémoire doit s'appliquer : {report:?}"
        );
    }
}
