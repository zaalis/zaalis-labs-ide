# Rapport d’intégration zaalis IDE — 26 septembre 2026

## Ce qui est intégré

- Deux dispositions avec un seul état de projet et de conversation : **Éditeur** (code au centre, chat latéral) et **Chat IDE** (chat au centre, projets et conversations à gauche). À droite : fichiers, zaalis browser, terminal, artefacts, activité des agents et lecture d’un autre chat. La disposition et la largeur du panneau sont mémorisées.
- zaalis browser est hébergé par la fenêtre native Win32/WebView2. Son code de navigation, ses onglets, son accueil et son profil sont intégrés comme composant natif ; l’interface Web envoie les dimensions et les commandes au composant.
- Les conversations conservent leur identifiant de session Rust et leur historique API. Le démon sauvegarde et restaure l’arbre des agents et le contexte de travail. Les appels d’outils sont journalisés, le contexte trop grand est condensé, et les résultats d’outils interrompus ne sont pas rejoués automatiquement.
- Les modèles disposent de capacités déclarées (outils, vision, contexte, raisonnement contrôlable ou natif). L’interface ne propose des niveaux de raisonnement que lorsque le fournisseur les accepte. Ollama est interrogé pour les capacités du modèle installé ; un simple nom de fichier GGUF ne suffit pas à déclarer la vision ou la pensée.
- Les agents et sous-agents disposent d’un suivi dans la conversation et d’une annulation ciblée. Les artefacts issus des outils sont indexés par conversation et ouvrables depuis le panneau droit. Les sous-agents lancés par `spawn_agent` restent attendus par leur parent pendant le tour ; une file de délégation asynchrone indépendante du tour n’est pas encore présente.

## Vérifications effectuées

| Vérification | Résultat |
| --- | --- |
| Tests Node (`npm test`) | 16 réussis. Le helper `node-pty` affiche encore `AttachConsole failed` pendant la suite, sans échec de test. |
| Tests Rust (`cargo test --workspace`) | Réussis ; test supplémentaire de second tour avec conservation de la réponse précédente réussi. |
| JavaScript et encodage | `node --check` et `check:mojibake` réussis. |
| Interface | Les deux dispositions rendues dans Chrome à 1600 × 900 avec serveur de données de test ; navigation, sélecteur de raisonnement et panneau droit présents. |
| Navigateur natif | Version Windows lancée avec WebView2 : panneau Chat IDE visible, hôte de 419 × 914 px, navigateur prêt et visible, un onglet ouvert, aucune erreur signalée. La disposition précédente a été restaurée. |
| Modèle local réel | `SmolLM2-135M-Instruct-Q4_K_M.gguf` a produit une réponse via le serveur, le démon Rust et llama.cpp avec une fenêtre de 8192 tokens. À 4096 tokens, le catalogue complet dépassait le contexte. Un essai de deux tours a dépassé le délai de 180 secondes ; la reprise est testée au niveau Rust, mais pas validée en bout en bout avec ce petit modèle. |
| Mistral réel | La requête atteint Mistral et l’erreur est correctement propagée ; le fournisseur répond `429 Rate limit exceeded`. Une réponse positive et la reprise de session Mistral n’ont donc pas pu être validées. |
| Compilation | Binaire Rust de production, serveur Node empaqueté, coque native et installateur Inno Setup compilés. |

## Limites avant une affirmation « 100 % fonctionnel »

La navigation vers un site externe et les téléchargements du navigateur intégré n’ont pas été exercés pendant ce test. Une réponse Mistral exige la levée de la limite 429 sur la clé configurée. La reprise du petit modèle local doit être mesurée ou plafonnée si sa génération dépasse régulièrement trois minutes. Le suivi des sous-agents existe, mais leur exécution différée et indépendante du tour parent reste à concevoir.

Le test réel a créé des copies isolées de `users.json` et du secret local sous `%TEMP%\zaalis-live-smoke-*`. Leur suppression automatique a échoué avec `EPERM`, puis la suppression manuelle par outil a été refusée par la politique de sécurité de l’environnement. Ces dossiers doivent être supprimés depuis l’Explorateur Windows une fois tous les processus zaalis de test arrêtés. Aucun secret n’a été ajouté au dépôt.
