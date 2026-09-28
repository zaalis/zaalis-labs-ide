# Paquets natifs macOS

`npm run build:macos` lance `native/build_macos_dmg.sh` et produit un DMG pour chaque architecture :

```text
native/installer/zaalis-macos-arm64.dmg
native/installer/zaalis-macos-x64.dmg
```

Chaque image contient `zaalis IDE.app`, son serveur et son cœur Rust, Electron, le navigateur intégré et les assistants Swift. L'application est signée après assemblage. Définissez `MACOS_CODESIGN_IDENTITY` et `ZAALIS_CODESIGN_ID` sur la même identité durable pour une distribution ; sans cela, la construction locale utilise une signature ad hoc.

Voir [README_MACOS.md](../README_MACOS.md) pour les prérequis, l'installation et les autorisations système.
