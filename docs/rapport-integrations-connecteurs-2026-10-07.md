# Connecteurs GitHub, WhatsApp et Telegram — 7 octobre 2026

Version 1.0.16 conservée. Branche main ; changements locaux préexistants conservés. Aucun commit, push ni publication.

## Parcours utilisateur

- GitHub : Connecter le compte lance le parcours navigateur avec le client officiel GitHub CLI fourni dans le paquet Windows. L’utilisateur n’a plus de formulaire Client ID ni de jeton personnel. Un code d’autorisation temporaire est affiché avec un bouton de copie ; GitHub demande ensuite de valider la connexion. L’autorisation est présentée sous l’identité GitHub CLI. Les autorisations de dépôts propres à Zaalis restent à sélectionner après connexion.
- WhatsApp personnel : Connecter WhatsApp affiche un QR d’appareil lié. Dans la discussion avec soi-même, envoyer !zaalis suivi de la question. Les messages de contacts, les groupes, les médias, les anciens messages et les doublons ne déclenchent pas l’IA. Les identifiants téléphone et LID du propriétaire sont reconnus.
- Telegram : configurer un bot privé via BotFather, fournir sa clé dans la page du connecteur, puis utiliser le lien d’association et appuyer sur Démarrer. Une nonce limitée à dix minutes associe une seule conversation privée. Les autres utilisateurs et les groupes sont ignorés.
- Modèle : les sélecteurs reprennent les fournisseurs et modèles du Chat. Le choix est commun aux messageries. Les réponses utilisent le moteur Rust en mode conversation, sans serveur MCP ni accès au projet actif. Le modèle GGUF est démarré si nécessaire.
- Conversations : historique des vingt derniers messages par compte et messagerie, chiffré dans le coffre local. /new commence une nouvelle conversation.
- Zaalis et le PC doivent rester ouverts et connectés à Internet pour recevoir les messages et répondre.

## Présentation

Cartes GitHub, WhatsApp et Telegram avec logos locaux, couleurs distinctes, descriptions, sections de configuration et boutons séparés. Champs et textes espacés ; menus hors des zones de clipping ; contrôle visuel en thèmes sombre et clair, français et anglais, et largeurs 1440, 1024, 768 et 390 pixels.

## Validation finale

- npm test : 131 tests, 130 réussis, 0 échec, 1 ignoré.
- Tests des nouveaux connecteurs : stockage chiffré et isolation des comptes, association Telegram, nonce expirée, refus des groupes et autres expéditeurs, commandes WhatsApp dans la discussion personnelle, déduplication, alias LID, reconnexion après erreur, suppression du seul profil propriétaire lors de déconnexion, conservation chiffrée de l’historique.
- GitHub CLI : configuration temporaire isolée, exclusion des variables de jeton ambiantes, annulation et protection contre un ancien processus qui tenterait d’annuler sa nouvelle tentative. La configuration personnelle existante de gh n’est pas utilisée.
- Réseau réel, binaire empaqueté puis installé : code device GitHub réellement reçu et QR WhatsApp réellement obtenu par Microsoft Edge. Aucune autorisation de compte personnel, aucun message personnel envoyé.
- Smoke UI : les trois logos se chargent ; connexion GitHub et association Telegram simulées ; QR, instructions, formulaires, modèles, langues, thèmes et reflow vérifiés. Zéro erreur JavaScript. Sources, build et installation contrôlés.
- Non-régression mémoire et catalogue agents : smoke empaqueté avec 20 fournisseurs simulés, sélection modèle/rôle et parité des catalogues.
- Audit de langue : 18 écrans du binaire empaqueté, aucune erreur JavaScript et aucun résidu français dans les contrôles audités en anglais.
- npm audit --omit=dev : 0 vulnérabilité connue. Runtime WhatsApp distribué : 0 vulnérabilité connue. Puppeteer actualisé par override ; il utilise Edge/Chrome présent sur le PC et ne télécharge pas Chromium.
- Shell C++/WebView2, serveur Node Windows et installateur recompilés. Les bibliothèques navigateur sont distribuées comme sources hors du snapshot pkg ; le client GitHub officiel est fourni avec sa licence MIT.
- Installation Windows mise à jour ; 4844 fichiers d’application et de runtime comparés au build par SHA-256. Les 10 fichiers persistants JSON/secret contrôlés sont inchangés. Ancienne installation sauvegardée sous .tmp/installed-before-connectors-20261007-180607.

## Limites de preuve

L’approbation GitHub réelle, le scan WhatsApp avec un compte personnel et l’échange Telegram réel nécessitent les comptes de l’utilisateur et n’ont pas été effectués. Les tests de réponses messagerie utilisent des adaptateurs simulés ; aucune réponse réelle d’une IA payante depuis un compte WhatsApp/Telegram personnel n’est revendiquée. L’UI a été contrôlée sous Edge avec le serveur installé, sans contrôle visuel interactif de la fenêtre native WebView2.

WhatsApp utilise whatsapp-web.js, un pont communautaire vers WhatsApp Web, et pas l’API officielle Meta. Les clés Telegram et les historiques sont chiffrés ; le profil d’appareil WhatsApp est conservé dans les données utilisateur comme un profil de navigateur. Le client GitHub écrit un jeton uniquement dans une configuration temporaire isolée avant import dans le coffre chiffré, puis cette configuration est supprimée. L’approbation demande les portées du client GitHub CLI officiel.

Les exécutables Zaalis restent non signés. Les avertissements pkg concernent les imports/fichiers optionnels du navigateur upstream ; la compilation aboutit et les parcours connecteurs ont été testés sur l’exécutable obtenu. Les nouvelles dépendances portent aussi des avertissements de dépréciation de glob/fluent-ffmpeg, distincts du résultat de sécurité 0 vulnérabilité connue.

## Sources et preuves

- GitHub CLI : https://cli.github.com/manual/gh_auth_login
- Telegram Bot API : https://core.telegram.org/bots/api
- Liens d’association : https://core.telegram.org/bots/features#deep-linking
- whatsapp-web.js : https://wwebjs.dev/guide/creating-your-bot/authentication.html
- Captures : .tmp/connectors-ui
- Logs de compilation : .tmp/connectors-server-build.log et .tmp/connectors-installer-build.log
