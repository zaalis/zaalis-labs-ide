# Outils de l’IA, machines virtuelles et panneau VM — 10 novembre 2026

Travail réalisé en local à partir de `7188781` (identique à `origin/main`).
Rien n’est commité ni poussé.

## Cartographie

| Zone | Rôle | Fichiers |
|---|---|---|
| Serveur | Routes HTTP, ponts internes vers le cœur Rust (`/api/internal/rust-*`) | `src/app/server.js` |
| Cœur agent | Boucle d’agent, fournisseurs, outils, garde d’accès | `rust/crates/*` |
| Outil `computer` | Contrôle du bureau : capture, OCR, UI Automation, souris, clavier | `rust/crates/zaalis-extensions/src/computer.rs`, `src/runtime/automation-manager.js`, `src/runtime/windows-computer.js` |
| Outil `vm` | Machines Debian (QEMU + SSH) et Windows Sandbox (`wsb`) | `rust/crates/zaalis-extensions/src/vm.rs`, `src/laboratory/vm-manager.js` |
| Laboratoire | Hypothèses testées dans des VM jetables | `src/laboratory/laboratory.js` |
| Terminal | PTY persistant partagé par l’utilisateur et l’agent | `src/runtime/terminal-manager.js` |
| Interface | Panneau VM, réglages, feuilles de style | `interface/script/vm.js`, `interface/vm.css`, `interface/design-system.css` |

## Défauts trouvés et corrigés

| Défaut | Effet | Correction |
|---|---|---|
| `tar.exe` pris sur le PATH | Avec Git installé, GNU tar lit `C:` comme un hôte distant : l’import du projet dans une VM échouait (test rouge) | `tar.exe` de `System32` utilisé explicitement |
| Terminal : décalage dans un tampon plafonné | Après 512 Ko de sortie, chaque commande de l’agent attendait son délai complet (10 min) puis était déclarée expirée | Sortie de la commande collectée depuis les événements |
| Sonde des capacités à chaque rafraîchissement | Le panneau VM lançait PowerShell + CIM toutes les 2 s | Réponse partagée et gardée 60 s, invalidée après activation |
| Arrêt de VM fragile | Un `wsb list` en échec laissait QEMU, le pont et le battement actifs et la session « en arrêt » pour toujours | Chaque étape de libération s’exécute ; arrêts simultanés fusionnés |
| Arrêt normal signalé en erreur | « QEMU arrêté (null) » restait affiché après un arrêt demandé | La sortie demandée n’est plus une erreur |
| Disques jamais libérés | Chaque VM laissait son disque ; `reset` empilait les sessions | Action `delete`, `reset` libère l’ancienne, nettoyage au démarrage (dossiers orphelins, QEMU orphelin, exports de plus de 7 jours) |
| `reset` perdait l’environnement figé | Une VM issue d’un modèle repartait sur Debian nu | `templateId` conservé |
| Console Windows dupliquée | Une fois le tampon plein, toute la sortie était réécrite à chaque rafraîchissement | Compteur `outputEnd` ; seul le nouveau texte est ajouté |
| Sortie complète renvoyée toutes les 2 s | Jusqu’à 512 Ko par VM masqués et envoyés à chaque sondage | 128 Ko au plus pour l’interface |
| Activation refusée | Refus de l’UAC : message PowerShell brut ou `ENOENT` | Message clair |
| Outil `computer` muet sur les refus | L’IA recevait « computer HTTP 500 » sans la cause | La cause renvoyée par le pont est transmise |
| Délai du pont Windows | Le message contenait toute la ligne de commande PowerShell | Message court « timeout » |
| Journal d’automatisation sans limite | Les textes saisis s’accumulaient en mémoire pendant une longue tâche | 400 entrées au plus |
| Variables CSS inexistantes | Panneau VM, laboratoire, collaboration et skills gardaient des couleurs sombres en thème clair | Alias définis par apparence ; panneau VM réécrit sur les jetons communs |
| Panneau VM sans capacités | « Cannot read properties of undefined » | État « indisponible » affiché |

## Outil `vm` pour l’IA

- `status` accepte `waitMs` (30 s au plus) : l’IA attend la disponibilité en un appel.
- `exec` accepte `timeoutMs` (1 à 120 s).
- `delete` arrête si besoin et libère le disque.
- La description de l’outil précise l’enchaînement attendu et le comportement du délai sous Windows.

## Panneau VM

Onglets avec pastille d’état, choix du système par cartes (la raison d’une
indisponibilité est écrite sur la carte), réseau en sélecteur à deux positions,
pastille d’état, console arrondie aux couleurs du thème, champ intégré pour
récupérer un fichier (plus de boîte système), confirmation en place pour
« Repartir propre » et « Supprimer », messages dans le panneau. Sondage toutes
les 1,2 s pendant un démarrage ou un arrêt, 4 s sinon, suspendu quand le
panneau ou la fenêtre est masqué. Transitions de 180 à 220 ms, désactivées avec
« réduire les animations ».

## Vérification

- `npm test` : 214 réussis, 0 échec (209 auparavant dont 1 échec).
- `cargo test --workspace` : 494 réussis, 0 échec.
- `npm run check:mojibake` : aucun défaut.
- Compilation : cœur Rust, serveur, terminal, coque C++ ; `node test/package-smoke.js` réussi sur le serveur empaqueté.
- Panneau VM contrôlé dans le navigateur, thèmes sombre et clair, avec le serveur de fixtures et des données simulées ; parcours de tous les panneaux et rubriques de réglages sans erreur JavaScript.

## Non vérifié

Aucune VM réelle n’a été démarrée pendant cette session : le démarrage QEMU,
Windows Sandbox, le terminal SSH et le nettoyage d’un QEMU orphelin sont
couverts par des tests unitaires avec processus simulés, pas par un essai réel.
Le contrôle du bureau n’a pas été exercé sur le PC.

## Interface « que du chat » (suite, même jour)

La maquette est appliquée à la disposition Chat, qui devient la disposition par
défaut (un choix enregistré de l’éditeur est conservé).

- Le rail d’outils et les contrôles secondaires de la barre supérieure (version,
  langue, installation de modèles, aide, bascule Éditeur/Chat) sont remplacés
  par un seul bouton « Outils » : il liste les panneaux existants, l’éditeur de
  code, l’installation de modèles et l’aide. La disposition Éditeur est inchangée.
- Chat vide : salutation, champ de message et quatre points de départ réunis au
  centre (ouvrir un projet, tester dans une VM, tâche sur le PC, créer un document).
- Fichiers : `interface/script/chat-simple.js`, `interface/chat-simple.css`,
  valeur par défaut dans `interface/script/workspace.js`.

Contrôlé dans le navigateur avec le serveur de fixtures : ouverture d’un panneau
depuis le menu, points de départ, aller-retour avec l’éditeur, aucune erreur
JavaScript. Non contrôlé : fenêtre étroite (moins de 760 px) et thème clair de
ces nouveaux éléments.
