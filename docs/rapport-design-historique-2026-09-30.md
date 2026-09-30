# Mini rapport — 30 septembre 2026

- Clés API et MCP : champs espacés, cartes arrondies, séparateurs discrets et textes lisibles. Le titre MCP et les boutons de réglages dans les petites fenêtres sont corrigés.
- Navigation : icônes de dossiers conservées, icônes des chats retirées, menu « … » avec suppression confirmée. Supprimer un chat actif efface aussi sa mémoire ; une tâche en cours doit être arrêtée avant suppression.
- QR : dessin animé du Z, apparition du QR complet, traînée temporaire au passage de la souris. Les animations respectent la réduction des mouvements ; la marge blanche du QR facilite la lecture.
- Historique : les blocs d’outils conservent leur HTML et leur présentation après sauvegarde/réouverture. Les anciens blocs enregistrés en texte brut sont repliés ; leur mise en page d’origine ne peut pas être récupérée intégralement.
- Projets : restauration du dossier avant le chargement du chat, contrôle du dossier lors de la reprise Rust, et outil `workspace` pour lister puis ouvrir les projets connus dans l’IDE et le terminal. Un chat sans projet utilise un espace dédié, au lieu du dossier d’installation.

Validation : 37 tests Node réussis ; 25 tests Rust réussis et 7 tests réseau ignorés. Le test d’intégration du serveur Windows empaqueté vérifie réellement la sélection du projet, le dossier du terminal, le remplacement d’une session liée à l’ancien dossier et la reprise dans le bon projet. Les routes existantes et la restriction des fonctions desktop sont vérifiées.

Contrôle visuel : panneaux API/MCP, menu et confirmation, sauvegarde puis rechargement d’un chat, animation du Z, QR final et apparition/disparition de la traînée. Les réglages restent utilisables à 375 pixels de largeur. Le QR est vérifié avec une URL de test, sans ouvrir de tunnel public.

Le serveur et les binaires Rust sont recompilés, l’interface est synchronisée dans `native/dist`, puis l’installateur est reconstruit. Le packager signale des références Electron absentes dans le navigateur fourni ; les tests du serveur Windows passent malgré ces avertissements. Les modifications préexistantes du dépôt sont conservées.
