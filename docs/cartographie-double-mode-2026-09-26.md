# Cartographie de zaalis IDE et faisabilité du double mode

Date : 26 septembre 2026. Analyse statique du dépôt `D:\connexion ide`, du code de zaalis browser dans `D:\zaalis web\ZaalisBrowser` et de la copie locale de Hermes Agent indiquée par Bryan. Aucun changement applicatif ni essai d'intégration n'a été effectué.

## Réponse courte

Oui, les deux modes sont réalisables avec le socle actuel. Le mode **Éditeur** peut conserver fichiers/code au centre et chat à droite, avec une interface allégée. Le mode **Chat IDE** peut placer le chat au centre, les projets et conversations à gauche, et des panneaux ouvrables à droite (fichiers, aperçu, navigateur, terminal, autre chat). Le moteur d'agents, les modèles et l'historique doivent rester communs aux deux modes : seule la disposition change.

L'intégration de **zaalis browser dans la même fenêtre** est également réalisable, mais nécessite une modification native des deux projets. L'IDE est une fenêtre Win32 avec un WebView2 ; le navigateur est aussi une fenêtre Win32 avec plusieurs WebView2. Aujourd'hui le pont HTTP ouvre le navigateur externe. Pour un véritable panneau à droite, le navigateur doit pouvoir créer et piloter ses contrôles WebView2 dans une zone hôte de l'IDE, ou partager une couche navigateur réutilisable. Encastrer l'exécutable tel quel serait fragile.

## Existant confirmé dans zaalis IDE

| Domaine | Composants trouvés | État réel |
| --- | --- | --- |
| Fenêtre et disposition | `native/main.cpp`, `interface/index.html`, `interface/app.css` | Fenêtre Win32/WebView2 unique ; barre latérale projets/conversations/fichiers, éditeur central, chat/agents à droite, séparateurs. Pas de commutateur entre deux dispositions. |
| Projets et chats | `interface/script/ui.js`, `interface/script/ai.js`, `/api/chats`, `/api/history` | Conversations associées à un chemin de projet, projet sans conversation, historique et synchronisation. Une partie de l'historique est encore affichée dans le panneau de chat ; la hiérarchie globale façon capture n'est pas complète. |
| Modèles locaux | `server.js`, `model-catalog.js`, `interface/script/main.js`, `rust/crates/zaalis-providers` | Ollama et moteur GGUF/llama.cpp ; liste, téléchargement, choix de quantification, chargement et déchargement, contexte et couches GPU. À consolider en un catalogue de capacités et d'états fiable par modèle. |
| Raisonnement | `interface/script/ai.js`, `rust/crates/zaalis-core/src/model.rs`, adaptateurs `zaalis-providers` | Sélecteur de niveaux, flux de raisonnement et blocs repliables. Les niveaux UI, Rust et chaque fournisseur ont des vocabulaires différents ; la détection UI des modèles locaux repose notamment sur `r1`, donc elle peut masquer des modèles raisonnants. |
| Agents | `rust/crates/zaalis-agent/src/spawn.rs`, `session.rs`, `interface/script/ai.js` | Outil natif `spawn_agent`, héritage du modèle et des droits, limite de profondeur, espace isolé, fusion contrôlée ; écran « Agents » avec équipe choisie manuellement. L'outil natif attend le rapport de l'enfant : pas de file de sous-agents en arrière-plan avec reprise et suivi comparable à Hermes. |
| Outils | `rust/crates/zaalis-tools`, `server.js`, `mcp-registry.js` | Lecture/écriture de fichiers, exécution, Git, tâches, checkpoints, MCP et contrôles de permissions. L'interface ne présente pas encore une surface unifiée pour gérer outils, compétences et autorisations par projet. |
| Terminal | `terminal-manager.js`, `/api/terminal/sessions`, `interface/script/ai.js` | PTY persistant et panneau inférieur ; à rendre dockable/onglet à droite dans le mode Chat IDE, avec plusieurs sessions visibles. |
| Navigateur | `server.js` `/api/browser-open`, `/api/browser-search` | Lancement et commande de zaalis browser externe via son API locale. Aucun navigateur intégré à l'IDE aujourd'hui. |
| Artefacts | `interface/script/ai.js` | Cartes de fichiers, diffs, image et visionneuse. Pas d'index durable des fichiers/liens/images produits par conversation, ni de panneau d'artefacts avec aperçu et ouverture. |
| Code et revue | `interface/script/ui.js`, `/api/file`, `/api/gitdiff` | Arbre de fichiers, éditeur simple, sauvegarde, revue et diffs. Pour viser un confort proche de VS Code, il faut encore des fonctions d'éditeur plus riches ; cela n'est pas nécessaire au mode Chat IDE initial. |
| Fonctions transversales | `interface/index.html`, `interface/script/ai.js`, `server.js` | Pièces jointes, dictée, recherche Web via le navigateur, recherche approfondie, accès distant mobile et automatisation du PC sont déjà amorcés. Leur commande doit rester accessible dans les deux dispositions. |

## Composants intéressants dans Hermes

Hermes est une **référence et un réservoir de code possible**, pas une dépendance déjà branchée à zaalis. Sa copie locale contient notamment :

