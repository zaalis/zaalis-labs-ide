# Deep search — note de conception (a faire plus tard)

La recherche web simple existe deja : outils natifs `web_search` (DuckDuckGo,
gratuit, sans cle) et `web_fetch` (lecture d'une page publique), definis dans
`web.js` et cables dans `agent-engine.js` / `tool-protocol.js`. Une passe :
`web_search` -> quelques `web_fetch` -> reponse.

Le « deep search » (style Gemini Deep Research / ChatGPT) n'est PAS un autre
moteur : c'est une **boucle d'agent qui s'auto-relance** jusqu'a ce que le sujet
soit couvert. Ce qui reste a construire, ce sont quatre curseurs.

## Les 4 curseurs a ouvrir

1. **Iterations** — aujourd'hui `MAX_TOOL_ROUNDS = 6` dans `agent-engine.js`.
   Un mode deep doit relancer la boucle tant que le modele signale des trous
   (ex. balise `[ENCORE]` en fin de reponse) avec un plafond dur plus haut.
2. **Budget de tokens** — lire 30+ pages sature le contexte. Solution deja
   disponible : l'outil `task` (sous-agent lecture seule) qui a maintenant acces
   a `web_search` / `web_fetch`. Chaque sous-agent recherche un sous-sujet et
   **remonte un resume**, pas les pages brutes.
3. **Largeur** — nombre de resultats par requete et nombre de requetes/sujets
   lances en parallele. Prevoir un fan-out de sous-agents `task`.
4. **Critere d'arret** — le modele continue tant qu'il reste des questions,
   s'arrete quand c'est couvert, avec un budget max (temps ou nombre de pages)
   pour ne jamais tourner a l'infini.

## Architecture proposee

```
Agent principal (planificateur)
  -> decoupe la question en N sous-sujets
  -> lance N sous-agents `task` en parallele (fan-out)
       chaque task: web_search -> web_fetch xK -> resume court + sources
  -> lit les resumes, detecte les trous
  -> relance des task cibles sur les trous (boucle)
  -> synthese finale citee (URLs)
```

Le sous-agent `task` est deja la brique : lecture seule, resume, sources. Le
mode deep = un orchestrateur au-dessus + le desserrage des 4 curseurs.

## Points d'attention

- Garder le garde-fou SSRF de `web.js` (adresses privees / metadata bloquees).
- Plafonner le cout : budget global de pages/temps affiche a l'utilisateur.
- Deduplication des URLs entre sous-agents.
- Toujours citer les sources dans la synthese ; ne jamais inventer un contenu.

## Option moteur payant (facultatif, plus tard)

Si la qualite gratuite ne suffit pas, brancher un fournisseur oriente IA
(Tavily, Brave Search API) derriere la meme fonction `webSearch` de `web.js`,
via une cle en configuration. Le reste du systeme (outils, boucle, sous-agents)
ne change pas.
