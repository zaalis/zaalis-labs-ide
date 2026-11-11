# Pont Blender Zaalis — réalisation et comparaison, 11 novembre 2026

## Ce qui est livré

Une extension Blender originale (`native/blender/zaalis_bridge/`), son archive
reproductible et un connecteur MCP JavaScript intégré à Zaalis. Le pont actif
ne dépend plus de Blender Lab. L'API `bpy`, Blender et Python restent évidemment
des dépendances : « maison » décrit le pont et ses outils, pas le moteur 3D.

Le connecteur expose **30 outils**, dont les 18 précédents et 12 nouveaux :

| Outil | Fonctionnement |
|---|---|
| `scene_audit` | Comptage sur les maillages évalués : triangles, arêtes ouvertes/non manifold, faces dégénérées, sommets isolés, UV, échelles et images absentes. Profils général/jeu/impression. |
| `scene_snapshot` | État nommé : géométrie de base hachée, transformations monde, dimensions, matériaux/nœuds, paramètres des modificateurs et Geometry Nodes. 20 états en session. |
| `verify_changes` | Différence avec cet état et vérification d'attentes : présence, dimensions avec tolérance, matériau et triangles maximum. |
| `checkpoint` | Création d'une copie `.blend`, liste et restauration explicite. Les fichiers persistants sont nommés par UUID ; les noms utilisateur ne deviennent pas des chemins. |
| `performance_report` | Classement des triangles, expansion des modificateurs, temps de lecture et estimation mémoire des textures. |
| `place_objects` | Prévisualisation puis application explicite : alignement d'origines, distribution selon les boîtes monde et dépose verticale sur une surface via neuf rayons. |
| `detect_intersections` | BVH sur surfaces évaluées en coordonnées monde ; filtrage par boîtes englobantes. |
| `export_asset` | Analyse puis export explicite GLB ou FBX avec profils Roblox/Unreal. Refus d'écrasement, sélection restaurée. Pas d'animation dans ces profils. |
| `create_pbr_material` | Matériau Principled BSDF paramétrique, affecté aux faces cibles ; les maillages partagés sont isolés avant modification. |
| `create_geometry_repeat` | Vrai groupe Geometry Nodes avec entrées Count/Spacing et modificateurs. Génère une répétition linéaire avec géométrie réalisée. |
| `update_geometry_repeat` | Modifie les entrées de chaque modificateur sans modifier les autres utilisateurs du groupe. Adaptation aux API 5.2 et 5.3. |
| `inspect_batch` | Plusieurs diagnostics en un échange réseau, uniquement dans une liste de sections de lecture autorisées. |

Les descriptions MCP et le skill généré présentent ces outils à l'agent. Les
arguments sont validés côté serveur avant exécution. Les opérations de placement
se prévisualisent par défaut ; `apply=true` applique. L'export nécessite
`export=true`. Les outils de modification enregistrent une étape d'annulation
lorsqu'une interface Blender est présente. Les checkpoints restent le recours
pour une restauration complète.

## Exemples d'appels MCP

```json
{"tool":"scene_audit","arguments":{"profile":"game","triangle_budget":50000}}
{"tool":"scene_snapshot","arguments":{"name":"avant","objects":["Cube"]}}
{"tool":"checkpoint","arguments":{"action":"create","name":"Avant modélisation"}}
{"tool":"create_geometry_repeat","arguments":{"objects":["Cube"],"name":"Repeater","count":5,"spacing":[3,0,0]}}
{"tool":"update_geometry_repeat","arguments":{"objects":["Cube"],"modifier":"Repeater","count":8}}
{"tool":"verify_changes","arguments":{"snapshot":"avant","expectations":[{"name":"Cube","max_triangles":1000}]}}
{"tool":"export_asset","arguments":{"objects":["Cube"],"profile":"gltf"}}
```

Les attentes utilisent les dimensions Blender dans les unités de la scène. Le
rapport d'export donne `scale_length` ; la dépose et l'espacement utilisent le
repère monde. Les couleurs du constructeur PBR sont des composantes RGBA linéaires.

## Comparaison à Blender Lab officiel

