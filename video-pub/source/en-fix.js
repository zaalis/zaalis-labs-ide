// Evaluated in the captured page: translate the IDE's remaining French UI strings (i18n gaps)
// and report any visible French-looking text that is still left.
(() => {
  const M = {
    'Afficher les chats': 'Show chats',
    'Afficher les fichiers': 'Show files',
    'Copier': 'Copy',
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (M[t]) node.textContent = node.textContent.replace(t, M[t]);
  }
  const french = /[éèàçùêâ]|\b(les|des|une|pour|avec|dans|Afficher|Aucun|Ouvrir|Fichiers|Modèle|Fournisseur|Ecrivez|Bienvenue)\b/;
  const lines = document.body.innerText.split('\n').map(x => x.trim()).filter(x => x && french.test(x));
  return [...new Set(lines)].slice(0, 30);
})()
