# Consolidation des branches sur main — 6 octobre 2026

Le dépôt `zaalis/zaalis-labs-ide` utilise désormais une base commune pour Windows, Linux et macOS. La branche `main` conserve la coquille Windows et les fonctionnalités récentes : GitHub, accueil, profil des tokens, mémoire de corrections, laboratoire, artefacts, abonnements et terminal.

## Historiques réunis

| Branche auditée | Révision auditée | Intégration |
| --- | --- | --- |
| main initial | `0b4d469` | Base Windows |
| codex/github-welcome-token-profile | `0b4d469` et travaux locaux | Fonctionnalités récentes commités sur main |
| origin/macos | `1dd9b01` | Fusion `52d5a4a` |
| origin/linux | `baa0f5f` | Fusion `0a67222` |
| sync-macos | `23129dc` | Fusion `9bf6371` |

Les branches locales `linux` et `macos`, en retard sur les branches distantes, sont également couvertes par ces fusions. Leurs commits sont conservés dans l’historique. Les suppressions de la coquille Windows et des VM dans les variantes POSIX n’ont pas été appliquées à la base commune. Les anciens moteurs JavaScript et l’intégration Brain sont remplacés par le moteur Rust et ses contrôles actuels.

Les adaptations natives sont regroupées dans `platform-runtime.js`, les ponts Linux/Swift et les scripts de compilation dédiés. La coquille Electron conserve la persistance des cookies et les correctifs de capture macOS. Le paquet Linux inclut le daemon Rust et le terminal PTY. Les pipelines POSIX distribuent le client terminal complet, et le workflow macOS construit depuis `main`.

## Vérifications locales

- JavaScript : 117 tests, 116 réussis, aucun échec, un ignoré.
- Rust : 469 tests réussis, aucun échec, huit ignorés.
- Syntaxe JavaScript, encodage des sources et whitespace vérifiés.
- Scripts POSIX vérifiés avec `bash -n` dans Ubuntu/WSL.
- Serveur Windows compilé testé : interface, modèles, préférences, authentification, MCP, Blender et dictée.
- Agent réel sur serveur compilé : lecture autorisée, écritures/commande/artefact/push refusés pour le projet GitHub en lecture seule, même en mode autonome.
- Interface vérifiée dans Edge à cinq tailles de fenêtre, avec bannière, badges, modes du graphique et salutations selon l’heure.
- Serveur, Rust/CLI, client terminal et coquille Windows recompilés. L’installateur est une sortie générée locale, exclue de Git pour éviter la limite de taille de GitHub.

Les builds natifs Linux et macOS, ainsi que leurs interactions réelles sur ces systèmes, ne sont pas prouvés par les contrôles Windows. Le workflow macOS permet la validation sur un runner macOS après publication. Aucun déploiement de VM ni accès aux comptes utilisateur de production n’a été effectué.

## Conservation et publication

Un bundle Git complet de l’état avant consolidation est conservé localement dans `.tmp/main-consolidation-20261006-163541/branches.bundle`. Les correctifs ont été commités avant les fusions ; leur récupération ne dépend pas de la conservation des anciennes branches. Les fichiers locaux de `video-pub/` sont conservés hors du push des sources.

La suppression des branches secondaires intervient uniquement après vérification que leurs révisions sont incluses dans `main`, avec protection contre une modification distante concurrente. Aucun push forcé de `main` n’est nécessaire.
