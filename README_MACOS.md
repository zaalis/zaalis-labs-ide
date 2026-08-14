# zaalis IDE macOS

Application Electron macOS, en x64 (Intel) et arm64 (Apple Silicon), avec le
coeur agent Rust `zaalis-agentd` embarque dans le bundle.

Build sur un Mac :

```sh
sh native/build_macos_dmg.sh
```

Prerequis : Node.js 22+, Rust 1.90+ (cibles `aarch64-apple-darwin` et
`x86_64-apple-darwin`), les outils en ligne de commande Xcode (`swiftc`,
`codesign`, `hdiutil`).

Sorties :

```text
native/installer/zaalis-macos-arm64.dmg
native/installer/zaalis-macos-x64.dmg
```

Installation sur macOS :

Ouvrez le `.dmg` correspondant a votre Mac, puis glissez `zaalis IDE` dans le
dossier Applications.

CLI :

Le paquet installe le binaire Rust `zaalis` dans le bundle. Depuis une
installation portable :

```sh
./zaalis\ IDE.app/Contents/Resources/app/bundle/bin/zaalis
./zaalis\ IDE.app/Contents/Resources/app/bundle/bin/zaalis "analyse le dossier"
```

Controle du bureau :

La premiere activation demande deux autorisations dans Reglages Systeme >
Confidentialite et securite : **Accessibilite** et **Enregistrement de l'ecran**.
Elles sont accordees au bundle signe. Definissez `ZAALIS_CODESIGN_ID` sur une
identite de signature persistante : une signature ad-hoc change d'empreinte a
chaque build et revoque silencieusement ces deux autorisations.

Modeles locaux :

Les modeles GGUF passent par llama.cpp, telecharge a la demande dans
`~/Library/Application Support/zaalis/engine`. Le binaire macOS embarque Metal :
la variante `metal` utilise le GPU, la variante `cpu` force le calcul processeur
(`-ngl 0`) et sert de repli automatique quand un modele ne tient pas en memoire
unifiee.
