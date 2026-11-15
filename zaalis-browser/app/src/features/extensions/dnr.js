'use strict';
/* =============================================================================
 *  Moteur declarativeNetRequest maison.
 * -----------------------------------------------------------------------------
 *  Dans Electron, dès qu'une session a un écouteur ses.webRequest (Client
 *  Hints, Safe Browsing…), le DNR natif des extensions est court-circuité.
 *  zaalis applique donc lui-même les règles (statiques, dynamiques, de
 *  session) depuis le répartiteur webRequest partagé.
 *
 *  Pris en charge : actions block, allow, allowAllRequests, upgradeScheme,
 *  redirect (url, extensionPath, transform, regexSubstitution), modifyHeaders ;
 *  conditions urlFilter (||, |, ^, *), regexFilter, isUrlFilterCaseSensitive,
 *  requestDomains / excludedRequestDomains, initiatorDomains /
 *  excludedInitiatorDomains (et domains / excludedDomains historiques),
 *  resourceTypes / excludedResourceTypes, requestMethods /
 *  excludedRequestMethods, domainType, tabIds / excludedTabIds.
 *  Les règles sont indexées par jeton (comme Chromium) : seules les règles
 *  candidates d'une URL sont évaluées, même avec des centaines de milliers
 *  de règles (bloqueurs de publicité).
 * =========================================================================== */

const ACTION_RANK = { allow: 5, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1, modifyHeaders: 0 };
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
const MULTI_TLD = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp', 'or.jp', 'co.nz', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'co.in', 'co.kr', 'com.ar', 'com.sg', 'co.za', 'com.tw', 'com.hk', 'gouv.fr', 'asso.fr']);

function registrable(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const p = h.split('.');
  if (p.length <= 2) return h;
  const last2 = p.slice(-2).join('.');
  return MULTI_TLD.has(last2) ? p.slice(-3).join('.') : last2;
}
function domainMatch(host, list) {
  if (!host) return false;
  for (const d of list) { if (host === d || host.endsWith('.' + d)) return true; }
  return false;
}
function hostSuffixes(host) {
  const out = [];
  let h = host;
  while (h) { out.push(h); const i = h.indexOf('.'); if (i < 0) break; h = h.slice(i + 1); }
  return out;
}
const urlTokens = (url) => url.toLowerCase().match(/[a-z0-9]{3,}/g) || [];

