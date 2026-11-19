#!/usr/bin/env bash
# One-time setup of the Glyphes VM (Debian, Google Cloud e2-micro free tier).
# Run as root:  sudo bash setup-vm.sh <public-hostname>
# Example host: 34-1-2-3.sslip.io  (free name that points to the VM's IP; Caddy gets a Let's Encrypt certificate)
set -euo pipefail
HOST="${1:?usage: setup-vm.sh <public-hostname>}"
export DEBIAN_FRONTEND=noninteractive

# 1 GB of RAM is tight: a swap file keeps npm and whisper from being killed.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update -y
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https ffmpeg git build-essential cmake unattended-upgrades

# Node.js 24 (node:sqlite, built-in WebSocket/fetch).
if ! node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# Caddy: HTTPS reverse proxy with automatic certificates.
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# Service account with no shell, data in /var/lib/glyphes (mode 700).
id glyphesd >/dev/null 2>&1 || useradd --system --home /var/lib/glyphes --shell /usr/sbin/nologin glyphesd
install -d -o glyphesd -g glyphesd -m 700 /var/lib/glyphes
install -d -o root -g root -m 755 /opt/glyphes

# Local dictation: whisper.cpp + the small "base" model (the VM has no GPU and 1 GB of RAM).
if [ ! -x /opt/whisper/whisper-cli ]; then
  rm -rf /tmp/whisper.cpp && git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp
  cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
  cmake --build /tmp/whisper.cpp/build -j 2 --target whisper-cli
  install -d /opt/whisper && install -m 755 /tmp/whisper.cpp/build/bin/whisper-cli /opt/whisper/whisper-cli
  curl -fL -o /opt/whisper/ggml-base-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin
  rm -rf /tmp/whisper.cpp
fi

# Settings file (Google OAuth client is added later by deploy.sh / by hand).
if [ ! -f /etc/glyphes.env ]; then
  cat > /etc/glyphes.env <<EOF
PUBLIC_URL=https://${HOST}
GLYPHES_DATA=/var/lib/glyphes
GLYPHES_WEB=/opt/glyphes/web
GLYPHES_TZ=Europe/Paris
PORT=8787
HOST=127.0.0.1
WHISPER_BIN=/opt/whisper/whisper-cli
WHISPER_MODEL=/opt/whisper/ggml-base-q5_1.bin
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
EOF
fi
chown root:glyphesd /etc/glyphes.env && chmod 640 /etc/glyphes.env

cat > /etc/systemd/system/glyphes.service <<'EOF'
[Unit]
Description=zaalis Glyphes
After=network-online.target
Wants=network-online.target

[Service]
User=glyphesd
Group=glyphesd
EnvironmentFile=/etc/glyphes.env
WorkingDirectory=/opt/glyphes/server
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning index.js
Restart=always
RestartSec=3
MemoryMax=600M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/glyphes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
${HOST} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
EOF

systemctl daemon-reload
systemctl enable glyphes caddy >/dev/null
systemctl restart caddy
echo "setup ok: https://${HOST}"
