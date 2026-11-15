'use strict';
// Descriptions des erreurs réseau et cibles des liens Safe Links.
// (extrait de main.js — aucune dépendance sur l'état du navigateur)

// Libellé + explication d'un code d'erreur réseau Chromium (net_error_list.h).
// Avant, toute erreur affichait « vérifiez l'adresse », y compris quand le lien
// était correct (coupure réseau, certificat, redirections en boucle…).
function describeNetError(code, host) {
  const c = Number(code);
  const known = {
    '-105': ['ERR_NAME_NOT_RESOLVED', 'Ce site est inaccessible', `Impossible de trouver l'adresse IP du serveur de <code>${host}</code>. Vérifiez l'adresse saisie.`],
    '-137': ['ERR_NAME_RESOLUTION_FAILED', 'Ce site est inaccessible', `La résolution DNS de <code>${host}</code> a échoué. Vérifiez votre connexion ou votre DNS.`],
    '-106': ['ERR_INTERNET_DISCONNECTED', 'Aucune connexion Internet', 'Vérifiez le câble réseau, le modem ou le Wi-Fi, puis réessayez.'],
    '-21':  ['ERR_NETWORK_CHANGED', 'La connexion a été interrompue', 'Un changement de réseau a été détecté. Réessayez.'],
    '-100': ['ERR_CONNECTION_CLOSED', 'Ce site est inaccessible', `<code>${host}</code> a fermé la connexion de manière inattendue.`],
    '-101': ['ERR_CONNECTION_RESET', 'Ce site est inaccessible', 'La connexion a été réinitialisée. Un pare-feu, un proxy ou le réseau peut en être la cause.'],
    '-102': ['ERR_CONNECTION_REFUSED', 'Ce site est inaccessible', `<code>${host}</code> n'autorise pas la connexion.`],
    '-104': ['ERR_CONNECTION_FAILED', 'Ce site est inaccessible', 'La tentative de connexion a échoué.'],
    '-109': ['ERR_ADDRESS_UNREACHABLE', 'Ce site est inaccessible', `L'adresse de <code>${host}</code> est injoignable depuis ce réseau.`],
    '-118': ['ERR_CONNECTION_TIMED_OUT', 'Ce site est inaccessible', `<code>${host}</code> a mis trop de temps à répondre.`],
    '-7':   ['ERR_TIMED_OUT', 'Ce site est inaccessible', `<code>${host}</code> a mis trop de temps à répondre.`],
    '-310': ['ERR_TOO_MANY_REDIRECTS', 'Cette page ne fonctionne pas', `<code>${host}</code> vous a redirigé à de trop nombreuses reprises. Effacez les cookies de ce site puis réessayez.`],
    '-20':  ['ERR_BLOCKED_BY_CLIENT', 'Cette page a été bloquée', 'Le chargement de cette page a été bloqué.'],
    '-27':  ['ERR_BLOCKED_BY_RESPONSE', 'Cette page a été bloquée', 'Le serveur interdit l\'affichage de cette page dans ce contexte.'],
    '-300': ['ERR_INVALID_URL', 'Adresse non valide', 'L\'adresse de cette page n\'est pas valide.'],
    '-301': ['ERR_DISALLOWED_URL_SCHEME', 'Adresse non prise en charge', 'Ce type de lien ne peut pas être ouvert dans un onglet.'],
    '-302': ['ERR_UNKNOWN_URL_SCHEME', 'Adresse non prise en charge', 'Ce type de lien ne peut pas être ouvert dans un onglet.'],
    '-324': ['ERR_EMPTY_RESPONSE', 'Cette page ne fonctionne pas', `<code>${host}</code> n'a envoyé aucune donnée.`],
    '-337': ['ERR_HTTP2_PROTOCOL_ERROR', 'Cette page ne fonctionne pas', `<code>${host}</code> a renvoyé une réponse non valide. Réessayez.`],
    '-356': ['ERR_QUIC_PROTOCOL_ERROR', 'Cette page ne fonctionne pas', 'Erreur du protocole QUIC. Réessayez.'],
    '-130': ['ERR_PROXY_CONNECTION_FAILED', 'Aucune connexion Internet', 'Le serveur proxy ne répond pas. Vérifiez les paramètres proxy de Windows.'],
  };
  if (known[String(c)]) return known[String(c)];
  if (c <= -200 && c > -300) {
    return ['ERR_CERT_' + Math.abs(c), 'Votre connexion n\'est pas privée',
      `Le certificat de sécurité de <code>${host}</code> n'est pas valide. Des personnes malveillantes pourraient tenter de dérober vos informations.`];
  }
  return [`ERREUR_${c}`, 'Cette page ne fonctionne pas', `Impossible d'afficher <code>${host}</code> pour le moment.`];
}

// Liens « enveloppés » par un filtre de messagerie (Microsoft Safe Links :
// Outlook, Teams). L'adresse réelle est dans le paramètre `url`. Quand le
// filtre est injoignable (réseau qui bloque Exchange Online, panne…), la page
// d'erreur propose d'ouvrir directement cette destination.
function wrappedLinkTarget(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    const host = x.hostname.toLowerCase();
    const safeLinks = host.endsWith('.safelinks.protection.outlook.com') ||
      (host === 'statics.teams.cdn.office.net' && x.pathname.includes('/safelinks/'));
    if (!safeLinks) return null;
    const dest = new URL(x.searchParams.get('url') || '');
    if (dest.protocol !== 'https:' && dest.protocol !== 'http:') return null;
    if (dest.username || dest.password) return null;
    return dest.toString();
  } catch { return null; }
}

// Erreurs réseau pour lesquelles le serveur n'a pas pu être joint.
const UNREACHABLE_NET_ERRORS = new Set([-7, -21, -100, -101, -102, -104, -105, -109, -118, -137, -324]);

module.exports = { describeNetError, wrappedLinkTarget, UNREACHABLE_NET_ERRORS };