// urlFilter -> RegExp (syntaxe Chrome / Adblock).
function filterToRegExp(f, caseSensitive) {
  let s = String(f);
  let prefix = '', suffix = '';
  if (s.startsWith('||')) { s = s.slice(2); prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?'; }
  else if (s.startsWith('|')) { s = s.slice(1); prefix = '^'; }
  if (s.endsWith('|')) { s = s.slice(0, -1); suffix = '$'; }
  let body = '';
  for (const ch of s) {
    if (ch === '*') body += '.*';
    else if (ch === '^') body += '(?:[^a-zA-Z0-9_.%-]|$)';
    else body += ch.replace(/[.+?${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i');
}
// Meilleur jeton « sûr » d'un urlFilter : borné des deux côtés par un séparateur.
function bestToken(f, caseSensitive) {
  let s = String(f);
  const anchoredStart = s.startsWith('|');
  s = s.replace(/^\|\|?/, '');
  const anchoredEnd = s.endsWith('|');
  if (anchoredEnd) s = s.slice(0, -1);
  if (!caseSensitive) s = s.toLowerCase();
  let best = '';
  const re = /[a-z0-9]+/gi;
  let m;
  while ((m = re.exec(s))) {
    const tok = m[0].toLowerCase();
    if (tok.length < 3) continue;
    const before = m.index === 0 ? (anchoredStart ? 'sep' : 'open') : s[m.index - 1];
    const endIdx = m.index + m[0].length;
    const after = endIdx === s.length ? (anchoredEnd ? 'sep' : 'open') : s[endIdx];
    const okB = before === 'sep' || (before !== 'open' && before !== '*');
    const okA = after === 'sep' || (after !== 'open' && after !== '*');
    if (okB && okA && tok.length > best.length) best = tok;
  }
  return best;
}

class RuleIndex {
  constructor() { this.byToken = new Map(); this.byDomain = new Map(); this.generic = []; this.size = 0; this.regexCount = 0; }
  add(rule) {
    this.size++;
    const c = rule.condition || {};
    if (c.regexFilter) this.regexCount++;
    if (c.urlFilter) {
      const tok = bestToken(c.urlFilter, !!c.isUrlFilterCaseSensitive);
      if (tok) { push(this.byToken, tok, rule); return; }
    }
    const doms = c.requestDomains;
    if (Array.isArray(doms) && doms.length && !c.urlFilter && !c.regexFilter) { for (const d of doms) push(this.byDomain, String(d).toLowerCase(), rule); return; }
    this.generic.push(rule);
  }
  candidates(url, host, visit) {
    for (const r of this.generic) visit(r);
    const seen = new Set();
    for (const t of urlTokens(url)) {
      if (seen.has(t)) continue; seen.add(t);
      const l = this.byToken.get(t); if (l) for (const r of l) visit(r);
    }
    for (const d of hostSuffixes(host)) { const l = this.byDomain.get(d); if (l) for (const r of l) visit(r); }
  }
}
function push(map, k, v) { const l = map.get(k); if (l) l.push(v); else map.set(k, [v]); }

// Vérifie une règle (forme Chrome) ; lève une erreur au format de Chrome.
function validateRule(r) {
  if (!r || typeof r !== 'object') throw new Error('Règle invalide');
  if (!Number.isInteger(r.id) || r.id < 1) throw new Error('Rule with id ' + r.id + ' does not have a valid id.');
  const a = r.action || {};
  if (!(a.type in ACTION_RANK)) throw new Error('Rule with id ' + r.id + ' does not specify a valid action type.');
  if (r.priority != null && (!Number.isInteger(r.priority) || r.priority < 1)) throw new Error('Rule with id ' + r.id + ' has an invalid priority.');
  const c = r.condition || {};
  if (c.urlFilter != null && c.regexFilter != null) throw new Error('Rule with id ' + r.id + ' specified both urlFilter and regexFilter.');
  if (c.regexFilter != null) { try { new RegExp(c.regexFilter); } catch { throw new Error('Rule with id ' + r.id + ' specified an invalid regular expression.'); } }
  if (a.type === 'redirect' && !a.redirect) throw new Error('Rule with id ' + r.id + ' does not specify the redirect.');
  if (a.type === 'allowAllRequests' && !(c.resourceTypes || []).every(t => t === 'main_frame' || t === 'sub_frame')) throw new Error('Rule with id ' + r.id + ' is an allowAllRequests rule with invalid resource types.');
  return r;
}

function createDnr() {
  // extId -> { rulesets: Map(rid -> rules[]), enabled:Set, disabledStatic: Map(rid -> Set(ids)),
  //            dynamic: rules[], session: rules[], index: RuleIndex, order, options, matched: [] }
  const exts = new Map();
  const frameAllow = new Map();   // tabId -> [{ extId, priority }] (allowAllRequests sur le document)
  let order = 0;

  function rebuild(e) {
    const idx = new RuleIndex();
    const addAll = (rules, rulesetId) => { for (const r of rules) { r.__rs = rulesetId; idx.add(r); } };
    for (const rid of e.enabled) {
      const rules = e.rulesets.get(rid);
      if (!rules) continue;
      const dis = e.disabledStatic.get(rid);
      addAll(dis && dis.size ? rules.filter(r => !dis.has(r.id)) : rules, rid);
    }
    addAll(e.dynamic, '_dynamic');
    addAll(e.session, '_session');
    e.index = idx;
  }

  function setExtension(id, data) {
    const e = exts.get(id) || { order: ++order, matched: [], options: {}, session: [] };
    e.rulesets = data.rulesets || e.rulesets || new Map();
    e.enabled = new Set(data.enabled || []);
    e.disabledStatic = data.disabledStatic || new Map();
    e.dynamic = data.dynamic || [];
    if (data.session) e.session = data.session;
    if (data.options) e.options = data.options;
    e.manifestId = id;
    rebuild(e);
    exts.set(id, e);
    return e;
  }
  const removeExtension = (id) => { exts.delete(id); };
  const get = (id) => exts.get(id) || null;

  function conditionMatches(r, req) {
    const c = r.condition || {};
    const type = req.type;
    if (Array.isArray(c.resourceTypes) && c.resourceTypes.length) { if (!c.resourceTypes.includes(type)) return false; }
    else if (Array.isArray(c.excludedResourceTypes)) { if (c.excludedResourceTypes.includes(type)) return false; }
    else if (type === 'main_frame' && r.action.type !== 'allowAllRequests') return false;
    if (Array.isArray(c.requestMethods) && !c.requestMethods.includes(req.method)) return false;
    if (Array.isArray(c.excludedRequestMethods) && c.excludedRequestMethods.includes(req.method)) return false;
    if (Array.isArray(c.tabIds) && !c.tabIds.includes(req.tabId)) return false;
    if (Array.isArray(c.excludedTabIds) && c.excludedTabIds.includes(req.tabId)) return false;
    if (Array.isArray(c.requestDomains) && !domainMatch(req.host, c.requestDomains)) return false;
    if (Array.isArray(c.excludedRequestDomains) && domainMatch(req.host, c.excludedRequestDomains)) return false;
    const inc = c.initiatorDomains || c.domains;
    const exc = c.excludedInitiatorDomains || c.excludedDomains;
    if (Array.isArray(inc) && !domainMatch(req.initiatorHost, inc)) return false;
    if (Array.isArray(exc) && domainMatch(req.initiatorHost, exc)) return false;
    if (c.domainType) {
      const third = !!req.initiatorHost && registrable(req.initiatorHost) !== registrable(req.host);
      if (c.domainType === 'thirdParty' ? !third : third) return false;
    }
    if (c.urlFilter != null) {
      if (!r.__re) r.__re = filterToRegExp(c.urlFilter, !!c.isUrlFilterCaseSensitive);
      if (!r.__re.test(req.url)) return false;
    } else if (c.regexFilter != null) {
      if (!r.__re) { try { r.__re = new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i'); } catch { return false; } }
      if (!r.__re.test(req.url)) return false;
    }
    return true;
  }

  function better(a, b) {   // a meilleure que b ?
    if (!b) return true;
    const pa = a.priority || 1, pb = b.priority || 1;
    if (pa !== pb) return pa > pb;
    return ACTION_RANK[a.action.type] > ACTION_RANK[b.action.type];
  }

  function redirectUrl(extId, r, req) {
    const d = r.action.redirect || {};
    if (d.url) return d.url;
    if (d.extensionPath) return 'chrome-extension://' + extId + '/' + String(d.extensionPath).replace(/^\/+/, '');
    if (d.regexSubstitution != null && r.condition && r.condition.regexFilter) {
      const re = new RegExp(r.condition.regexFilter, r.condition.isUrlFilterCaseSensitive ? '' : 'i');
      const m = re.exec(req.url);
      if (!m) return null;
      return String(d.regexSubstitution).replace(/\\(\d)/g, (_, n) => m[+n] || '');
    }
    if (d.transform) {
      const u = new URL(req.url), t = d.transform;
      if (t.scheme) u.protocol = t.scheme + ':';
      if (t.host != null) u.hostname = t.host;
      if (t.port != null) u.port = t.port;
      if (t.path != null) u.pathname = t.path;
      if (t.query != null) u.search = t.query;
      if (t.fragment != null) u.hash = t.fragment;
      if (t.queryTransform) {
        const qp = u.searchParams;
        for (const k of t.queryTransform.removeParams || []) qp.delete(k);
        for (const kv of t.queryTransform.addOrReplaceParams || []) {
          if (kv.replaceOnly && !qp.has(kv.key)) continue;
          qp.set(kv.key, kv.value);
        }
      }
      if (t.username != null) u.username = t.username;
      if (t.password != null) u.password = t.password;
      return u.toString();
    }
    return null;
  }

  // Évalue une requête. req : { url, method, type, tabId, initiator }.
  function match(req, onlyExt) {
    let u;
    try { u = new URL(req.url); } catch { return null; }
    if (!/^(https?|wss?):$/.test(u.protocol)) return null;
    let initiatorHost = '';
    if (req.initiator) { try { const iu = new URL(req.initiator); if (iu.protocol === 'chrome-extension:') return null; initiatorHost = iu.hostname; } catch {} }
    const r0 = { url: req.url, method: String(req.method || 'GET').toLowerCase(), type: req.type || 'other', tabId: req.tabId == null ? -1 : req.tabId, host: u.hostname.toLowerCase(), initiatorHost: initiatorHost.toLowerCase() };
    const results = [];
    for (const [extId, e] of exts) {
      if (onlyExt && extId !== onlyExt) continue;
      if (!e.index || !e.index.size) continue;
      let best = null; const headerRules = [];
      e.index.candidates(r0.url, r0.host, (r) => {
        if (r.action.type === 'modifyHeaders') { if (conditionMatches(r, r0)) headerRules.push(r); return; }
        if ((!best || better(r, best)) && conditionMatches(r, r0)) best = r;
      });
      // allowAllRequests posé sur le document de l'onglet.
      const fa = r0.type !== 'main_frame' ? (frameAllow.get(r0.tabId) || []).find(x => x.extId === extId) : null;
      if (fa && (!best || (best.priority || 1) <= fa.priority) && !(best && best.action.type === 'allow')) {
        best = { id: fa.ruleId, priority: fa.priority, action: { type: 'allow' }, __rs: fa.rulesetId };
      }
      // modifyHeaders : ignoré si la requête est bloquée, ou autorisée par une
      // règle allow de priorité supérieure ou égale.
      const blocked = best && best.action.type === 'block';
      const allowP = best && best.action.type.startsWith('allow') ? (best.priority || 1) : 0;
      const hdrs = blocked ? [] : headerRules.filter(h => (h.priority || 1) > allowP);
      if (best || hdrs.length) results.push({ extId, e, rule: best, headerRules: hdrs });
    }
    if (!results.length) return null;
    // allowAllRequests sur un document : mémorisé pour ses sous-requêtes.
    if (r0.type === 'main_frame') frameAllow.delete(r0.tabId);
    for (const res of results) {
      if (res.rule && res.rule.action.type === 'allowAllRequests' && (r0.type === 'main_frame')) {
        const l = frameAllow.get(r0.tabId) || [];
        l.push({ extId: res.extId, priority: res.rule.priority || 1, ruleId: res.rule.id, rulesetId: res.rule.__rs });
        frameAllow.set(r0.tabId, l);
      }
    }
    const out = { action: null, redirectUrl: null, matched: [], requestHeaders: [], responseHeaders: [] };
    const pick = (type) => results.filter(x => x.rule && x.rule.action.type === type).sort((a, b) => b.e.order - a.e.order)[0];
    let win = pick('block');
    if (win) out.action = 'block';
    else if ((win = pick('upgradeScheme')) && /^(http|ws):$/.test(u.protocol)) { out.action = 'redirect'; const up = new URL(req.url); up.protocol = u.protocol === 'http:' ? 'https:' : 'wss:'; out.redirectUrl = up.toString(); }
    else if ((win = pick('redirect'))) { const to = redirectUrl(win.extId, win.rule, r0); if (to && to !== req.url) { out.action = 'redirect'; out.redirectUrl = to; } else win = null; }
    for (const res of results) {
      if (res.rule && (res.rule.action.type !== 'modifyHeaders')) out.matched.push({ extId: res.extId, ruleId: res.rule.id, rulesetId: res.rule.__rs, action: res.rule.action.type });
      if (!out.action || out.action === 'redirect') {
        for (const h of res.headerRules) {
          out.matched.push({ extId: res.extId, ruleId: h.id, rulesetId: h.__rs, action: 'modifyHeaders' });
          for (const op of h.action.requestHeaders || []) out.requestHeaders.push(op);
          for (const op of h.action.responseHeaders || []) out.responseHeaders.push(op);
        }
      }
    }
    return out;
  }

  function clearTab(tabId) { frameAllow.delete(tabId); }

  return { setExtension, removeExtension, get, match, clearTab, rebuild, exts };
}

// Applique des opérations modifyHeaders à un objet d'en-têtes (clé -> valeur(s)).
function applyHeaderOps(headers, ops, response) {
  let changed = false;
  const findKey = (name) => Object.keys(headers).find(k => k.toLowerCase() === String(name).toLowerCase());
  for (const op of ops) {
    const k = findKey(op.header);
    if (op.operation === 'remove') { if (k) { delete headers[k]; changed = true; } }
    else if (op.operation === 'set') { if (k) delete headers[k]; headers[op.header] = response ? [String(op.value)] : String(op.value); changed = true; }
    else if (op.operation === 'append') {
      if (k) {
        if (response) headers[k] = [].concat(headers[k], String(op.value));
        else headers[k] = String(headers[k]) + ', ' + String(op.value);
      } else headers[op.header] = response ? [String(op.value)] : String(op.value);
      changed = true;
    }
  }
  return changed;
}

module.exports = { createDnr, validateRule, filterToRegExp, bestToken, applyHeaderOps, ALL_TYPES };
