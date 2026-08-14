/* =====================================================================
   Contenu de l'aide / documentation (titres + descriptifs).
   ?ditable facilement : ajoute/retire des entr?es { q, a }.
   ===================================================================== */
window.HELP_TOPICS = [
  {
    q: "C'est quoi une IA (mod?le de langage) ?",
    a: "Une IA de type ? mod?le de langage ? est un programme entra?n? sur ?norm?ment de texte pour comprendre et g?n?rer du langage. Dans zaalis, elle peut r?pondre ? tes questions, ?crire et modifier du code, analyser ton projet et lancer des commandes. Plus le mod?le est grand, plus il est ? intelligent ? ? mais plus il est lourd."
  },
  {
    q: "Mod?le Cloud vs Local (Ollama) ? quelle diff?rence ?",
    a: "Cloud (GPT, Claude, Gemini, Grok, Mistral) : tr?s puissant, tourne sur les serveurs du fournisseur, n?cessite une cl? API (souvent payante). Local (Ollama) : tourne sur TON ordinateur, 100% gratuit et priv?, mais la qualit? d?pend de ton mat?riel (un gros mod?le local demande un bon GPU/RAM)."
  },
  {
    q: "Quel mod?le choisir ?",
    a: "Pour coder s?rieusement : un gros mod?le cloud (Claude, GPT) est le plus fiable. Pour rester gratuit/priv? : Ollama avec qwen2.5-coder (code) ou qwen3 (g?n?ral). Sur un petit PC : reste sur des mod?les 3B?8B (l?gers). Sur un bon GPU : tu peux monter ? 14B?32B."
  },
  {
    q: "C'est quoi la quantization (Q4, Q6, Q8) ?",
    a: "C'est une compression du mod?le pour le rendre plus l?ger. Q4 = plus petit et rapide, qualit? correcte (recommand? par d?faut, ex. Q4_K_M). Q6 = bon compromis. Q8 = quasi qualit? maximale mais plus lourd. Plus le chiffre est ?lev?, meilleure est la qualit? mais plus ?a prend de place et de m?moire."
  },
  {
    q: "C'est quoi le contexte et les tokens ?",
    a: "Le ? contexte ? est la m?moire de la conversation : tout ce que l'IA garde en t?te (tes messages + ses r?ponses + le projet). Il se mesure en ? tokens ? (~4 caract?res = 1 token). Chaque mod?le a une limite (fen?tre de contexte). La barre sous le s?lecteur montre combien tu en utilises ; quand ?a approche de la limite, zaalis compacte automatiquement les anciens messages."
  },
  {
    q: "C'est quoi le raisonnement (reasoning) ?",
    a: "Certains mod?les ? r?fl?chissent ? avant de r?pondre (?tapes internes), ce qui am?liore les r?ponses complexes. Le curseur de r?flexion (MAX/MED/OFF) r?gle l'effort. Sur les mod?les compatibles, tu peux d?plier ? R?flexion durant Xs ? pour voir le raisonnement."
  },
  {
    q: "C'est quoi la vision (images) ?",
    a: "Les mod?les ? vision ? peuvent analyser des images que tu joins (bouton +). C?t? cloud : GPT-4o, Claude, Gemini, Pixtral. C?t? local : llava, llama3.2-vision. Si un mod?le ne supporte pas la vision, l'option Image est gris?e."
  },
  {
    q: "C'est quoi le mode Agents ?",
    a: "Plusieurs IA travaillent en ?quipe sur la m?me t?che : chacune a un r?le (D?veloppeur, Architecte, Reviewer?), un ? Chef de projet ? coordonne et produit la r?ponse finale. Coche au moins 2 agents et donne une t?che."
  },
  {
    q: "Les modes Supervis? / Semi-auto / Autonome ?",
    a: "Ils r?glent la libert? de l'IA sur ton projet. Supervis? : chaque modification/commande demande ton accord. Semi-auto : les fichiers sont ?crits automatiquement, les commandes demandent validation. Autonome : l'IA agit sans rien demander (plus rapide, mais ? utiliser en confiance)."
  },
  {
    q: "C'est quoi le GGUF (mod?le local sans Ollama) ?",
    a: "GGUF est un format de fichier qui contient un mod?le d'IA pr?t ? tourner sur ton ordinateur. zaalis embarque son propre moteur (llama.cpp) : tu t?l?charges un seul fichier .gguf et il tourne directement, SANS avoir besoin d'installer Ollama. C'est totalement s?par? d'Ollama ? deux moteurs ind?pendants : ? Ollama ? pour les mod?les Ollama, ? GGUF ? pour les fichiers .gguf locaux. Avantage : l?ger, priv?, gratuit, et tu choisis exactement le fichier et sa quantization (Q4, Q6, Q8?)."
  },
  {
    q: "C'est quoi Vulkan, ROCm et CPU (acc?l?ration GPU) ?",
    a: "Ce sont les fa?ons dont le moteur GGUF peut calculer sous Linux. Vulkan utilise le GPU (NVIDIA, Intel ou AMD) pour acc?l?rer les r?ponses. ROCm est pr?f?r? sur les cartes AMD quand son runtime est install?. CPU calcule uniquement avec le processeur, ce qui marche partout mais reste plus lent. Auto d?tecte la meilleure variante, puis repasse en CPU si le moteur GPU ne d?marre pas."
  },
  {
    q: "Comment installer un mod?le local ?",
    a: "Clique ? Installer des mod?les ? ? onglet Populaires (cur?) ou Hugging Face (recherche). Choisis un mod?le, clique Installer (et la version/quant pour Hugging Face). Il se t?l?charge puis appara?t dans le s?lecteur Ollama. Ollama se lance tout seul au d?marrage de zaalis."
  }
];
