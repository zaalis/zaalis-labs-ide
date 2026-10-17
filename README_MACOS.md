# zaalis IDE for macOS

The Electron application is built for Intel x64 and Apple Silicon arm64 and bundles the shared Rust agent (`zaalis-agentd`). It offers the same features as the Windows IDE: chat, agents and assistant tools, the terminal client, plugins and MCP servers, messengers, GitHub, the laboratory and virtual machines.

Build on a Mac with `sh native/build_macos_dmg.sh`. Prerequisites: Node.js 22+, Rust 1.90+ with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets, Xcode command-line tools (`swiftc`, `codesign`, `hdiutil`), CMake, a C/C++ compiler for whisper.cpp, and network access (the build downloads the Node runtime, the GitHub client and `cloudflared` for each architecture).

The build produces `native/installer/zaalis-macos-arm64.dmg` and `native/installer/zaalis-macos-x64.dmg`. Open the image for your Mac, double-click `Installer zaalis IDE`, then follow Continue → Install → Finish. The native assistant uses the same dark/violet design as the Windows installer, offers system or personal Applications, verifies the copied application before replacing an existing installation, and can optionally install the Terminal command. The terminal client is `zaalis IDE.app/Contents/Resources/app/bundle/bin/zaalis` (the packaged `src/app/cli.js`, as `bin\zaalis.exe` on Windows); pass a prompt as an argument for a noninteractive request.

The shared conversation history supports resume, fork, rename, archive, search and ordered event replay from the IDE and terminal. Clarification forms, queued messages, agent activity, the task center and general knowledge use the same services as `main`. The direct Rust diagnostic client is also included as `bundle/bin/zaalis-cli`.

Like the Windows installer, each package ships the WhatsApp bridge (with a Node runtime of the same architecture), the official GitHub client `gh` for browser sign-in, and `cloudflared` for remote access. Set `ZAALIS_CODESIGN_ID` (or `MACOS_CODESIGN_IDENTITY` in CI) to a persistent signing identity: an ad-hoc signature changes on every build and silently revokes the macOS permissions below.

Desktop control relies on macOS Screen Recording and Accessibility permissions. Grant both permissions to the application before using capture or input automation. `activate_app` accepts an `.app` path or the name shown in Applications or Launchpad (for example `Blender`), as Windows accepts a Start menu name. Voice dictation asks for the Microphone permission.

The agent's local `text_to_speech` uses the system voices through `say`. Video analysis uses `ffmpeg` when it is installed (`brew install ffmpeg`).

Debian VMs use QEMU with Hypervisor.framework (HVF). **Enable Linux components** in the Virtual machines settings installs QEMU with Homebrew (`brew install qemu`, no administrator prompt) and downloads the official Debian 12 image, verified by SHA-512, to `~/Library/Application Support/zaalis/server-data/virtual-machines/images`. Apple Silicon runs the arm64 image natively; Intel Macs run the amd64 image. OpenSSH is part of macOS. Windows Sandbox remains Windows-only.

GGUF models use llama.cpp, downloaded on demand to `~/Library/Application Support/zaalis/engine`. The Metal variant uses the GPU. The CPU variant sets `-ngl 0` and is the fallback if a model cannot fit in unified memory.

To rebuild only the custom installers from the existing signed applications (without recompiling the IDE), run:

```sh
sh native/make_dmg.sh "native/dist-macos-arm64/zaalis IDE.app" native/installer/zaalis-macos-arm64.dmg "zaalis IDE 1.0.16"
sh native/make_dmg.sh "native/dist-macos-x64/zaalis IDE.app" native/installer/zaalis-macos-x64.dmg "zaalis IDE 1.0.16"
```

The wizard source is `native/installer-macos/main.swift`. Its visual assets reuse the Windows installer palette/background; `Finder.DS_Store` opens the DMG in icon view with the assistant centered. The application payload is in `.payload/zaalis IDE.app`, also discoverable by the automatic updater.
