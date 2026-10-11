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
mkdir -p "$CACHE"
if [ ! -x "$CACHE/cloudflared" ]; then
  curl -fL --retry 3 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CACHE/cloudflared.part"
  chmod 755 "$CACHE/cloudflared.part"
  "$CACHE/cloudflared.part" --version >/dev/null
  mv -f "$CACHE/cloudflared.part" "$CACHE/cloudflared"
fi
cp -f "$CACHE/cloudflared" "$DIST/cloudflared"
chmod 755 "$DIST/cloudflared"
"$DIST/cloudflared" --version
