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
cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT HUP INT TERM
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Layout shown inside the mounted disk image: the app + an Applications shortcut.
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# Sign the app so Gatekeeper does not refuse it on first launch. Prefer the
# persistent identity from ZAALIS_CODESIGN_ID (see package_macos_electron.sh)
# so TCC approvals survive updates; fall back to ad-hoc.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign "${ZAALIS_CODESIGN_ID:--}" "$STAGE/$(basename "$APP")" >/dev/null 2>&1 || true
fi

create_status=0
hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$OUT" || create_status=$?

# A file named .dmg is not necessarily a mountable disk image.  Do not report
# success until macOS verifies the image it has just created.
hdiutil verify "$OUT" >/dev/null || {
  echo "ERROR: hdiutil could not create a valid DMG (create exit code: $create_status)." >&2
  exit 1
}
if [ "$create_status" -ne 0 ]; then
  # On some macOS versions hdiutil can return a late non-zero status after it
  # has finished a valid compressed image. Verification above is authoritative.
  echo "WARNING: hdiutil create exited $create_status, but the generated DMG verified successfully." >&2
fi
echo "DMG written to $OUT"
