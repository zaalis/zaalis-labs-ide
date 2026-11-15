# Connexion Grok, interface et sécurité — 14 novembre 2026

## Connexion xAI

Le message `Grok / xAI` / `Interrompu après 2 s` / `[invalid_request] xAI : HTTP 400` venait de l’abonnement, pas d’une coupure réseau. Le jeton OAuth du client Grok (`b1a00492-073a-47ea-816f-4c329264a828`) était envoyé à `https://api.x.ai/v1/responses`, qui attend une clé d’API. L’abonnement SuperGrok parle à `https://cli-chat-proxy.grok.com/v1/responses`, avec `X-XAI-Token-Auth: xai-grok-cli` et une version de client.

Le corps repris de ChatGPT ajoutait trois refus immédiats : `reasoning.summary: "auto"`, `include: []`, et les outils `tool_search` / `web_search`, noms réservés par xAI. Le corps d’erreur (`{"error":"..."}` en chaîne) n’était pas lu, d’où le seul texte `HTTP 400`.

Correction dans `src/accounts/account-subscriptions.js` : proxy CLI, en-têtes d’identité, effort `low|medium|high|xhigh` (omis pour grok-build / Composer), résumé `concise`, alias `zaalis_tool_search` et `zaalis_web_search` remis aux noms internes après la réponse. La version annoncée est `1.0.46`, surchargeable par `ZAALIS_GROK_CLI_VERSION` si le proxy répond 426.

Tests : `node --test test/account-subscriptions.test.js test/chatgpt-subscription.test.js` — 12 réussis, 0 échec. L’appel réel avec le compte connecté n’a pas été rejoué dans cette session.

## Interface

La timeline d’agent (`interface/timeline.css`, `timeline.js`) est déjà le modèle Cursor : une ligne par outil, sortie repliée, diff vert/rouge, spinner, `prefers-reduced-motion`. Les animations d’attente (point, points de saisie, reflet du libellé) étaient écrites puis désactivées (`animation: none`). Elles tournent à nouveau.

Les anciennes cartes d’outils hors timeline ont un nom en police mono, un état d’erreur coloré et un contour au clavier.

Écarts encore visibles, non repris dans ce correctif : deux présentations d’outils coexistent (timeline et cartes `ghost-tool`), la barre d’envoi reste plus chargée qu’un composer Cursor, et les sous-agents du panneau latéral n’affichent pas leurs outils en direct.

## Sécurité

Revue statique du serveur, du cookie de session, du tunnel mobile et des lectures de fichiers. Aucun exploit lancé, aucune cible externe.

- Session IDE : cookie `HttpOnly`, `SameSite=Strict`. Comparaisons de secrets en temps constant.
- Tunnel et mobile : liste blanche. Pas d’accès fichiers, clés, exec ni contrôle du bureau. Le chat mobile ne reçoit pas le jeton d’espace de travail Rust.
- Fichiers : un dossier ouvert reste borné par `root`. Le poste local authentifié peut choisir ce dossier : c’est le fonctionnement d’un IDE.
- Jeton d’appairage mobile dans l’URL `/m?t=`, puis cookie `HttpOnly`. `SameSite=Lax` et `Secure` seulement si le proxy annonce HTTPS.
- Le poste apparié peut encore envoyer un message à l’agent. Ce n’est pas une exécution d’outils locaux, mais c’est la surface à garder derrière le tunnel.

Pas de correctif de sécurité supplémentaire : les contrôles déjà en place tiennent pour un IDE local. Un audit de dépendances npm n’a pas été relancé dans cette session.
