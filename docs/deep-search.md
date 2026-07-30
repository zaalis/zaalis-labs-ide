# Deep search — note de conception

Statut : IMPLEMENTE. Outil natif `deep_search` dans `agent-engine.js`
(fonctions `runDeepSearch` / `planSubQuestions` / `planGaps` /
`runResearchTask` / `synthesizeDeep`) et defini dans `tool-protocol.js`.
Ce document garde le raisonnement de conception et les pistes d'evolution.

La recherche web simple existe aussi : outils natifs `web_search` (DuckDuckGo,
gratuit, sans cle) et `web_fetch` (lecture d'une page publique), definis dans
`web.js` et cables dans `agent-engine.js` / `tool-protocol.js`. Une passe :
`web_search` -> quelques `web_fetch` -> reponse.

Le « deep search » (style Gemini Deep Research / ChatGPT) n'est PAS un autre
moteur : c'est une **boucle d'agent qui s'auto-relance** jusqu'a ce que le sujet
soit couvert. Les quatre curseurs ci-dessous sont deja branches ; les valeurs
par defaut sont les constantes `DEEP_*` en haut de `agent-engine.js`.

## Les 4 curseurs (etat actuel)

1. **Iterations** — `DEEP_MAX_ROUNDS = 2` : une passe initiale + une passe de
   comblement des trous decidee par `planGaps` (qui peut repondre `[]` pour
   arreter plus tot).
2. **Budget de tokens** — chaque sous-question part dans un sous-agent
   `runResearchTask` (base sur `runSubAgentTask`, lecture seule, web_search /
   web_fetch) qui **remonte un resume court + ses sources**, pas les pages
   brutes. La synthese ne voit que ces resumes.
3. **Largeur** — `DEEP_MAX_SUBQUESTIONS = 4` sous-questions par passe, lancees
   en parallele (`Promise.all`), avec un plafond absolu `DEEP_MAX_TASKS_TOTAL = 6`
   sur le nombre total de sous-agents.
4. **Critere d'arret** — la boucle s'arrete quand `planGaps` renvoie `[]`,
   quand le plafond de taches est atteint, ou apres `DEEP_MAX_ROUNDS`.

## Architecture livree

```
runDeepSearch (agent-engine.js)
  planSubQuestions   -> decoupe la question en N sous-questions (JSON)
  Promise.all(runResearchTask)  -> fan-out lecture seule
       chaque task: web_search -> web_fetch xK -> resume + Sources
  planGaps           -> 0 a 2 sous-questions de comblement, sinon []
  synthesizeDeep     -> synthese citee, langue = ctx.language
  -> texte final + liste de sources dedupliquees
```

`deep_search` est un outil natif en lecture seule (actif dans tous les modes de
permission). Il n'est PAS disponible aux sous-agents, ce qui empeche toute
recursion. Les sous-agents de recherche ne peuvent appeler ni `task` ni
`deep_search`.

## Points d'attention (respectes)

- Garde-fou SSRF de `web.js` conserve (adresses privees / metadata bloquees).
- Budgets bornes par les constantes `DEEP_*` (temps via `DEEP_TIMEOUT_MS`).
- Deduplication des URLs entre sous-agents (`dedupe`).
- Synthese citee, jamais de contenu invente (consigne dans `synthesizeDeep`).

## Pistes d'evolution

- Streaming des evenements de sous-agents vers l'UI (aujourd'hui remontes en
  bloc dans `result.events`).
- Rendre les budgets `DEEP_*` configurables par requete / par utilisateur.
- Cache de pages entre sous-agents pour eviter de relire une meme URL.

## Option moteur payant (facultatif, plus tard)

Si la qualite gratuite ne suffit pas, brancher un fournisseur oriente IA
(Tavily, Brave Search API) derriere la meme fonction `webSearch` de `web.js`,
via une cle en configuration. Le reste du systeme (outils, boucle, sous-agents)
ne change pas.
