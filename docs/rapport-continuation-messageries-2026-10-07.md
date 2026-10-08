# Mini-rapport — reprise du travail par WhatsApp et Telegram

Livraison du 7 octobre 2026, version Zaalis 1.0.16 reconstruite et copiée dans l’installation Windows existante. Ce rapport remplace la description des discussions séparées du rapport précédent sur les connecteurs.

## Changements

- WhatsApp et Telegram se lient à une conversation existante de l’IDE : projet, historique, modèle ou équipe, session Rust et permissions. Le choix « L’IA qui vous répond » a été remplacé par « Conversation à continuer » et « Utiliser la conversation active ».
- Les anciennes conversations peuvent être reprises avec le bouton de conversation active : leur première liaison reprend la configuration visible dans l’IDE. Une ancienne conversation dépourvue de configuration doit d’abord être ouverte dans l’IDE.
- Les réponses et questions de l’IA rejoignent le même historique. Les demandes d’autorisation et les plans arrivent dans la messagerie qui a lancé le tour. Un plan peut être révisé en répondant avec ses consignes. Les validations utilisent un code associé à la demande ; un accord autorise l’action une seule fois. Sur WhatsApp, les commandes restent précédées de `!zaalis` dans la discussion avec soi-même.
- Une conversation occupée ne lance pas un second tour en parallèle. Les changements de permissions dans l’IDE s’appliquent aussi à la reprise depuis le téléphone. Les équipes respectent les restrictions GitHub en lecture seule. Une sauvegarde ancienne de l’IDE conserve les messages reçus depuis les messageries.
- GitHub explique le dossier local avec l’exemple `C:\Projets\MonProjet` : le dossier réel du dépôt cloné, contenant `.git`. Le bouton du projet actif est davantage espacé. Le menu des droits est arrondi, animé et utilisable au clavier ; le panneau du dépôt se déplie avec une transition. Une confirmation verte apparaît après la réponse positive du serveur et disparaît si les champs sont modifiés.

## Vérifications

| Contrôle | Résultat |
|---|---|
| Suite complète | 139 tests : 138 réussis, 0 échec, 1 ignoré |
| Reprise réelle avec le moteur Rust et un fournisseur local de test | Historique repris ; en mode supervisé, fichier absent avant l’accord et écrit après l’accord Telegram simulé |
| Plan avec le même moteur réel | Plan transmis, approuvé, puis seconde validation avant l’écriture réelle du fichier |
| Isolation et synchronisation | Compte étranger refusé ; code d’une autre messagerie refusé ; retours de plan conservés ; messages distants préservés sans doublons ; messages tardifs après déconnexion ignorés |
| Interface sur serveur empaqueté et installé | Liaison réelle d’une conversation ancienne via l’API, sélection des droits, confirmation verte, français/anglais, thèmes clair/sombre et fenêtres étroites ; aucune erreur JavaScript relevée |
| Régressions interface | Parité des 20 fournisseurs Chat/Agents, mémoire des corrections et 18 captures de langue validées |
| Serveur empaqueté, projet et terminal | 3 tests de projet réussis ; correction Rust, rappel mémoire et terminal PowerShell validés |
| WhatsApp installé, réseau réel | QR d’association reçu puis session de test déconnectée |
| GitHub, nouvel essai réseau réel | Le client officiel a renvoyé `failed to authenticate via web browser: HTTP 500` ; autorisation réelle du compte non validée pendant ce contrôle |

Les échanges Telegram des tests sont simulés, tandis que le moteur Rust, le dossier temporaire et les écritures sont réels. Aucun message n’a été envoyé depuis un compte personnel. La reprise complète depuis un téléphone personnel et le rendu interactif WebView2 restent à vérifier après association du compte.

## Compilation et installation

Serveur, shell Windows et sélecteur de dossier compilés. Installateur Inno Setup terminé : `native/installer/zaalis-setup.exe`, 479 452 727 octets. Les avertissements `pkg` sur certains fichiers de dépendances restent présents ; le test terminal a également émis l’avertissement connu `node-pty: AttachConsole failed` au nettoyage, avec un résultat de test réussi. Les exécutables et l’installateur sont `NotSigned`.

Les 105 fichiers copiés dans `C:\Users\boque\AppData\Local\Programs\zaalis` ont été comparés à la compilation par SHA-256. Les 12 fichiers persistants JSON/secret contrôlés n’ont pas changé. Une sauvegarde des anciens exécutables et de l’interface a été conservée dans `.tmp/installed-before-continuation-20261007-184544`. Aucun commit ni push effectué.

SHA-256 du serveur : `3A6E2478DE30C7C91327FCAE860315767256AD1FCBF6F52366215E307B3BFACC`.

SHA-256 de l’installateur : `78911112AF0B33B016706DB7C10B010950CFD82215FDD19CE78A39123516F06D`.
