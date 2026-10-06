# Intégrations, accueil et profil de tokens — 6 octobre 2026

Travail dans `connexion ide`, branche `codex/github-welcome-token-profile`. Les modifications locales préexistantes ont été conservées. Aucun commit, push ou merge distant effectué.

## Fonctionnalités

- Paramètres → Intégrations : connexion GitHub par jeton à permissions fines, liste paginée des dépôts visibles pour ce jeton, filtre et permissions par dépôt (aucun accès, lecture seule, lecture et écriture). Liens vers les intégrations MCP, Blender, Opale et les machines virtuelles existantes.
- Le jeton GitHub reste chiffré dans le coffre du serveur et ne passe pas dans les prompts, le stockage navigateur ou les arguments des commandes Git.
- Pour le projet actif reconnu en lecture seule, le serveur force le mode lecture seule et le garde Rust applique un verrou indépendant du mode autonome et des approbations antérieures. Les commandes, écritures, actions bureau, VM et MCP arbitraires sont refusées. Les outils Git locaux sont également bloqués : certaines lectures Git peuvent exécuter des programmes configurés dans le dépôt. Les lectures de fichiers et les lectures GitHub autorisées restent disponibles.
- L’outil `workspace` expose les dépôts autorisés, leur arborescence, les fichiers, les PR ouvertes, le push de commits préparés, la création de PR et le merge avec vérification du SHA exact. Les écritures exigent l’identité GitHub enregistrée, la racine associée, origin et sa destination de push, des fichiers communs et un historique vérifiable. Aucun push forcé. Un changement des permissions arrête les agents existants.
- Accueil au lancement : cinquante messages, salutations selon l’heure locale, possibilité de mentionner le dernier projet, petit logo commun au chat et à l’éditeur. Le message du chat disparaît au premier échange.
- Tokens : avatar, bannière photo avec dégradé, total historique, pic quotidien, jours actifs, meilleure série et série actuelle ; graphique des douze derniers mois avec vues quotidienne, sur sept jours et cumulée ; dix paliers de création de 10 000 à 1 milliard de tokens. Ces badges ne donnent aucun crédit ni quota. Les jours et séries utilisent UTC et l’historique réellement enregistré.

## Validation

- JavaScript : 112 tests, 111 réussis, zéro échec, un ignoré. Les 13 tests GitHub sont inclus.
- Rust : suite workspace réussie, 469 tests réussis et huit ignorés ; après le dernier renforcement, les 84 tests du garde ont été relancés et passent.
- Syntaxe JavaScript, contrôle d’encodage et `git diff --check` réussis.
- Edge réel : accueil, limites horaires, réglages, dix badges, modes du graphique, ajout/retrait de bannière avec persistance sur le serveur ; fenêtres de 375, 560, 768, 1 100 et 1 440 pixels, thème clair et mouvement réduit. Les chiffres de cette vérification visuelle sont des données de test, pas les statistiques du compte utilisateur.
- Serveur compilé + agent Rust réel + fournisseur de test : lecture réussie ; écriture, commande, création d’un document et push refusés malgré le mode autonome demandé. Le fichier témoin demeure intact. Le registre reçoit les mesures du fournisseur de test.
- Serveur, cœur Rust/CLI, client terminal, coquille C++ et installateur recompilés. Les six fichiers d’interface concernés correspondent à leurs copies distribuées par SHA-256.

## Limites vérifiées

La connexion au compte GitHub personnel et un véritable push/merge authentifié n’ont pas été exécutés. L’écriture reste soumise aux permissions et protections de branche de GitHub. Pour les dépôts privés, le commit distant nécessaire à la vérification doit être présent dans l’historique Git local ; sinon le push est refusé et un fetch préalable est nécessaire.

La connexion par navigateur est implémentée mais nécessite `ZAALIS_GITHUB_CLIENT_ID` d’une application GitHub enregistrée avec device flow activé. La connexion par jeton est disponible sans cette configuration. GitHub recommande les GitHub Apps pour des permissions plus fines : https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps

Le verrou concerne les agents de l’IDE et les opérations de cette intégration. Ce n’est pas une restriction des droits Windows de l’utilisateur ou des outils externes à l’IDE.

Interface vérifiée dans Edge et serveur compilé exécuté ; installation et interaction dans la fenêtre native WebView2 non effectuées. Avertissements non bloquants : `node-pty` AttachConsole dans les tests, avertissements `pkg` sur les ressources Electron du navigateur. Installateur non signé.

## Installateur

- Fichier : `native/installer/zaalis-setup.exe`
- Taille : 437 211 113 octets (environ 437 Mo)
- Généré le 6 octobre 2026 à 16:31:48, heure de Paris
- Signature : `NotSigned`
- SHA-256 : `D02559D41DD3C8EEEBEBDBD22B2CD23FA2203AF3DC67246A9146DAAF851D3AE5`
- Captures de validation : `.tmp/github-profile-ui/` ; journaux : `.tmp/github-javascript-tests.log`, `.tmp/github-installer-build.log`, `.tmp/github-server-build.log`.
