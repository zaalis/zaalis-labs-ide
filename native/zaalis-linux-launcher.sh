#!/bin/sh
set -eu

launcher=$(readlink -f -- "$0")
app_dir=$(dirname -- "$launcher")
helper="$app_dir/chrome-sandbox"

# Chromium chooses its sandbox before Electron loads the JavaScript entry point.
# The Debian package installs this helper as root:4755. A portable extraction
# made without root can still launch the IDE with the existing fallback.
if [ "$(stat -c '%u:%a' -- "$helper" 2>/dev/null || true)" = '0:4755' ]; then
  exec "$app_dir/zaalis-ide-bin" "$@"
fi

exec "$app_dir/zaalis-ide-bin" --no-sandbox "$@"
