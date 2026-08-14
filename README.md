# zaalis labs IDE — macOS

Local IDE by zaalis labs with a shared Rust agent core, a thin local Node.js HTTP adapter, and a native macOS application powered by Electron.

This repository is the macOS edition. The Windows and Linux editions live in their own repositories and share the same server, interface and Rust core.

## Launch with the macOS installer

Download the `.dmg` matching your Mac from the [latest release](https://github.com/zaalis/zaalis-labs-ide/releases/latest):

- `zaalis-macos-arm64.dmg` — Apple Silicon (M1, M2, M3, M4…)
- `zaalis-macos-x64.dmg` — Intel

Open the image and drag **zaalis IDE** into your Applications folder.

## Launch manually

Prerequisites: Node.js 22 or newer and Rust 1.90 or newer.

```bash
npm install
cargo build --manifest-path rust/Cargo.toml -p zaalis-agentd
npm start
```

Then open:

```text
http://localhost:3000
```

## Desktop control

AI computer control runs through `macos-computer-bridge`, a Swift helper built and signed with the application, driven by the Electron shell. The shell owns the two system permissions the feature needs — **Accessibility** and **Screen Recording** — which macOS grants to the signed bundle in System Settings › Privacy & Security. The activity overlay, the same purple gradient border and control dock as the Linux and Windows editions, is drawn by the shell as click-through windows on every display.

`ZAALIS_CODESIGN_ID` should name a persistent signing identity. Ad-hoc signing produces a new code hash at every build, which silently revokes those two approvals after each update.

## Local models

Local GGUF models run through llama.cpp, downloaded on demand into `~/Library/Application Support/zaalis/engine`. macOS publishes a single binary per architecture and it already embeds **Metal**, so there is no GPU variant to download as on Windows or Linux:

- **Metal** is the default and uses the GPU through the unified memory
- **CPU** forces computation on the processor (`-ngl 0`), useful when the unified memory is already saturated, and is the automatic fallback when a model is too large to start on the GPU

The binary matches the architecture of the packaged server, so an Apple Silicon build uses the arm64 engine and an Intel build the x64 one. Ollama is also supported and is started automatically when installed (Ollama.app or Homebrew).

## Command sandbox

Commands always run with a minimal environment and process-tree cleanup. Set
`ZAALIS_SANDBOX_MODE=strict` to require native filesystem and network isolation;
startup fails closed when the platform backend is unavailable. A workspace
release build places `zaalis-sandbox` beside the daemon, which uses Seatbelt on
macOS.

## Rebuild the macOS application

Prerequisites: Node.js, Rust 1.90 or newer (with both Apple targets), Xcode command line tools (`swiftc`, `codesign`, `hdiutil`).

```bash
sh native/build_macos_dmg.sh
```

The generated installers can be found here:

```text
native/installer/zaalis-macos-arm64.dmg
native/installer/zaalis-macos-x64.dmg
```

## License and copyright

Copyright © 2026 Bryan Boquel / zaalis. All rights reserved.

zaalis Labs IDE is owned by Bryan Boquel / zaalis. Usage, modification, contribution, redistribution, commercial use, and branding rights are governed by the [LICENSE](LICENSE) file and the [NOTICE](NOTICE) file included in this repository.

No ownership rights are transferred by accessing, cloning, using, modifying, or contributing to this repository.
