'use strict';
/* =============================================================================
 *  Répartiteur webRequest partagé
 * -----------------------------------------------------------------------------
 *  Electron n'accepte qu'UNE écoute par événement webRequest et par session :
 *  un second `ses.webRequest.onBeforeSendHeaders(...)` remplace le premier.
 *  Ce module installe une seule écoute par session et la répartit entre les
 *  modules qui s'y abonnent :
 *
 *    const wr = ctx.module('webrequest');
 *    wr.onBeforeSendHeaders((details, headers) => { headers['X'] = 'y'; });
 *    wr.onBeforeRequest(details => ({ cancel: true }) | undefined);
 *    wr.onHeadersReceived((details, headers) => { … });
 *
 *  Les écoutes ne sont installées que pour les événements réellement utilisés
 *  (chaque écoute webRequest a un coût sur toutes les requêtes).
 * =========================================================================== */

function init(ctx) {
  const handlers = { beforeRequest: [], beforeSendHeaders: [], headersReceived: [] };
  const sessions = new Set();
  // Événements d'observation (sans réponse) : sendHeaders, responseStarted,
  // beforeRedirect, completed, errorOccurred — utilisés par chrome.webRequest
  // des extensions (src/features/extensions.js).
  const OBSERVE = { sendHeaders: 'onSendHeaders', responseStarted: 'onResponseStarted', beforeRedirect: 'onBeforeRedirect', completed: 'onCompleted', errorOccurred: 'onErrorOccurred' };
  const observers = { sendHeaders: [], responseStarted: [], beforeRedirect: [], completed: [], errorOccurred: [] };
  const runObservers = (kind) => (details) => {
    for (const fn of observers[kind]) { try { fn(details); } catch (e) { console.error('[webrequest:' + kind + ']', e); } }
  };
  function installObserver(ses, kind) {
    try { ses.webRequest[OBSERVE[kind]](runObservers(kind)); } catch (e) { console.error('[webrequest] installation', kind, e); }
  }
  function observe(kind, fn) {
    observers[kind].push(fn);
    if (observers[kind].length === 1) for (const ses of sessions) installObserver(ses, kind);
    return () => { const i = observers[kind].indexOf(fn); if (i >= 0) observers[kind].splice(i, 1); };
  }

  function runBeforeRequest(details, cb) {
    for (const fn of handlers.beforeRequest) {
      try {
        const r = fn(details);
        if (r && (r.cancel || r.redirectURL)) { cb(r); return; }
      } catch (e) { console.error('[webrequest:beforeRequest]', e); }
    }
    cb({});
  }
  function runBeforeSendHeaders(details, cb) {
    const headers = Object.assign({}, details.requestHeaders);
    let changed = false;
    for (const fn of handlers.beforeSendHeaders) {
      try {
        const r = fn(details, headers);
        if (r === false) { cb({ cancel: true }); return; }
        if (r !== undefined) changed = true;
      } catch (e) { console.error('[webrequest:beforeSendHeaders]', e); }
    }
    cb(changed ? { requestHeaders: headers } : {});
  }
  function runHeadersReceived(details, cb) {
    if (!details.responseHeaders) { cb({}); return; }
    const headers = Object.assign({}, details.responseHeaders);
    let changed = false;
    for (const fn of handlers.headersReceived) {
      try { if (fn(details, headers) !== undefined) changed = true; }
      catch (e) { console.error('[webrequest:headersReceived]', e); }
    }
    cb(changed ? { responseHeaders: headers } : {});
  }

  function install(ses) {
    try {
      if (handlers.beforeRequest.length) ses.webRequest.onBeforeRequest(runBeforeRequest);
      if (handlers.beforeSendHeaders.length) ses.webRequest.onBeforeSendHeaders(runBeforeSendHeaders);
      if (handlers.headersReceived.length) ses.webRequest.onHeadersReceived(runHeadersReceived);
      for (const kind of Object.keys(observers)) if (observers[kind].length) installObserver(ses, kind);
    } catch (e) { console.error('[webrequest] installation', e); }
  }
  function add(kind, fn) {
    handlers[kind].push(fn);
    // Abonnement tardif : on (ré)installe sur les sessions déjà prêtes.
    if (handlers[kind].length === 1) for (const ses of sessions) install(ses);
    return () => { const i = handlers[kind].indexOf(fn); if (i >= 0) handlers[kind].splice(i, 1); };
  }

  ctx.on('session', (ses) => { if (sessions.has(ses)) return; sessions.add(ses); install(ses); });

  return {
    // fn(details) -> undefined | { cancel:true } | { redirectURL }
    onBeforeRequest: (fn) => add('beforeRequest', fn),
    // fn(details, headers) : modifie `headers` en place et renvoie true si
    // quelque chose a changé ; renvoie false pour annuler la requête.
    onBeforeSendHeaders: (fn) => add('beforeSendHeaders', fn),
    // fn(details, headers) : idem pour les en-têtes de réponse.
    onHeadersReceived: (fn) => add('headersReceived', fn),
    // Observation seule : fn(details), aucune valeur de retour attendue.
    onSendHeaders: (fn) => observe('sendHeaders', fn),
    onResponseStarted: (fn) => observe('responseStarted', fn),
    onBeforeRedirect: (fn) => observe('beforeRedirect', fn),
    onCompleted: (fn) => observe('completed', fn),
    onErrorOccurred: (fn) => observe('errorOccurred', fn),
  };
}

module.exports = { init };
