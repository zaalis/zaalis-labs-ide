# zaalis labs IDE

IDE local de zaalis labs avec interface web, serveur Node.js local et application native Windows via WebView2.

## Telechargement

- [Telecharger l'installateur Windows `zaalis-setup.exe`](https://github.com/zaalis/zaalis-labs-ide/raw/main/native/installer/zaalis-setup.exe)

## Lancer en developpement

Prerequis: Node.js.

```bash
npm install
npm start
```

L'application demarre sur:

```text
http://localhost:3000
```

## Generer l'application Windows

Prerequis:

- Node.js
- Visual Studio avec la charge C++ Desktop
- Inno Setup 6 pour l'installateur

```bat
native\build_server.bat
native\build_shell.bat
native\build_installer.bat
```

Resultats generes:

- `native\dist\zaalis.exe`
- `native\dist\zaalis-server.exe`
- `native\installer\zaalis-setup.exe`

## Fichiers non versionnes

Les donnees locales et sensibles ne sont pas poussees dans Git:

- `server-data/`
- comptes, secrets de session et historiques de chats
- `node_modules/`
- builds `native/dist/`
- fichiers `.env`

Le depot contient le code source, les assets utiles, les scripts de build et l'installateur public `native/installer/zaalis-setup.exe`.
