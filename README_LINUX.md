# zaalis IDE Linux

Application Electron Linux x64 autonome, avec le coeur agent Rust
`zaalis-agentd` embarque dans le bundle.

Build sur Linux :

```sh
sh native/build_linux.sh
```

Build depuis Windows (via WSL) :

```bat
native\build_linux.bat
```

Prerequis : Node.js 22+, Rust 1.90+, `dpkg-deb`, `tar`, `curl`, CMake et un compilateur C/C++.

Sorties :

```text
native/installer/zaalis-linux-x64.deb
native/installer/zaalis-linux-x64.tar.gz
```

Installation sur Linux :

Double-cliquez sur `zaalis-linux-x64.deb`, puis installez avec l'application
logiciels de votre distribution, ou :

```sh
sudo apt install ./zaalis-linux-x64.deb
```

Apres installation :

```sh
zaalis
zaalis ide
zaalis-ide
```

Le raccourci `zaalis IDE` ouvre une vraie application Electron locale avec
Chromium embarque. Chrome, Chromium, Edge ou Brave ne sont pas requis.

Lancement portable :

```sh
mkdir -p zaalis-linux
tar -xzf zaalis-linux-x64.tar.gz -C zaalis-linux
cd zaalis-linux
chmod +x zaalis-ide \
  resources/app/bundle/zaalis-server \
  resources/app/bundle/zaalis-agentd \
  resources/app/bundle/bin/zaalis
./zaalis-ide
```

CLI :

```sh
./resources/app/bundle/bin/zaalis
./resources/app/bundle/bin/zaalis "analyse le dossier"
```

Controle du bureau :

Le `.deb` declare les dependances du terminal PTY, de la capture/OCR et du
controle de bureau (`xdotool`, `gnome-screenshot`, `tesseract-ocr`,
`python3-pyatspi`, `gir1.2-gtk-3.0`, `zenity`). L'injection d'evenements passe
par X11 : sous Wayland, ouvrez une session Xorg pour que le controle de bureau
fonctionne.

Connecteurs et outils embarques :

Comme l'installateur Windows, le paquet contient le pont WhatsApp (avec son
runtime Node), le client GitHub officiel `gh` pour la connexion par navigateur
et `cloudflared` pour l'acces a distance. Le `.deb` recommande aussi `git`,
`espeak-ng` (synthese vocale locale de l'agent), `ffmpeg` (analyse video),
`qemu-system-x86`, `qemu-utils` et `openssh-client` (machines virtuelles).

Machines virtuelles :

Les VM Debian utilisent QEMU avec KVM. Le bouton « Activer les composants Linux »
des parametres Machines virtuelles installe ce qui manque via `pkexec`, ajoute
l'utilisateur au groupe `kvm` (reconnexion requise) et telecharge l'image
officielle Debian 12, verifiee par SHA-512, dans
`~/.local/share/zaalis/server-data/virtual-machines/images`. Windows Sandbox
reste propre a Windows.

Modeles locaux :

Les modeles GGUF passent par llama.cpp, telecharge a la demande dans
`~/.local/share/zaalis/engine`. La variante est choisie selon le GPU detecte :
`rocm` sur AMD quand le runtime ROCm est installe, `vulkan` sinon (NVIDIA, Intel,
AMD), `cpu` en dernier recours et en repli automatique. llama.cpp ne publie pas
de binaire CUDA pour Linux : une variante `cuda` heritee d'une configuration
Windows retombe sur Vulkan.

Le paquet du 30 septembre 2026 a ete compile sur Ubuntu 24.04 x64 et demande glibc 2.39 minimum. Le controle de bureau utilise X11/XWayland et AT-SPI ; une session Wayland stricte doit etre validee separement.
