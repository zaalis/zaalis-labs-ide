# Menus, recherche web et modèles — 19 novembre 2026

## 1. Sélecteurs de modèle et de réflexion

La pastille du modèle et celle du fournisseur basculent désormais leur menu explicitement : un clic sur une pastille ouverte la referme toujours, quel que soit le choix fait juste avant. Choisir un niveau de réflexion ferme le menu, comme le choix d’un modèle. Après un changement de fournisseur, la liste de ses modèles s’ouvre ; un clic sur la pastille du fournisseur la referme au lieu d’empiler un second menu.

La fermeture au clic extérieur passe par `pointerdown` et le chemin composé de l’événement. Avant, elle reposait sur `click` : la liste étant reconstruite au moment du choix, la cible pouvait être détachée du document et passer pour un clic extérieur. Ce comportement dépendait de l’ordre des rendus.

Dans le panneau IA étroit de l’éditeur, le menu débordait à gauche et était coupé. Il est maintenant recadré dans le panneau.

Fichier : `interface/script/model-picker.js`.

## 2. Recherche web en arrière-plan

L’action `search` de l’outil `browser` n’ouvre plus d’onglet visible et ne bascule plus l’écran vers le navigateur. Le serveur interroge le moteur en arrière-plan et garde les **3 pages les plus pertinentes**. Le classement suit l’ordre du moteur, corrigé par la présence des mots de la requête dans le titre et l’extrait. Il garde une page par site, et les publicités comme les pages internes du moteur sont exclues.

Dans le fil de la conversation, ces pages s’affichent sous forme de cartes : favicon, titre et domaine. Un clic ouvre la page dans le navigateur intégré. Le clic droit propose **Ouvrir dans le navigateur intégré**, **Ouvrir dans le navigateur externe** et **Copier le lien**. Ce menu fonctionne sur tous les liens du chat. Les mêmes cartes résument aussi `web_search` et `deep_search`. Les conversations enregistrées les conservent.

Le modèle reçoit les 3 liens avec leur extrait. Il peut ensuite lire une page avec `web_fetch` ou `browser open`.

Fichiers : `src/app/server.js` (`backgroundWebSearch`), `src/services/search-ranking.js`, `interface/script/timeline.js`, `interface/timeline.css`, `interface/script/ai.js`, `interface/script/action-menu.js`, `rust/crates/zaalis-extensions/src/browser.rs`.

## 3. Erreurs claires et journal des erreurs

- Les messages destinés à l’utilisateur disent ce qui s’est passé et quoi faire. Exemples : recherche vide, moteur injoignable, délai dépassé, aucun résultat, mode hors ligne, navigateur intégré indisponible, lien non ouvert, copie refusée. L’outil Rust ne préfixe plus ces messages par `browser HTTP 500 :`.
- La cause technique est écrite dans le **journal des erreurs de l’IDE** : `<données>/logs/ide-errors.log`, au format d’un objet JSON par ligne. Chaque entrée contient la date, la source, un code stable, le message affiché et le détail technique. Le fichier tourne à 1 Mo et la génération précédente est conservée.
- Les jetons, clés API et identifiants présents dans les URL sont masqués avant écriture.
- `GET /api/error-log` liste les dernières entrées. `POST /api/error-log` permet à l’interface d’y consigner ses propres échecs.
- Dans le shell Electron (Linux et macOS), l’écriture dans le presse-papiers était refusée par le gestionnaire de permissions. Elle est désormais autorisée pour l’IDE, et la lecture reste refusée. Une copie par sélection prend le relais si l’API asynchrone échoue.

Fichiers : `src/services/error-journal.js`, `native/electron/main.js`.

## 4. Modèles mis à jour

Sources officielles consultées le 19 novembre 2026 :

