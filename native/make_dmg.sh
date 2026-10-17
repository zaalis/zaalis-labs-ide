#!/usr/bin/env sh
# Package the native macOS wizard and the already-built IDE in a DMG.
# Usage: make_dmg.sh <zaalis IDE.app> <output.dmg> <volume name>
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
APP=${1:?missing .app path}
OUT=${2:?missing output .dmg path}
VOLNAME=${3:?missing volume name}
[ -d "$APP" ] || { echo "Application missing: $APP" >&2; exit 1; }
case "$(lipo -archs "$APP/Contents/MacOS/zaalis-ide")" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Expected a single-architecture macOS application" >&2; exit 1 ;;
esac
# Preserve the exact tested application, including its existing signatures.
codesign --verify --deep --strict "$APP"
mkdir -p "$(dirname "$OUT")"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/zaalis-dmg-stage.XXXXXX")
TEMP_OUT="$(dirname "$OUT")/.$(basename "$OUT" .dmg).partial-$$.dmg"
cleanup() {
  rm -rf "$STAGE"
  rm -f "$TEMP_OUT"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$STAGE/.payload"
cp -R "$APP" "$STAGE/.payload/"
# The updater searches two levels deep for zaalis IDE.app. The hidden payload
# remains compatible, while Finder presents only the installation assistant.
TOKEN=$(uuidgen)
printf '%s\n' "$TOKEN" > "$STAGE/.zaalis-install-id"
sh "$ROOT/native/build_macos_setup.sh" "$ROOT" "$ARCH" "$STAGE/Installer zaalis IDE.app" "$TOKEN" "$APP"
cp "$ROOT/native/installer-macos/Finder.DS_Store" "$STAGE/.DS_Store"
create_status=0
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$TEMP_OUT" || create_status=$?
hdiutil verify "$TEMP_OUT" >/dev/null || {
  echo "Invalid DMG (hdiutil create exit code: $create_status)" >&2
  exit 1
}
if [ "$create_status" -ne 0 ]; then
  echo "hdiutil returned $create_status, but independent verification passed." >&2
fi
mv -f "$TEMP_OUT" "$OUT"
echo "Custom macOS installer: $OUT"
