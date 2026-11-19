# Vertex AI (bêta), création de compte et mot de passe oublié — 19 novembre 2026

## 1. Google Vertex AI, réservé au canal Bêta

- **Activation** : Paramètres › Mises à jour › Canal › **Bêta**. Le canal est maintenant enregistré côté serveur, pas seulement dans l’interface. En canal Stable, Vertex AI n’apparaît nulle part et ses routes répondent 403.
- **Configuration** : Paramètres › Clés et abonnements › « Google Vertex AI (bêta) ». Deux types d’identifiants sont acceptés :
  - une clé de compte de service (fichier JSON de Google Cloud) ;
  - les identifiants gcloud déjà présents sur le PC (ADC), en cochant la case prévue (après `gcloud auth application-default login`).
  On peut aussi indiquer l’ID du projet (lu dans la clé si vide) et la région (`global` par défaut).
- **Fonctionnement** : l’agent Rust passe par un proxy local (`/api/internal/vertex/v1`). Ce proxy obtient un jeton d’accès Google valable une heure et mis en cache, l’ajoute à la requête, puis appelle le point d’accès Vertex compatible OpenAI. Les identifiants ne quittent jamais le serveur local et sont chiffrés au repos.
- **Modèles** : Gemini 4 Neon, Carbon, Argon et Hydrogen, Gemini 3.8 Flash et 3.1 Pro Preview, avec 1 M de contexte.
- **Erreurs claires** :
  - identifiants révoqués ;
  - API non activée ou rôle manquant ;
  - facturation désactivée ;
  - région ou modèle introuvable ;
  - quota atteint.

  Le détail technique va dans le journal des erreurs.
- **Limite** : c’est la facturation Google Cloud à l’usage. Un forfait Google AI Pro ou Ultra ne peut pas servir ici, car Google interdit l’usage de sa connexion Gemini CLI par des applications tierces.

## 2. Création de compte

- Le formulaire demande maintenant **Prénom** et **Nom** (côte à côte, empilés sur mobile). Ils sont validés : lettres, accents, espaces, tirets et apostrophes. L’IDE salue l’utilisateur par son prénom.
- Nouveau style des écrans de connexion, d’inscription et de mot de passe oublié :
  - carte en verre dépoli et typographie système de type Apple ;
  - libellés au-dessus des champs, champs de 44 px et bouton en pilule ;
  - champ fautif mis en évidence ;
  - thèmes clair et sombre ;
  - affichage adapté au mobile.
- **Fond animé** : une grille de petits points. Ceux qui sont proches du curseur se soulèvent avec un effet de ressort, prennent la couleur d’accent, puis retombent. L’animation ne tourne que lorsque l’écran est visible et que quelque chose bouge. Elle est désactivée si le système demande de réduire les animations.
- **Mot de passe** : le formulaire exige 8 caractères, dont au moins une lettre et un chiffre. Pour ne rien casser, le serveur accepte encore les inscriptions sans nom envoyées par d’anciens clients (CLI, scripts), avec l’ancienne règle de 6 caractères.

## 3. Mot de passe oublié

1. Écran de connexion › **Mot de passe oublié ?**, puis saisie de l’adresse du compte.
2. L’IDE **ouvre aussitôt une fenêtre dans le navigateur par défaut de l’ordinateur** (Chrome, Edge…). Aucun e-mail n’est envoyé, donc aucun compte de messagerie n’est à configurer. Si le navigateur ne peut pas être lancé, l’IDE ouvre la page lui-même ou affiche un lien.
3. Dans cette page temporaire, valable **30 minutes** et utilisable **une seule fois**, on choisit le nouveau mot de passe.
4. Après le changement, **toutes les sessions ouvertes de ce compte sont déconnectées**. L’ancien mot de passe est refusé et la page ne fonctionne plus.

**Sécurité** :
- Une adresse inconnue reçoit un message clair (« Aucun compte n’utilise cette adresse sur cet ordinateur »).
- Une nouvelle demande est possible toutes les 10 secondes, et elle remplace la précédente.
- Le jeton est stocké uniquement sous forme d’empreinte.
- Le jeton passe dans le fragment de l’URL : il n’est jamais transmis au serveur dans l’adresse, et la page l’efface de la barre d’adresse.
- La demande est refusée par le tunnel mobile.

**Conséquence à connaître** : sans e-mail, il n’y a plus de vérification de l’identité. Toute personne qui utilise ce PC peut réinitialiser le mot de passe d’un compte de cet IDE si elle en connaît l’adresse. Les comptes et leurs données étant déjà stockés sur ce PC, c’est cohérent avec le fonctionnement local de l’IDE.

## 4. Vérifications

- `npm test` : 260 tests, 258 réussis, 2 ignorés, 0 échec. Le fichier `test/account-reset-vertex.test.js` couvre :
  - les jetons de réinitialisation ;
  - la signature JWT Google et le cache du jeton ;
  - les identifiants gcloud ;
  - le parcours HTTP complet : restriction au canal Bêta, noms à l’inscription, adresse inconnue, ouverture de la page, nouveau mot de passe, sessions coupées, page à usage unique.
- Vérifications dans le navigateur (instance de développement isolée) :
  - animation des points ;
  - inscription avec prénom et nom, et validation des champs ;
  - bloc Vertex visible seulement en Bêta, puis enregistré ;
  - message envoyé à Vertex : la chaîne complète agent Rust → proxy → Google répond par une erreur claire avec des identifiants factices ;
  - « Mot de passe oublié » qui ouvre la page de réinitialisation sur le bon compte ;
  - mot de passe changé, ancien refusé, page inutilisable une seconde fois ;
  - affichage mobile.
- `native/dist/zaalis-server.exe` a été recompilé et `native/dist/interface` resynchronisé. Le test de fumée de l’exécutable est réussi.

## 5. Limites à connaître

- La page de réinitialisation s’ouvre sur le PC où tourne zaalis IDE : le serveur n’accepte que les connexions locales (`127.0.0.1`).
- **Vertex AI n’a pas été testé avec un vrai projet Google Cloud** (pas de compte disponible ici). La chaîne a été validée jusqu’au refus des identifiants par Google.
- L’application installée n’est pas mise à jour tant que l’installateur n’a pas été régénéré puis exécuté.
