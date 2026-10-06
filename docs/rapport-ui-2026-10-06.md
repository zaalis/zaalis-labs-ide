# Ajustements de l’interface — 6 octobre 2026

## Comportement

- Intégrations : une carte GitHub ouvre la connexion et les permissions des dépôts. Une flèche revient à la liste. La mention « D’autres intégrations arrivent bientôt » remplace les doublons MCP, Blender, Opale et VM.
- Badges : dix illustrations originales générées par IA, avec des critères fondés sur les tokens, les jours actifs, les séries, les appels mesurés et les modèles explorés. Les prompts et sujets figurent dans `badge-artwork-2026-10-06.md` ; les PNG sont dans `interface/image/badges/`.
- Projets : repli progressif de la liste et rotation de la flèche ; les éléments repliés sortent du parcours clavier. Les menus des conversations restent accessibles après l’animation.
- Navigation : avatar maintenu en bas lors du repli. Le profil apparaît et disparaît progressivement. Les préférences de mouvement réduit sont respectées.
- En-tête : suppression du bouton Terminal redondant à côté de Chat/Agents. Le terminal du panneau d’outils reste accessible. Mémoire des corrections précède immédiatement la version.
- Discussion du projet : conversation indépendante initialement vide, disponible dans les deux dispositions. Les questions reçoivent le projet, le fichier actif, le contexte visible et l’activité des agents. La discussion utilise la route de chat existante, dont le serveur impose la lecture seule. Les messages et brouillons restent en mémoire pendant la session et sont distincts par compte, projet et tâche ; ils ne sont pas enregistrés dans l’historique central.
- Accueil : prénom extrait du pseudo, par exemple « Bonjour Bryan », avec salutation adaptée à l’heure et rafraîchie après une modification du profil.

## Validation

- JavaScript : 117 tests, 116 réussis, zéro échec et un ignoré. Diagnostic PTY non bloquant `AttachConsole failed`.
- Syntaxe des fichiers modifiés, encodage et whitespace vérifiés.
- Edge : navigation GitHub et retour, suppression des doublons, position de l’avatar, ordre mémoire/version, animation du repli, discussion et conservation du brouillon, dix images des badges, plusieurs critères, bannière, thèmes et cinq largeurs de fenêtre.
- La réponse IA et les mesures d’usage sont simulées dans le contrôle visuel. Le contenu envoyé à l’IA est inspecté ; l’authentification locale et les API de bannière sont réelles. Aucun appel payant à un fournisseur n’a été effectué pour ce contrôle.
- Serveur Windows compilé : contrôles de fonctionnement du paquet et de l’interface. Le serveur, le CLI/Rust, le terminal et la fenêtre native ont été recompilés, puis un nouvel installateur Windows a été produit.
- Contrôle de l’agent réel sur serveur compilé : lecture permise, écriture, commande, artefact et push refusés pour GitHub en lecture seule.

L’installateur généré reste local et non signé. Une instance installée étant ouverte pendant ces travaux, le paquet est livré pour installation après fermeture de l’application. La compilation Windows et les contrôles Edge ne constituent pas une validation native Linux ou macOS.
