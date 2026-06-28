# zaalis IDE macOS

Packages portables macOS x64 et arm64.

Build depuis Windows:

```bat
native\build_macos.bat
```

Sorties:

```text
native\installer\zaalis-macos-x64.tar.gz
native\installer\zaalis-macos-arm64.tar.gz
native\installer\zaalis-macos-universal-installer.tar.gz
```

Installation sur macOS:

Decompressez `zaalis-macos-universal-installer.tar.gz`, puis double-cliquez sur
`Installer zaalis IDE.command`.

Lancement portable:

```sh
mkdir -p zaalis-macos
tar -xzf zaalis-macos-arm64.tar.gz -C zaalis-macos
cd zaalis-macos
chmod +x zaalis-server bin/zaalis zaalis-ide.command
codesign --sign - zaalis-server bin/zaalis 2>/dev/null || true
./zaalis-ide.command
```

Sur Mac Intel, utilisez `zaalis-macos-x64.tar.gz`.

CLI:

```sh
./bin/zaalis
./bin/zaalis "analyse le dossier"
```
