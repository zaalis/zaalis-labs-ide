#!/usr/bin/env sh
set -eu

ROOT=${1:?missing root}
ARCH=${2:?missing arch}
SOURCE_DIST=${3:?missing source dist}
ELECTRON_ZIP=${4:?missing electron zip}
FINAL_DIST=${5:?missing final dist}
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
VERSION=${VERSION:-1.0.0}

WORK="${TMPDIR:-/tmp}/zaalis-electron-macos-${ARCH}-$$"
APP="$FINAL_DIST/zaalis IDE.app"

rm -rf "$WORK" "$FINAL_DIST"
mkdir -p "$WORK" "$FINAL_DIST"

python3 "$ROOT/native/extract_zip_posix.py" "$ELECTRON_ZIP" "$WORK"

SRC_APP="$WORK/Electron.app"
if [ ! -d "$SRC_APP" ]; then
  echo "ERROR: Electron.app not found after extracting $ELECTRON_ZIP" >&2
  exit 1
fi

cp -a "$SRC_APP" "$APP"
rm -f "$APP/Contents/Resources/default_app.asar"
rm -rf "$APP/Contents/Resources/default_app.asar.unpacked"

if [ -f "$APP/Contents/MacOS/Electron" ]; then
  mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/zaalis-ide"
fi

APP_RES="$APP/Contents/Resources/app"
BUNDLE="$APP_RES/bundle"
rm -rf "$APP_RES"
mkdir -p "$APP_RES" "$BUNDLE"

cp "$ROOT/native/electron/package.json" "$APP_RES/package.json"
cp "$ROOT/native/electron/main.js" "$APP_RES/main.js"
cp "$ROOT/native/electron/preload.js" "$APP_RES/preload.js"
cp -R "$SOURCE_DIST/." "$BUNDLE/"
cp "$ROOT/package.json" "$BUNDLE/package.json"
if [ -f "$ROOT/README_MACOS.md" ]; then
  cp "$ROOT/README_MACOS.md" "$BUNDLE/README.txt"
fi
mkdir -p "$BUNDLE/image"
cp "$ROOT/native/image/logo-zaalis.png" "$BUNDLE/image/logo-zaalis.png"
cp "$ROOT/native/image/logo-zaalis.icns" "$BUNDLE/image/logo-zaalis.icns"
cp "$ROOT/native/image/logo-zaalis.icns" "$APP/Contents/Resources/logo-zaalis.icns"

python3 - "$APP/Contents/Info.plist" "$VERSION" <<'PY'
import plistlib
import sys

plist_path, version = sys.argv[1], sys.argv[2]
with open(plist_path, "rb") as f:
    data = plistlib.load(f)

data["CFBundleExecutable"] = "zaalis-ide"
data["CFBundleIdentifier"] = "fr.zaalis.ide"
data["CFBundleName"] = "zaalis IDE"
data["CFBundleDisplayName"] = "zaalis IDE"
data["CFBundleShortVersionString"] = version
data["CFBundleVersion"] = version
data["CFBundleIconFile"] = "logo-zaalis.icns"
data["LSMinimumSystemVersion"] = data.get("LSMinimumSystemVersion", "10.15")
data["NSHighResolutionCapable"] = True

with open(plist_path, "wb") as f:
    plistlib.dump(data, f, sort_keys=False)
PY

find "$APP" -type d -exec chmod 755 {} +
chmod +x "$APP/Contents/MacOS/zaalis-ide" \
  "$APP/Contents/Resources/app/bundle/zaalis-server" \
  "$APP/Contents/Resources/app/bundle/bin/zaalis" 2>/dev/null || true

rm -rf "$WORK"
echo "Electron darwin-${ARCH} app written to $APP"