| Fournisseur | Source | Changement |
|---|---|---|
| OpenAI | [developers.openai.com/api/docs/models](https://developers.openai.com/api/docs/models) | Ajout de **GPT-6.2 Astra** (`gpt-6.2-astra`) et de **GPT-6.2 Sol** (`gpt-6.2-sol`), avec 1,05 M de tokens de contexte. GPT-6.2 Astra devient le modèle par défaut. |
| Anthropic | Référence officielle de l’API Claude (liste du 3 novembre 2026) | Ajout de **Claude Fable 5.1** (`claude-fable-5-1`) et de **Claude Opus 5** (`claude-opus-5`), qui manquaient. Fable 5.2, Opus 5.5, Sonnet 5.5 et Haiku 5.5 restent en tête de liste. |
| Google | [Journal des modifications de l’API Gemini](https://aistudio.google.com/docs/changelog) | Ajout de **Gemini 4 Neon** (GA le 18 novembre, 1 M de contexte), **Gemini 4 Carbon**, **Gemini 4 Argon**, **Gemini 4 Hydrogen** et **Gemini 3.8 Flash**. Retrait de la liste de Gemini 3.5 Flash (déprécié le 8 octobre) et des modèles 2.5 (dépréciés le 2 novembre, redirigés le 1er décembre). Les niveaux de réflexion sont activés pour Gemini 4. |
| xAI | [docs.x.ai/docs/models](https://docs.x.ai/docs/models) | Grok 4.7 reste le modèle phare. `grok-imagine-image-2.0` remplace `grok-imagine-image-quality`, absent de la documentation. |
| Mistral | [Changelog Mistral](https://docs.mistral.ai/resources/changelogs) | Ajout de **Mistral Large 4** (`mistral-large-4`, 1 M de contexte). L’alias `mistral-large-latest` est désormais affiché « Mistral Large (latest) » au lieu de « Large 3 ». |
| Moonshot | [platform.kimi.ai](https://platform.kimi.ai/docs/introduction) | Kimi K3.1 Pro était déjà présent. Aucun changement. |

Toutes les copies des listes ont été alignées : interface, mobile, CLI, catalogue serveur, abonnements ChatGPT, fournisseurs compatibles, messageries, catalogue du navigateur et valeurs par défaut Rust.

Non retenu, faute de source officielle : le retrait de `gpt-4` de l’API, qui n’apparaît que sur Wikipédia. GPT-6 Cyber est à accès restreint et n’a pas d’identifiant public.

## 5. Vérifications

- `npm test` : 254 tests, 252 réussis, 2 ignorés, 0 échec. Le nouveau fichier `test/search-links.test.js` couvre le classement des liens, le journal et le masquage des secrets.
- `cargo test -p zaalis-extensions -p zaalis-providers` : 98 tests réussis.
- Vérifications dans l’interface (instance de développement isolée) :
  - ouverture et fermeture des menus par la pastille, après un choix de modèle, de réflexion ou de fournisseur ;
  - menu recadré dans le panneau étroit ;
  - cartes des 3 liens, menu du clic droit et copie du lien ;
  - écriture dans le journal ;
  - nouvelles listes de modèles et niveaux de réflexion de Gemini 4.
- Recompilation :
  - `npm run build:rust` : workspace Rust en release (55 s), `zaalis-agentd.exe` et `zaalis-cli.exe` copiés dans `native/dist` ;
  - `npm run build:server` : `native/dist/zaalis-server.exe` régénéré, avec uniquement les avertissements pkg déjà connus ;
  - `native/dist/interface` resynchronisé, comme le fait `build_shell.bat`.
- Test de fumée : l’exécutable démarre et sert la nouvelle interface (cartes de liens, GPT-6.2). `/api/error-log` exige bien une session.
- L’application installée (`AppData\Local\Programs\zaalis`) n’a pas été remplacée : il faut générer puis exécuter l’installateur pour en profiter.

Limite : le blocage décrit (menu qui ne se referme pas) n’a pas pu être reproduit à l’identique dans la build de développement. La logique a été rendue déterministe pour tous les cas testés. À confirmer dans l’application installée après mise à jour.
