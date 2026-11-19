# zaalis IDE for macOS

The Electron application is built for Intel x64 and Apple Silicon arm64 and bundles the shared Rust agent (`zaalis-agentd`).

Build on a Mac with `sh native/build_macos_dmg.sh`. Prerequisites: Node.js 22+, Rust 1.90+ with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets, Xcode command-line tools (`swiftc`, `codesign`, `hdiutil`), CMake, and a C/C++ compiler for whisper.cpp.

The build produces `native/installer/zaalis-macos-arm64.dmg` and `native/installer/zaalis-macos-x64.dmg`. Open the image for your Mac and drag `zaalis IDE` to Applications. The package installs the Rust CLI binary `zaalis` inside the application bundle; use its packaged path or the launcher provided by the installed application.

Desktop control relies on macOS Screen Recording and Accessibility permissions. Grant both permissions to the application before using capture or input automation.

GGUF models use llama.cpp, downloaded on demand to `~/Library/Application Support/zaalis/engine`. The Metal variant uses the GPU. The CPU variant sets `-ngl 0` and is the fallback if a model cannot fit in unified memory.
