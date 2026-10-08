# Correction du mode anglais et des transitions — 6 octobre 2026

## Changements

- Ajout d’un catalogue français/anglais partagé pour les textes statiques, les commandes, les attributs accessibles et les composants créés après le chargement.
- Correction des paramètres, menus de modèles, aide, accueil, profil de tokens, intégrations, laboratoire, VM, mémoire de corrections et messages usuels de connexion.
- Actualisation des sélecteurs personnalisés lors du changement de langue, y compris leurs infobulles et libellés accessibles. La préférence est conservée après rechargement.
- Transmission de la langue aux pages internes du navigateur et à ses menus natifs via le serveur et son canal WebView2. Les sites externes ne reçoivent pas ce script de localisation.
- Apparition progressive des panneaux et des listes déroulantes, transition de la fenêtre des paramètres, coins arrondis avec découpe de son contenu. Les animations respectent la préférence de réduction des mouvements.

## Vérifications réalisées

| Contrôle | Résultat |
| --- | --- |
| Suite `npm test` | 117 tests : 116 réussis, 0 échec, 1 ignoré |
| Syntaxe JavaScript et `git diff --check` | Réussis ; avertissements Git de conversion LF/CRLF |
| Interface anglaise, serveur source | 18 vues : aucun texte français détecté par le contrôle, aucune erreur JavaScript |
| Même contrôle, serveur Windows compilé | 18 vues : aucun texte français détecté, aucune erreur JavaScript |
| Choix de langue depuis le menu | Réussi |
| Langue conservée après rechargement | Réussi |
| Retour au français | Sélecteur et navigation VM vérifiés |
| Contenu utilisateur | Un message français reste inchangé |
| Erreur d’identifiants incorrects | Message rendu en anglais, réponse du serveur réel |
| Fenêtre de paramètres à 1280, 1024, 768 et 390 px | Contenue dans le viewport |
| Animation des panneaux et réduction des mouvements | Styles calculés vérifiés |
| Pages internes du navigateur | 6 documents : libellés statiques contrôlés en anglais ; restauration du français et protection des messages vérifiées |
| Canal natif du navigateur | Test de démarrage, ressources internes et injection de la langue réussi avec une fenêtre native simulée |
| Régression accueil / GitHub / tokens | Test existant réussi ; réponse IA et statistiques simulées |
| Serveur Windows compilé | Smoke réussi : interface, raisonnement, GGUF, préférences, connexion ChatGPT, MCP stdio, Blender et dictée |
| Sources / interface livrée | SHA-256 identiques pour index.html, app.css et tous les scripts d’interface |

Les preuves détaillées se trouvent dans `.tmp/language-ui/audit.json`, les captures de ce dossier et les journaux `.tmp/language-*.log`.

## Compilation et livrables

Serveur, CLI Rust, client terminal, fenêtre Windows et installateur ont été construits avec succès. Après les dernières corrections du catalogue, le serveur et l’installateur ont été reconstruits et le catalogue final copié dans l’interface livrée.

- Installateur : `native/installer/zaalis-setup.exe`
- Taille : 463 375 988 octets, soit environ 442 Mio.
- Dernière compilation : 2026-10-06 à 19:15:21, heure locale.
- SHA-256 : `4944AD8BFB79D00740AEC02D0EAE4EFF2007B7CB23F9FB6DA91D3C43C13C4FEE`
- En-tête Windows : MZ ; signature Authenticode : `NotSigned`.

Le packager émet des avertissements sur Electron et certains chemins de la copie du navigateur. Ils n’ont pas empêché la compilation ; les tests du serveur compilé et du canal du navigateur passent.

## Portée de la preuve

Les contrôles confirment l’anglais sur les vues parcourues et les libellés statiques des six pages internes du navigateur. Ils ne constituent pas une preuve exhaustive de chaque erreur rare d’un fournisseur externe ou de chaque dialogue natif. Les scripts fonctionnels de ces six documents ont été retirés pour leur contrôle statique ; le canal natif est contrôlé séparément avec une fenêtre simulée. La fenêtre Windows installée et les animations dans son WebView2 n’ont pas été vérifiées manuellement après installation.

Les messages de conversation, noms de fichiers et contenus des sites restent dans leur langue d’origine. Aucun service externe, compte personnel ou installation existante n’a été modifié par les fixtures de vérification.

## État Git

Travail local sur `main`, base `d9c8e0c0a54628c30399fa106564a78e7369c08f`. Les corrections de cette demande ne sont pas commitées ni poussées. Le dossier préexistant `video-pub/` a été conservé.
