#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="$ROOT/native/.whisper-build"
mkdir -p "$WORK" "$ROOT/native/whisper"
if [ ! -f "$WORK/whisper.cpp-1.9.4/CMakeLists.txt" ]; then
  curl -fL --retry 3 https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz -o "$WORK/source.tar.gz"
  tar -xzf "$WORK/source.tar.gz" -C "$WORK"
fi
METAL=OFF
OSX_ARCH=
if [ "$(uname -s)" = Darwin ]; then METAL=ON; OSX_ARCH="arm64;x86_64"; fi
cmake -S "$WORK/whisper.cpp-1.9.4" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES="$OSX_ARCH" -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL="$METAL" -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
cmake --build "$WORK/build" --target whisper-cli -j 4
cp "$WORK/build/bin/whisper-cli" "$ROOT/native/whisper/whisper-cli"
cp "$WORK/whisper.cpp-1.9.4/LICENSE" "$ROOT/native/whisper/LICENSE"
chmod 755 "$ROOT/native/whisper/whisper-cli"
