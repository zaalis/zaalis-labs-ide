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
