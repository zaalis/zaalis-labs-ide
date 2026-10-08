# Tokens exacts, messageries fiables et chat en déroulé — 8 octobre 2026

## Comptage des tokens

- La jauge de contexte n'estime plus rien. Elle affiche la taille mesurée par le fournisseur au dernier appel du modèle (`context_tokens` côté Rust : entrée + sortie de cet appel). Elle se met à jour après chaque appel, pendant le tour. Tant qu'aucune mesure n'existe, elle affiche « — ».
- La taille maximale du contexte vient du catalogue du serveur, qui est la référence ; la table locale ne sert qu'au démarrage.
- Le compactage automatique côté interface se déclenche uniquement sur une mesure exacte.
- `/context` et `/cost` affichent le contexte mesuré et le dernier tour (entrée/sortie exactes).
- Le pied de chaque réponse indique les tokens du tour, mesurés par le fournisseur.
- Registre :
  - MiniMax (abonnement) transmet désormais ses tokens ; ils étaient enregistrés à 0 auparavant.
  - ChatGPT et xAI n'enregistrent plus « 0 mesuré » quand le fournisseur ne renvoie rien.
  - L'usage imbriqué dans le dernier choix (Kimi/Moonshot) est lu.
  - Le dernier `message_delta` d'Anthropic fait foi.
- Paramètres → Tokens :
  - jours et séries comptés en heure locale, heure d'été comprise ;
  - détail par modèle ;
  - couverture de mesure : chaque appel sans relevé du fournisseur est compté 0 et nommé.

## WhatsApp

- Parcours guidé : Connecter → « Préparation du QR code… » → QR avec les instructions → « QR scanné, finalisation… » → « Connecté » → message de test.
- Dans la discussion avec soi-même, seuls les messages commençant par `zaalis!` vont à l'IA ; `!zaalis` reste accepté. Les autres messages restent des notes. Avec un numéro dédié, les correspondants autorisés écrivent sans mot déclencheur.
- Pont :
  - version WhatsApp Web actualisée au démarrage ;
  - appareil retiré depuis le téléphone ou session corrompue : les identifiants sont effacés et un nouveau QR est proposé, au lieu d'une erreur permanente ;
  - QR expiré : bouton « Afficher un nouveau QR code » ;
  - session ouverte par un autre programme : message explicite ;
  - redémarrage immédiat après le scan ;
  - reconnexions espacées progressivement.

## Telegram

- Lien d'association affiché avec un QR à scanner depuis le téléphone, un compte à rebours et un bouton « Nouveau lien » quand il expire.
- Clé révoquée : l'interrogation s'arrête avec un message clair, au lieu de réessayer à l'infini.
- Bot utilisé ailleurs (409) et limites d'envoi (429) : messages explicites et attente adaptée.
- Lien expiré utilisé dans Telegram : le bot explique quoi faire.
- Ajout de « Changer de bot » et du message de test.

## GitHub

- La route qui modifie le compte et les droits des dépôts est réservée à l'IDE sur ce PC (refus depuis le téléphone, le tunnel et le navigateur intégré).
- Autorisation révoquée ou expirée : statut « Reconnexion nécessaire » et bouton « Reconnecter » ; les droits par dépôt sont conservés.
- Limite d'API atteinte : l'heure de reprise est indiquée.
- Code d'autorisation copié automatiquement, avec un compte à rebours.

## Chat et Agents

- Un seul message par tour, dans l'ordre :
  - texte de l'IA, réellement streamé ;
  - lignes d'actions regroupées et repliables, avec icône ou logo (« A lu un fichier et a exécuté une commande », GitHub, serveur MCP, Web…) ;
  - réflexion ;
  - « Contexte compacté automatiquement » ;
  - autorisations ;
  - erreurs du fournisseur.
- Les fichiers modifiés restent visibles dans le fil, sans pastille flottante : « Modifié » / « Ajouté » / « Supprimé », avec `+N` en vert et `−N` en rouge ; un clic affiche le diff.
- Le déroulé est restauré à l'identique à la réouverture de la conversation.
- Vue Agents : même rendu pour l'agent principal. Corrigé : `workers` non défini interrompait le flux dès qu'un agent secondaire changeait d'état.

## Vérifications

- `npm test` : 152 tests réussis, 0 échec, sous PowerShell. Sous Git Bash, le test d'import VM échoue uniquement parce que le `tar` GNU de Git Bash interprète « C: » comme un hôte distant.
- `cargo test --workspace` : toutes les suites réussies.
- Contrôle d'encodage : aucun mojibake.
- Bout en bout : serveur local, moteur Rust compilé et fournisseur scripté (lecture, commande, modification, création de fichier).
  - Déroulé, diff et `+/−` vérifiés.
  - Jauge exacte, puis restaurée après rechargement.
  - Registre : 8 appels, 20 400 tokens en entrée, 500 en sortie, 800 en cache, identiques aux valeurs déclarées.
- Vrai QR WhatsApp obtenu depuis les serveurs WhatsApp avec le pont mis à jour, puis annulé. Aucun compte associé, aucun message personnel envoyé.
- États Telegram (lien + QR + compte à rebours, connecté) et WhatsApp connecté contrôlés en thème sombre et clair, et à 390 px.
- Non vérifié avec de vrais comptes : scan WhatsApp, démarrage d'un bot Telegram réel et autorisation GitHub.