Référence : [page officielle](https://www.blender.org/lab/mcp-server/),
[source officielle](https://projects.blender.org/lab/blender_mcp), add-on fourni
v1.0.3. L'inventaire des outils du MCP officiel connecté à cette session couvre
exécution Python, inspections de fichiers/objets, documentation API et manuel,
captures, navigation et rendu, avec plusieurs variantes en arrière-plan.

| Aspect | Blender Lab | Zaalis dans ce dépôt |
|---|---|---|
| Architecture | Extension officielle et processus MCP externe selon la documentation | Extension Zaalis + serveur MCP dans l'IDE |
| Python arbitraire | Oui | Oui ; les outils spécialisés exécutent du Python validé/préécrit |
| Diagnostic métier, comparaison, copies de restauration, placement, exports et constructeurs | Réalisables par scripts via Python ; pas de prétention d'exclusivité fonctionnelle | Outils nommés, schémas, rapports et tests dédiés |
| Documentation | Recherche API et manuel dans l'inventaire officiel | Introspection de l'API installée ; pas de remplacement complet de la recherche du manuel officiel |
| Connexion locale | Socket configurable ; l'archive v1.0.3 examinée n'a pas le jeton Zaalis | Interface loopback fixe et jeton aléatoire |
| Réglage d'accès en ligne | Demandé par l'add-on v1.0.3 | Le pont ne modifie pas ce réglage |
| Limite de données | Exécution Python reste une capacité très large | Authentification et bornes réseau, mais pas de sandbox pour du Python autorisé |
| Maintenance | Projet Blender Lab | Compatibilité, bugs et maintenance à notre charge |

L'outil Python officiel peut exécuter les mêmes algorithmes. Le gain de Zaalis
est leur formalisation, leur intégration et la réduction des échanges/erreurs,
pas une capacité mathématique inaccessible au MCP officiel.

## Mesure de réactivité réelle

Résultat enregistré dans `blender-bridge-benchmark-20261111.json`. Script :
`node scripts/benchmark-blender-bridge.js`, avec `BLENDER_TEST_EXE` défini.

Deux processus Blender 5.3.0 avec interface, lancés séparément avec paramètres
d'usine et préférences isolées ; aucune scène utilisateur ouverte. Même code
de lecture, socket loopback, 4 appels de chauffe puis 12 mesures séquentielles.
Les véritables timers des deux extensions fonctionnent dans l'interface.

| Mesure | Blender Lab v1.0.3 | Zaalis v1.0.0 |
|---|---:|---:|
| Médiane par appel | 253,544 ms | 11,058 ms |
| 95e percentile (12 mesures) | 254,366 ms | 12,585 ms |
| Intervalle actif | 250 ms, défaut officiel | 10 ms |

Rapport des médianes : **22,93** dans ce scénario. Cette différence provient
principalement de la fréquence de traitement : le timer officiel est réglable.
La fréquence Zaalis implique davantage de réveils du thread principal au repos
(elle n'est pas adaptative dans cette version). Ce résultat ne mesure ni les FPS,
ni le rendu, ni la qualité de raisonnement du modèle. Il n'établit aucune
supériorité universelle. Le gain de `inspect_batch` dépend du nombre d'échanges
évités et du coût des diagnostics.

## Validation et limites

Les tests réels emploient une scène de test dans des processus séparés sur
Windows, Blender 5.2.2 et 5.3.0. Ils couvrent : authentification refusée avec
mauvais jeton ; audit de topologie ouverte ; empreinte d'une modification de
sommet ; détection d'une modification de shader et d'entrée Geometry Nodes ;
alignement, distribution, dépose ; intersections ; isolation des maillages
partagés ; nombre de sommets évalués ; export et réimport GLB/FBX avec dimensions
vérifiées ; restauration d'un `.blend` et continuité de la connexion. Le ZIP est
également installé et activé dans un profil temporaire via le chemin d'installation
réel, sans activer l'accès en ligne ni exposer le jeton dans le statut public.

Commandes :

```powershell
python scripts/build-blender-bridge.py
node --test test/blender-connector.test.js
$env:BLENDER_TEST_EXE = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
node --test test/blender-live.test.js
$env:BLENDER_TEST_EXE = 'C:\Program Files\Blender Foundation\Blender 5.3\blender.exe'
node --test test/blender-live.test.js
$env:BLENDER_BENCH_REPORT = 'docs/blender-bridge-benchmark-20261111.json'
node scripts/benchmark-blender-bridge.js
npm test
npm run check:mojibake
```

Résultat final de la suite générale avec Blender 5.3 : **211 tests réussis,
0 échec, 1 ignoré** (212 au total). Les tests Blender ciblés passent également
sur 5.2. Le serveur Windows a été compilé dans un répertoire de contrôle et
`node test/blender-package-smoke.js` vérifie le chargement du nouveau connecteur,
la découverte du ZIP et le statut authentifié avec un compte et un profil
jetables. Le contrôle d'encodage et `git diff --check` passent. La compilation
pkg signale des avertissements sur des fichiers du navigateur intégré et des
dépendances externes ; le test du serveur réussit, mais ne certifie pas un
installateur IDE complet ni toutes les fonctions du navigateur.

Limites explicites :

- Aucun test d'import dans Roblox Studio ou Unreal n'est prétendu. Les exports
  sont réimportés dans Blender ; les moteurs cibles doivent encore être validés.
- La topologie n'est pas une preuve d'imprimabilité et ne vérifie pas les UV
  superposés, l'orientation globale des normales ou l'auto-intersection.
- Le BVH cherche des intersections de surfaces, pas un objet entièrement
  enfermé dans un autre sans contact.
- La dépose à neuf rayons est un placement vertical approximatif ; elle ne
  garantit pas l'absence de pénétration sur une surface très irrégulière.
- Les snapshots ne remplacent pas une copie persistante et ne vérifient pas
  tous les attributs, pixels externes, courbes d'animation ou critères esthétiques.
- Les estimations mémoire et temps de lecture ne sont ni une mesure VRAM exacte
  ni un benchmark de recalcul à froid.
- Les constructeurs fournissent un matériau PBR et un modèle de répétition
  linéaire. Les autres graphes passent toujours par l'API Python générale.
- Les calculs longs bloquent le thread principal. Une requête en attente peut
  expirer ; un script déjà en cours ne peut pas être interrompu de force.
- Le paquet source est prêt ; les préférences du profil Blender de l'utilisateur
  ne sont pas modifiées par les tests. L'installateur complet de l'IDE doit être
  reconstruit pour distribuer le nouveau pont dans une application native déjà installée.
