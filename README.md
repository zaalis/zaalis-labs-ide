# zaalis IDE Linux

Application Electron Linux x64 autonome avec serveur local, CLI, terminal PTY
et contrôle du poste Linux optionnel.

## Construire depuis Windows

```bat
native\build_linux.bat
```

Sorties :

```text
native\installer\zaalis-linux-x64.tar.gz
native\installer\zaalis-linux-x64.deb
```

## Installer et lancer

Double-cliquez sur `zaalis-linux-x64.deb`, puis installez-le avec l'application
logiciels de votre distribution. Le paquet expose ensuite :

```sh
zaalis
zaalis ide
zaalis-ide
```

Le raccourci `zaalis IDE` ouvre Chromium embarqué ; aucun navigateur externe
n'est requis. Le `.deb` installe aussi les composants AT-SPI, capture/OCR,
clavier/souris et terminal PTY nécessaires aux fonctions correspondantes.

## Licence et copyright

Copyright © 2026 Bryan Boquel / zaalis. Tous droits réservés.

zaalis Labs IDE appartient à Bryan Boquel / zaalis. Les droits d'utilisation,
de modification, de contribution, de redistribution, d'usage commercial et de
marque sont régis par [LICENSE](LICENSE) et [NOTICE](NOTICE).

Aucun droit de propriété n'est transféré par l'accès, le clonage,
l'utilisation, la modification ou la contribution à ce dépôt.
