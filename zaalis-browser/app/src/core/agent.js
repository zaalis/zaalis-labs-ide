'use strict';
// Agent IA outillé (comme l'extension Claude dans Chrome) : outils, vision, actions natives, protocole DevTools, boucle de chat.
// Module extrait de main.js : les dépendances sur l'état du navigateur
// passent par M (accesseurs fournis par main.js, toujours à jour).

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const url = require('url');
const { nativeImage, dialog, app } = require('electron');
const { AGENT_OVERLAY_JS, parseModifiers, keyCodeFor, resolveTargetJs, a11ySnapshotJs, agentUrl, findElementsJs, PAGE_TEXT_JS, clampResult, stripHtml, waitForJs, FOCUS_SELECT_JS, READ_VALUE_JS, legacyFillJs, DISPATCH_CHANGE_JS, formInputJs, AGENT_SYSTEM, parseToolCall, toolLabel } = require('./page-scripts');

function init(M) {
  // Le backend IDE ne renvoie que du texte : on donne à l'assistant la capacité
  // d'INSPECTER et d'AGIR sur la page active via une boucle d'outils par protocole
  // texte. Le modèle demande un outil (bloc json), le navigateur l'exécute sur la
  // WebContents active, renvoie le résultat, et la boucle continue jusqu'à la
  // réponse finale.

  // Boucle d'agent bornée par les TOKENS, comme l'extension Claude dans Chrome :
  // pas de plafond d'étapes arbitraire. Chaque étape = une action (lire, cliquer,
  // remplir UN champ). On continue tant que le contexte ré-injecté reste sous le
  // budget de tokens ; deux garde-fous n'existent que pour empêcher une boucle
  // réellement infinie (jamais atteints en usage normal). L'autorisation d'agir
  // n'est demandée qu'une fois par session.
  const AGENT_HARD_CAP = 300;          // garde-fou anti-boucle infinie
  const AGENT_TOKEN_BUDGET = 200000;   // limite réelle : tokens de contexte estimés (marge sûre pour tout modèle cloud)
  // Estimation grossière ~4 caractères / token de tout ce qui est ré-injecté.
  function agentTokenEstimate(sysPrompt, hist, next) {
    let chars = String(sysPrompt || '').length + String(next || '').length;
    for (const m of hist) chars += String((m && m.content) || '').length;
    return Math.ceil(chars / 4);
  }

  // Outils qui modifient la page ou l'état du navigateur : autorisation demandée
  // une fois par demande de l'utilisateur (comme les extensions Claude/ChatGPT).
  // Self-test uniquement : actions acceptées sans boîte de dialogue.
  let agentAutoApprove = false;
  // Vrai si une capture de l'onglet a été jointe au premier tour de l'agent.
  let lastAgentAutoShot = false;
  const AGENT_MUTATING_TOOLS = new Set([
    'click', 'hover', 'fill', 'form_input', 'type', 'key', 'drag', 'upload_file',
    'navigate', 'tab_new', 'tab_close', 'execute_js', 'inject_css', 'download',
    'save_pdf', 'resize_viewport',
  ]);


  function waitLoad(wc, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); wc.removeListener('did-stop-loading', finish); resolve(); };
      const timer = setTimeout(finish, ms || 4000);
      wc.once('did-stop-loading', finish);
    });
  }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // ----- Vision & action « comme l'extension Claude dans Chrome » --------------
  // Tout le code injecté par l'agent tourne dans un MONDE ISOLÉ (même DOM que la
  // page, contexte JavaScript séparé) : la page ne peut ni voir ni altérer nos
  // références d'éléments ou notre curseur — mêmes garanties que les content
  // scripts d'extension Chrome. Seul execute_js reste dans le monde de la page.
  const AGENT_WORLD_ID = 1013;
  let aiControlTab = null;

  function agentExec(wc, code) {
    return wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }], true);
  }

  // Halo de contrôle : injecté dans l'onglet piloté, jamais dans le panneau IA.
  // Reproduit littéralement le halo de la recherche IA (même dégradé, même flou
  // 14px, même opacité, même animation) — un rectangle plein flouté dont seul le
  // pourtour reste visible via le masque, si bien que la fenêtre est cernée du
  // même bandeau lumineux épais que la barre de recherche.
  function setAiControlBorder(t, active) {
    const target = active ? t : aiControlTab;
    aiControlTab = active && t ? t : null;
    if (!target || !target.view || target.view.webContents.isDestroyed()) return Promise.resolve();

    const enabled = !!active;
    const code = `(() => {
      const borderId = 'zaalis-agent-control-border';
      const styleId = 'zaalis-agent-control-border-style';
      const current = document.getElementById(borderId);
      if (!${enabled}) {
        if (current) current.remove();
        const style = document.getElementById(styleId);
        if (style) style.remove();
        if (window.__zCur) {
          try { window.__zCur.root.remove(); } catch {}
          try { delete window.__zCur; } catch {}
        }
        return;
      }
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = '@keyframes zaalis-agent-border-flow { from { background-position:0% 50%; } to { background-position:200% 50%; } }';
        (document.head || document.documentElement).appendChild(style);
      }
      if (current) return;
      const border = document.createElement('div');
      border.id = borderId;
      border.setAttribute('aria-hidden', 'true');
      // Le masque doit être *fondu* (dégradé alpha), pas à bord franc : un masque
      // dur est appliqué après le filtre et redécouperait des bords nets, ce qui
      // « durcit » le halo. Ici chaque bord s'estompe vers l'intérieur, puis le
      // blur(14px) diffuse le tout — même brume exacte que la barre de recherche.
      const feather = 'linear-gradient(to right,transparent,#000 10px,transparent 40px),linear-gradient(to left,transparent,#000 10px,transparent 40px),linear-gradient(to bottom,transparent,#000 10px,transparent 40px),linear-gradient(to top,transparent,#000 10px,transparent 40px)';
      border.style.cssText = [
        'position:fixed', 'inset:-3px', 'z-index:2147483647', 'pointer-events:none',
        'opacity:.8', 'filter:blur(14px)',
        'background:linear-gradient(90deg,rgba(0,120,255,.85),rgba(0,212,255,.85),rgba(120,90,255,.85),rgba(0,212,255,.85),rgba(0,120,255,.85))',
        'background-size:200% 100%', 'animation:zaalis-agent-border-flow 7s linear infinite',
        '-webkit-mask:' + feather, 'mask:' + feather
      ].join(';');
      (document.body || document.documentElement).appendChild(border);
    })()`;
    return agentExec(target.view.webContents, code).catch(() => {});
  }


  // Pendant une étape sans cible (lecture, réseau, réflexion…), le curseur reste
  // visible exactement là où l'étape précédente l'a laissé. La prochaine action
  // réutilise la transition de transform et glisse naturellement vers sa cible.
  async function agentHoldCursor(wc, label) {
    try {
      await agentExec(wc, AGENT_OVERLAY_JS + ';window.__zCur.hold(' +
        JSON.stringify(String(label || 'IA active')) + ');');
    } catch {}
  }

  // Anime le curseur jusqu'à la cible (halo inclus) et attend la fin du trajet,
  // puis émet l'onde de clic si demandé. Ne bloque jamais l'outil en cas d'échec
  // d'affichage (page exotique) : l'action reste prioritaire sur le visuel.
  async function agentShowAction(wc, pt, label, withPulse) {
    try {
      await agentExec(wc, AGENT_OVERLAY_JS + ';window.__zCur.act(' + Math.round(pt.x) + ',' + Math.round(pt.y) + ',' +
        JSON.stringify(String(label || '')) + ',' + JSON.stringify(pt.rect || null) + ');');
      await sleepMs(560);
      if (withPulse) await agentExec(wc, 'window.__zCur && window.__zCur.pulse(' + Math.round(pt.x) + ',' + Math.round(pt.y) + ');');
    } catch {}
  }

  // Vrai clic souris : sendInputEvent injecte des événements natifs (move, down,
  // up) dans la WebContents — indiscernables d'un clic humain (hover, focus,
  // :active se déclenchent). Coordonnées CSS → DIP via le facteur de zoom.
  async function nativeClick(wc, xCss, yCss) {
    let z = 1;
    try { z = wc.getZoomFactor() || 1; } catch {}
    const x = Math.round(xCss * z), y = Math.round(yCss * z);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await sleepMs(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleepMs(55);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  // Frappe native d'une touche (ex. 'Return' pour valider un formulaire).
  function nativeKeyTap(wc, keyCode) {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'char', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  }


  // ----- Entrées natives supplémentaires (souris, clavier, molette) ----------
  function cssToDip(wc, x, y) {
    let z = 1;
    try { z = wc.getZoomFactor() || 1; } catch {}
    return { x: Math.round(x * z), y: Math.round(y * z) };
  }


  // Clic natif généralisé : bouton, nombre de clics (double/triple), modificateurs.
  async function nativeMouseClick(wc, xCss, yCss, opts) {
    opts = opts || {};
    const { x, y } = cssToDip(wc, xCss, yCss);
    const button = ['left', 'right', 'middle'].includes(opts.button) ? opts.button : 'left';
    const clicks = Math.max(1, Math.min(3, parseInt(opts.clicks, 10) || 1));
    const modifiers = parseModifiers(opts.modifiers);
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    await sleepMs(40);
    for (let i = 1; i <= clicks; i++) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: i, modifiers });
      await sleepMs(45);
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: i, modifiers });
      if (i < clicks) await sleepMs(70);
    }
  }


  // Une combinaison (« ctrl+shift+a ») ou une touche simple, frappée nativement.
  async function nativeKeyCombo(wc, combo) {
    const parts = String(combo).split('+').filter(Boolean);
    if (!parts.length) return;
    const keyName = parts.pop();
    const modifiers = parseModifiers(parts.join('+'));
    const keyCode = keyCodeFor(keyName);
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // Caractère imprimable sans raccourci : l'événement char insère le texte.
    const printable = keyCode.length === 1 || keyCode === 'Space' || keyCode === 'Return';
    if (printable && !modifiers.some(m => m === 'control' || m === 'meta' || m === 'alt')) {
      wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : keyCode === 'Return' ? '\r' : keyCode, modifiers });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleepMs(35);
  }

  // Dernière capture envoyée au modèle : ses pixels servent de repère aux
  // actions par coordonnées (rapport capture -> pixels CSS de la page).
  const lastShotScale = new WeakMap();   // webContents -> facteur image / CSS

  async function agentPoint(wc, target) {
    target = target || {};
    if (Array.isArray(target.coordinate) && target.coordinate.length >= 2) {
      const scale = lastShotScale.get(wc) || 1;
      const x = Number(target.coordinate[0]) / scale, y = Number(target.coordinate[1]) / scale;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'coordonnées invalides' };
      return { x, y, rect: null, label: '(' + Math.round(x) + ', ' + Math.round(y) + ')' };
    }
    if (!target.ref && !target.selector && !target.text) return { error: 'préciser "ref", "selector", "text" ou "coordinate"' };
    const pt = await agentExec(wc, resolveTargetJs(target));
    return pt || { error: 'élément introuvable' };
  }

  // Capture de l'onglet, redimensionnée pour le modèle (JPEG compact).
  async function agentScreenshot(wc, region) {
    const vp = await wc.executeJavaScript('({w:innerWidth,h:innerHeight})', true).catch(() => null);
    if (!vp || !vp.w) return { error: 'capture impossible pour le moment' };
    let z = 1;
    try { z = wc.getZoomFactor() || 1; } catch {}
    let rect;
    if (Array.isArray(region) && region.length === 4) {
      const scale = lastShotScale.get(wc) || 1;
      const [x0, y0, x1, y1] = region.map(v => Number(v) / scale);
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return { error: 'zone invalide' };
      rect = { x: Math.round(x0 * z), y: Math.round(y0 * z), width: Math.round((x1 - x0) * z), height: Math.round((y1 - y0) * z) };
    }
    // L'overlay du curseur est masqué le temps de la capture.
    await agentExec(wc, 'window.__zCur && (window.__zCur.root.style.visibility="hidden")').catch(() => {});
    let img = null;
    try {
      try { img = rect ? await wc.capturePage(rect) : await wc.capturePage(); } catch { img = null; }
      // Fenêtre réduite ou recouverte : le compositeur ne fournit pas d'image
      // (UnknownVizError). Le protocole DevTools sait rendre la page malgré tout.
      if ((!img || img.isEmpty()) && ensureDebugger(wc)) {
        const clip = rect ? { x: rect.x / z, y: rect.y / z, width: rect.width / z, height: rect.height / z, scale: z } : undefined;
        const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }).catch(() => null);
        if (shot && shot.data) img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      }
    } finally { await agentExec(wc, 'window.__zCur && (window.__zCur.root.style.visibility="")').catch(() => {}); }
    if (!img || img.isEmpty()) return { error: 'capture vide (onglet masqué ?)' };
    if (rect) {
      // Zoom : la zone est agrandie jusqu'à 1280 px de large pour être lisible.
      const sz = img.getSize();
      const w = Math.min(1280, Math.max(sz.width, Math.round(sz.width * 2)));
      img = img.resize({ width: w, quality: 'best' });
      const out = img.getSize();
      return { data: img.toJPEG(85).toString('base64'), width: out.width, height: out.height, zoom: true };
    }
    // Capture complète : image à l'échelle CSS (au plus 1440 px de large) pour
    // que les coordonnées vues par le modèle correspondent aux pixels de la page.
    const width = Math.min(1440, vp.w);
    img = img.resize({ width, quality: 'good' });
    const out = img.getSize();
    lastShotScale.set(wc, out.width / vp.w);
    return { data: img.toJPEG(80).toString('base64'), width: out.width, height: out.height, zoom: false };
  }

  // ----- Protocole DevTools (réseau détaillé, envoi de fichiers) -------------
  const netLogs = new WeakMap();      // webContents -> [{ method, url, status, type, mime }]
  function ensureDebugger(wc) {
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
        wc.debugger.on('detach', () => netLogs.delete(wc));
        wc.debugger.on('message', (_e, method, params) => {
          const log = netLogs.get(wc);
          if (!log) return;
          if (method === 'Network.requestWillBeSent') {
            log.push({ id: params.requestId, method: params.request.method, url: params.request.url, type: params.type || '', status: 0 });
            if (log.length > 300) log.shift();
          } else if (method === 'Network.responseReceived') {
            const e = log.find(x => x.id === params.requestId);
            if (e) { e.status = params.response.status; e.mime = params.response.mimeType; }
          } else if (method === 'Network.loadingFailed') {
            const e = log.find(x => x.id === params.requestId);
            if (e) e.failed = params.errorText || 'échec';
          }
        });
      }
      return true;
    } catch { return false; }
  }
  async function startNetworkCapture(wc) {
    if (netLogs.has(wc)) return true;
    if (!ensureDebugger(wc)) return false;
    netLogs.set(wc, []);
    try { await wc.debugger.sendCommand('Network.enable'); return true; } catch { netLogs.delete(wc); return false; }
  }


  // Exécute un outil sur l'onglet piloté. Renvoie un texte pour le modèle, ou un
  // objet { text, image?, tab? } (capture jointe, changement d'onglet piloté).
  async function runAgentTool(t, tool, args) {
    args = args || {};
    const J = (v) => JSON.stringify(v);
    // Outils d'onglets : utilisables même sans page active.
    if (tool === 'tabs_list') {
      return J(M.tabs.map(x => ({ tab_id: x.id, titre: x.view.webContents.getTitle(), url: x.view.webContents.getURL(),
        actif: x === M.activeTab(), piloté: x === t, privé: !!x.incognito })));
    }
    if (tool === 'tab_new') {
      const nt = M.createTab(args.url ? String(args.url) : '', true, { incognito: !!(t && t.incognito), openerId: t ? t.id : 0 });
      await waitLoad(nt.view.webContents, 6000);
      return { text: 'Nouvel onglet ' + nt.id + ' ouvert et piloté : ' + nt.view.webContents.getURL(), tab: nt };
    }
    if (tool === 'tab_select') {
      const nt = M.tabs.find(x => x.id === parseInt(args.tab_id, 10));
      if (!nt) return 'Onglet introuvable : ' + args.tab_id + ' (voir tabs_list).';
      M.selectTab(nt.id);
      return { text: 'Onglet ' + nt.id + ' sélectionné et piloté : ' + nt.view.webContents.getTitle() + ' — ' + nt.view.webContents.getURL(), tab: nt };
    }
    if (tool === 'tab_close') {
      const id = args.tab_id != null ? parseInt(args.tab_id, 10) : (t ? t.id : -1);
      const ct = M.tabs.find(x => x.id === id);
      if (!ct) return 'Onglet introuvable : ' + args.tab_id;
      M.closeTab(ct.id);
      const now = M.activeTab();
      return ct === t ? { text: 'Onglet fermé. Onglet piloté : ' + (now ? now.id + ' — ' + now.view.webContents.getURL() : 'aucun'), tab: now } : 'Onglet ' + id + ' fermé.';
    }
    if (tool === 'wait') {
      const s = Math.max(0.1, Math.min(30, Number(args.seconds) || 1));
      await sleepMs(s * 1000);
      return 'Attente de ' + s + ' s terminée.';
    }
    if (!t) return 'Aucune page web active.';
    const wc = t.view.webContents;

    switch (tool) {
      case 'read_page': {
        const r = await agentExec(wc, a11ySnapshotJs(args.selector));
        if (!r) return 'Page illisible pour le moment.';
        if (r.error) return r.error;
        let tree = r.tree || '(page vide)';
        if (args.filter === 'interactive') tree = tree.split('\n').filter(l => /\[ref_\d+\]/.test(l)).join('\n');
        return 'Titre : ' + r.title + '\nURL : ' + agentUrl(r.url) + '\n\n' + tree +
               (r.cut ? '\n…(arbre tronqué — précise "selector" ou utilise find)' : '');
      }
      case 'find': {
        const r = await agentExec(wc, findElementsJs(args.query));
        if (!r || r.error) return (r && r.error) || 'Recherche impossible.';
        if (!r.lines.length) return 'Aucun élément ne correspond à « ' + args.query + ' ». Essaie read_page ou screenshot.';
        return r.lines.join('\n') + (r.total > r.lines.length ? '\n…(' + r.total + ' correspondances, affine la requête)' : '');
      }
      case 'get_page_text': {
        const r = await agentExec(wc, PAGE_TEXT_JS);
        if (!r) return 'Texte illisible.';
        return 'Titre : ' + r.title + '\nURL : ' + agentUrl(r.url) + '\n\n' + clampResult(r.text || '(aucun texte)');
      }
      case 'screenshot': {
        const shot = await agentScreenshot(wc, args.region);
        if (shot.error) return shot.error;
        return {
          text: (shot.zoom ? 'Zoom de la zone demandée' : 'Capture de l\'onglet') + ' jointe (' + shot.width + '×' + shot.height + ' px)' +
                (shot.zoom ? '.' : ' ; ces pixels sont les coordonnées à utiliser avec "coordinate".'),
          image: { mime: 'image/jpeg', data: shot.data },
        };
      }
      case 'read_console': {
        let buf = t.consoleBuf || [];
        if (args.only_errors) buf = buf.filter(e => e.level === 'error' || e.level === 'warn');
        if (args.pattern) { const p = String(args.pattern).toLowerCase(); buf = buf.filter(e => e.message.toLowerCase().includes(p)); }
        if (!buf.length) return 'Aucun message correspondant dans la console (depuis le chargement de la page).';
        return buf.slice(-80).map(e => '[' + e.level + '] ' + e.message + (e.source ? ' (' + e.source + ':' + e.line + ')' : '')).join('\n');
      }
      case 'read_network': {
        const fresh = !netLogs.has(wc);
        const live = await startNetworkCapture(wc);
        let list = live ? (netLogs.get(wc) || []) : [];
        if (args.pattern) { const p = String(args.pattern).toLowerCase(); list = list.filter(e => e.url.toLowerCase().includes(p)); }
        if (live && list.length) {
          return clampResult(list.slice(-80).map(e => e.method + ' ' + (e.failed ? 'ÉCHEC ' + e.failed : e.status || '…') + ' ' + e.type + ' ' + e.url.slice(0, 200)).join('\n'));
        }
        // Pas encore de journal : ressources déjà chargées (API Performance).
        const perf = await wc.executeJavaScript(
          '(()=>{try{return performance.getEntriesByType("resource").slice(-60).map(e=>({url:e.name,type:e.initiatorType,ms:Math.round(e.duration),size:e.transferSize||0,status:e.responseStatus||0}))}catch(e){return[]}})()', true).catch(() => []);
        const p = args.pattern ? String(args.pattern).toLowerCase() : '';
        const rows = perf.filter(e => !p || e.url.toLowerCase().includes(p)).map(e => 'GET ' + (e.status || '?') + ' ' + e.type + ' ' + e.ms + 'ms ' + e.url.slice(0, 200));
        return clampResult((fresh && live ? 'Capture réseau détaillée activée pour les prochaines requêtes.\n' : '') + (rows.join('\n') || 'Aucune requête enregistrée.'));
      }
      case 'fetch_url': {
        let u = M.allowedPageUrl(String(args.url || ''), false);
        if (!u) return 'URL refusée : seuls http et https sont autorisés.';
        try {
          const res = await wc.session.fetch(u, { credentials: 'include', headers: { 'User-Agent': M.chromeUserAgent() } });
          const type = res.headers.get('content-type') || '';
          let body = await res.text();
          if (/html/i.test(type)) body = stripHtml(body);
          return clampResult('HTTP ' + res.status + ' — ' + type + '\n\n' + body);
        } catch (e) { return 'Échec de lecture : ' + (e && e.message || e); }
      }
      case 'wait_for': {
        if (!args.selector && !args.text) return 'Erreur : préciser "selector" ou "text".';
        const limit = Math.max(1, Math.min(60, Number(args.timeout) || 10)) * 1000;
        const start = Date.now();
        while (Date.now() - start < limit) {
          const ok = await agentExec(wc, waitForJs(args.selector, args.text)).catch(() => false);
          if (ok === 'invalid') return 'Sélecteur invalide : ' + args.selector;
          if (ok === true) return 'Trouvé après ' + ((Date.now() - start) / 1000).toFixed(1) + ' s.';
          await sleepMs(250);
        }
        return 'Toujours absent après ' + (limit / 1000) + ' s.';
      }
      case 'execute_js': {
        const code = String(args.code || '');
        if (!code.trim()) return 'Erreur : aucun code fourni.';
        const wrapped =
          '(async()=>{try{const __r=await (async()=>{' + code + '\n})();' +
          'return JSON.stringify(__r===undefined?"(ok, sans valeur de retour)":__r);}' +
          'catch(e){return JSON.stringify({__error:String(e&&e.message||e)});}})()';
        const raw = await wc.executeJavaScript(wrapped, true);
        return clampResult(raw);
      }
      case 'inject_css': {
        const css = String(args.css || '');
        if (!css.trim()) return 'Erreur : aucun CSS fourni.';
        const key = await wc.insertCSS(css, { cssOrigin: 'author' });
        return J({ ok: true, appliqué: css.length + ' caractères', clé: key });
      }
      case 'click':
      case 'hover': {
        const pt = await agentPoint(wc, args);
        if (pt.error) return J({ error: pt.error });
        const verb = tool === 'hover' ? 'Survol' : (args.clicks == 2 ? 'Double-clic' : args.button === 'right' ? 'Clic droit' : 'Clic');
        await agentShowAction(wc, pt, verb + (pt.label ? ' — ' + pt.label.slice(0, 40) : ''), tool === 'click');
        if (tool === 'hover') {
          const d = cssToDip(wc, pt.x, pt.y);
          wc.sendInputEvent({ type: 'mouseMove', x: d.x, y: d.y });
          await sleepMs(300);
          return J({ ok: true, survolé: pt.label || '(élément)' });
        }
        const before = wc.getURL();
        await nativeMouseClick(wc, pt.x, pt.y, { button: args.button, clicks: args.clicks, modifiers: args.modifiers });
        await sleepMs(450);
        const out = { ok: true, cliqué: pt.label || '(élément)' };
        if (wc.getURL() !== before) { await waitLoad(wc, 4000); out.navigation = wc.getURL(); }
        return J(out);
      }
      case 'fill': {
        if (!args.ref && !args.selector && !args.text) return 'Erreur : "ref" ou "selector" requis.';
        const pt = await agentExec(wc, resolveTargetJs({ ref: args.ref, selector: args.selector, text: args.text }));
        if (!pt || pt.error) return J({ error: (pt && pt.error) || 'champ introuvable' });
        const value = String(args.value == null ? '' : args.value);
        await agentShowAction(wc, pt, 'Saisie — ' + (pt.label || 'champ').slice(0, 40), true);
        wc.focus();
        await nativeClick(wc, pt.x, pt.y);   // focus par vrai clic (handlers focus/click natifs)
        await sleepMs(140);
        await agentExec(wc, FOCUS_SELECT_JS);          // sélectionne l'existant…
        try { await wc.insertText(value); } catch {}   // …remplacé par une frappe native
        await sleepMs(90);
        // Vérifie la valeur obtenue ; au besoin repli sur l'affectation directe.
        let final = await agentExec(wc, READ_VALUE_JS);
        if (final !== value) {
          await agentExec(wc, legacyFillJs(value));
          final = await agentExec(wc, READ_VALUE_JS);
        }
        await agentExec(wc, DISPATCH_CHANGE_JS);
        if (args.enter) { await sleepMs(80); nativeKeyTap(wc, 'Return'); await sleepMs(400); await waitLoad(wc, 4000); }
        // Rend le clavier au panneau IA pour ne pas voler la saisie de l'utilisateur.
        if (M.aiPanelOpen && M.aiPanelView) { try { M.aiPanelView.webContents.focus(); } catch {} }
        return J({ ok: true, champ: pt.label || args.selector || args.ref || '',
                   valeur: String(final == null ? '' : final).slice(0, 120), entrée: !!args.enter });
      }
      case 'form_input': {
        const pt = await agentPoint(wc, args);
        if (pt.error) return J({ error: pt.error });
        await agentShowAction(wc, pt, 'Réglage — ' + (pt.label || 'champ').slice(0, 40), false);
        const r = await agentExec(wc, formInputJs(args.value));
        if (r && r.toggle) { await nativeClick(wc, pt.x, pt.y); await sleepMs(200); }
        return J(r || { error: 'réglage impossible' });
      }
      case 'type': {
        const text = String(args.text == null ? '' : args.text);
        if (!text) return 'Erreur : "text" vide.';
        wc.focus();
        try { await wc.insertText(text); } catch (e) { return 'Frappe impossible : ' + (e && e.message || e); }
        return J({ ok: true, tapé: text.length + ' caractères' });
      }
      case 'key': {
        const seq = String(args.keys || '').trim().split(/\s+/).filter(Boolean);
        if (!seq.length) return 'Erreur : "keys" vide.';
        const repeat = Math.max(1, Math.min(50, parseInt(args.repeat, 10) || 1));
        wc.focus();
        const before = wc.getURL();
        for (let i = 0; i < repeat; i++) for (const combo of seq) await nativeKeyCombo(wc, combo);
        await sleepMs(250);
        const out = { ok: true, touches: seq.join(' ') + (repeat > 1 ? ' ×' + repeat : '') };
        if (wc.getURL() !== before) { await waitLoad(wc, 4000); out.navigation = wc.getURL(); }
        return J(out);
      }
      case 'scroll': {
        const dir = String(args.direction || 'down').toLowerCase();
        const amount = Math.max(1, Math.min(30, Number(args.amount) || 3));
        let pt = null;
        if (args.ref || args.selector || args.text || args.coordinate) { pt = await agentPoint(wc, args); if (pt.error) return J({ error: pt.error }); }
        const vp = await wc.executeJavaScript('({w:innerWidth,h:innerHeight})', true).catch(() => ({ w: 800, h: 600 }));
        const at = cssToDip(wc, pt ? pt.x : vp.w / 2, pt ? pt.y : vp.h / 2);
        const step = 120 * amount;
        const dx = dir === 'left' ? step : dir === 'right' ? -step : 0;
        const dy = dir === 'up' ? step : dir === 'down' ? -step : 0;
        wc.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: dx, deltaY: dy, canScroll: true });
        await sleepMs(350);
        const pos = await wc.executeJavaScript('({x:Math.round(scrollX),y:Math.round(scrollY),h:document.documentElement.scrollHeight})', true).catch(() => null);
        return J({ ok: true, défilement: dir, position: pos });
      }
      case 'scroll_to': {
        const pt = await agentPoint(wc, args);   // resolveTargetJs centre déjà l'élément
        if (pt.error) return J({ error: pt.error });
        await agentShowAction(wc, pt, 'Ici', false);
        return J({ ok: true, visible: pt.label || '(élément)' });
      }
      case 'drag': {
        const from = await agentPoint(wc, typeof args.from === 'object' ? args.from : { ref: args.from });
        if (from.error) return J({ error: 'départ : ' + from.error });
        const to = await agentPoint(wc, typeof args.to === 'object' ? args.to : { ref: args.to });
        if (to.error) return J({ error: 'arrivée : ' + to.error });
        await agentShowAction(wc, from, 'Glisser', false);
        const a = cssToDip(wc, from.x, from.y), b = cssToDip(wc, to.x, to.y);
        wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
        wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 12; i++) {
          await sleepMs(25);
          wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + (b.x - a.x) * i / 12), y: Math.round(a.y + (b.y - a.y) * i / 12), modifiers: ['leftbuttondown'] });
        }
        await agentShowAction(wc, to, 'Déposer', false);
        wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        await sleepMs(300);
        return J({ ok: true, de: from.label, vers: to.label });
      }
      case 'upload_file': {
        const paths = (Array.isArray(args.paths) ? args.paths : [args.path || args.paths]).filter(Boolean).map(String);
        if (!paths.length) return 'Erreur : "paths" requis.';
        const missing = paths.filter(p => !fs.existsSync(p));
        if (missing.length) return 'Fichier introuvable : ' + missing.join(', ');
        const pt = await agentPoint(wc, args);
        if (pt.error) return J({ error: pt.error });
        // Chaque envoi de fichier est confirmé : c'est une sortie de données locales.
        const ok = await dialog.showMessageBox(M.mainWin, {
          type: 'question', title: 'zaalis Browser', buttons: ['Annuler', 'Envoyer'], defaultId: 0, cancelId: 0, noLink: true,
          message: 'L\'assistant IA veut envoyer ' + paths.length + ' fichier(s) à ' + M.hostOf(wc.getURL()),
          detail: paths.join('\n'),
        });
        if (ok.response !== 1) return 'Envoi refusé par l\'utilisateur.';
        const token = 'z' + crypto.randomBytes(6).toString('hex');
        const marked = await agentExec(wc, `(() => { const el = window.__zTarget; if (!el) return false;
          const input = el.matches('input[type=file]') ? el : el.querySelector('input[type=file]');
          if (!input) return false; input.setAttribute('data-zaalis-upload', ${J(token)}); return true; })()`);
        if (!marked) return 'Cet élément n\'est pas un champ fichier (input type=file).';
        if (!ensureDebugger(wc)) return 'Envoi impossible : outils de développement indisponibles.';
        try {
          const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
          const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-zaalis-upload="' + token + '"]' });
          if (!nodeId) return 'Champ fichier introuvable.';
          await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: paths, nodeId });
        } catch (e) { return 'Envoi impossible : ' + (e && e.message || e); }
        finally { agentExec(wc, `document.querySelector('[data-zaalis-upload]')?.removeAttribute('data-zaalis-upload')`).catch(() => {}); }
        return J({ ok: true, envoyés: paths.map(p => path.basename(p)) });
      }
      case 'navigate': {
        if (args.action === 'back')    { if (wc.navigationHistory.canGoBack())    wc.navigationHistory.goBack();    else return 'Impossible de reculer.'; }
        else if (args.action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); else return 'Impossible d\'avancer.'; }
        else if (args.action === 'reload')  { wc.reload(); }
        else if (args.url) {
          let u = String(args.url).trim();
          if (!/^[a-z]+:\/\//i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? M.resolveQuery(u) : 'https://' + u;
          u = M.allowedPageUrl(u, false);
          if (!u) return 'Navigation refusée : seuls les liens http et https sont autorisés.';
          try { await wc.loadURL(u); } catch (e) { if (!/ERR_ABORTED/.test(String(e && e.message))) return 'Échec de navigation : ' + (e && e.message || e); }
        } else return 'Erreur : préciser "url" ou "action".';
        await waitLoad(wc, 5000);
        if (aiControlTab === t) await setAiControlBorder(t, true);
        return 'Page chargée : ' + wc.getTitle() + ' — ' + wc.getURL();
      }
      case 'resize_viewport': {
        if (args.reset) { wc.disableDeviceEmulation(); return 'Taille d\'écran réelle rétablie.'; }
        const w = Math.max(200, Math.min(4000, parseInt(args.width, 10) || 0));
        const h = Math.max(200, Math.min(4000, parseInt(args.height, 10) || 0));
        if (!w || !h) return 'Erreur : "width" et "height" requis.';
        wc.enableDeviceEmulation({ screenPosition: w < 900 ? 'mobile' : 'desktop', screenSize: { width: w, height: h },
          viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width: w, height: h }, scale: 1 });
        await sleepMs(300);
        return 'Écran simulé : ' + w + '×' + h + ' (resize_viewport {"reset":true} pour revenir).';
      }
      case 'download': {
        const u = M.allowedPageUrl(String(args.url || ''), false);
        if (!u) return 'URL refusée.';
        wc.downloadURL(u);
        return 'Téléchargement lancé vers le dossier Téléchargements : ' + u;
      }
      case 'save_pdf': {
        try {
          const data = await wc.printToPDF({ printBackground: true });
          const dir = app.getPath('downloads');
          const file = M.uniqueDownloadPath(dir, (wc.getTitle() || 'page').slice(0, 100) + '.pdf');
          fs.writeFileSync(file, data);
          return J({ ok: true, fichier: file });
        } catch (e) { return 'PDF impossible : ' + (e && e.message || e); }
      }
      default:
        return 'Outil inconnu : ' + tool + '. Outils disponibles : voir la liste du message système.';
    }
  }

  // Contexte rapide de la page active, injecté dans le prompt système à chaque tour.
  async function quickPageContext(t) {
    if (!t) return '';
    try {
      const info = await t.view.webContents.executeJavaScript(
        '({title:document.title||"",url:location.href,text:(document.body&&document.body.innerText||"").replace(/\\s+/g," ").trim().slice(0,2500)})', true);
      // Une URL data: contient tout le document : inutile (et coûteux) de la répéter.
      const shownUrl = /^data:/i.test(info.url) ? 'data: (document généré localement)' : String(info.url).slice(0, 500);
      return 'Titre : ' + (info.title || '(sans titre)') + '\nURL : ' + shownUrl + ' — onglet ' + t.id +
             '\nAperçu du contenu :\n' + (info.text || '(vide)');
    } catch { return ''; }
  }

  function ideErrorReply(e) {
    const m = String(e && e.message || '');
    if (m.startsWith('no-key:')) return '⚠️ ' + m.slice(7) + '\nAjoute ta clé API dans zaalis labs ide (Paramètres → Clés API).';
    if (m === 'no-secret') return '⚠️ zaalis labs ide n\'a jamais été lancé sur cet ordinateur. Lance-le une première fois pour activer l\'IA.';
    if (m === 'timeout')   return '⚠️ Le modèle met trop de temps à répondre. Réessaie.';
    if (/too many|429|rate.?limit/i.test(m)) return '⚠️ Le fournisseur IA limite le débit (trop de requêtes rapprochées). Patiente quelques secondes puis réessaie.';
    if (!m || /ECONNREFUSED|ERR_CONNECTION|net::|socket hang up|ECONNRESET/i.test(m)) {
      return '⚠️ Impossible de joindre zaalis labs ide. Vérifie qu\'il est bien lancé, puis réessaie.';
    }
    // Message explicite de l'IDE (abonnement ChatGPT déconnecté, modèle inconnu,
    // clé de passerelle absente…) : on le montre tel quel, il dit quoi faire.
    return '⚠️ ' + m.slice(0, 400) +
      (/abonnement|chatgpt|cl[ée]|key/i.test(m) ? '\nVérifie la configuration dans zaalis labs ide (Paramètres).' : '');
  }

  async function aiChatSend(text, pageContext) {
    text = String(text || '').replace(/\x1f/g, ' ').trim();
    if (!text || M.aiChatBusy) return;
    let chat = M.aiChatById(M.aiCurrentChatId);
    if (!chat) chat = M.newAiChat(text.slice(0, 44));
    if (chat.messages.length === 0 && chat.title === 'Nouvelle conversation') chat.title = text.slice(0, 44);

    // Historique conversationnel (on écarte les étapes d'outils, non pertinentes
    // pour le modèle d'un tour à l'autre et parfois refusées par le serveur).
    const history = chat.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));
    chat.messages.push({ role: 'user', content: text });
    chat.updatedAt = new Date().toISOString();
    M.saveAiChats();
    M.aiChatBusy = true;
    M.pushAiChatMessages();
    M.pushAiChatList();

    // Onglet piloté par l'agent : peut changer en cours de route (tab_new, tab_select).
    let t = M.activeTab();
    let liveCtx = pageContext;
    if (!liveCtx && t) liveCtx = await quickPageContext(t);
    const sysPrompt = AGENT_SYSTEM + (liveCtx
      ? '\n\n--- Page actuellement ouverte ---\n' + liveCtx
      : '\n\n(Aucune page web active pour le moment.)');

    const loopHistory = history.slice();
    let nextMessage = text + '\n\n[zaalis Browser] Pour lire ou agir sur la page, utilise les blocs zaalis-tool ' +
      '(lire un élément précis : execute_js, find ou get_page_text).';
    let nextImages = [];
    let usedTool = false, retriedProtocol = false;
    let finalReply = null;
    // L'IA voit la page dès le premier tour : capture de l'onglet jointe
    // (retirée automatiquement si le modèle ne lit pas les images).
    lastAgentAutoShot = false;
    if (t && !M.isInternal(t.view.webContents.getURL())) {
      const shot = await agentScreenshot(t.view.webContents).catch(() => ({ error: true }));
      if (shot && !shot.error) {
        nextImages = [{ mime: 'image/jpeg', data: shot.data }];
        nextMessage += '\n(Capture actuelle de l\'onglet jointe, ' + shot.width + '×' + shot.height + ' px ; utilise screenshot pour une vue à jour.)';
        lastAgentAutoShot = true;
      }
    }
    let agentMutationApproved = false;

    let repeatKey = '', repeatCount = 0;
    for (let step = 0; step < AGENT_HARD_CAP; step++) {
      // Limite réelle = tokens : on s'arrête proprement avant de saturer le
      // contexte du modèle, plutôt que d'attendre une erreur d'API.
      if (agentTokenEstimate(sysPrompt, loopHistory, nextMessage) > AGENT_TOKEN_BUDGET) {
        finalReply = 'J\'ai atteint la limite de contexte (tokens) du modèle après avoir traité une grande partie de la tâche. Relance-moi pour poursuivre.';
        break;
      }
      // Un échec ponctuel (rate-limit du fournisseur, réseau) ne doit pas casser
      // toute la session d'agent : jusqu'à 3 tentatives avec pause adaptée
      // (les 429 « Too Many Requests » exigent de laisser la fenêtre se rouvrir).
      let out = null, lastErr = null;
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          out = await M.ideChat({ message: nextMessage, history: loopHistory, systemPrompt: sysPrompt, timeoutMs: 120000, images: nextImages });
        } catch (e) {
          lastErr = e;
          const m = String(e && e.message || '');
          if (m.startsWith('no-key:') || m === 'no-secret') break;
          // Modèle sans vision : on retire la capture et on le lui signale.
          if (nextImages.length && /image|vision|multimodal/i.test(m)) {
            nextImages = [];
            nextMessage += '\n(La capture n\'a pas pu être transmise : ce modèle ne lit pas les images. Utilise read_page, find ou get_page_text.)';
            continue;
          }
          if (attempt < 2) await sleepMs(/too many|429|rate.?limit/i.test(m) ? 12000 : 2500);
        }
      }
      if (!out) { finalReply = ideErrorReply(lastErr); break; }

      const resp = out.response;
      nextImages = [];
      const call = parseToolCall(resp);
      // Le modèle a tenté un outil intégré de l'IDE (autre navigateur) au lieu
      // des nôtres et abandonne : une seule relance, avec la consigne explicite.
      if (!call && !usedTool && !retriedProtocol && t &&
          /(n['’]ai pas pu|impossible|ne peux pas|n['’]arrive pas).{0,80}(capture|page|onglet|outil|navigateur|délai)|outil.{0,30}(expir|erreur|lecture seule)/i.test(resp)) {
        retriedProtocol = true;
        loopHistory.push({ role: 'user', content: nextMessage });
        loopHistory.push({ role: 'assistant', content: resp });
        nextMessage = '[zaalis Browser] Tu as utilisé un outil intégré qui ne voit pas cette page. Recommence avec les outils ' +
          'de zaalis Browser : réponds UNIQUEMENT par un bloc ```zaalis-tool (par exemple {"tool":"screenshot","args":{}} ' +
          'ou {"tool":"read_page","args":{}}).';
        continue;
      }
      if (!call) { finalReply = resp; break; }
      usedTool = true;

      // Garde-fou anti-boucle : la même action répétée à l'identique plusieurs
      // fois d'affilée = blocage (le remplissage légitime vise des champs
      // différents, donc des args différents).
      const repeatK = call.tool + '|' + JSON.stringify(call.args || {});
      if (repeatK === repeatKey) {
        if (++repeatCount >= 4) { finalReply = 'Je répète la même action sans progresser, je m\'arrête pour éviter une boucle. Peux-tu préciser la demande ?'; break; }
      } else { repeatKey = repeatK; repeatCount = 0; }

      // Le modèle demande un outil : on l'exécute et on réinjecte le résultat.
      loopHistory.push({ role: 'user', content: nextMessage });
      loopHistory.push({ role: 'assistant', content: resp });

      const label = toolLabel(call);
      if (t) {
        await setAiControlBorder(t, true);
        await agentHoldCursor(t.view.webContents, label);
      }
      M.aiPanelSend({ type: 'aiChatStep', label });
      let result;
      const mutating = AGENT_MUTATING_TOOLS.has(call.tool);
      if (mutating && agentAutoApprove && M.AGENT_SELFTEST) agentMutationApproved = true;
      if (mutating && !agentMutationApproved) {
        const choice = await dialog.showMessageBox(M.mainWin, {
          type: 'question',
          buttons: ['Annuler', 'Autoriser cette action'],
          defaultId: 0, cancelId: 0,
          message: 'L’assistant IA souhaite agir sur la page',
          detail: label + '\n\nLa page peut contenir des instructions trompeuses. Autorisez seulement si cette action correspond bien à votre demande.',
        });
        agentMutationApproved = choice.response === 1;
        if (!agentMutationApproved) result = 'Action refusée par l’utilisateur.';
      }
      try { if (result == null) result = await runAgentTool(t, call.tool, call.args); }
      catch (e) { result = 'Erreur outil : ' + (e && e.message || e); }
      // Résultat riche : capture jointe (vision) et/ou nouvel onglet piloté.
      if (result && typeof result === 'object') {
        if (result.image) nextImages = [result.image];
        if ('tab' in result) {
          if (t && t !== result.tab) await setAiControlBorder(null, false);
          t = result.tab || M.activeTab();
        }
        result = result.text || '';
      }

      chat.messages.push({ role: 'tool', tool: call.tool, label, content: clampResult(result).slice(0, 800) });
      chat.updatedAt = new Date().toISOString();
      M.saveAiChats();
      // Mise à jour INCRÉMENTALE (pas de re-render complet) : le panneau ajoute
      // la ligne au lot et fait glisser le compteur, sans reconstruire le chat.
      M.aiPanelSend({ type: 'aiChatAction', label });

      // Rappel du protocole à chaque tour : le cœur de l'IDE expose aussi ses
      // propres outils « browser » / « computer », qui visent un autre navigateur.
      nextMessage = '[RÉSULTAT DE L\'OUTIL ' + call.tool + ' — exécuté dans zaalis Browser, onglet ' + (t ? t.id : '?') + ']\n' +
        clampResult(result) +
        '\n\n[zaalis Browser] Pour la prochaine action, réponds UNIQUEMENT par un bloc ```zaalis-tool ' +
        '(ou donne ta réponse finale sans bloc). Tes outils intégrés browser/computer ne voient pas cette page : ne les appelle pas.';
    }

    if (finalReply == null) finalReply = 'Je me suis arrêté après plusieurs étapes d\'analyse sans conclure. Peux-tu préciser ta demande ?';
    await setAiControlBorder(null, false);
    chat.messages.push({ role: 'assistant', content: finalReply });
    chat.updatedAt = new Date().toISOString();
    M.aiChatBusy = false;
    M.saveAiChats();
    M.pushAiChatMessages();
    M.pushAiChatList();
  }

  // « Demander a l'IA » : extrait le texte de la page active, ouvre le panneau
  // et lance un resume dans une nouvelle conversation.
  async function askAiAboutPage() {
    const t = M.activeTab();
    if (!t) return;
    M.openAiPanel();
    if (M.aiChatBusy) return;   // une reponse est deja en cours : on montre juste le panneau
    let info = null;
    try {
      info = await t.view.webContents.executeJavaScript(`({
        title: document.title || '',
        url: location.href,
        text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 8000),
      })`, true);
    } catch {}
    const title = (info && info.title) || t.view.webContents.getTitle() || 'cette page';
    const url = (info && info.url) || t.view.webContents.getURL() || '';
    M.newAiChat(('Résumé — ' + title).slice(0, 60));
    M.pushAiChatList();
    M.pushAiChatMessages();
    const ctx = 'Titre : ' + title + '\nURL : ' + url + '\n\nContenu :\n' + ((info && info.text) || '(contenu inaccessible)');
    aiChatSend('Fais un résumé clair et structuré de cette page.', ctx);
  }


  return {
    get AGENT_HARD_CAP() { return AGENT_HARD_CAP; },
    get AGENT_TOKEN_BUDGET() { return AGENT_TOKEN_BUDGET; },
    agentTokenEstimate,
    get agentAutoApprove() { return agentAutoApprove; },
    set agentAutoApprove(v) { agentAutoApprove = v; },
    get lastAgentAutoShot() { return lastAgentAutoShot; },
    set lastAgentAutoShot(v) { lastAgentAutoShot = v; },
    get AGENT_MUTATING_TOOLS() { return AGENT_MUTATING_TOOLS; },
    waitLoad,
    get sleepMs() { return sleepMs; },
    get AGENT_WORLD_ID() { return AGENT_WORLD_ID; },
    get aiControlTab() { return aiControlTab; },
    set aiControlTab(v) { aiControlTab = v; },
    agentExec,
    setAiControlBorder,
    agentHoldCursor,
    agentShowAction,
    nativeClick,
    nativeKeyTap,
    cssToDip,
    nativeMouseClick,
    nativeKeyCombo,
    get lastShotScale() { return lastShotScale; },
    agentPoint,
    agentScreenshot,
    get netLogs() { return netLogs; },
    ensureDebugger,
    startNetworkCapture,
    runAgentTool,
    quickPageContext,
    ideErrorReply,
    aiChatSend,
    askAiAboutPage,
  };
}

module.exports = { init };
