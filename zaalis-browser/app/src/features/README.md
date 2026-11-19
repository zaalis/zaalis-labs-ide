# Modules de fonctionnalités

Chaque fonctionnalité « façon Chrome » vit dans `src/features/<nom>.js`, est
listée dans `src/features/index.js` et exporte `init(ctx)`. La valeur renvoyée
par `init` est l'API publique du module (`ctx.module('<nom>')`).

## Contexte `ctx` (défini dans main.js, section « Modules de fonctionnalités »)

| Membre | Rôle |
| --- | --- |
| `app, electron, fs, path, os, crypto, SEP` | modules de base |
| `mainWin, chromeView, panelView, tabs, dataFolder, settings, bookmarks, history` | état du navigateur (getters) |
| `activeTab(), tabById(id), tabOfWebContents(wc)` | onglets (`{ id, view, incognito, pinned, … }`) |
| `createTab(url, activate, opts), closeTab(id), selectTab(id), navigateActive(u), openInternal(page)` | navigation |
| `pushState(), pushPanelState(), layoutAll(), raiseOverlays()` | rafraîchir l'interface |
| `sendChrome(msg), sendPanel(msg), toast(text), reply(event, msg)` | messages vers l'interface |
| `action(name, fn(args, event), { pages:['x.html'|'*'], views:['nom'] })` | action du bus `zaalis:postMessage` |
| `rpc(name, async fn(params, event), opts)` | requête/réponse pour les pages (`zx.call`) |
| `on('session'\|'tabCreated'\|'tabClosed'\|'tabActivated'\|'ready'\|'quit', fn)` | hooks |
| `state('chrome'\|'panel', fn)`, `tabState(fn(tab))` | champs ajoutés aux messages `state` |
| `page(kind, async fn(payload, { tab, wc, frame, frameUrl, origin, isMainFrame }))` | canal `ipcRenderer.invoke('zaalis:page', { kind, … })` des scripts de contenu |
| `alias(host, 'page.html')` | `zaalis://host` / `chrome://host` → page interne |
| `trustView(wc, nom)` | autorise une vue annexe (popup) à émettre les actions déclarées `views:[nom]` |
| `readJson(file, fallback, sealed)`, `writeJson(file, data, sealed)`, `sealWrite/sealRead`, `profileDataDir()` | persistance (sealed = chiffré `safeStorage`) |

Les actions venant du chrome (`chrome.html`), du panneau et du panneau IA sont
toujours acceptées ; celles des onglets uniquement depuis les pages internes
listées dans `pages`.

## Pages internes

`interface/<page>.html` chargées dans un onglet, avec `zx.css` / `zx.js`
(kit commun : `zx.call`, `zx.post`, `zx.on`, `zx.dialog`, `zx.toast`…).
Ajouter une ligne `data-internal="<page>"` dans le groupe « Outils » de
`panel.html` pour l'ouvrir depuis les paramètres.

## Tests

`tests/e2e/<nom>.test.js` exporte `async (t, ctx, env)` ; `env.modules` donne
les API des modules. `npm run e2e [nom]` lance chaque suite dans une instance
Electron au profil jetable. `npm test` vérifie la syntaxe de tout le projet.

## Cœur (src/core)

Blocs extraits de main.js : `page-scripts.js` (scripts injectés), `ai-catalog.js`,
`net-errors.js`, `search-parse.js` (sans dépendance), `agent.js` et
`agent-selftest.js` (dépendances injectées par main.js via des accesseurs `M`).
