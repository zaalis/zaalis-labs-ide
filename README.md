# zaalis labs IDE

IDE local de zaalis labs avec interface web, serveur Node.js local et application native Windows via WebView2.

## Lancer avec l'installateur Windows

Telechargez puis lancez:

[zaalis-setup.exe](https://github.com/zaalis/zaalis-labs-ide/raw/main/native/installer/zaalis-setup.exe)

L'installateur ajoute l'application dans Windows et cree les raccourcis de lancement.

## Lancer manuellement

Prerequis: Node.js.

```bash
npm install
npm start
```

Ouvrez ensuite:

```text
http://localhost:3000
```

## Reconstruire l'application Windows

Prerequis:

- Node.js
- Visual Studio avec la charge C++ Desktop
- Inno Setup 6

```bat
native\build_server.bat
native\build_shell.bat
native\build_installer.bat
```

L'installateur genere se trouve ici:

```text
native\installer\zaalis-setup.exe
```
