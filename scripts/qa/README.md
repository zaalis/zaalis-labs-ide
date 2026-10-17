# Local visual validation

Run `node scripts/qa/parity-fixture.js`, then open the printed URL. The default
port is 3335; set `ZAALIS_QA_PORT` to choose another. The script refuses an
occupied port. `.tmp/parity-qa/info.json` contains the fixture account, temporary
project path, and provider `compat:custom` / model `qa-fixture`. Printed login
credentials belong only to this isolated local test account.

The real application server and Rust daemon run against a loopback SSE provider.
Account data and the project live in a temporary directory. Existing user data
and external APIs are not used.

Chat scenarios:

- An ordinary message streams reasoning, Markdown, a table and a code block.
- `QA_CLARIFY` calls `request_user_input` and waits for the user's selection.
- `QA_TOOLS` reads `fixture.js` through the real `read` tool.
- `QA_AGENTS` sends deliberately verbose progress, then launches a real native
  child named “Vérification du projet”. Check the 280-character preview, active
  and completed groups, expandable report, and persistence after reloading.
- `QA_DIFF` writes that file through the real `write` tool, using the chat's
  permissions. Supervised mode can require approval.
- `QA_SLOW` slows the response for cancellation and message queue checks.
- `QA_ERROR` returns an intentional provider error.

Stop with Ctrl+C or send `stop` on stdin. The temporary directory is removed;
server logs and QA connection information remain in `.tmp`. Regenerate
`info.json` by starting the fixture again before reusing its URL.

The corresponding automated check is
`node --test test/conversation-runtime.test.js`. It creates its own accounts,
ports and temporary directories, and checks runtime session continuity, forked
history, knowledge recall, clarification, tools, and manual/scheduled tasks.
