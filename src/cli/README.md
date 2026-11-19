# Terminal clients

`node src/app/cli.js` (`zaalis-terminal.exe` when packaged) connects to the same
authenticated HTTP server as the IDE. `/api/conversations` owns conversation
history and the Rust `sessionId`. Files in `~/.zaalis/sessions` keep the last
conversation pointer for each directory and support old local snapshots.

- `stream-state.js` assembles lead text and reasoning while excluding child
  agent responses and preserving segment boundaries around tool calls.
- `conversations.js` defines HTTP calls and transcript conversion.
- `conversation-commands.js` handles selection, resume, fork and metadata.
- `workspace-commands.js` maps tools, tasks and general knowledge to shared
  services. A task created without a schedule stays disabled until explicitly
  run with `/tasks run <id>`. `--every <minutes>` or `--at <ISO date>` explicitly
  enables scheduling. Scheduled jobs use supervised permissions by default.

Examples: `zaalis sessions proxy`, `zaalis resume <id>`,
`zaalis -c -p "Continue"`, `/fork Experiment`, `/tools describe read`,
`/tasks create --every 30 Check errors`, `/knowledge add Project decision`.
`/delete <id>` requires the exact active conversation ID.

`memory` retains the historical correction memory (`/api/memory`). `knowledge`
manages general facts and decisions (`/api/knowledge`), recalled by relevance
within the same account and project.

The Rust `zaalis-cli.exe` remains a direct JSON-RPC diagnostic client for
inspecting the daemon and agent tree. It does not use the authenticated HTTP
conversation catalogue. Use `zaalis-terminal.exe` for the IDE's shared session
workflow.

Focused checks: `node --test test/cli-parity.test.js`.
