# Zaalis — capacités de l’assistant dans l’IDE et le terminal

**8 octobre 2026 — réalisation locale, branche `codex/hermes-tool-parity`.**
Les dernières modifications de `main` ont été récupérées avant le travail
(base `86450e1`). Les outils ont été développés pour Zaalis, sans reprendre
le code de Hermes.

## Réalisé

Les familles demandées sont intégrées : découverte des outils, mémoire
persistante, recherche de conversations, exécution Python, gestion des Skills,
questions structurées, tâches planifiées, agents détachés, Kanban, coffre et
extensions navigateur, voix, images/vidéo, A2A et connecteurs spécialisés.
Les adaptateurs couvrent Discord, Feishu/Lark, Home Assistant, Spotify,
Yuanbao/MCP et les environnements Docker, SSH, Singularity, Modal et Daytona.

L’IDE et le terminal installé utilisent le même serveur et le même moteur
Rust, les mêmes outils, modèles, capacités de raisonnement et six modes de
permission. Le catalogue de validation comporte **169 entrées, alias compris** ;
ce chiffre ne représente pas 169 services externes actifs.

## Validation

- **172 tests Node réussis, 1 ignoré ; 479 tests Rust réussis, 8 ignorés ; aucun échec.**
- Scénarios avec le vrai serveur/moteur, puis avec les exécutables compilés :
  catalogue et modèles communs, mémoire, Python, découverte MCP, refus en
  lecture seule, approbation supervisée, planification et agents persistants.
- Vraie console **PowerShell** : catalogue, mémoire partagée, question avec
  saisie masquée, absence du secret dans les requêtes modèle, reprise de l’agent.
- Interface : catalogue, formulaire de mémoire, français/anglais et réponse à
  une question suivie de la reprise de l’agent.
- **Abonnement ChatGPT existant / `gpt-6-luna` : essais réels réussis** pour la
  mémoire et l’orchestration Python (résultat 42), puis depuis le terminal compilé.
  Les essais ont utilisé des dossiers temporaires ; les données personnelles
  de l’application ont été préservées.

## Conditions de mise en service

Les services externes nécessitent leurs identifiants et permissions ; leurs
adaptateurs ont été contrôlés avec des réponses simulées, sans prétendre avoir
validé chaque compte réel. La vision dépend du modèle ; la vidéo locale exige
FFmpeg. Le contrôle ordinateur demande une activation explicite.

Python est borné en durée/sorties et contient l’arbre des processus. **Il
n’isole pas par défaut les fichiers et le réseau.** Le confinement strict est
indisponible sur cette machine et échoue explicitement lorsqu’il est demandé.
Les tâches planifiées fonctionnent pendant que le serveur est lancé.

Serveur, moteur Rust, terminal et installateur Windows reconstruits. Les
exécutables sont **non signés**. L’installateur est livré dans
`native/installer/zaalis-setup.exe` ; la copie déjà installée doit être mise à
jour pour bénéficier des ajouts. Aucune publication GitHub n’a été effectuée.

Les avertissements de packaging du navigateur Electron et l’avertissement
ConPTY de la suite existante sont consignés dans les journaux. Les essais
des nouveaux exécutables ont réussi ; l’ouverture de la coque WebView2 déjà
installée et les connexions cloud réelles restent hors de cette preuve.

## Pièces disponibles

- `assistant-catalogue.json` : liste détaillée, schémas et disponibilités.
- `assistant-source-proof.json`, `assistant-packaged-proof.json` : scénarios.
- `assistant-luna-proof.json`, `assistant-luna-cli-proof.json` : essais Luna.
- `assistant-validation.json`, `assistant-artifacts.json` : bilans et empreintes.
- `assistant-ui-proof.jpg` : capture du panneau.
- `../assistant-tools/README.md` : commandes et configuration des connexions.
