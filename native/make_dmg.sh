#!/usr/bin/env sh
# ============================================================
#  Builds a drag-to-Applications .dmg from a single .app.
#  macOS only: relies on hdiutil (no Linux/Windows equivalent).
#
#  Usage:
#    native/make_dmg.sh "<app path>" "<output.dmg>" "<volume name>"
# ============================================================
set -eu

APP=${1:?missing .app path}
OUT=${2:?missing output .dmg path}
VOLNAME=${3:?missing volume name}

if [ ! -d "$APP" ]; then
  echo "ERROR: app not found: $APP" >&2
  exit 1
fi

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "ERROR: hdiutil not found. A .dmg can only be built on macOS." >&2
  exit 1
fi

STAGE="${TMPDIR:-/tmp}/zaalis-dmg-stage-$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Layout shown inside the mounted disk image: the app + an Applications shortcut.
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# Ad-hoc sign the app so Gatekeeper does not refuse it on first launch.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$STAGE/$(basename "$APP")" >/dev/null 2>&1 || true
fi

hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$OUT"

rm -rf "$STAGE"
echo "DMG written to $OUT"
