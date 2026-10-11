# Modèles locaux fiables et WhatsApp « comme un contact » — 8 octobre 2026

## Diagnostic (modèle réel, pas une simulation)

Reproduction sur le PC de développement avec le modèle installé (`Qwen3.5-9B-Q4_K_M.gguf`), le moteur llama.cpp fourni (b9690, CUDA) et `zaalis-agentd` piloté comme le fait `server.js`. Un proxy a enregistré chaque requête et chaque réponse brute du moteur.

| Symptôme | Cause réelle | Responsable |
| --- | --- | --- |
| « Le modèle local a produit un appel d'outil invalide » | Le modèle produisait un appel **valide** : une phrase d'annonce suivie de `{"tool_call":{"name":"list",…}}`, sans bloc ```` ``` ````. Le parseur n'acceptait une annonce qu'avec un bloc ```` ``` ````. Le modèle laissait parfois aussi passer une balise `</think>`. | Parseur de l'IDE (3 échecs sur 3 avant, 3 réussites sur 3 après) |
| « Le contexte du modèle est trop petit pour les instructions et outils actifs » | Contexte GGUF par défaut de 8192 tokens, alors que les instructions et la trentaine d'outils (plus les MCP) en prennent environ 5 800. L'estimation interne (3 caractères par token) surestime ce volume d'environ 40 %. | Valeur par défaut de l'IDE |
| Le modèle annonce « Commençons par lister… » puis s'arrête | Un petit modèle peut s'arrêter avant d'écrire l'appel. | Comportement du modèle, désormais rattrapé |
| Tours locaux lents (6 à 12 s de recalcul par tour) | Le prompt système changeait à chaque tour (compteur d'outils, fichiers **lus** présentés comme « créés/modifiés ») : llama.cpp perdait son cache et recalculait 7 000 à 14 000 tokens. | Runtime de l'IDE |

L'utilisateur n'a rien provoqué.

## Corrections

- **Parseur du protocole d'outils texte** (GGUF, et modèles Ollama sans outils natifs) :
  - accepte un appel nu, entre ```` ```json ```` ou entre `<tool_call>` après une annonce ;
  - accepte les arguments encodés deux fois ;
  - retire les balises de raisonnement ;
  - reste fermé en cas d'échec : JSON tronqué, deuxième appel ou texte après l'appel ⇒ rien n'est exécuté.
- **Auto-correction** : un appel illisible n'interrompt plus le tour. Le modèle reçoit la raison précise et réessaie, jusqu'à 2 fois de suite. Ensuite seulement, un message visible explique que rien n'a été exécuté.
- **Relance unique** quand un modèle sans outils natifs annonce une action sans l'exécuter.
- **Affichage progressif** : avec un modèle local, le texte s'affiche au fil de la génération. Seul un JSON d'outil potentiel est retenu jusqu'à la fin ; il ne s'affiche jamais.
- **Contexte adaptatif** : si le catalogue complet laisse moins d'un quart du contexte à la conversation, seuls les 14 outils essentiels sont envoyés (le modèle en est informé). L'erreur ne reste que si même cela ne tient pas, et elle donne alors les chiffres réels.
- **Contexte GGUF par défaut** : 16384 au lieu de 8192 (serveur, CLI, interface, catalogue). Un réglage déjà enregistré n'est pas modifié.
- **Cache llama.cpp préservé** :
  - plus de compteur par tour dans le prompt ;
  - seuls `write`, `edit` et `apply_patch` alimentent « Fichiers déjà créés/modifiés » et `files_changed`, ce qui corrige aussi la fusion de sous-agents, qui recopiait des fichiers seulement lus.
- Mesure : 200 à 1 200 tokens recalculés par tour, contre 7 000 à 14 000 auparavant.

## WhatsApp

WhatsApp affiche tout message envoyé par un compte comme un message de ce compte. Dans la discussion avec soi-même, les réponses de l'IA apparaissent donc forcément de votre côté. Pour qu'elles arrivent comme celles d'une personne, l'IA doit écrire depuis un second compte :

- Intégrations → WhatsApp propose maintenant le choix **« Comment l'IA vous répond »** :
  - discussion avec vous-même ;
  - numéro dédié, avec le ou les numéros autorisés.
- Changer de mode déconnecte le compte relié (après confirmation), pour scanner ensuite le QR code avec le bon compte.
- Avec le numéro dédié :
  - les réponses, erreurs comprises, arrivent comme des messages reçus, sans préfixe « Zaalis · » ;
  - l'indicateur « en train d'écrire… » s'affiche pendant le travail ;
  - les messages reçus sont marqués comme lus.
- Correction : enregistrer la conversation liée remettait silencieusement le mode sur « discussion avec soi-même ».

## Vérifications

- `cargo test --workspace` : tout est vert.
  - Nouveaux tests du parseur, construits sur les réponses réellement enregistrées du modèle.
  - Nouveaux tests du runtime : auto-correction, abandon après 2 corrections, relance unique, contexte réduit, lecture jamais comptée comme modification, prompt stable d'un tour à l'autre.
- `npm test` : 156 tests verts, dont les modes WhatsApp. Le test d'import VM exige le `tar.exe` de Windows : sous Git Bash, le `tar` GNU l'emporte dans le `PATH`.
- Bout en bout avec Qwen3.5-9B :
  - « analyse et dit moi que contien le projet » : 3 réussites sur 3, avec 1 à 10 outils exécutés ;
  - « comment améliorer le projet » : analyse complète ;
  - contexte limité à 6144 : réussite avec les outils essentiels.
