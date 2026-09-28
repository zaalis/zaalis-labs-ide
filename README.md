# zaalis labs IDE pour macOS

IDE local de zaalis labs avec le cœur agent Rust, un serveur Node.js local et une application Electron pour macOS. Cette branche reprend les fonctions communes de `main` et fournit les intégrations natives macOS : navigateur intégré, terminal, dictée, contrôle du bureau et mises à jour par DMG.

## Installer l'application

Téléchargez le DMG adapté à votre Mac depuis la [dernière version publiée](https://github.com/zaalis/zaalis-labs-ide/releases/latest) :

- `zaalis-macos-arm64.dmg` pour les Mac Apple Silicon ;
- `zaalis-macos-x64.dmg` pour les Mac Intel.

Ouvrez le DMG et glissez **zaalis IDE** dans Applications. Les données de l'application sont conservées dans `~/Library/Application Support/zaalis`.

## Démarrer depuis les sources

Prérequis : Node.js 22 ou plus récent et Rust 1.90 ou plus récent.

```sh
npm install
npm run build:cli
npm start
```

Ouvrez ensuite `http://localhost:3000`. Ce mode sert au développement de l'interface et du serveur ; les fonctions nécessitant le shell Electron demandent une application empaquetée.

## Reconstruire les applications macOS

Installez les outils de ligne de commande Xcode (`swiftc`, `codesign`, `hdiutil`) et les cibles Rust `aarch64-apple-darwin` et `x86_64-apple-darwin`, puis lancez :

```sh
npm install
npm run build:macos
```

Les résultats sont `native/installer/zaalis-macos-arm64.dmg` et `native/installer/zaalis-macos-x64.dmg`. La construction inclut le serveur, le CLI et l'agent Rust, le module natif du terminal, Electron, les assistants Swift et le navigateur intégré.

Le contrôle du bureau demande les autorisations **Accessibilité** et **Enregistrement de l'écran** dans Réglages Système › Confidentialité et sécurité. Pour conserver ces autorisations après une mise à jour, signez les versions distribuées avec la même identité de signature. Voir [README_MACOS.md](README_MACOS.md).

## Licence

Copyright © 2026 Bryan Boquel / zaalis. Tous droits réservés. Les conditions d'utilisation et de contribution figurent dans [LICENSE](LICENSE) et [NOTICE](NOTICE).
