'use strict';
/* =============================================================================
 *  Client Hints « Google Chrome »
 * -----------------------------------------------------------------------------
 *  Electron surcharge l'user-agent (UA de Chrome, cf. chromeUserAgent) : dans
 *  ce cas Chromium n'envoie PLUS AUCUN Client Hint (Sec-CH-UA…), alors que
 *  Chrome les envoie à chaque requête vers une origine sûre. Certains services
 *  (Google, Microsoft, banques, plateformes vidéo) concluent alors à un
 *  navigateur « non Chrome » et dégradent l'expérience. Ce module reproduit
 *  le comportement de Chrome :
 *   - en-têtes de faible entropie toujours envoyés aux origines sûres
 *     (https, localhost) : Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform ;
 *   - en-têtes de haute entropie (Full-Version-List, Platform-Version, Arch,
 *     Bitness, Model, WoW64, Full-Version) seulement si l'origine les a
 *     demandés par « Accept-CH » sur une réponse de navigation ;
 *   - marque GREASE calculée comme Chromium (même graine = version majeure),
 *     donc identique à navigator.userAgentData, corrigé côté JavaScript par
 *     preload-content.js (section « Client Hints »).
 *  Passe par le répartiteur webRequest partagé (src/features/webrequest.js).
 * =========================================================================== */

const os = require('os');

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];

// Marque GREASE de Chromium (components/embedder_support/user_agent_utils.cc).
function greaseBrand(seed) {
  return {
    brand: 'Not' + GREASE_CHARS[seed % GREASE_CHARS.length] + 'A' + GREASE_CHARS[(seed + 1) % GREASE_CHARS.length] + 'Brand',
    version: GREASE_VERSIONS[seed % GREASE_VERSIONS.length],
  };
}
function brandList(full, fullVersions) {
  const major = Number(String(full).split('.')[0]) || 0;
  const g = greaseBrand(major);
  const v = fullVersions ? full : String(major);
  return [
    { brand: g.brand, version: fullVersions ? g.version + '.0.0.0' : g.version },
    { brand: 'Chromium', version: v },
    { brand: 'Google Chrome', version: v },
  ];
}

// Analyse « "Marque";v="123", "Autre";v="8" ».
function parseBrands(value) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*;\s*v\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(value || '')))) out.push({ brand: m[1], version: m[2] });
  return out;
}
function formatBrands(list) { return list.map(b => `"${b.brand}";v="${b.version}"`).join(', '); }

// Version de plateforme au format de Chrome sous Windows (contrat d'API
// universelle) : Windows 10 -> 1..10, Windows 11 -> 13+.
function windowsPlatformVersion() {
  const build = Number(String(os.release()).split('.')[2]) || 0;
  if (build >= 26100) return '19.0.0';
  if (build >= 22631) return '15.0.0';
  if (build >= 22621) return '15.0.0';
  if (build >= 22000) return '14.0.0';
  return '10.0.0';
}
function platformName() {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
}

function isTrustworthy(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:' || x.protocol === 'wss:') return true;
    if (x.protocol !== 'http:' && x.protocol !== 'ws:') return false;
    const h = x.hostname;
    return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]';
  } catch { return false; }
}

function init(ctx) {
  const full = String(process.versions.chrome || '0.0.0.0');
  const values = {
    'sec-ch-ua': formatBrands(brandList(full, false)),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platformName()}"`,
    'sec-ch-ua-full-version-list': formatBrands(brandList(full, true)),
    'sec-ch-ua-full-version': `"${full}"`,
    'sec-ch-ua-platform-version': `"${process.platform === 'win32' ? windowsPlatformVersion() : String(os.release())}"`,
    'sec-ch-ua-arch': `"${process.arch === 'arm64' ? 'arm' : 'x86'}"`,
    'sec-ch-ua-bitness': `"${process.arch === 'ia32' ? '32' : '64'}"`,
    'sec-ch-ua-model': '""',
    'sec-ch-ua-wow64': '?0',
  };
  const LOW = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
  const acceptCh = new Map();   // origine -> Set(en-têtes demandés)

  function apply(details, headers) {
    if (!isTrustworthy(details.url)) return undefined;
    let origin = '';
    try { origin = new URL(details.url).origin; } catch {}
    const wanted = new Set(LOW);
    const asked = acceptCh.get(origin);
    if (asked) for (const h of asked) if (values[h] !== undefined) wanted.add(h);
    // Remplace les éventuelles valeurs « Chromium seul » envoyées par le moteur.
    for (const k of Object.keys(headers)) if (/^sec-ch-ua/i.test(k)) delete headers[k];
    for (const h of wanted) headers[h] = values[h];
    return true;
  }
  function learn(details, headers) {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return undefined;
    if (!isTrustworthy(details.url)) return undefined;
    const key = Object.keys(headers).find(k => k.toLowerCase() === 'accept-ch');
    if (!key) return undefined;
    const raw = [].concat(headers[key]).join(',');
    const set = new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.startsWith('sec-ch-ua')));
    try {
      const origin = new URL(details.url).origin;
      if (set.size) acceptCh.set(origin, set); else acceptCh.delete(origin);
      if (acceptCh.size > 2000) acceptCh.delete(acceptCh.keys().next().value);
    } catch {}
    return undefined;   // en-têtes de réponse inchangés
  }

  const wr = ctx.module('webrequest');
  if (wr) {
    wr.onBeforeSendHeaders(apply);
    wr.onHeadersReceived(learn);
  } else {
    console.error('[clienthints] module webrequest absent : en-têtes non envoyés');
  }
  return { values, brandList: (fv) => brandList(full, fv), greaseBrand, parseBrands, formatBrands, isTrustworthy, _acceptCh: acceptCh };
}

module.exports = { init, parseBrands, formatBrands, greaseBrand, brandList, isTrustworthy };
