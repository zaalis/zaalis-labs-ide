# zaalis IDE - macOS Electron package

This macOS copy ships as local Electron `.app` packages for Intel x64 and Apple
Silicon arm64, plus a double-click installer archive. The app includes its own
Chromium runtime, the zaalis local server, and the zaalis CLI.

Build:

```bat
native\build_macos.bat
```

Outputs:

```text
native\installer\zaalis-macos-x64.tar.gz
native\installer\zaalis-macos-arm64.tar.gz
native\installer\zaalis-macos-universal-installer.tar.gz
```

The universal installer archive contains an installer command that chooses the
right Electron `.app` for Intel or Apple Silicon and copies it to
`/Applications` when possible, otherwise to `~/Applications`.
Windows installer files are intentionally not kept in this macOS package folder.
