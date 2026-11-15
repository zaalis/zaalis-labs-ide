'use strict';
/* =============================================================================
 *  Certificats : erreurs TLS, exceptions, visionneuse, état de sécurité
 * -----------------------------------------------------------------------------
 *  - Erreur de certificat sur la page principale : interstitiel « Votre
 *    connexion n'est pas privée » (NET::ERR_CERT_…) ; « Continuer vers <hôte>
 *    (dangereux) » ajoute une exception pour la session, limitée à l'hôte ET à
 *    l'empreinte exacte du certificat présenté.
 *  - Visionneuse : sujet, émetteur, validité, empreinte SHA-256, noms, chaîne,
 *    à partir du certificat réellement vérifié par Chromium pour la page
 *    (setCertificateVerifyProc, qui laisse Chromium décider : code -3), ou à
 *    défaut via une connexion TLS directe (tls.connect).
 *  - État de sécurité de chaque onglet pour la barre d'adresse : secure,
 *    insecure (http), exception (certificat accepté malgré une erreur), mixed
 *    (contenu mixte signalé par Chromium), dangerous (Safe Browsing ignoré).
 * =========================================================================== */

const tls = require('tls');

const CERT_ERRORS = {
  '-200': 'NET::ERR_CERT_COMMON_NAME_INVALID',
  '-201': 'NET::ERR_CERT_DATE_INVALID',
  '-202': 'NET::ERR_CERT_AUTHORITY_INVALID',
  '-203': 'NET::ERR_CERT_CONTAINS_ERRORS',
  '-204': 'NET::ERR_CERT_NO_REVOCATION_MECHANISM',
  '-205': 'NET::ERR_CERT_UNABLE_TO_CHECK_REVOCATION',
  '-206': 'NET::ERR_CERT_REVOKED',
  '-207': 'NET::ERR_CERT_INVALID',
  '-208': 'NET::ERR_CERT_WEAK_SIGNATURE_ALGORITHM',
  '-210': 'NET::ERR_CERT_NON_UNIQUE_NAME',
  '-211': 'NET::ERR_CERT_WEAK_KEY',
  '-212': 'NET::ERR_CERT_NAME_CONSTRAINT_VIOLATION',
  '-213': 'NET::ERR_CERT_VALIDITY_TOO_LONG',
  '-214': 'NET::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED',
  '-215': 'NET::ERR_CERT_SYMANTEC_LEGACY',
  '-217': 'NET::ERR_CERT_KNOWN_INTERCEPTION_BLOCKED',
  '-218': 'NET::ERR_SSL_OBSOLETE_VERSION_OR_CIPHER',
};
const CERT_EXPLAIN = {
  'net::ERR_CERT_COMMON_NAME_INVALID': 'Le certificat de sécurité de ce serveur ne correspond pas à ce nom de domaine. Cela peut être dû à une erreur de configuration ou à un pirate qui intercepte votre connexion.',
  'net::ERR_CERT_DATE_INVALID': 'Le certificat de sécurité de ce serveur a expiré ou n\'est pas encore valide (vérifiez aussi la date et l\'heure de votre ordinateur).',
  'net::ERR_CERT_AUTHORITY_INVALID': 'Le certificat de sécurité de ce serveur n\'est pas émis par une autorité approuvée par votre ordinateur (certificat auto-signé ou interception).',
  'net::ERR_CERT_REVOKED': 'Le certificat de ce serveur a été révoqué par son émetteur.',
  'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM': 'Ce serveur utilise un certificat signé avec un algorithme trop faible.',
};
// Erreurs pour lesquelles Chrome ne propose pas de continuer.
const NON_OVERRIDABLE = new Set(['-206', '-217', '-218']);

function errorName(error) {
  const e = String(error || '');
  if (/^-\d+$/.test(e)) return CERT_ERRORS[e] || ('NET::ERR_CERT ' + e);
  return e.replace(/^net::/i, 'NET::');
}

