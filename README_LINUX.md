# zaalis IDE for Linux

The Linux x64 Electron application bundles the shared Rust agent (`zaalis-agentd`).

Build on Linux with `sh native/build_linux.sh`, or from Windows through WSL with `native\build_linux.bat`. Prerequisites: Node.js 22+, Rust 1.90+, `dpkg-deb`, `tar`, `curl`, CMake, and a C/C++ compiler.

The build produces `native/installer/zaalis-linux-x64.deb` and `native/installer/zaalis-linux-x64.tar.gz`. Install the `.deb` with your distribution's software application or `sudo apt install ./zaalis-linux-x64.deb`. After installation, run `zaalis`, `zaalis ide`, or `zaalis-ide`. The desktop app bundles Chromium; it does not require a separate Chrome, Chromium, Edge, or Brave installation.

For a portable installation:

```sh
mkdir -p zaalis-linux
tar -xzf zaalis-linux-x64.tar.gz -C zaalis-linux
cd zaalis-linux
chmod +x zaalis-ide resources/app/bundle/zaalis-server resources/app/bundle/zaalis-agentd resources/app/bundle/bin/zaalis
./zaalis-ide
```

The CLI is `./resources/app/bundle/bin/zaalis`; pass a prompt as an argument for a noninteractive request.

The `.deb` declares desktop control dependencies for PTY, capture, OCR, and X11 input: `xdotool`, `gnome-screenshot`, `tesseract-ocr`, `python3-pyatspi`, `gir1.2-gtk-3.0`, and `zenity`. Desktop input injection uses X11; use an Xorg session for full desktop control under Wayland.

Like the Windows installer, the package ships the WhatsApp bridge (with its Node runtime), the official GitHub client `gh` for browser sign-in, and `cloudflared` for remote access. The `.deb` also recommends `git`, `espeak-ng` (local agent speech), `ffmpeg` (video analysis), `qemu-system-x86`, `qemu-utils`, and `openssh-client` (virtual machines).

Debian VMs use QEMU with KVM. **Enable Linux components** in the Virtual machines settings installs missing packages through `pkexec`, adds the user to the `kvm` group (log out and back in), and downloads the official Debian 12 image, verified by SHA-512, to `~/.local/share/zaalis/server-data/virtual-machines/images`. Windows Sandbox remains Windows-only.

GGUF models use llama.cpp, downloaded on demand to `~/.local/share/zaalis/engine`. The runtime selects ROCm for AMD when installed, then Vulkan for supported GPUs, then CPU. A Windows CUDA setting falls back to Vulkan because llama.cpp does not provide that Linux CUDA binary. The package built on Ubuntu 24.04 x64 on September 30, 2026 required glibc 2.39 or newer; strict Wayland behavior needs separate validation.
