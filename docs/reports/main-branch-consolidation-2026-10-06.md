# Branch consolidation on main — October 6, 2026

Historical record: `zaalis/zaalis-labs-ide` adopted a shared source base for Windows, Linux, and macOS. The Windows shell and GitHub, welcome, token profile, correction memory, laboratory, artifact, subscription, and terminal features were retained.

| Audited branch | Audited revision | Integration |
| --- | --- | --- |
| Original main | `0b4d469` | Windows base |
| `codex/github-welcome-token-profile` | `0b4d469` plus local work | Recent features committed on main |
| `origin/macos` | `1dd9b01` | Merge `52d5a4a` |
| `origin/linux` | `baa0f5f` | Merge `0a67222` |
| `sync-macos` | `23129dc` | Merge `9bf6371` |

Older local Linux and macOS commits remained in history. Platform-specific removal of the Windows shell or VMs was not adopted. The Rust agent replaced older JavaScript engines. Platform adaptations were grouped into the platform runtime, native bridges, and dedicated build scripts. The Linux bundle included the Rust daemon and PTY terminal.

At the time, Node tests reported 116 passed, 1 skipped, and 0 failed; Rust reported 469 passed and 8 skipped. JavaScript syntax, source encoding, whitespace, POSIX script syntax, packaged Windows server flows, a real agent read-only guard scenario, and five Edge viewport sizes were checked. Windows server, Rust/CLI, terminal client, shell, and installer were rebuilt. Linux and macOS native runtime behavior was outside those Windows checks.

A Git bundle of the pre-consolidation state was saved at `.tmp/main-consolidation-20261006-163541/branches.bundle`. Secondary branches were to be removed only after ancestry verification. The original report said `video-pub/` was retained at that time; it does not describe the current tree.
