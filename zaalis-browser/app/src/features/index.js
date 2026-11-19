// Liste ordonnée des modules de fonctionnalités chargés par main.js
// (loadFeatures). Chaque module exporte init(ctx) — voir « Modules de
// fonctionnalités » dans main.js pour le contexte disponible.
module.exports = [
  'updater',
  'tabgroups',
  'memorysaver',
  'taskmanager',
  'crashes',
  'passwords',
  'autofill',
  'importer',
  'webrequest',      // répartiteur webRequest partagé (doit précéder ses abonnés)
  'safebrowsing',
  'certificates',
  'clienthints',
  'defaultbrowser',
  'extensions',
  'translate',
  'spellcheck',
  'reader',
  'qrcode',
  'cast',
  'sync',            // après passwords / autofill (fusionne leurs données)
];
