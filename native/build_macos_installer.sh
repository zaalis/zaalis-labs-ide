#!/usr/bin/env sh
set -eu

ROOT=${1:?missing project root}
OUT="$ROOT/native/installer/zaalis-macos-universal-installer.tar.gz"
WORK="${TMPDIR:-/tmp}/zaalis-macos-installer-$$"
STAGE="$WORK/macos-installer"
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
VERSION=${VERSION:-1.0.0}

copy_app() {
  arch="$1"
  dist="$2"
  src="$dist/zaalis IDE.app"
  dest="$STAGE/apps/$arch/zaalis IDE.app"

  if [ ! -d "$src" ]; then
    echo "ERROR: Electron app not found: $src" >&2
    exit 1
  fi

  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"

  chmod +x "$dest/Contents/MacOS/zaalis-ide" \
    "$dest/Contents/Resources/app/bundle/zaalis-server" \
    "$dest/Contents/Resources/app/bundle/bin/zaalis" 2>/dev/null || true
}

rm -rf "$WORK" "$ROOT/native/macos-installer"
mkdir -p "$STAGE/apps"

copy_app "x64" "$ROOT/native/dist-macos-x64"
copy_app "arm64" "$ROOT/native/dist-macos-arm64"

cat > "$STAGE/Installer zaalis IDE.command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64) SRC="${DIR}/apps/arm64/zaalis IDE.app" ;;
  x86_64) SRC="${DIR}/apps/x64/zaalis IDE.app" ;;
  *)
    echo "Architecture macOS non supportee: $ARCH"
    read -r -p "Appuyez sur Entree pour fermer." _
    exit 1
    ;;
esac

if [ -w "/Applications" ]; then
  DEST="/Applications/zaalis IDE.app"
else
  mkdir -p "$HOME/Applications"
  DEST="$HOME/Applications/zaalis IDE.app"
fi

rm -rf "$DEST"
cp -R "$SRC" "$DEST"
chmod +x "$DEST/Contents/MacOS/zaalis-ide" \
  "$DEST/Contents/Resources/app/bundle/zaalis-server" \
  "$DEST/Contents/Resources/app/bundle/bin/zaalis" 2>/dev/null || true
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

if [ -w "/usr/local/bin" ]; then
  ln -sf "$DEST/Contents/Resources/app/bundle/bin/zaalis" /usr/local/bin/zaalis 2>/dev/null || true
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DEST/Contents/Resources/app/bundle/bin/zaalis" "$HOME/.local/bin/zaalis" 2>/dev/null || true
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$DEST/Contents/Resources/app/bundle/zaalis-server" >/dev/null 2>&1 || true
  codesign --force --sign - "$DEST/Contents/Resources/app/bundle/bin/zaalis" >/dev/null 2>&1 || true
  codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true
fi

echo "zaalis IDE __ZAALIS_VERSION__ installe dans: $DEST"
open "$DEST" >/dev/null 2>&1 || true
read -r -p "Installation terminee. Appuyez sur Entree pour fermer." _
EOF
sed -i "s/__ZAALIS_VERSION__/$VERSION/g" "$STAGE/Installer zaalis IDE.command"

cat > "$STAGE/README.txt" <<EOF
Double-cliquez sur "Installer zaalis IDE.command".
Le script installe automatiquement la bonne application Electron $VERSION
pour Intel ou Apple Silicon, puis ouvre zaalis IDE.
EOF

find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/Installer zaalis IDE.command" \
  "$STAGE/apps/x64/zaalis IDE.app/Contents/MacOS/zaalis-ide" \
  "$STAGE/apps/x64/zaalis IDE.app/Contents/Resources/app/bundle/zaalis-server" \
  "$STAGE/apps/x64/zaalis IDE.app/Contents/Resources/app/bundle/bin/zaalis" \
  "$STAGE/apps/arm64/zaalis IDE.app/Contents/MacOS/zaalis-ide" \
  "$STAGE/apps/arm64/zaalis IDE.app/Contents/Resources/app/bundle/zaalis-server" \
  "$STAGE/apps/arm64/zaalis IDE.app/Contents/Resources/app/bundle/bin/zaalis"

tar -czf "$OUT" -C "$STAGE" .
rm -rf "$WORK"
