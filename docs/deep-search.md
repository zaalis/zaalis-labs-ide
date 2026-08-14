# Recherche web native

Statut : implementee dans le core Rust partage.

Les outils `web_search`, `web_fetch` et `deep_search` sont enregistres dans le
`ToolRuntime` universel par `zaalis-extensions`. Ils sont donc disponibles de
la meme maniere pour tous les providers, Chat, Agents et le CLI.

`web_fetch` applique les protections suivantes avant toute lecture :

- protocoles limites a HTTP(S), sans identifiants ni fragment ;
- resolution DNS controlee et adresse epinglee pour la requete ;
- refus des adresses privees, loopback, link-local, metadata et non routables ;
- aucune redirection automatique ;
- contenu textuel uniquement, reponse plafonnee a 1 Mio et sortie bornee.

`deep_search` effectue une recherche bornee, lit jusqu'a six sources publiques
avec les memes garde-fous, puis retourne un dossier structure. La synthese et
les citations restent sous le controle de l'agent et de son budget.
