# Skills, /revers et Daybreak — 27 octobre 2026

Implémentation réalisée dans le dépôt Windows Zaalis Labs, à partir de `d198cb8`.
Les changements sont locaux ; aucun push ni installation sur le compte utilisateur
n’a été effectué.

## Fonctions livrées

- **Paramètres → Skills** : bibliothèque personnelle et skills du projet,
  recherche, aperçu textuel, import de `SKILL.md`, activation/désactivation par
  compte. Les chemins symboliques et les noms dangereux sont refusés. Les
  changements sont pris en compte au prochain tour sans interrompre les autres
  sessions de l’utilisateur.
- **`/skills`**, **`/skill <nom> <demande>`** et **`/revers [objectif]`** : invocation
  explicite, instructions vérifiées côté serveur, nouveau workflow dans la
  conversation existante. Le workflow intégré ne peut pas être remplacé par une
  skill du projet.
- **Reverse engineering** : inventaire, architecture, dépendances, flux, preuves
  et limites ; analyse statique en lecture seule par défaut. **`/revers --dynamic
  <test autorisé>`** conserve les permissions sélectionnées et permet les outils
  d’exécution existants, dont les processus en arrière-plan. Une analyse de
  binaire dépend toujours des outils réellement disponibles ; aucune récupération
  universelle du code source original n’est promise.
- **OpenAI Responses** : les modèles GPT récents, dont GPT-6 Luna, passent par
  l’adaptateur Responses avec les appels d’outils et le streaming. Les anciens
  modèles et les autres fournisseurs conservent leurs protocoles compatibles.
- **Standard / Daybreak Blue / Daybreak Red** : choix enregistré par compte,
  transmis explicitement à OpenAI. L’application expose le résultat communiqué
  par le fournisseur et ne remplace jamais silencieusement un refus Daybreak par
  une requête Standard.
- **Connexion ChatGPT officielle** pour les nouvelles connexions : navigateur,
  PKCE, nonce, état OAuth, client émis par OpenAI, vérification cryptographique de
  l’identité et des scopes, stockage chiffré et renouvellement. Les sessions
  historiques restent utilisables en Standard ; elles nécessitent une reconnexion
  officielle pour demander Daybreak.

Le workflow a été écrit pour Zaalis en s’inspirant de l’observation et de
l’organisation des preuves présentées dans
[claude-code-reverse](https://github.com/Yuyz0112/claude-code-reverse), sans intégrer
son patch des applications installées.

## Vérification

| Contrôle | Résultat |
|---|---|
| `npm test` | **209 réussis, 0 échec** |
| `cargo test --manifest-path rust/Cargo.toml -p zaalis-extensions` | **23 réussis, 0 échec ; 7 tests réseau ignorés** |
| `node test/package-smoke.js` | Serveur Windows empaqueté validé : comptes, conversations, PTY, UI, préférences, MCP, dictée et fonctions existantes |
| Test HTTP → Rust → Responses | Appels d’outils réels sur fournisseur simulé, programme explicite, activation des skills, refus Daybreak sans repli |
| OAuth | Tests des signatures, audience, issuer, nonce, expiration, PKCE, scopes et renouvellement du client émis |
| UI | Application Windows recompilée inspectée ; thèmes clair/sombre ; largeur mobile 390 px, largeur de page 390 px ; aucune erreur de console observée |
| `git diff --check` | Aucune erreur de diff |

**Tests avec les fournisseurs réels :**

- **GPT-6 Luna : analyse statique réussie**, deux fois, via l’abonnement existant.
  Il a chargé `revers`, lu trois fichiers et établi le résultat **42** avec les
  références aux lignes. La session expirée existante a été renouvelée et
  conservée chiffrée, sans extension de ses droits.
- **Arrière-plan avec GPT Luna : cycle `process start → poll → kill` observé**,
  avec résultats d’outils sans erreur. Le premier collecteur n’a pas enregistré
  la réponse finale et a été corrigé. Une relance a rencontré une indisponibilité
  réseau ChatGPT avant tout appel d’outil ; ce parcours n’est donc pas présenté
  comme reproductible sans réserve.
- **Mistral Small : refus HTTP 429 / `rate_limited`**, y compris sur une requête
  minimale indépendante. La clé est configurée mais le test réel ne peut pas
  être déclaré réussi tant que le fournisseur refuse les requêtes.
- **Daybreak et nouvelle autorisation OAuth : protocole testé avec services
  simulés.** Aucun droit Daybreak réel n’a été accordé ou vérifié sur le compte.
  Les accès dépendent d’OpenAI, du compte/projet, du modèle et de la surface
  autorisée. La compatibilité OpenAI d’une passerelle tierce ne suffit pas à
  garantir Daybreak.

Captures : [sombre](assets/skills-revers-2026-10-27/skills-dark.png),
[clair](assets/skills-revers-2026-10-27/skills-light.png),
[mobile](assets/skills-revers-2026-10-27/skills-mobile.png).

## Compilation et livrables

Build Rust release, serveur Node empaqueté, shell WebView2, CLI Rust, terminal et
installateur Inno Setup terminés. Le build émet les avertissements habituels de
`pkg` sur des modules optionnels ; les scénarios du serveur empaqueté passent.

- Application prête à lancer : `native/dist/zaalis.exe` avec son dossier complet.
- Installateur : `native/installer/zaalis-setup.exe`.
- Taille de l’installateur : **498 126 463 octets, soit 475,05 MiB**.
- SHA-256 : `63104F89A1FBF91B1EAC5399D0259A65F31F198084C0FE3B6EE3B36B58D0BC81`.

Les exécutions de validation utilisent des comptes et projets temporaires.
Le programme installé chez l’utilisateur n’a pas été remplacé.

Références OpenAI : [Daybreak / Responses](https://developers.openai.com/api/docs/guides/daybreak),
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
