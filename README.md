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

The code is in `mcp-registry.js` (validation, both transports), `rust-agent-bridge.js` (configuration handed to the Rust core) and `rust/crates/zaalis-extensions/src/mcp.rs` (the runtime client).

## Blender

**Settings → MCP → Blender** links the agent to Blender, with nothing to install outside the IDE:

- the IDE detects Blender (5.1 or newer) and the state of Blender Lab's official **MCP** add-on;
- **Installer** opens a window that checks the version, asks for Blender to be closed, lists what will change in Blender (the add-on shipped in `native/blender`, its automatic start, and Blender's "Allow Online Access" setting, which the add-on requires) and asks for consent. Nothing is changed in Blender without it;
- the MCP server is the IDE itself (`blender-connector.js`, tools in `blender-tools.js`): the agent's `mcp` calls to server `blender` are turned into the add-on's socket protocol (port 9876).

The 18 tools:

| Area | Tools |
| --- | --- |
| Scene | `scene_summary`, `list_objects`, `object_details`, `node_tree` |
| Seeing | `screenshot` (3D viewport or the whole Blender window), `render` (viewport, optionally from the scene camera, or the scene's render engine) — returned as images the model looks at |
| File | `file_info`, `missing_files`, `linked_libraries`, `datablocks`, `inspect_blend_file` (another `.blend`, read by a windowless Blender without opening it) |
| Python API | `api_search`, `api_docs` (from Blender's own introspection, so always matching the installed version) |
| Interface | `focus_object`, `switch_workspace`, `show_properties` |
| Acting | `execute_python`, `undo` — each `execute_python` call is one step of Blender's undo history |

Once linked, the agent can run Python in Blender without a confirmation prompt, like any MCP call. The add-on itself is GPL-3.0-or-later and redistributed unmodified (see `native/blender/README.md`).

## Images for the model

Tool results can carry pictures, which the Rust core sends to the model as images (never as text): desktop captures, Blender screenshots and renders, any MCP server's `image` content, image files read with `read` (PNG, JPEG, GIF, WebP) and the integrated browser's `screenshot`. Up to 4 images per call and 8 per round reach the model, in one message labelled with the tools they come from. A model without vision is told the image was not sent and works from the text of the result.

## Desktop control

With desktop control enabled, the agent drives Windows through the `computer` tool (`windows-computer.js` for the Windows side, `automation-manager.js` for sessions and safety):

- **inspect** returns a capture, the active window's controls from UI Automation (role, label, value, frame and center) and the text read by Windows' own OCR, all in the pixels of the image the model receives; after an action it says whether the screen actually changed (visual signature plus text and controls);
- gestures: click (left, right, middle, with modifiers), double click, drag, scroll at a point (both directions), Unicode typing that leaves the clipboard alone, key chords with repeat, wait;
- `activate_app` takes a full `.exe` path or the name shown in the Start menu, and brings an already open window to the front instead of starting a second copy; `display_index` picks a screen;
- the agent never types into a password field (UI Automation and the Win32 `ES_PASSWORD` style), and a click or Enter on a button whose label means deleting, sending or paying is refused;
- MCP servers and Skills stay available in this mode, so Blender is driven through its MCP server rather than with the mouse.

## Voice dictation

The microphone button records in the interface and the local server transcribes (`POST /api/stt`, `voice-stt.js`). Everything stays on the PC:

- **whisper.cpp** is the engine. Its Windows binaries are in `native/whisper` (see the README there for their origin and checksums) and are installed to `{app}\whisper`. The model, `ggml-small-q5_1.bin` (181 MB), is downloaded once into `%LOCALAPPDATA%\zaalis\server-data\voice` from the official `ggerganov/whisper.cpp` repository and checked against its sha256.
- **Windows' own recognizer** stands in while the model is downloading, or if the engine cannot run. It is far less accurate and needs the language installed in Windows.

The same endpoint serves the integrated browser's voice search.

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

## Une branche commune pour les trois plateformes

Les sources communes et les adaptateurs Windows, Linux et macOS sont réunis sur `main`.

- Windows : chaîne native C++/WebView2 décrite dans `native/README.md`.
- Linux : `npm run build:linux` sur Linux ; voir `README_LINUX.md`.
- macOS : `npm run build:macos` sur un Mac ; voir `README_MACOS.md`. Le workflow macOS utilise `main`.

Les installateurs sont des sorties locales ignorées par Git et des artefacts de distribution ; ils ne sont pas suivis dans les sources. Les builds natifs nécessitent le système hôte et les outils correspondants.
