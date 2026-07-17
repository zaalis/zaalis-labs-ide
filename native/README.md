# zaalis IDE - Linux Electron package

This Linux copy ships as a local Electron desktop app with its own Chromium
runtime, the zaalis local server, and the zaalis CLI. The Debian installer can
be opened with the system software installer on common Debian/Ubuntu desktops.

Build:

```bat
native\build_linux.bat
```

Outputs:

```text
native\installer\zaalis-linux-x64.tar.gz
native\installer\zaalis-linux-x64.deb
```

The `.deb` installs the app under `/opt/zaalis-ide`, adds a desktop launcher,
and exposes `zaalis` plus `zaalis-ide` in the terminal. The graphical IDE is
now a real Electron application and does not require Chrome, Chromium, Edge, or
Brave to be installed separately.
Windows installer files are intentionally not kept in this Linux package folder.

The package also bundles the Linux `node-pty` addon used by the integrated
terminal and declares the AT-SPI, screenshot, OCR, keyboard and pointer tools
used by the opt-in desktop-control feature.
