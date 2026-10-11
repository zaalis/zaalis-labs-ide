# Zaalis — corrections et recompilation du 8 octobre 2026

## Corrections livrées

- La section **Modèles** accueille désormais les limites de l’assistant, les modèles principal, auxiliaire et de secours, ainsi que Mixture of Agents. Les modèles par défaut restent disponibles dans cette section. Ces contrôles ont quitté Intégrations.
- Les noms longs de projets et de conversations sont tronqués avec une ellipse. Le bouton à trois points conserve son espace et fonctionne ; le titre complet reste accessible au survol.
- L’icône fichiers/chats conserve sa position en bas lorsque la barre latérale se replie. La navigation glisse horizontalement.

## Vérifications

- Suite Node : **184 tests réussis, 1 ignoré, aucun échec**.
- Vérification dans le navigateur, sur le serveur recompilé : section Modèles, valeurs **500 / 10 / 250**, absence des contrôles dans Intégrations, noms longs, ouverture du menu à trois points et repli. Hauteur de l’icône avant/après : **639,33 px** dans une fenêtre de 1280 × 720.
- Réglage enregistré depuis Modèles et lu par le terminal compilé : **400**, puis restauration de **500**, dans un compte de test jetable. Contrôles français et anglais sur l’interface source.
- Tests de bout en bout relancés sur les exécutables reconstruits : catalogue partagé de **171 outils**, permissions, mémoire, Python, MCP, délégation en arrière-plan, planification et sessions. Terminal PowerShell interactif réel : catalogue, mémoire, question confidentielle et reprise de l’agent.
- Réglages compilés : limites persistées, budget actualisé à la reprise, composition MoA avec comptabilisation et modèle de secours. Fournisseur local simulé, moteur Rust réel.
- Les essais réels ChatGPT/Luna et les **486 tests Rust réussis, 8 ignorés** proviennent de la validation précédente ; ils n’ont pas été relancés pour ces changements d’interface.

## Livraison et portée

Application Windows, sélecteur de dossiers, moteur Rust, serveur et terminal reconstruits. Installateur : `native/installer/zaalis-setup.exe`. Empreintes dans `assistant-artifacts.json` ; preuves dans `assistant-ui-layout-proof.json`, `assistant-packaged-proof.json` et `assistant-settings-proof.json`.

Les binaires ne sont pas signés. La copie installée et son environnement WebView2 n’ont pas été remplacés ni validés. Certains services externes nécessitent encore leur configuration ou un pont MCP : leur présence dans le catalogue ne prouve pas leur activation réelle. Les avertissements de packaging sont conservés dans les journaux de compilation.

Travail sur la branche locale `codex/hermes-tool-parity`, sans publication distante.
