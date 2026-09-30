# zaalis labs IDE for Windows

Local IDE by zaalis labs, built on a shared Rust agent core, a local Node.js HTTP adapter, and a native Windows application powered by WebView2.

## Install the Windows application

Download and run:

[zaalis-setup.exe](https://github.com/zaalis/zaalis-labs-ide/raw/main/native/installer/zaalis-setup.exe)

The installer adds the application to Windows and creates launch shortcuts.

## Run the development server

Prerequisites: Node.js and Rust 1.90 or later.

```powershell
npm install
cargo build --manifest-path rust/Cargo.toml -p zaalis-agentd
npm start
```

Then open:

```text
http://localhost:3000
```

This mode opens the local web interface for development; it does not launch the native Windows desktop application.

## Command isolation on Windows

Commands run by agents use a reduced environment and process-tree cleanup. Set `ZAALIS_SANDBOX_MODE=strict` to require native filesystem and network isolation: startup fails when the required strict-isolation mechanism is unavailable.

On Windows, the application attempts to use AppContainer or Windows Sandbox. When neither mechanism is available, it retains standard Job Object containment and does not claim strict isolation.

## Opale (notes application)

Opale is a separate project: a standalone Markdown notes application (a vault is a folder of `.md` files linked with `[[…]]`). It does not live in this repository; by default its folder is `opale` on the Desktop.

The two are linked by default. When Opale is present on the PC and running, the agent can read, write and reorganise the open vault through Opale's local MCP endpoint, with nothing to configure. **Settings → MCP → Opale** shows the state, starts Opale, or switches the link off. The IDE side of the link is `opale-connector.js`.

## Personal MCP servers

**Settings → MCP → MCP personnels** connects your own MCP servers, with the two transports Claude Desktop and Codex use:

- **a local program (stdio)** — a command, its arguments and optional environment variables, started by the IDE (`npx …`, `uvx …`, or a full path);
- **a Streamable HTTP URL** — HTTPS, or plain HTTP on loopback, with an optional bearer token.

A Claude/Codex-style JSON file (`mcpServers`) can be imported, and **Tester la connexion** shows what a server answers before it is saved. Tokens and environment values are encrypted at rest and never sent back to the interface. The agent learns about each enabled server through a Skill generated from the server's own tool list; `allow` / `deny` restrict which tools it may call.

The **Blender MCP** preset runs Blender Lab's `blender-mcp` program, found on `PATH` or where Codex / Claude Desktop installed it. Blender's add-on listens on a raw TCP socket (port 9876), not on HTTP: the URL `http://127.0.0.1:9876/mcp` cannot work, and entries saved with it are converted to the preset automatically. If the program is missing: `pip install git+https://projects.blender.org/lab/blender_mcp.git`, then enable the MCP add-on in Blender.

The code is in `mcp-registry.js` (validation, both transports, presets), `rust-agent-bridge.js` (configuration handed to the Rust core) and `rust/crates/zaalis-extensions/src/mcp.rs` (the runtime client).

## Voice dictation

The microphone button records in the interface and the local server transcribes (`POST /api/stt`, `voice-stt.js`): with a stored OpenAI or Mistral key the recording is sent to that provider's transcription model; otherwise Windows' offline speech recognizer is used (lower accuracy, and the language must be installed in Windows). The same endpoint serves the integrated browser's voice search.

## Rebuild the Windows application

Prerequisites:

- Node.js
- Rust 1.90 or later
- Visual Studio with the **Desktop development with C++** workload
- Inno Setup 6

In PowerShell, run:

```powershell
npm run build:rust
cmd /c native\build_server.bat
cmd /c native\build_cli.bat
cmd /c native\build_shell.bat
cmd /c native\build_installer.bat
```

The generated installer is located at:

```text
native\installer\zaalis-setup.exe
```

## License and copyright

Copyright © 2026 Bryan Boquel / zaalis. All rights reserved.

zaalis Labs IDE is owned by Bryan Boquel / zaalis. Usage, modification, contribution, redistribution, commercial use, and branding rights are governed by the [LICENSE](LICENSE) and [NOTICE](NOTICE) files included in this repository.

Accessing, cloning, using, modifying, or contributing to this repository does not transfer any ownership rights.
