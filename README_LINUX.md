# zaalis IDE Linux

Package Electron Linux x64 autonome.

Build depuis Windows:

```bat
native\build_linux.bat
```

Sortie:

```text
native\installer\zaalis-linux-x64.tar.gz
native\installer\zaalis-linux-x64.deb
```

Installation sur Linux:

Double-cliquez sur `zaalis-linux-x64.deb`, puis installez avec l'application
logiciels de votre distribution.

Apres installation:

```sh
zaalis
zaalis ide
zaalis-ide
```

Le raccourci `zaalis IDE` ouvre une vraie application Electron locale avec
Chromium embarque. Chrome, Chromium, Edge ou Brave ne sont pas requis.

Lancement portable:

```sh
mkdir -p zaalis-linux
tar -xzf zaalis-linux-x64.tar.gz -C zaalis-linux
cd zaalis-linux
chmod +x zaalis-ide resources/app/bundle/zaalis-server resources/app/bundle/bin/zaalis
./zaalis-ide
```

CLI:

```sh
./resources/app/bundle/bin/zaalis
./resources/app/bundle/bin/zaalis "analyse le dossier"
```
