# Mémoire, catalogue agents et connexion GitHub — 7 octobre 2026

Version conservée : 1.0.16. Branche main, changements locaux préexistants conservés. Aucun commit ni push.

## Changements

- Fenêtre mémoire centrée, surfaces et champs cohérents avec les thèmes, cases personnalisées, état vide et dates selon la langue.
- Les contrôles mémoire suivent le changement de langue sans réinitialiser les champs en cours de saisie. Les contenus de fiches ne sont pas traduits.
- Catalogue agents dérivé du sélecteur Chat : fournisseurs configurés, modèles live et modèles saisis manuellement. Le défilement existant est conservé.
- Sélecteurs modèle/rôle arrondis, animés, accessibles au clavier, respectant la réduction des animations. Les menus en top layer échappent au clipping de la liste.
- GitHub : bouton principal de connexion navigateur, ouverture du navigateur Windows par le serveur, code device et attente automatique de l’autorisation. Aucun jeton à saisir dans cette interface.
- Configuration du Client ID public OAuth depuis les intégrations ou ZAALIS_GITHUB_CLIENT_ID. Le device flow doit être activé dans l’application GitHub enregistrée.
- Annulation, expiration, ralentissement du polling et protection contre le retour d’une autorisation annulée en vol.

## Validation

- npm test : 120 tests, 119 réussis, 0 échec, 1 ignoré.
- Tests GitHub : 16 réussis, incluant OAuth simulé, chiffrement, refus de destination inconnue et annulation pendant polling.
- Audit langue : 18 écrans, sources et serveur empaqueté, aucune erreur JavaScript ni texte français résiduel dans les contrôles audités en anglais.
- Nouveau smoke UI sur sources, build et installation : 20 fournisseurs simulés, parité Chat/Agents, catalogue modèles live, sélection modèle/rôle et payload agent, scroll, réduction d’animations, mémoire FR/EN, centrage et tailles 1440/768/390, thèmes, connexion GitHub simulée avec polling automatique.
- memory-terminal-smoke : serveur et moteur Rust réels avec fournisseur local de test, correction, vérification, rappel dans de nouvelles conversations et CLI, désactivation par projet.
- Shell C++/WebView2 et serveur Windows recompilés ; interface copiée dans native/dist sans effacer de fichiers.
- Installation locale mise à jour uniquement pour zaalis.exe, zaalis-server.exe, pickfolder.exe et interface ; SHA-256 identiques au build. Les 10 fichiers persistants JSON/secret existants sont restés identiques.
- Ancienne application sauvegardée sous .tmp/installed-before-polish-20261007-172036.

## Limites

- Aucun Client ID d’application GitHub Zaalis n’a été fourni ; aucune connexion au compte GitHub personnel n’a été effectuée. Le parcours OAuth a été validé avec réponses simulées. Configuration GitHub réelle encore nécessaire.
- UI vérifiée sous Edge/Chromium avec le vrai serveur empaqueté et installé. Pas de validation visuelle interactive dans la fenêtre native WebView2.
- Binaries Windows non signés (NotSigned). pkg avertit à propos des imports Electron et de certains fichiers preload/icône du navigateur upstream ; compilation terminée avec succès. Le navigateur intégré réel n’est pas revalidé par ce smoke.

Les captures et les preuves de hash sont dans .tmp/agent-memory-ui. Documentation GitHub : https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
