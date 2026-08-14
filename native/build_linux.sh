#!/usr/bin/env sh
# ============================================================
#  Chaine de build Linux native (a lancer SUR une machine Linux ou un runner
#  CI Linux). Equivalent de native/build_linux.bat, qui pilote la meme chaine
#  depuis Windows via WSL.
#
#  Sorties :
#    native/installer/zaalis-linux-x64.tar.gz   (archive portable)
#    native/installer/zaalis-linux-x64.deb      (installateur double-clic)
#
#  Prerequis : node, npm, cargo (Rust 1.90+), dpkg-deb, tar.
# ============================================================
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

SERVERDIST="$ROOT/native/dist-linux-server"
DIST="$ROOT/native/dist-linux"
INSTALLER="$ROOT/native/installer"

mkdir -p "$SERVERDIST/bin" "$INSTALLER"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERREUR : '$1' est introuvable. $2" >&2
    exit 1
  }
}
need node "Installez Node.js 22 ou plus recent."
need npm "Installez Node.js 22 ou plus recent."
need cargo "Installez Rust : curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
need dpkg-deb "Installez dpkg-dev (paquet Debian/Ubuntu)."

echo "[1/8] Installation des outils de build..."
npm install

echo "[2/8] Verification de l'encodage des sources..."
npm run check:mojibake

echo "[3/8] Empaquetage du serveur -> $SERVERDIST/zaalis-server ..."
npx pkg . --no-bytecode --public --public-packages "*" --targets node22-linux-x64 \
  --output "$SERVERDIST/zaalis-server"

echo "[4/8] Compilation de node-pty pour le runtime Node embarque..."
sh "$ROOT/native/build_linux_node_pty.sh" "$ROOT"

# zaalis-agentd est le coeur agent : sans lui, Chat, Agents et le CLI n'ont
# aucun moteur. On le construit donc avant tout empaquetage.
echo "[5/8] Compilation du coeur Rust (agentd, CLI, bac a sable)..."
cargo build --manifest-path rust/Cargo.toml --release \
  -p zaalis-cli -p zaalis-agentd -p zaalis-sandbox-helper

echo "[6/8] Mise en place des binaires Rust -> $SERVERDIST ..."
sh "$ROOT/scripts/stage-rust-binaries.sh" "$SERVERDIST"

echo "[7/8] Copie de l'interface et des metadonnees..."
rm -rf "$SERVERDIST/interface"
cp -R "$ROOT/interface" "$SERVERDIST/interface"
if [ -d "$ROOT/image" ]; then
  rm -rf "$SERVERDIST/image"
  cp -R "$ROOT/image" "$SERVERDIST/image"
fi
cp -f "$ROOT/package.json" "$SERVERDIST/package.json"
[ -f "$ROOT/README_LINUX.md" ] && cp -f "$ROOT/README_LINUX.md" "$SERVERDIST/README.txt"

echo "[8/8] Empaquetage Electron, archive portable et paquet Debian..."
node "$ROOT/native/package_electron.js" linux x64 "$SERVERDIST" "$DIST"
tar -czf "$INSTALLER/zaalis-linux-x64.tar.gz" -C "$DIST" .
sh "$ROOT/native/build_linux_deb.sh" "$ROOT"

echo
echo "Termine. Paquets Linux :"
echo "  $INSTALLER/zaalis-linux-x64.tar.gz"
echo "  $INSTALLER/zaalis-linux-x64.deb"