function init(ctx) {
  const { app, crypto } = ctx;

  const exceptions = new Set();          // "hôte|empreinte" acceptés (session)
  const exceptionHosts = new Map();      // hôte -> { fingerprint, error, at }
  const lastError = new Map();           // wc.id -> { url, host, error, fingerprint, certificate }
  const verified = new Map();            // hôte -> { certificate, verificationResult, errorCode, at }
  const mixed = new WeakMap();           // onglet -> bool
  const exceptionTabs = new WeakMap();   // onglet -> hôte accepté par exception

  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

  // ----- Résumé d'un certificat (objet Certificate d'Electron) ------------
  function summarize(c, depth) {
    if (!c) return null;
    let x509 = null;
    try { x509 = new crypto.X509Certificate(c.data || c.raw); } catch {}
    const subj = c.subject || {}, iss = c.issuer || {};
    const out = {
      subject: c.subjectName || subj.commonName || (x509 && x509.subject) || '',
      subjectOrg: (subj.organizations || []).join(', '),
      issuer: c.issuerName || iss.commonName || (x509 && x509.issuer) || '',
      issuerOrg: (iss.organizations || []).join(', '),
      validFrom: c.validStart ? c.validStart * 1000 : (x509 ? Date.parse(x509.validFrom) : 0),
      validTo: c.validExpiry ? c.validExpiry * 1000 : (x509 ? Date.parse(x509.validTo) : 0),
      serial: c.serialNumber || (x509 && x509.serialNumber) || '',
      sha256: x509 ? x509.fingerprint256 : '',
      sha1: x509 ? x509.fingerprint : '',
      altNames: x509 && x509.subjectAltName ? x509.subjectAltName.split(/,\s*/).slice(0, 50) : [],
      keyType: x509 && x509.publicKey ? x509.publicKey.asymmetricKeyType : '',
      selfSigned: !!(x509 && x509.subject === x509.issuer),
    };
    const issuer = c.issuerCert && c.issuerCert !== c && (depth || 0) < 6 ? summarize(c.issuerCert, (depth || 0) + 1) : null;
    if (issuer) { const { chain, ...rest } = issuer; out.chain = [rest, ...(chain || [])]; } else out.chain = [];
    return out;
  }
  // Résumé d'un certificat de tls.getPeerCertificate(true).
  function summarizePeer(p) {
    const seen = new Set();
    const one = (c) => {
      let x509 = null;
      try { x509 = new crypto.X509Certificate(c.raw); } catch {}
      return {
        subject: (c.subject && c.subject.CN) || (x509 && x509.subject) || '',
        subjectOrg: (c.subject && c.subject.O) || '',
        issuer: (c.issuer && c.issuer.CN) || (x509 && x509.issuer) || '',
        issuerOrg: (c.issuer && c.issuer.O) || '',
        validFrom: Date.parse(c.valid_from) || 0,
        validTo: Date.parse(c.valid_to) || 0,
        serial: c.serialNumber || '',
        sha256: c.fingerprint256 || '',
        sha1: c.fingerprint || '',
        altNames: c.subjectaltname ? c.subjectaltname.split(/,\s*/).slice(0, 50) : [],
        keyType: x509 && x509.publicKey ? x509.publicKey.asymmetricKeyType : '',
        selfSigned: !!(x509 && x509.subject === x509.issuer),
      };
    };
    const first = one(p);
    first.chain = [];
    let cur = p.issuerCertificate;
    seen.add(p.fingerprint256);
    while (cur && !seen.has(cur.fingerprint256) && first.chain.length < 6) {
      seen.add(cur.fingerprint256);
      first.chain.push(one(cur));
      cur = cur.issuerCertificate;
    }
    return first;
  }
  function fetchPeerCert(host, port) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
      const sock = tls.connect({ host, port: port || 443, servername: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: 8000 }, () => {
        try {
          const p = sock.getPeerCertificate(true);
          const s = p && p.raw ? summarizePeer(p) : null;
          if (s) s.authorized = sock.authorized, s.authorizationError = sock.authorizationError ? String(sock.authorizationError) : '';
          finish(s);
        } catch { finish(null); }
      });
      sock.on('error', () => finish(null));
      sock.on('timeout', () => finish(null));
    });
  }

  // ----- Vérification Chromium : on mémorise le certificat présenté --------
  ctx.on('session', (ses) => {
    try {
      ses.setCertificateVerifyProc((req, cb) => {
        try {
          verified.set(String(req.hostname || '').toLowerCase(), {
            certificate: req.certificate, verificationResult: req.verificationResult, errorCode: req.errorCode, at: Date.now(),
          });
          if (verified.size > 500) verified.delete(verified.keys().next().value);
        } catch {}
        cb(-3);   // -3 : utiliser le résultat de la vérification de Chromium
      });
    } catch (e) { console.error('[certificates] setCertificateVerifyProc', e); }
  });

  // ----- Erreurs de certificat ---------------------------------------------
  app.on('certificate-error', (event, wc, url, error, certificate, callback, isMainFrame) => {
    const host = hostOf(url);
    const fp = certificate && certificate.fingerprint || '';
    if (host && fp && exceptions.has(host + '|' + fp)) {
      event.preventDefault();
      callback(true);
      const tab = ctx.tabOfWebContents(wc);
      if (tab && isMainFrame !== false) exceptionTabs.set(tab, host);
      return;
    }
    if (isMainFrame !== false) lastError.set(wc.id, { url, host, error: String(error || ''), fingerprint: fp, certificate });
    callback(false);   // refus (comportement par défaut) -> did-fail-load
  });

  // Appelée par main.js (did-fail-load, code -2xx). true si l'interstitiel est affiché.
  function handleCertFailure(tab, wc, failedUrl, code, desc) {
    const sb = ctx.module('safebrowsing');
    if (!sb || !sb.createInterstitial) return false;
    const host = hostOf(failedUrl);
    const last = lastError.get(wc.id);
    const info = last && last.host === host ? last : { url: failedUrl, host, error: String(desc || code), fingerprint: '', certificate: null };
    const name = errorName(code) !== 'NET::ERR_CERT ' + code ? errorName(code) : errorName(info.error);
    const key = 'net::' + name.replace(/^NET::/, '');
    sb.createInterstitial(wc, {
      kind: 'cert', url: failedUrl, host,
      error: name,
      errorText: CERT_EXPLAIN[key] || 'Des individus malveillants tentent peut-être de dérober vos informations sur ' + host + ' (mots de passe, messages ou numéros de carte de crédit, par exemple).',
      cert: info.certificate ? summarize(info.certificate) : null,
      fingerprint: info.fingerprint,
      canProceed: !!info.fingerprint && !NON_OVERRIDABLE.has(String(code)),
    });
    return true;
  }
  ctx.on('ready', () => {
    const sb = ctx.module('safebrowsing');
    if (sb && sb.registerKind) sb.registerKind('cert', {
      proceed(info, wc) {
        if (!info.fingerprint) throw new Error('Certificat inconnu');
        exceptions.add(info.host + '|' + info.fingerprint);
        exceptionHosts.set(info.host, { fingerprint: info.fingerprint, error: info.error, at: Date.now() });
        wc.loadURL(info.url).catch(() => {});
      },
    });
  });

  // ----- Contenu mixte et état de sécurité des onglets ----------------------
  ctx.on('tabCreated', (tab, wc) => {
    wc.on('console-message', (event, ...legacy) => {
      const message = String((event && event.message) ?? legacy[1] ?? '');
      if (/Mixed Content/i.test(message) && !mixed.get(tab)) { mixed.set(tab, true); ctx.pushState(); }
    });
    wc.on('did-navigate', (_e, u) => {
      mixed.delete(tab);
      const h = exceptionTabs.get(tab);
      if (h && hostOf(u) !== h) exceptionTabs.delete(tab);
    });
  });
  function securityLevel(tab) {
    if (!tab || !tab.view) return '';
    let u = '';
    try { u = tab.view.webContents.getURL(); } catch { return ''; }
    let parsed;
    try { parsed = new URL(u); } catch { return ''; }
    const host = parsed.hostname.toLowerCase();
    const sb = ctx.module('safebrowsing');
    if (/^https?:$/.test(parsed.protocol) && sb && sb.isBypassed && sb.isBypassed(host)) return 'dangerous';
    if (parsed.protocol === 'http:') {
      if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]') return 'local';
      return 'insecure';
    }
    if (parsed.protocol === 'https:') {
      if (exceptionTabs.get(tab) === host || exceptionHosts.has(host)) return 'exception';
      if (mixed.get(tab)) return 'mixed';
      return 'secure';
    }
    if (parsed.protocol === 'file:') return 'file';
    return '';
  }
  ctx.tabState((t) => ({ security: securityLevel(t) }));

  // Informations de sécurité pour la popup « Informations sur le site ».
  async function siteSecurity(tab) {
    const level = securityLevel(tab);
    let u;
    try { u = new URL(tab.view.webContents.getURL()); } catch { return { level }; }
    const out = { level, host: u.hostname, cert: null, verification: '' };
    if (u.protocol !== 'https:') return out;
    const v = verified.get(u.hostname.toLowerCase());
    if (v && v.certificate) {
      out.cert = summarize(v.certificate);
      out.verification = v.verificationResult === 'net::OK' ? 'Certificat valide' : String(v.verificationResult || '');
    } else {
      const p = await fetchPeerCert(u.hostname, u.port ? Number(u.port) : 443);
      if (p) { out.cert = p; out.verification = p.authorized ? 'Certificat valide' : (p.authorizationError || 'Certificat non approuvé'); }
    }
    const ex = exceptionHosts.get(u.hostname.toLowerCase());
    if (ex) out.exception = { error: ex.error, at: ex.at };
    return out;
  }

  // ----- Page security.html : exceptions -----------------------------------
  ctx.rpc('certExceptions', () => [...exceptionHosts.entries()].map(([host, e]) => ({ host, ...e })), { pages: ['security.html'] });
  ctx.rpc('certRevoke', (p) => {
    const host = String(p.host || '').toLowerCase();
    const e = exceptionHosts.get(host);
    if (e) { exceptions.delete(host + '|' + e.fingerprint); exceptionHosts.delete(host); }
    ctx.pushState();
    return true;
  }, { pages: ['security.html'] });
  ctx.rpc('certInspect', async (p) => {
    const host = String(p.host || '').toLowerCase().replace(/[^a-z0-9.:-]/g, '');
    if (!host) throw new Error('Hôte invalide');
    const [h, port] = host.split(':');
    const c = await fetchPeerCert(h, port ? Number(port) : 443);
    if (!c) throw new Error('Connexion TLS impossible vers ' + host);
    return c;
  }, { pages: ['security.html'] });

  return { handleCertFailure, siteSecurity, securityLevel, fetchPeerCert, summarize, errorName, hasException: (h) => exceptionHosts.has(h) };
}

module.exports = { init, errorName };
