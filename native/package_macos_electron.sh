#!/usr/bin/env sh
set -eu

ROOT=${1:?missing root}
ARCH=${2:?missing arch}
SOURCE_DIST=${3:?missing source dist}
ELECTRON_ZIP=${4:?missing electron zip}
FINAL_DIST=${5:?missing final dist}
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
VERSION=${VERSION:-1.0.0}
SWIFT_TARGET="arm64-apple-macos12.0"
if [ "$ARCH" = "x64" ]; then
  SWIFT_TARGET="x86_64-apple-macos12.0"
fi

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
if command -v swiftc >/dev/null 2>&1; then
  swiftc -target "$SWIFT_TARGET" -O \
    -framework Foundation -framework Speech -framework AVFoundation \
    "$ROOT/native/macos_speech_transcriber.swift" \
    -o "$APP_RES/macos-speech-transcriber"
  swiftc -target "$SWIFT_TARGET" -O \
    -framework Foundation -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework ImageIO -framework ScreenCaptureKit -framework Carbon -framework Vision \
    "$ROOT/native/macos_computer_bridge.swift" \
    -o "$APP_RES/macos-computer-bridge"
else
  echo "ERROR: swiftc not found. macOS voice dictation helper cannot be built." >&2
  exit 1
fi
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
data["NSMicrophoneUsageDescription"] = "zaalis IDE uses the microphone only when you start voice dictation."
data["NSSpeechRecognitionUsageDescription"] = "zaalis IDE uses macOS speech recognition only when you start voice dictation."
data["NSAudioCaptureUsageDescription"] = "zaalis IDE uses audio capture only when you start voice dictation."
data["NSScreenCaptureUsageDescription"] = "zaalis IDE captures the screen only while you explicitly enable AI computer control."

with open(plist_path, "wb") as f:
    plistlib.dump(data, f, sort_keys=False)
PY

find "$APP" -type d -exec chmod 755 {} +
chmod +x "$APP/Contents/MacOS/zaalis-ide" \
  "$APP/Contents/Resources/app/macos-speech-transcriber" \
  "$APP/Contents/Resources/app/macos-computer-bridge" \
  "$APP/Contents/Resources/app/bundle/zaalis-server" \
  "$APP/Contents/Resources/app/bundle/bin/zaalis" 2>/dev/null || true

# Sign only after every bundled resource has been copied.  Signing earlier
# leaves Electron's resource seal stale and macOS rejects the application.
# ZAALIS_CODESIGN_ID may name a persistent (self-signed) identity: ad-hoc
# signing ("-") produces a new code hash on every build, which silently
# invalidates the user's Accessibility/Screen Recording approvals in TCC
# after each update. A stable identity keeps those approvals across builds.
CODESIGN_ID="${ZAALIS_CODESIGN_ID:--}"
if command -v codesign >/dev/null 2>&1; then
  # The helper itself calls the macOS Accessibility and Screen Recording APIs.
  # Signing it before the enclosing bundle gives TCC a stable identity instead
  # of treating it as an anonymous executable with a separate, opaque grant.
  codesign --force --identifier fr.zaalis.ide.speech-transcriber --sign "$CODESIGN_ID" "$APP/Contents/Resources/app/macos-speech-transcriber"
  codesign --force --identifier fr.zaalis.ide.computer-bridge --sign "$CODESIGN_ID" "$APP/Contents/Resources/app/macos-computer-bridge"
  codesign --force --deep --sign "$CODESIGN_ID" "$APP"
fi

rm -rf "$WORK"
echo "Electron darwin-${ARCH} app written to $APP"
