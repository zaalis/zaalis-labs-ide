# macOS parity validation — 2026-10-17

Integrated all changes from `main` at `79d8ef242534c5e7eb173e14dc09344e98e04e04` into the macOS history. Runtime/build sources are recorded by merge commit `ad419c1bb2667150319d975ecd2a5e2864ad99a0`; subsequent changes only improve validation scripts, test startup deadlines and this report.

## Included behavior

- Canonical conversations: shared IDE/CLI history, continuation, fork, rename, archive, search, deletion and ordered event replay.
- Structured clarifications, pending message queue, Markdown tables, startup screen, task center, knowledge recall and agent activity/progress.
- Native background child-agent status, wait and cancellation; tool discovery and invocation retain the shared permission guards.
- Existing assistant tools, model policies, integrations and deferred/dynamic MCP discovery remain available. CLI routing now reaches the canonical conversation/task services rather than being shadowed by older commands; `zaalis tasks` without arguments lists tasks.
- macOS paths, zsh and POSIX shells, native browser/desktop/voice helpers, automatic updater, permissions, connectors and VM support are preserved. The desktop bridge compiles with this Mac's macOS 13 SDK.
- Both packages ship the shared HTTP terminal client as `bundle/bin/zaalis` and the direct Rust diagnostic client as `bundle/bin/zaalis-cli`.

## Verification

Before release compilation: 227 Node tests passed, 6 platform-dependent tests skipped; 503 Rust tests passed. End-to-end provider fixtures ran entirely on loopback with disposable accounts and projects.

`npm run build:macos` exited successfully and produced both DMGs. Each was independently verified with `hdiutil verify`, mounted read-only, and checked with `codesign --verify --deep --strict`. The application, Electron framework, server, daemon, sandbox, both CLI clients, Swift helpers, connectors and PTY binaries match their target architectures. Whisper is universal. All 151 interface files in each mounted package match the current sources; the Applications shortcut and Blender payload are present.

The actual packaged Intel server passed `test/package-smoke.js`: canonical conversations, knowledge, tasks, real PTY, static UI, reasoning capabilities, GGUF, preferences, ChatGPT sign-in routes, MCP stdio, Blender and silent dictation. The packaged CLI and daemon passed all 7 CLI/conversation-runtime tests, including streaming, shared runtime continuation, clarification, manual tasks and scheduled tasks. The test harness allows longer startup deadlines for cold packaged macOS launches.

Bundled Intel GitHub CLI, cloudflared, Node runtime and Rust CLI execute successfully. After cross-compilation, the local Node PTY was restored and its 5 applicable tests passed (1 Windows-only test skipped).

## Original artifacts and limits

The installation presentation and DMGs below were subsequently replaced by the [custom native macOS installer](macos-custom-installer-2026-10-17.md). The IDE application payload is unchanged.

Version: `1.0.16`. Artifacts remain in `native/installer/`; they are ignored build output, not Git source files.

- `zaalis-macos-arm64.dmg`: 328482816 bytes; SHA-256 `01a15df27370d217820f8c850d746a4d01baae546d08f7b810a0fe59087753ab`.
- `zaalis-macos-x64.dmg`: 345545565 bytes; SHA-256 `075d80204222d326bb334c3cb6f9236d658a786f3d9cb5e85376c841d752deee`.

Signatures are local ad-hoc signatures; the packages are not notarized. Apple Silicon execution was not tested on this Intel host; its image, signatures, payload architectures and assets were verified statically.

Machine-readable evidence: [macos-validation-2026-10-17.json](macos-validation-2026-10-17.json). Repeat package inspection with `python3 scripts/release/verify-macos.py`. Packaged smoke checks accept `ZAALIS_TEST_SERVER_EXE`; runtime tests also accept `ZAALIS_AGENTD_PATH` and `ZAALIS_TEST_CLI_EXE`.
