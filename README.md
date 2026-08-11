# zaalis labs IDE

Local IDE by zaalis labs with a shared Rust agent core, a thin local Node.js HTTP adapter, and a native Windows application powered by WebView2.

## Launch with the Windows installer

Download and run:

[zaalis-setup.exe](https://github.com/zaalis/zaalis-labs-ide/raw/main/native/installer/zaalis-setup.exe)

The installer adds the application to Windows and creates launch shortcuts.

## Launch manually

Prerequisites: Node.js and Rust 1.90 or newer.

```bash
npm install
cargo build --manifest-path rust/Cargo.toml -p zaalis-agentd
npm start
```

Then open:

```text
http://localhost:3000
```

## Command sandbox

Commands always run with a minimal environment and process-tree cleanup. Set
`ZAALIS_SANDBOX_MODE=strict` to require native filesystem and network isolation;
startup fails closed when the platform backend is unavailable. A workspace
release build places `zaalis-sandbox` beside the daemon on Linux/macOS. The
strict Unix helper uses Landlock plus network seccomp on Linux and Seatbelt on
macOS. Windows probes the available AppContainer/Windows Sandbox backend and
otherwise keeps the default Job Object containment without claiming strict
isolation.

## Rebuild the Windows application

Prerequisites:

- Node.js
- Rust 1.90 or newer
- Visual Studio with the Desktop C++ workload
- Inno Setup 6

```bat
native\build_server.bat
native\build_cli.bat
native\build_shell.bat
native\build_installer.bat
```

The generated installer can be found here:

```text
native\installer\zaalis-setup.exe
```

## License and copyright

Copyright © 2026 Bryan Boquel / zaalis. All rights reserved.

zaalis Labs IDE is owned by Bryan Boquel / zaalis. Usage, modification, contribution, redistribution, commercial use, and branding rights are governed by the [LICENSE](LICENSE) file and the [NOTICE](NOTICE) file included in this repository.

No ownership rights are transferred by accessing, cloning, using, modifying, or contributing to this repository.
