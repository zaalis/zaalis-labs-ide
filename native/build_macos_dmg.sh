#!/usr/bin/env sh
# ============================================================
#  macOS-native build pipeline (no WSL, no Windows).
#  Produces ONE .dmg per architecture:
#    native/installer/zaalis-macos-arm64.dmg   (Apple Silicon: M1/M2/M3...)
#    native/installer/zaalis-macos-x64.dmg     (Intel)
#
#  Run this on a Mac (or a macOS CI runner). Requires: node, npx, hdiutil.
# ============================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

INSTALLER="$ROOT/native/installer"
mkdir -p "$INSTALLER"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
VERSION=${VERSION:-1.0.0}

echo "[1/3] Preparing Electron icon (.icns)..."
node native/make_icns.js

build_arch() {
  arch="$1"          # x64 | arm64
  pkg_target="$2"    # node22-macos-x64 | node22-macos-arm64

  serverdist="native/dist-macos-${arch}-server"
  dist="native/dist-macos-${arch}"
  zip="native/.electron-cache/electron-darwin-${arch}.zip"

  echo "==> Building macOS ${arch}"
  rm -rf "$serverdist" "$dist"
  mkdir -p "$serverdist/bin"

  echo "    - packaging server"
  npx pkg . --no-bytecode --public --public-packages "*" \
    --targets "$pkg_target" --output "$serverdist/zaalis-server"

  echo "    - packaging CLI"
  npx pkg cli.js --no-bytecode --public --public-packages "*" \
    --targets "$pkg_target" --output "$serverdist/bin/zaalis"

  echo "    - copying assets"
  cp -R interface "$serverdist/interface"
  [ -d image ] && cp -R image "$serverdist/image"
  cp package.json "$serverdist/package.json"
  [ -f README_MACOS.md ] && cp README_MACOS.md "$serverdist/README.txt"

  echo "    - downloading Electron runtime"
  node native/download_electron_macos.js "$arch" "$zip"

  echo "    - assembling .app"
  sh native/package_macos_electron.sh "$ROOT" "$arch" "$ROOT/$serverdist" "$ROOT/$zip" "$ROOT/$dist"

  echo "    - building .dmg"
  sh native/make_dmg.sh \
    "$ROOT/$dist/zaalis IDE.app" \
    "$INSTALLER/zaalis-macos-${arch}.dmg" \
    "zaalis IDE ${VERSION}"
}

echo "[2/3] Building Apple Silicon (arm64) DMG..."
build_arch arm64 node22-macos-arm64

echo "[3/3] Building Intel (x64) DMG..."
build_arch x64 node22-macos-x64

echo
echo "Done. macOS DMGs:"
echo "  $INSTALLER/zaalis-macos-arm64.dmg   (Apple Silicon)"
echo "  $INSTALLER/zaalis-macos-x64.dmg     (Intel)"
