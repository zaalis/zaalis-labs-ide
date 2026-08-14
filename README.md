# zaalis labs IDE — Linux

Local IDE by zaalis labs with a shared Rust agent core, a thin local Node.js HTTP adapter, and a native Linux application powered by Electron.

This repository is the Linux edition. The Windows and macOS editions live in their own repositories and share the same server, interface and Rust core.

## Launch with the Debian installer

Download `zaalis-linux-x64.deb` from the [latest release](https://github.com/zaalis/zaalis-labs-ide/releases/latest) and install it:

```bash
sudo apt install ./zaalis-linux-x64.deb
```

The package installs the application under `/opt/zaalis-ide`, adds a desktop entry, and puts the `zaalis` CLI on the PATH. A portable `zaalis-linux-x64.tar.gz` archive is published alongside it for non-Debian distributions.

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

AI computer control uses `xdotool` for input, `gnome-screenshot` or ImageMagick's `import` for capture, and AT-SPI (`python3-pyatspi`) to read the accessible tree. The activity overlay — the same purple gradient border and control dock as the macOS and Windows editions — is a click-through GTK window drawn by `python3-gi`. The Debian package declares all of these as dependencies.

X11 is required for input injection: on a Wayland session, log in with "GNOME on Xorg" (or the Xorg session of your desktop) for computer control to work.

## Local models

Local GGUF models run through llama.cpp, downloaded on demand into `~/.local/share/zaalis/engine`. The engine variant is picked from the GPU found on the machine:

- **ROCm** on AMD, when the ROCm runtime (`/opt/rocm`) is actually installed
- **Vulkan** on NVIDIA, Intel and AMD without ROCm — this is the general-purpose GPU path
- **CPU** otherwise, and as an automatic fallback when a GPU build fails to start

llama.cpp publishes no CUDA build for Linux, so a `cuda` variant inherited from a Windows configuration is mapped to Vulkan. Ollama is also supported and is started automatically only when it was installed manually (a systemd-managed install is left to systemd).

## Command sandbox

Commands always run with a minimal environment and process-tree cleanup. Set
`ZAALIS_SANDBOX_MODE=strict` to require native filesystem and network isolation;
startup fails closed when the platform backend is unavailable. A workspace
release build places `zaalis-sandbox` beside the daemon, which uses Landlock
plus network seccomp on Linux.

## Rebuild the Linux application

Prerequisites: Node.js, Rust 1.90 or newer, `dpkg-deb`, and `tar`.

On Linux:

```bash
sh native/build_linux.sh
```

From Windows with WSL:

```bat
native\build_linux.bat
```

The generated packages can be found here:

```text
native/installer/zaalis-linux-x64.deb
native/installer/zaalis-linux-x64.tar.gz
```

## License and copyright

Copyright © 2026 Bryan Boquel / zaalis. All rights reserved.

zaalis Labs IDE is owned by Bryan Boquel / zaalis. Usage, modification, contribution, redistribution, commercial use, and branding rights are governed by the [LICENSE](LICENSE) file and the [NOTICE](NOTICE) file included in this repository.

No ownership rights are transferred by accessing, cloning, using, modifying, or contributing to this repository.
