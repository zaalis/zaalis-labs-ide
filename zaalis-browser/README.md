# Navigateur intégré (zaalis Browser)

Le panneau navigateur de zaalis IDE utilise la copie de zaalis Browser située dans `app/`. Aucune installation distincte n'est nécessaire.

```text
native/electron/browser-bridge.js   vues Chromium Electron, permissions, téléchargements
              ↕ socket Unix privée + jeton, JSON par ligne
zaalis-browser/host.js             démarrage et API du navigateur dans le serveur IDE
zaalis-browser/electron-shim.js    compatibilité Electron pour app/main.js
zaalis-browser/app/                code et pages du navigateur intégré
```

Le shell Electron crée la socket avec des permissions `0600` avant de démarrer le serveur, puis lui transmet son chemin et un jeton de session. Le navigateur démarre à la première ouverture du panneau ou à la première recherche demandée par l'IDE.

Les données résident dans `~/Library/Application Support/zaalis/Browser`. Lors du premier démarrage, les données de `~/Library/Application Support/zaalis browser` peuvent être copiées ; le dossier d'origine reste intact. Les recherches, les liens des réponses et l'outil `browser` de l'agent utilisent ce navigateur. L'ouverture dans le navigateur externe reste disponible sur demande explicite.

Pour synchroniser la copie du navigateur depuis son dépôt source :

```sh
npm run sync:browser
```

Le script enregistre la révision et les empreintes des fichiers dans `app/UPSTREAM.json`.
