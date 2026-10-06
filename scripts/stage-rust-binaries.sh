#!/usr/bin/env sh
# Copie les binaires du coeur Rust dans le dossier de distribution que la
# coquille Electron empaquette ensuite.  Equivalent POSIX de
# scripts/stage-rust-binaries.ps1 (edition Windows).
#
#   zaalis        -> <dist>/bin/zaalis        (CLI installe sur le PATH)
#   zaalis-agentd -> <dist>/zaalis-agentd     (coeur agent appele par server.js)
#
# Usage: sh scripts/stage-rust-binaries.sh [--cli-only] [dist_dir]
set -eu

CLI_ONLY=0
DIST=""
for arg in "$@"; do
  case "$arg" in
    --cli-only) CLI_ONLY=1 ;;
    *) DIST="$arg" ;;
  esac
done

PROJECT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# Une compilation croisee (cargo --target <triplet>) ecrit dans
# rust/target/<triplet>/release : le pipeline qui la lance nous indique alors ou
# chercher via ZAALIS_RUST_RELEASE_DIR.
RELEASE_DIR=${ZAALIS_RUST_RELEASE_DIR:-"$PROJECT_ROOT/rust/target/release"}

# Sans argument, on vise le dossier de distribution de la plateforme courante.
# macOS en produit un par architecture, Linux un seul.
if [ -z "$DIST" ]; then
  case "$(uname -s)" in
    Darwin)
      case "$(uname -m)" in
        arm64) DIST="$PROJECT_ROOT/native/dist-macos-arm64-server" ;;
        *) DIST="$PROJECT_ROOT/native/dist-macos-x64-server" ;;
      esac
      ;;
    *) DIST="$PROJECT_ROOT/native/dist-linux-server" ;;
  esac
fi

mkdir -p "$DIST/bin"

CLI_SOURCE="$RELEASE_DIR/zaalis"
if [ ! -f "$CLI_SOURCE" ]; then
  echo "Rust CLI missing: $CLI_SOURCE" >&2
  exit 1
fi
cp -f "$CLI_SOURCE" "$DIST/bin/zaalis"
chmod +x "$DIST/bin/zaalis"

if [ "$CLI_ONLY" -eq 0 ]; then
  DAEMON_SOURCE="$RELEASE_DIR/zaalis-agentd"
  if [ ! -f "$DAEMON_SOURCE" ]; then
    echo "Rust daemon missing: $DAEMON_SOURCE" >&2
    exit 1
  fi
  cp -f "$DAEMON_SOURCE" "$DIST/zaalis-agentd"
  chmod +x "$DIST/zaalis-agentd"

  # Bac a sable strict (landlock+seccomp sous Linux, seatbelt sous macOS) :
  # zaalis-exec le cherche a cote du binaire, son absence degrade seulement le
  # confinement, elle ne casse pas l'execution.
  if [ -f "$RELEASE_DIR/zaalis-sandbox" ]; then
    cp -f "$RELEASE_DIR/zaalis-sandbox" "$DIST/zaalis-sandbox"
    chmod +x "$DIST/zaalis-sandbox"
  fi
fi

echo "Rust binaries staged in $DIST"
