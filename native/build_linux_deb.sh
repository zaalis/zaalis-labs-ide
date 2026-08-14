#!/usr/bin/env sh
set -eu

ROOT=${1:?missing project root}
DIST="$ROOT/native/dist-linux"
OUT="$ROOT/native/installer/zaalis-linux-x64.deb"
WORK="${TMPDIR:-/tmp}/zaalis-linux-package-$$"
PKG="$WORK/package"
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
VERSION=${VERSION:-1.0.0}

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "ERROR: dpkg-deb not found in WSL." >&2
  exit 1
fi

rm -rf "$WORK" "$ROOT/native/package-linux"
mkdir -p "$PKG/DEBIAN" \
  "$PKG/opt/zaalis-ide" \
  "$PKG/usr/local/bin" \
  "$PKG/usr/share/applications"

cp -R "$DIST/." "$PKG/opt/zaalis-ide/"

cat > "$PKG/DEBIAN/control" <<EOF
Package: zaalis-ide
Version: $VERSION
Section: devel
Priority: optional
Architecture: amd64
Depends: ca-certificates, curl, xdg-utils, xdotool, xclip, imagemagick, gnome-screenshot, tesseract-ocr, python3, python3-gi, python3-pyatspi, gir1.2-gtk-3.0, zenity, libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libxss1, libasound2 | libasound2t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libatspi2.0-0 | libatspi2.0-0t64, libdrm2, libgbm1, libxkbcommon0, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libxtst6, libpango-1.0-0, libcairo2, libx11-6, libx11-xcb1, libxcb1, libxcb-dri3-0, libxext6, libdbus-1-3, libexpat1, libfontconfig1, libglib2.0-0, libnotify4, libsecret-1-0, libuuid1
Maintainer: zaalis
Description: zaalis IDE
 zaalis IDE packaged as a local Electron desktop app with its local server and command line helper.
EOF

cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env sh
set -e
chmod +x /opt/zaalis-ide/zaalis-ide /opt/zaalis-ide/chrome_crashpad_handler /opt/zaalis-ide/resources/app/bundle/zaalis-server /opt/zaalis-ide/resources/app/bundle/bin/zaalis /opt/zaalis-ide/resources/app/bundle/zaalis-agentd /usr/local/bin/zaalis 2>/dev/null || true
chmod +x /opt/zaalis-ide/resources/app/bundle/zaalis-sandbox 2>/dev/null || true
if [ -f /opt/zaalis-ide/chrome-sandbox ]; then
  chmod 4755 /opt/zaalis-ide/chrome-sandbox 2>/dev/null || true
fi
chmod +x /usr/local/bin/zaalis-ide 2>/dev/null || true
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
exit 0
EOF

cat > "$PKG/usr/local/bin/zaalis" <<'EOF'
#!/usr/bin/env sh
exec /opt/zaalis-ide/resources/app/bundle/bin/zaalis "$@"
EOF

cat > "$PKG/usr/local/bin/zaalis-ide" <<'EOF'
#!/usr/bin/env sh
exec /opt/zaalis-ide/zaalis-ide "$@"
EOF

cat > "$PKG/usr/share/applications/zaalis-ide.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=zaalis IDE
Comment=Launch zaalis IDE
Exec=/opt/zaalis-ide/zaalis-ide
Icon=/opt/zaalis-ide/resources/app/bundle/image/logo-zaalis.png
Terminal=false
Categories=Development;IDE;
StartupWMClass=zaalis-ide
EOF

find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod 644 {} +
chmod 755 "$PKG/DEBIAN/postinst" \
  "$PKG/usr/local/bin/zaalis" \
  "$PKG/usr/local/bin/zaalis-ide" \
  "$PKG/opt/zaalis-ide/zaalis-ide" \
  "$PKG/opt/zaalis-ide/resources/app/bundle/zaalis-server" \
  "$PKG/opt/zaalis-ide/resources/app/bundle/bin/zaalis" \
  "$PKG/opt/zaalis-ide/resources/app/bundle/zaalis-agentd"
# Bac a sable strict : optionnel, absent d'une build faite sans cargo.
if [ -f "$PKG/opt/zaalis-ide/resources/app/bundle/zaalis-sandbox" ]; then
  chmod 755 "$PKG/opt/zaalis-ide/resources/app/bundle/zaalis-sandbox"
fi
if [ -f "$PKG/opt/zaalis-ide/chrome_crashpad_handler" ]; then
  chmod 755 "$PKG/opt/zaalis-ide/chrome_crashpad_handler"
fi
if [ -f "$PKG/opt/zaalis-ide/chrome-sandbox" ]; then
  chmod 4755 "$PKG/opt/zaalis-ide/chrome-sandbox"
fi

dpkg-deb --build --root-owner-group "$PKG" "$OUT"
rm -rf "$WORK"
