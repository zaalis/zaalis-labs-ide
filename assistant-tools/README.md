# Outils partagés de Zaalis

Le moteur Rust, le serveur local et les mêmes connexions servent l’IDE et le
terminal installé (`bin/zaalis.exe`). Les outils sont écrits pour Zaalis. Les
noms publics compatibles sont des interfaces ; aucun code d’agent tiers n’a
été importé.

## Utilisation

Dans l’IDE, ouvrir **Outils** : catalogue, connexions, mémoire, sessions,
compétences, tâches, planification et agents détachés. Un état « connexion
requise » signifie que l’adaptateur existe mais que son service est absent.
« Configuré, à vérifier » ne signifie pas que le compte a été testé.

Dans PowerShell :

```powershell
zaalis tools memory
zaalis assistant-memory add Préférer les explications en français
zaalis assistant-memory search français
zaalis sessions mémoire
zaalis skills create exemple .\SKILL.md
zaalis skills view exemple
zaalis schedule create '{"name":"Analyse","prompt":"Examiner le projet sans modifier les fichiers","schedule":"every 1h","timezone":"Europe/Paris"}'
zaalis jobs start Examiner les fichiers du projet
zaalis jobs list
zaalis jobs result <id>
zaalis jobs cancel <id>
zaalis jobs questions
zaalis jobs answer <question-id> '{"answer":"Continuer"}'
zaalis jobs approve <session-id> <request-id>
zaalis connections configure .\connexion.json
zaalis connections authorize spotify
zaalis --image .\capture.png -p "Décrire cette capture"
```

Ces commandes existent aussi sous forme `/tools`, `/sessions`, `/skills`, etc.
`/attach` joint une image au prochain message. `/computer on` et `--computer`
activent le contrôle ordinateur explicite. `/memory` reste la mémoire des
corrections ; `/assistant-memory` gère les notes générales.

Le modèle retrouve les outils avec `tool_search`, consulte leur schéma avec
`tool_describe`, puis appelle `tool_call`. Les outils MCP peuvent être découverts
après une nouvelle connexion, dans le même tour. Une découverte ne donne aucune
permission supplémentaire. Les appels imbriqués repassent par le garde Rust et
le contrôle du serveur ; un mode lecture seule bloque les mutations.

## Connexions

Configurer les services dans **Outils → Connexions**, ou dans un fichier JSON
explicitement fourni à la commande `connections configure`. Les identifiants
sont chiffrés dans le stockage du compte. Les options ne peuvent pas contenir
de mots de passe ou de jetons ; les placer dans `credentials`.

Exemple Spotify (l’application OAuth doit autoriser l’adresse de retour locale) :

```json
{"id":"spotify","options":{"clientId":"VOTRE_APPLICATION_OAUTH"}}
```

Exemple Home Assistant :

```json
{"id":"homeassistant","baseUrl":"http://127.0.0.1:8123","credentials":{"token":"VOTRE_JETON"}}
```

Exemple fournisseur d’images, voix et vidéo utilisant les routes compatibles :

```json
{
  "id":"media",
  "baseUrl":"https://api.x.ai/v1",
  "credentials":{"apiKey":"VOTRE_CLE"},
  "options":{"imageModel":"grok-imagine-image","videoModel":"grok-imagine-video"}
}
```

Les routes et modèles peuvent être adaptés aux capacités du fournisseur
(`imagePath`, `imageEditPath`, `videoPath`, `videoEditPath`, `videoExtendPath`,
`speechPath`, `transcriptionPath`, `responsesPath`). Chaque protocole doit être
compatible avec la route choisie. Un abonnement de chat ne donne pas
automatiquement accès à une API de génération média.

Exemple d’environnements d’exécution :

```json
{
  "id":"execution",
  "options":{"backends":[
    {"id":"conteneur","type":"docker","container":"mon-conteneur"},
    {"id":"serveur","type":"ssh","host":"utilisateur@serveur","port":22},
    {"id":"daytona","type":"daytona","sandbox_id":"VOTRE_SANDBOX"},
    {"id":"modal","type":"modal","sandbox_id":"VOTRE_SANDBOX"}
  ]},
  "credentials":{"tokens":{
    "daytona":"VOTRE_CLE",
    "modal":{"tokenId":"VOTRE_ID","tokenSecret":"VOTRE_SECRET"}
  }}
}
```

Docker, SSH et Singularity doivent être installés. SSH utilise l’authentification
existante et les clés d’hôte vérifiées. Modal requiert son SDK Python ; Daytona
utilise son API Toolbox. Les passerelles HTTPS `rpc`, `modal` ou `daytona` avec
`endpoint` sont également prises en charge. Les processus lancés ont un handle,
un temps limite, des journaux bornés, une attente et une annulation.

Un navigateur CDP nécessite un endpoint **loopback** configuré avec `id: "cdp"`.
L’endpoint HTTP de découverte permet de lister, choisir et fermer des onglets.
Le coffre exige une réponse humaine, expire au bout de cinq minutes, vérifie
l’origine exacte et ne soumet pas automatiquement un formulaire.

Les agents A2A utilisent le protocole JSON-RPC 0.3 : `options.agents` contient
des objets `{id, endpoint}`, et `credentials.tokens` les jetons associés par ID.
Yuanbao utilise le serveur MCP explicitement choisi par `mcpServer`. Discord,
Feishu/Lark et Home Assistant requièrent les permissions de leur compte/service.

## Exécution et persistance

`execute_code` lance Python avec environnement nettoyé, durée et sorties bornées,
résultat JSON et un courtier `tools.<nom>(**arguments)` soumis aux permissions.
Par défaut, la protection contient l’arbre des processus : elle **n’isole pas
le système de fichiers ni le réseau**. `strict: true` demande le confinement
du système d’exploitation, désactive le courtier et échoue si ce confinement
est indisponible. Sur la machine de validation, ce mode strict est indisponible.
Les dépendances doivent déjà être installées ou installées par une commande
terminal autorisée. Utiliser les environnements configurés/VM pour une isolation
supplémentaire.

Les agents détachés travaillent dans une copie bornée excluant Git, les caches,
les fichiers `.env` et les clés usuelles. Cette copie ne constitue pas un bac à
sable du système d’exploitation. Les résultats ne sont pas fusionnés
automatiquement. Après redémarrage, un travail interrompu requiert une reprise
explicite. Les tâches planifiées héritent du modèle et des permissions et
fonctionnent pendant que le serveur est lancé.

Le TTS local utilise les voix Windows. L’analyse vidéo nécessite FFmpeg et un
modèle vision ; la génération d’images et de vidéos nécessite le fournisseur
configuré. Les actions d’interface émettent la même demande depuis les deux
surfaces et sont présentées par l’IDE connecté.

Les scripts de validation et les preuves sont dans `scripts/assistant-*` et
`reports/assistant-*`. Les tests emploient un compte et un dossier temporaires.