| Besoin | Référence Hermes | Ce qu'il faudrait adapter |
| --- | --- | --- |
| Modèles locaux | `apps/desktop/src/api/local-models.ts`, backend local Hermes | Gestion du matériel, installation du runtime, recherche, transferts avec pause/reprise, activation ; garder le moteur zaalis actuel et emprunter les parcours utiles. |
| Raisonnement | `agent/reasoning_effort.py`, profils dans `providers/base.py` | Capacités déclarées par modèle et traduction par fournisseur, plutôt que chaînes de noms codées en dur dans l'UI. |
| Sous-agents | `tools/delegate_tool.py` et modules associés | Délégation de fond, limite de concurrence, suivi, interruption, résultat différé. À intégrer au protocole d'événements Rust, sans remplacer l'isolation déjà présente. |
| Artefacts | `apps/desktop/src/app/artifacts/` | Index par conversation des fichiers, images et liens ; filtres, aperçu, ouverture. |
| Panneaux | `apps/desktop/src/app/right-sidebar/` | Idées de gestion des onglets navigateur, fichiers et terminaux, sans copier toute l'application Electron. |
| Extensions | `tools/mcp_tool_*`, `tools/skills_*`, `plugins/` | Registre d'outils et de compétences, découverte et activation par périmètre. zaalis dispose déjà d'un début MCP. |
| Mémoire et planification | `agent/`, `cron/`, documentation Hermes | À envisager dans une phase ultérieure ; ce n'est pas un prérequis pour le double mode. |

Hermes est sous licence MIT (`LICENSE`) ; la réutilisation de morceaux substantiels demande de conserver l'avis de licence et de vérifier leurs dépendances. Ses fichiers `AGENTS.md` ont été lus comme documentation du projet, pas comme consignes de modification de zaalis.

## Architecture proposée

1. Ajouter un état de disposition `editor | chat_ide` persistant par utilisateur, distinct des modes de permission et du choix Chat/Agents.
2. Conserver un seul identifiant de conversation, un seul flux d'événements de l'agent et un seul état de projet. Changer de disposition ne doit ni recréer la session ni effacer les messages.
3. Rendre la barre de gauche commune : sections Projets → conversations et Fichiers, repliables et redimensionnables ; conserver un espace « sans projet ».
4. En mode Éditeur : éditeur central, chat latéral réduit aux commandes utiles, terminal en bas si demandé.
5. En mode Chat IDE : chat central et lisible, composeur ancré en bas ; rail droit avec onglets `Fichiers`, `Navigateur`, `Terminal`, `Artefacts`, éventuellement `Autre chat`. Chaque panneau peut s'ouvrir, se fermer et se redimensionner.
6. Définir les artefacts comme données de conversation (`type`, `chemin/URL`, `titre`, `projet`, `conversation`, `création`, `provenance`) et les produire depuis les événements d'outils, plutôt que d'analyser seulement le texte de la réponse.
7. Créer une table de capacités des modèles : raisonnement contrôlable ou natif, outils, vision, longueur de contexte, format de sortie, disponibilité du moteur. Le sélecteur affiche uniquement les options réellement prises en charge.
8. Pour les sous-agents demandés par l'utilisateur : garder `spawn_agent`/`merge_agent`, ajouter progression visible, arrêt, limite de concurrence et résultats consultables ; distinguer équipe préparée dans l'UI et délégation déclenchée pendant un chat.
9. Extraire du navigateur un composant hôte réutilisable ou un protocole de contrôle plus complet. Le panneau natif WebView2 doit gérer ses onglets, le profil, les favoris, les téléchargements, les raccourcis et la fermeture. Le pont HTTP existant peut continuer à ouvrir des liens dans la fenêtre externe pendant la migration.

## Points de vigilance et ordre de travail

- **Navigateur** : le code de `D:\zaalis web\ZaalisBrowser\main.cpp` possède un environnement WebView2 et plusieurs contrôleurs liés à sa fenêtre propre. La portabilité de ces contrôles et le partage du profil doivent être prototypés avant de promettre une intégration complète. Une simple iframe ne donnerait pas toutes les fonctions du navigateur et certains sites refusent l'encadrement.
- **Appui technique** : [Microsoft décrit l'hébergement de plusieurs contrôles WebView2 par un environnement partagé](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis) et [la gestion de leur dossier de données](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder). Cela étaye la faisabilité du panneau natif, sans démontrer que le code zaalis actuel peut être déplacé sans refonte.
- **Deux interfaces, un moteur** : l'UI WebView2 actuelle est en HTML/CSS/JavaScript, Hermes Desktop en Electron/React. Copier son panneau entier créerait deux systèmes d'état. Reprendre les comportements et les contrats de données est moins risqué.
- **Agents locaux** : plusieurs sous-agents sur un seul GPU ou un moteur qui ne garde qu'un modèle en mémoire peuvent se ralentir mutuellement. Prévoir une file d'exécution et un indicateur de charge.
- **Historique** : la bascule de mode et le panneau « autre chat » exigent que les conversations soient indexées par identifiant stable, projet et état de session ; vérifier la persistance et la reprise avant la refonte visuelle.

Ordre conseillé : **(1)** modèle de disposition + barre latérale commune ; **(2)** mode Chat IDE et rail droit avec fichiers/terminal ; **(3)** index d'artefacts et capacités des modèles ; **(4)** suivi des sous-agents ; **(5)** prototype natif du navigateur, puis intégration complète. Le prototype navigateur est le principal point d'incertitude technique.
