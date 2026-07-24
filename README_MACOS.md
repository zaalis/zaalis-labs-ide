# zaalis IDE macOS

Applications Electron macOS x64 et arm64.

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
chmod +x zaalis\ IDE.app/Contents/MacOS/zaalis-ide \
  zaalis\ IDE.app/Contents/Resources/app/bundle/zaalis-server \
  zaalis\ IDE.app/Contents/Resources/app/bundle/bin/zaalis
codesign --force --deep --sign - zaalis\ IDE.app 2>/dev/null || true
open zaalis\ IDE.app
```

Sur Mac Intel, utilisez `zaalis-macos-x64.tar.gz`.

CLI:

```sh
./zaalis\ IDE.app/Contents/Resources/app/bundle/bin/zaalis
./zaalis\ IDE.app/Contents/Resources/app/bundle/bin/zaalis "analyse le dossier"
```
