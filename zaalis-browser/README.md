# Navigateur intégré (zaalis Browser)

Le panneau globe de zaalis IDE **est** zaalis Browser : son processus principal
(`app/main.js`) et ses pages (`app/interface/`) sont vendus ici tels quels depuis
le dépôt `zaalis web/zaalis Browser`. Aucune installation séparée n'est requise.

```
native/browser/BrowserHost.cpp   vues WebView2 (onglets, barre, panneaux), schéma zaalis://,
          ▲  tube nommé privé     téléchargements, autorisations, menus, protocole DevTools
          ▼  (JSON par ligne)
zaalis-browser/host.js           canal + démarrage + API pour l'IDE (open, search, outils agent)
zaalis-browser/electron-shim.js  surface Electron utilisée par main.js, sur WebView2
zaalis-browser/app/              zaalis Browser vendu (main.js légèrement adapté)
```

- Le shell natif crée le tube (ACL utilisateur courant + SYSTEM) avant de lancer
  `zaalis-server.exe` et lui transmet son nom et un jeton à usage unique.
- Le navigateur démarre à la première ouverture du panneau globe ou à la première
  recherche demandée par l'IDE.
- Données : `%APPDATA%\zaalis\Browser` (importées une fois depuis
  `%APPDATA%\zaalis browser` si ce dossier existe ; il n'est jamais modifié).
- `/search`, `/deep-search`, les liens des réponses et l'outil `browser` de
  l'agent utilisent ce navigateur. Un navigateur externe (celui par défaut du PC)
  ne s'ouvre que sur demande explicite (`/search --externe`, `open_external`).

## Mettre à jour vers la dernière version de zaalis Browser

```
npm run sync:browser
```

Le script copie la copie de travail du dépôt source (modifications non commitées
comprises), applique les adaptations vérifiées une par une et écrit
`app/UPSTREAM.json` (commit, date, empreintes). Si le code amont a bougé au point
qu'un patch ne s'applique plus, le script s'arrête au lieu de livrer un navigateur
à moitié adapté.
