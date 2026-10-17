#!/usr/bin/env sh
# Build only the native installation wizard, without rebuilding the IDE.
set -eu
ROOT=${1:?missing project root}
ARCH=${2:?missing architecture}
OUT=${3:?missing installer .app path}
TOKEN=${4:-preview}
PAYLOAD=${5:-}
VERSION=$(node -p "require(process.argv[1]).version" "$ROOT/package.json")
case "$ARCH" in
  arm64) TARGET=arm64-apple-macos12.0 ;;
  x64) TARGET=x86_64-apple-macos12.0 ;;
  *) echo "Unsupported installer architecture: $ARCH" >&2; exit 1 ;;
esac
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -target "$TARGET" -O -framework AppKit \
  "$ROOT/native/installer-macos/main.swift" -o "$OUT/Contents/MacOS/zaalis-setup"
cp "$ROOT/native/installer-macos/background.png" "$OUT/Contents/Resources/background.png"
cp "$ROOT/native/image/logo-zaalis.icns" "$OUT/Contents/Resources/AppIcon.icns"
python3 - "$OUT/Contents/Info.plist" "$VERSION" "$TOKEN" "$PAYLOAD" <<'PY'
import hashlib, pathlib, plistlib, sys
with open(sys.argv[1], 'wb') as output:
    info = {
        'CFBundleIdentifier': 'fr.zaalis.ide.installer',
        'CFBundleName': 'Installer zaalis IDE',
        'CFBundleDisplayName': 'Installer zaalis IDE',
        'CFBundleExecutable': 'zaalis-setup',
        'CFBundlePackageType': 'APPL',
        'CFBundleIconFile': 'AppIcon',
        'CFBundleShortVersionString': sys.argv[2],
        'CFBundleVersion': sys.argv[2],
        'LSMinimumSystemVersion': '12.0',
        'NSHighResolutionCapable': True,
        'NSPrincipalClass': 'NSApplication',
        'NSHumanReadableCopyright': 'zaalis',
        'ZaalisVolumeToken': sys.argv[3],
    }
    if sys.argv[4]:
        contents = pathlib.Path(sys.argv[4]) / 'Contents'
        seal = contents / '_CodeSignature/CodeResources'
        info['ZaalisPayloadSeal'] = hashlib.sha256(seal.read_bytes()).hexdigest()
        app_info = plistlib.loads((contents / 'Info.plist').read_bytes())
        info['ZaalisPayloadCode'] = hashlib.sha256((contents / 'MacOS' / app_info['CFBundleExecutable']).read_bytes()).hexdigest()
    plistlib.dump(info, output)
PY
codesign --force --sign "${MACOS_CODESIGN_IDENTITY:-${ZAALIS_CODESIGN_ID:--}}" "$OUT"
codesign --verify --strict "$OUT"
