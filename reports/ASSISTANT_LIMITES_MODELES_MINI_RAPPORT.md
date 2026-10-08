# Zaalis IDE et terminal — complément du 8 octobre 2026

## Livraison

Les limites et les réglages de modèles utilisent le même moteur et le même stockage par compte dans l’IDE et le terminal Windows. Développement indépendant, à partir des interfaces et de la documentation publique de Hermes ; son code n’a pas été repris.

| Réglage | Valeur par défaut |
|---|---:|
| Étapes de l’agent principal par tour utilisateur | 500 |
| Sous-agents simultanés | 10 |
| Tours par sous-agent | 250 |

Les valeurs peuvent être réduites. Les quotas des fournisseurs continuent de s’appliquer. Dix délégations simultanées et le refus de la onzième sont couverts par un test automatisé ; aucun essai payant de 500 tours n’a été lancé.

## Modèles et MoA

- **Main Model** : modèle principal par défaut, avec choix explicite toujours possible.
- **Auxiliary Model** : modèle dédié à l’analyse des images et vidéos, via les outils existants.
- **Fallback Models** : liste ordonnée de secours en cas d’échec de démarrage d’un appel. Aucune réponse partielle ni action exécutée n’est rejouée.
- **Mixture of Agents (MoA)** : plusieurs modèles donnent un avis sans outils ; un agrégateur prépare la réponse et utilise les outils. Les références interviennent une fois par tour utilisateur par défaut. MoA est optionnel et nécessite de sélectionner les références et l’agrégateur ; ses appels consomment les quotas des modèles choisis.

Les fournisseurs, modèles et niveaux de raisonnement proviennent des catalogues et capacités partagés. ChatGPT par abonnement avec `gpt-6-luna` a été testé réellement. Les commandes terminal sont `agent-settings`, `model-policy` et `integrations`, également disponibles sous forme de commandes interactives.

## Intégrations et limites de la parité

Les **33 entrées de la capture**, plus GitHub, sont présentes dans l’onglet Intégrations : recherche, guide, configuration, test de connexion, logos ou pictogrammes locaux. Les secrets utilisent le stockage chiffré existant.

Le catalogue commun expose **171 outils**, dont `messaging_read` et `messaging_send`. Les adaptateurs HTTP disponibles et les appels MCP utilisent les mêmes permissions dans les deux interfaces. Certains services demandent un pont externe fourni et configuré par le propriétaire ; leur présence dans le catalogue ne signifie pas qu’ils sont activés.

**La parité complète avec toutes les passerelles Hermes n’est pas établie.** WhatsApp et Telegram conservent leurs passerelles de réception natives existantes. Les nouvelles connexions HTTP/MCP servent aux appels de lecture et d’envoi ; elles ne démarrent pas toutes un assistant autonome sur les messages entrants. Matrix est limité aux salons non chiffrés. Les nouveaux services n’ont pas tous été testés sur des comptes réels. Les pictogrammes de protocoles/services sans marque vérifiée ne sont pas présentés comme des logos officiels.

## Vérification et livraison Windows

- Node : **184 réussis, 1 ignoré, 0 échec**.
- Rust : **486 réussis, 8 ignorés, 0 échec**.
- Tests de bout en bout sur serveur et terminal compilés : catalogue commun, mémoire, Python, questions structurées, permissions, MCP, délégation, planification, terminal PowerShell réel.
- Test des réglages compilés : persistance, budget actualisé lors d’une reprise, composition MoA et consommation, modèle de secours.
- Essais réels Luna : MoA avec outils dans le moteur partagé, puis réponse MoA dans le terminal compilé. Les fichiers personnels de configuration sont restés inchangés.
- Interface vérifiée dans le navigateur : valeurs 500/10/250, choix Luna persistant, fiches en français et anglais, **34 icônes chargées sans erreur**.

Preuves : `assistant-settings-proof.json`, `assistant-packaged-proof.json`, `assistant-luna-moa-proof.json`, `assistant-luna-cli-proof.json` et captures du présent dossier.

Serveur, terminal et moteur reconstruits ; installateur `native/installer/zaalis-setup.exe`. Binaires non signés. La copie déjà installée de l’application n’a pas été remplacée et son environnement WebView2 n’a pas été testé pour ce complément. Les empreintes sont consignées dans `assistant-artifacts.json`.

Travail conservé sur la branche locale `codex/hermes-tool-parity`, sans publication distante.

### Références de comportement

- Délégation : https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/
- MoA : https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents/
- Origine des icônes : `interface/assets/integrations/NOTICE.md`.
