/* =====================================================================
   Contenu de l'aide / documentation (titres + descriptifs).
   Éditable facilement : ajoute/retire des entrées { q, a }.
   ===================================================================== */
window.HELP_TOPICS = [
  {
    q: "C'est quoi une IA (modèle de langage) ?",
    a: "Une IA de type « modèle de langage » est un programme entraîné sur énormément de texte pour comprendre et générer du langage. Dans zaalis, elle peut répondre à tes questions, écrire et modifier du code, analyser ton projet et lancer des commandes. Plus le modèle est grand, plus il est « intelligent » — mais plus il est lourd."
  },
  {
    q: "Modèle Cloud vs Local (Ollama) — quelle différence ?",
    a: "Cloud (GPT, Claude, Gemini, Grok, Mistral) : très puissant, tourne sur les serveurs du fournisseur, nécessite une clé API (souvent payante). Local (Ollama) : tourne sur TON ordinateur, 100% gratuit et privé, mais la qualité dépend de ton matériel (un gros modèle local demande un bon GPU/RAM)."
  },
  {
    q: "Quel modèle choisir ?",
    a: "Pour coder sérieusement : un gros modèle cloud (Claude, GPT) est le plus fiable. Pour rester gratuit/privé : Ollama avec qwen2.5-coder (code) ou qwen3 (général). Sur un petit PC : reste sur des modèles 3B–8B (légers). Sur un bon GPU : tu peux monter à 14B–32B."
  },
  {
    q: "C'est quoi la quantization (Q4, Q6, Q8) ?",
    a: "C'est une compression du modèle pour le rendre plus léger. Q4 = plus petit et rapide, qualité correcte (recommandé par défaut, ex. Q4_K_M). Q6 = bon compromis. Q8 = quasi qualité maximale mais plus lourd. Plus le chiffre est élevé, meilleure est la qualité mais plus ça prend de place et de mémoire."
  },
  {
    q: "C'est quoi le contexte et les tokens ?",
    a: "Le « contexte » est la mémoire de la conversation : tout ce que l'IA garde en tête (tes messages + ses réponses + le projet). Il se mesure en « tokens » (~4 caractères = 1 token). Chaque modèle a une limite (fenêtre de contexte). La barre sous le sélecteur montre combien tu en utilises ; quand ça approche de la limite, zaalis compacte automatiquement les anciens messages."
  },
  {
    q: "C'est quoi le raisonnement (reasoning) ?",
    a: "Certains modèles « réfléchissent » avant de répondre (étapes internes), ce qui améliore les réponses complexes. Le curseur de réflexion (MAX/MED/OFF) règle l'effort. Sur les modèles compatibles, tu peux déplier « Réflexion durant Xs » pour voir le raisonnement."
  },
  {
    q: "C'est quoi la vision (images) ?",
    a: "Les modèles « vision » peuvent analyser des images que tu joins (bouton +). Côté cloud : GPT-4o, Claude, Gemini, Pixtral. Côté local : llava, llama3.2-vision. Si un modèle ne supporte pas la vision, l'option Image est grisée."
  },
  {
    q: "C'est quoi le mode Agents ?",
    a: "Plusieurs IA travaillent en équipe sur la même tâche : chacune a un rôle (Développeur, Architecte, Reviewer…), un « Chef de projet » coordonne et produit la réponse finale. Coche au moins 2 agents et donne une tâche."
  },
  {
    q: "Les modes Supervisé / Semi-auto / Autonome ?",
    a: "Ils règlent la liberté de l'IA sur ton projet. Supervisé : chaque modification/commande demande ton accord. Semi-auto : les fichiers sont écrits automatiquement, les commandes demandent validation. Autonome : l'IA agit sans rien demander (plus rapide, mais à utiliser en confiance)."
  },
  {
    q: "Comment installer un modèle local ?",
    a: "Clique « Installer des modèles » → onglet Populaires (curé) ou Hugging Face (recherche). Choisis un modèle, clique Installer (et la version/quant pour Hugging Face). Il se télécharge puis apparaît dans le sélecteur Ollama. Ollama se lance tout seul au démarrage de zaalis."
  }
];
