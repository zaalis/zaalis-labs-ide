#!/usr/bin/env bash
# Ship the Glyphes server + phone app to the VM and restart it.
# Usage (from the repo root, Git Bash):  bash glyphes/deploy/deploy.sh <vm-ip> [ssh-key]
set -euo pipefail
IP="${1:?usage: deploy.sh <vm-ip> [ssh-key]}"
KEY="${2:-$HOME/.ssh/zaalis_glyphes}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "glyphes@$IP")

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server/vendor" "$STAGE/web"
(cd "$ROOT/glyphes/server" && tar --exclude=./data --exclude=./dev --exclude=./test --exclude=./node_modules -cf - .) | tar -xf - -C "$STAGE/server"
cp "$ROOT/src/accounts/chatgpt-subscription.js" "$STAGE/server/vendor/"
(cd "$ROOT/interface/glyphes" && tar --exclude=./gallery.html --exclude=./gallery.js -cf - .) | tar -xf - -C "$STAGE/web"
tar -czf "$STAGE/glyphes.tgz" -C "$STAGE" server web

scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$STAGE/glyphes.tgz" "glyphes@$IP:/tmp/glyphes.tgz"
"${SSH[@]}" 'set -e
  sudo rm -rf /opt/glyphes/next && sudo mkdir -p /opt/glyphes/next
  sudo tar -xzf /tmp/glyphes.tgz -C /opt/glyphes/next && rm -f /tmp/glyphes.tgz
  cd /opt/glyphes/next/server && sudo npm install --omit=dev --no-audit --no-fund --loglevel=error
  sudo rm -rf /opt/glyphes/prev && { [ -d /opt/glyphes/server ] && sudo mkdir -p /opt/glyphes/prev && sudo mv /opt/glyphes/server /opt/glyphes/web /opt/glyphes/prev/ || true; }
  sudo mv /opt/glyphes/next/server /opt/glyphes/next/web /opt/glyphes/ && sudo rm -rf /opt/glyphes/next
  sudo systemctl restart glyphes
  sleep 2; systemctl is-active glyphes; curl -fsS http://127.0.0.1:8787/api/health'
echo
echo "deployed to $IP"
