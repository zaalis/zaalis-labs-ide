#!/usr/bin/env sh
# macOS counterpart of the Windows "connectors" build step
# (npm run build:server -> scripts/stage-connectors.js, cloudflared.exe) and of
# native/stage_linux_connectors.sh, for ONE architecture:
#   <dist>/messenger-runtime   Zaalis WhatsApp bridge + bundled Node runtime
#   <dist>/github/gh           official GitHub client (browser sign-in)
#   <dist>/cloudflared         remote-access tunnel
#
# Usage: sh native/stage_macos_connectors.sh <project_root> <x64|arm64> <dist_dir>
# Requires curl, shasum, tar, ditto (all shipped with macOS) and Node 22+ on PATH.
set -eu

ROOT=${1:?missing project root}
ARCH=${2:?missing architecture (x64 or arm64)}
DIST=${3:?missing dist directory}
# Same Node release as the runtime pkg embeds for node22-macos-* targets.
NODE_VERSION=${PKG_NODE_VERSION:-22.23.1}

case "$ARCH" in
  x64) CPU=x86_64; CLOUDFLARED_ARCH=amd64 ;;
  arm64) CPU=arm64; CLOUDFLARED_ARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

cd "$ROOT"
mkdir -p "$DIST"

# 1. The Node runtime of the TARGET architecture (an Intel package built on
#    Apple Silicon must not ship the host's arm64 node), checked against the
#    release's SHASUMS256.txt.
NODE_CACHE="$ROOT/native/macos-node-runtime"
NODE_NAME="node-v$NODE_VERSION-darwin-$ARCH"
NODE_HOME="$NODE_CACHE/$NODE_NAME"
if [ ! -x "$NODE_HOME/bin/node" ]; then
  mkdir -p "$NODE_CACHE"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$NODE_CACHE/SHASUMS256-$NODE_VERSION.txt"
  EXPECTED=$(awk -v f="$NODE_NAME.tar.gz" '$2 == f { print $1 }' "$NODE_CACHE/SHASUMS256-$NODE_VERSION.txt")
  [ -n "$EXPECTED" ] || { echo "Checksum for $NODE_NAME.tar.gz not found" >&2; exit 1; }
  curl -fL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz" -o "$NODE_CACHE/$NODE_NAME.tar.gz"
  ACTUAL=$(shasum -a 256 "$NODE_CACHE/$NODE_NAME.tar.gz" | awk '{ print $1 }')
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    rm -f "$NODE_CACHE/$NODE_NAME.tar.gz"
    echo "Node archive checksum mismatch" >&2; exit 1
  fi
  rm -rf "$NODE_HOME"
  tar -xzf "$NODE_CACHE/$NODE_NAME.tar.gz" -C "$NODE_CACHE"
  rm -f "$NODE_CACHE/$NODE_NAME.tar.gz"
fi

# 2. WhatsApp bridge and GitHub client, through the shared staging script.
ZAALIS_STAGE_ARCH="$ARCH" ZAALIS_STAGE_NODE="$NODE_HOME/bin/node" node scripts/stage-connectors.js "$DIST"
test -x "$DIST/messenger-runtime/node"
test -x "$DIST/github/gh"
file "$DIST/messenger-runtime/node" | grep -q "$CPU" || { echo "messenger-runtime/node is not $CPU" >&2; exit 1; }
file "$DIST/github/gh" | grep -q "$CPU" || { echo "github/gh is not $CPU" >&2; exit 1; }

# 3. cloudflared, as cloudflared.exe beside the Windows server.
CF_CACHE="$ROOT/native/macos-cloudflared/$ARCH"
if [ ! -x "$CF_CACHE/cloudflared" ]; then
  rm -rf "$CF_CACHE"
  mkdir -p "$CF_CACHE"
  curl -fL --retry 3 "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$CLOUDFLARED_ARCH.tgz" -o "$CF_CACHE/cloudflared.tgz"
  tar -xzf "$CF_CACHE/cloudflared.tgz" -C "$CF_CACHE"
  rm -f "$CF_CACHE/cloudflared.tgz"
  chmod 755 "$CF_CACHE/cloudflared"
fi
file "$CF_CACHE/cloudflared" | grep -q "$CPU" || { echo "cloudflared is not $CPU" >&2; exit 1; }
cp -f "$CF_CACHE/cloudflared" "$DIST/cloudflared"
chmod 755 "$DIST/cloudflared"

echo "    - connectors staged for macOS $ARCH (WhatsApp bridge, GitHub client, cloudflared)"
