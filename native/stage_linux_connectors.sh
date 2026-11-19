#!/usr/bin/env sh
# Equivalent Linux de l'etape "connecteurs" de la build Windows
# (npm run build:server -> scripts/stage-connectors.js, cloudflared.exe) :
#   <dist>/messenger-runtime   pont WhatsApp Zaalis + runtime Node embarque
#   <dist>/github/gh           client GitHub officiel (connexion par navigateur)
#   <dist>/cloudflared         tunnel de l'acces a distance
#
# Usage: sh native/stage_linux_connectors.sh <project_root> [dist_dir]
# A lancer apres native/build_linux_node_pty.sh, qui fournit Node 22.
set -eu

ROOT=${1:?missing project root}
DIST=${2:-"$ROOT/native/dist-linux-server"}
NODE_VERSION=22.17.0
NODE_HOME="$ROOT/native/linux-node-runtime/node-v$NODE_VERSION-linux-x64"

if [ ! -x "$NODE_HOME/bin/node" ]; then
  echo "Node $NODE_VERSION introuvable : lancez d'abord native/build_linux_node_pty.sh" >&2
  exit 1
fi

cd "$ROOT"
PATH="$NODE_HOME/bin:$PATH" "$NODE_HOME/bin/node" scripts/stage-connectors.js "$DIST"
test -x "$DIST/messenger-runtime/node"
test -x "$DIST/github/gh"
"$DIST/github/gh" --version | head -n 1

CACHE="$ROOT/native/linux-cloudflared"
CLOUDFLARED_VERSION=2026.11.1
CLOUDFLARED_SHA256=97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7
CLOUDFLARED="$CACHE/cloudflared-$CLOUDFLARED_VERSION"
mkdir -p "$CACHE"
verify_cloudflared() {
  printf '%s  %s\n' "$CLOUDFLARED_SHA256" "$1" | sha256sum --check --status
}
if ! verify_cloudflared "$CLOUDFLARED" 2>/dev/null; then
  curl -fL --retry 3 "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64" -o "$CLOUDFLARED.part"
  verify_cloudflared "$CLOUDFLARED.part"
  mv -f "$CLOUDFLARED.part" "$CLOUDFLARED"
fi
cp -f "$CLOUDFLARED" "$DIST/cloudflared"
chmod 755 "$DIST/cloudflared"
"$DIST/cloudflared" --version
