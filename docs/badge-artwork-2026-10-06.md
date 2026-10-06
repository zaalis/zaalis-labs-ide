# Illustrations des badges

Les dix images sont générées avec l’outil intégré `image_gen`, puis copiées dans `interface/image/badges/`. Les originaux restent dans le dossier de génération local. Aucun service externe de génération n’est configuré dans le produit.

Prompt commun utilisé, avec remplacement du sujet et de l’identifiant :

> Create one standalone small achievement badge icon for a desktop coding IDE: {subject}. Classic polished minimal illustration, clean front view, gold and cool slate blue palette, subtle highlights, crisp silhouette readable at 48 pixels, no text, no star shape, no surrounding badge or frame. Centered object occupying 75% of the square canvas. Transparent background. This is the {id} icon; return a saved PNG file usable in a project.

| Image | Sujet du prompt | Critère du badge |
| --- | --- | --- |
| spark.png | a single classic lightbulb | 10 000 tokens |
| worker.png | a single classic gold trophy | 3 jours actifs |
| builder.png | a simple pair of stacked building blocks | 1 million de tokens |
| terminal.png | a classic desktop terminal window with a simple command prompt chevron | 20 appels mesurés sur 12 mois |
| explorer.png | a single classic magnifying glass | 3 modèles utilisés sur 12 mois |
| ideas.png | a classic fountain pen nib | 10 jours actifs |
| architect.png | a classic drafting compass | 7 jours consécutifs |
| creator.png | a painter palette and brush | 100 millions de tokens |
| virtuoso.png | a simple laurel wreath with a central medallion | 30 jours consécutifs |
| legend.png | a classic gold crown | 1 milliard de tokens |

Les jours actifs, séries et tokens viennent des mesures enregistrées. Les modèles et appels correspondent à la période de douze mois du profil. Les badges n’ajoutent aucun crédit.
