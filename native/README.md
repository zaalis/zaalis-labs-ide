# zaalis IDE - application native Windows (C++ + WebView2)

Coquille C++ qui demarre l'adaptateur HTTP Node embarque en arriere-plan, affiche l'interface dans une fenetre WebView2 et arrete le serveur automatiquement a la fermeture. Chat, Agents et le CLI utilisent le meme core Rust via `zaalis-agentd`.

```text
[zaalis.exe] -> [zaalis-server.exe, port 3000] -> [zaalis-agentd.exe] -> providers/outils Rust
                                      `-> interface WebView2
```

## Lancer l'app native

Double-clic sur:

```text
native\dist\zaalis.exe
```

Le dossier `native\dist\` est genere par les scripts de build et contient:

- `zaalis.exe`
- `zaalis-server.exe`
- `zaalis-agentd.exe`
- `zaalis-cli.exe` (installe sous `bin\zaalis.exe`)
- `pickfolder.exe`
- `interface\`

Le dossier `server-data\` est cree automatiquement au premier lancement pour les comptes, sessions et historiques locaux.

## Reconstruire

Prerequis:

- Node.js
- Rust 1.90 ou plus recent
- Visual Studio avec la charge C++ Desktop
- Inno Setup 6 pour l'installateur

```bat
native\build_server.bat
native\build_cli.bat
native\build_shell.bat
native\build_installer.bat
```

Resultat installateur:

```text
native\installer\zaalis-setup.exe
```

## Details techniques

- `server.js` sert les fichiers depuis `interface\`.
- `native\main.cpp` lance `zaalis-server.exe` et ouvre `http://localhost:3000`.
- `native\installer.iss` copie la GUI, l'adaptateur serveur, `zaalis-agentd.exe`, le CLI Rust, `pickfolder.exe` et le dossier `interface\`.
