#!/usr/bin/env sh
set -eu

ROOT=${1:?missing project root}
NODE_VERSION=22.17.0
RUNTIME_ROOT="$ROOT/native/linux-node-runtime"
NODE_HOME="$RUNTIME_ROOT/node-v$NODE_VERSION-linux-x64"
DEPS="$ROOT/native/linux-node-pty"
SERVER_DIST="$ROOT/native/dist-linux-server"

if [ ! -x "$NODE_HOME/bin/node" ]; then
  mkdir -p "$RUNTIME_ROOT"
  ARCHIVE="$RUNTIME_ROOT/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$ARCHIVE"
  tar -xJf "$ARCHIVE" -C "$RUNTIME_ROOT"
  rm -f "$ARCHIVE"
fi

rm -rf "$DEPS" "$SERVER_DIST/node_modules/node-pty"
mkdir -p "$DEPS" "$SERVER_DIST/node_modules"
PATH="$NODE_HOME/bin:$PATH" "$NODE_HOME/bin/npm" install --prefix "$DEPS" --no-audit --no-fund --omit=dev node-pty@1.0.0
cp -R "$DEPS/node_modules/node-pty" "$SERVER_DIST/node_modules/node-pty"

test -f "$SERVER_DIST/node_modules/node-pty/build/Release/pty.node"
"$NODE_HOME/bin/node" -e "require(process.argv[1]); process.stdout.write('Linux node-pty OK\\n')" "$SERVER_DIST/node_modules/node-pty"
