# zaalis IDE native Windows application (C++ and WebView2)

The C++ shell starts the bundled Node HTTP adapter in the background, displays the interface in a WebView2 window, and stops the server when the window closes. Chat, Agents, and the CLI share the Rust core through `zaalis-agentd`.

```text
zaalis.exe -> zaalis-server.exe (port 3000) -> zaalis-agentd.exe -> Rust providers and tools
                                      \-> WebView2 interface
```

## Run the native application

Double-click `native\dist\zaalis.exe`. Build scripts generate `native\dist\`, which contains `zaalis.exe`, `zaalis-server.exe`, `zaalis-agentd.exe`, `zaalis-cli.exe` (installed as `bin\zaalis.exe`), `pickfolder.exe`, and `interface\`. The application creates `server-data\` on first launch for local accounts, sessions, and history.

## Rebuild

Prerequisites: Node.js, Rust 1.90 or newer, Visual Studio with the Desktop C++ workload, and Inno Setup 6 for the installer.

```bat
native\build_server.bat
native\build_cli.bat
native\build_shell.bat
native\build_installer.bat
```

The installer is generated at `native\installer\zaalis-setup.exe`.

## Implementation

- `src/app/server.js` serves the files in `interface\`.
- `native\main.cpp` launches `zaalis-server.exe` and opens `http://localhost:3000`.
- `native\installer.iss` packages the GUI, server adapter, `zaalis-agentd.exe`, Rust CLI, `pickfolder.exe`, and `interface\`.
