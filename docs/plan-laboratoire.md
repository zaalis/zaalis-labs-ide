# Moteur d'expériences et laboratoire — plan du 5 octobre 2026

1. Conserver le moteur Rust et les permissions hôte ; enregistrer chaque appel fournisseur, y compris interrompu, sans additionner les totaux cumulés.
2. Normaliser les catégories de tokens, conserver les mesures manquantes et partager une enveloppe entre les branches.
3. Fournir des expériences VM isolées : copie du projet, préparation explicite, hypothèses, tests avec assertions, preuves persistantes, retest final et arrêt.
4. Indexer les résultats et les échecs par utilisateur, projet et empreinte d'environnement. Une panne d'infrastructure ne réfute pas une hypothèse.
5. Exécuter progressivement, avec un parallélisme borné ; arrêter les branches inutiles et permettre l'annulation.
6. Exposer le laboratoire aux agents par un outil structuré et à l'utilisateur dans les paramètres VM. Ajouter les statistiques semaine/mois/année.
7. Comparer des exécutions appariées ; afficher les économies seulement quand une référence comparable existe.
8. Vérifier les contrats, migrations, isolation, budget, reprise, erreurs, parcours VM réels, interface et paquet Windows. Déposer les preuves et limites sur le Bureau.

La certification porte sur les scénarios exécutés. Aucun pourcentage d'économie ni absence universelle de défaut ne sera inventé.
