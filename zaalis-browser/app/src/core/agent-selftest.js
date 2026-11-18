'use strict';
// Self-test de l'agent IA (développement : npm run selftest).
// Module extrait de main.js : les dépendances sur l'état du navigateur
// passent par M (accesseurs fournis par main.js, toujours à jour).

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { app, BrowserWindow } = require('electron');
const { parseToolCall, AGENT_SYSTEM } = require('./page-scripts');
const { describeNetError, wrappedLinkTarget } = require('./net-errors');

function init(M) {
  async function runAgentSelfTest(mode) {
    const { waitLoad, agentExec, agentHoldCursor, runAgentTool, aiChatSend } = M.AGENT;
    const components = M.components;
    const results = [];
    const check = (name, pass, extra) => {
      results.push({ name, pass: !!pass });
      console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + name +
                  (!pass && extra ? '  — ' + String(extra).replace(/\n/g, ' ').slice(0, 200) : ''));
    };
    setTimeout(() => { console.log('[selftest] délai global dépassé'); app.exit(1); }, /chatgpt|mistral/.test(mode) ? 900000 : 240000);

    const TEST_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><head><title>Page de test agent</title></head><body>' +
      '<h1>Test agent zaalis</h1><p>Paragraphe de démonstration.</p>' +
      '<button id="btn" onclick="window.__n=(window.__n||0)+1;document.getElementById(\'out\').textContent=\'cliqué:\'+window.__n;console.log(\'bouton cliqué\')">Ajouter au panier</button>' +
      '<div id="out">jamais</div>' +
      '<form onsubmit="event.preventDefault();document.getElementById(\'res\').textContent=\'soumis:\'+document.getElementById(\'q\').value">' +
      '<input id="q" placeholder="Rechercher" value="ancien texte"><div id="res">rien</div></form>' +
      '<a href="#bas">Mon compte</a>' +
      '</body></html>');

    console.log('=== Self-test agent zaalis (' + mode + ') ===');
    const wrappedCall = parseToolCall('```zaalis-tool\n{"tool":"fill","args":{"ref":"ref_12","value":"test"}}\n```');
    const flatCall = parseToolCall('```json\n{"tool":"fill","ref":"ref_12","value":"test"}\n```');
    check('parseur : arguments enveloppés conservés', wrappedCall && wrappedCall.args.ref === 'ref_12' && wrappedCall.args.value === 'test');
    check('parseur : arguments racine conservés', flatCall && flatCall.args.ref === 'ref_12' && flatCall.args.value === 'test');
    check('recherche vocale : messages IPC autorisés', ['voiceStart', 'voiceStop', 'voiceAudio'].every(a => M.HOME_ACTIONS.has(a)));
    M.createTab('', true);
    const t = M.activeTab();
    const wc = t.view.webContents;
    await waitLoad(wc, 8000);
    await wc.loadURL(TEST_PAGE);
    await waitLoad(wc, 8000);
    await M.AGENT.sleepMs(400);

    // 1) read_page : arbre d'accessibilité avec refs
    const tree = await runAgentTool(t, 'read_page', {});
    check('read_page : bouton avec ref', /button "Ajouter au panier" \[ref_\d+\]/.test(tree), tree);
    check('read_page : champ texte avec valeur', /textbox "Rechercher" \[ref_\d+\] \(valeur: "ancien texte"\)/.test(tree), tree);
    check('read_page : titre h1', tree.includes('h1 "Test agent zaalis"'), tree);
    check('read_page : lien avec ref', /link "Mon compte" \[ref_\d+\]/.test(tree), tree);

    const btnRef   = (tree.match(/button "Ajouter au panier" \[(ref_\d+)\]/) || [])[1];
    const inputRef = (tree.match(/textbox "Rechercher" \[(ref_\d+)\]/) || [])[1];

    // 2) click par ref → vrai clic natif, le handler de la page doit tourner
    const c1 = await runAgentTool(t, 'click', { ref: btnRef });
    await M.AGENT.sleepMs(150);
    let out = await wc.executeJavaScript('document.getElementById("out").textContent', true);
    check('click par ref : handler déclenché', out === 'cliqué:1', c1 + ' / out=' + out);

    // 3) click par texte (repli sans ref)
    await runAgentTool(t, 'click', { text: 'ajouter au panier' });
    await M.AGENT.sleepMs(150);
    out = await wc.executeJavaScript('document.getElementById("out").textContent', true);
    check('click par texte', out === 'cliqué:2', 'out=' + out);

    // 4) curseur agent présent dans la page (overlay monde isolé)
    const cursor = await agentExec(wc, '!!(window.__zCur && window.__zCur.root.isConnected)');
    check('curseur agent visible (overlay)', cursor === true);
    await agentHoldCursor(wc, 'Analyse en cours');
    const heldAt = await agentExec(wc, '({opacity:window.__zCur.cur.style.opacity,transform:window.__zCur.cur.style.transform})');
    await M.AGENT.sleepMs(2800);
    const stillHeld = await agentExec(wc, 'window.__zCur.cur.style.opacity');
    check('curseur maintenu entre deux outils', heldAt.opacity === '1' && stillHeld === '1');

    // 5) fill + enter : REMPLACE l'ancienne valeur puis soumet le formulaire
    const f1 = await runAgentTool(t, 'fill', { ref: inputRef, value: 'zaalis test', enter: true });
    const movedToField = await agentExec(wc, 'window.__zCur.cur.style.transform');
    check('curseur glissé vers le champ', movedToField !== heldAt.transform, movedToField);
    const val = await wc.executeJavaScript('document.getElementById("q").value', true);
    const res = await wc.executeJavaScript('document.getElementById("res").textContent', true);
    check('fill : valeur remplacée (pas concaténée)', val === 'zaalis test', f1 + ' / value=' + val);
    check('fill + enter : formulaire soumis', res === 'soumis:zaalis test', 'res=' + res);

    // 6) console de la page capturée
    const logs = await runAgentTool(t, 'read_console', {});
    check('read_console : log du clic', String(logs).includes('bouton cliqué'), logs);

    // 7) rechargement → les refs de l'ancien document doivent être refusés proprement
    wc.reload();
    await waitLoad(wc, 8000);
    await M.AGENT.sleepMs(300);
    const stale = await runAgentTool(t, 'click', { ref: btnRef });
    check('refs invalidés après rechargement', String(stale).includes('référence inconnue'), stale);

    // 8) The settings panel uses one fixed native layout; only its CSS layer
    // moves. This avoids text repaint jitter on Windows and keeps the rounded
    // left edge stable throughout the transition.
    M.ensurePanelView();
    const boundsBeforePanel = M.panelBoundsUpdates;
    M.openPanel();
    // Le panneau peut encore charger sa page : on attend la fin réelle de
    // l'animation (au plus 2 s) au lieu d'un délai fixe.
    let panelVisual = null;
    for (let waited = 0; waited <= 2000; waited += 100) {
      await M.AGENT.sleepMs(100);
      panelVisual = await M.panelView.webContents.executeJavaScript(`({
        open: document.body.classList.contains('panel-visible'),
        transform: getComputedStyle(document.body).transform,
        radius: parseFloat(getComputedStyle(document.body).borderTopLeftRadius) || 0
      })`, true);
      if (panelVisual.open && panelVisual.transform === 'matrix(1, 0, 0, 1, 0, 0)') break;
    }
    // Fenêtre de test recouverte par une autre application : Chromium ne fait
    // pas avancer les transitions CSS, on lit alors directement la position finale.
    if (panelVisual.open && panelVisual.transform !== 'matrix(1, 0, 0, 1, 0, 0)') {
      panelVisual.transform = await M.panelView.webContents.executeJavaScript(`(() => {
        const b = document.body, prev = b.style.transition;
        b.style.transition = 'none';
        const tr = getComputedStyle(b).transform;
        b.style.transition = prev;
        return tr;
      })()`, true);
    }
    check('settings panel: opening completed', panelVisual.open && panelVisual.transform === 'matrix(1, 0, 0, 1, 0, 0)', JSON.stringify(panelVisual));
    check('settings panel: rounded left corners', panelVisual.radius === 10, JSON.stringify(panelVisual));
    M.closePanel();
    await M.AGENT.sleepMs(M.PANEL_ANIM_MS + 100);
    check('settings panel: closing completed', M.panelViewVisible === false);
    check('settings panel: no frame-by-frame native movement', M.panelBoundsUpdates - boundsBeforePanel <= 1, String(M.panelBoundsUpdates - boundsBeforePanel));

    // 9) Compatibilité « comme Chrome » : UA, Widevine, pop-ups, plein écran,
    // recherche dans la page, liens d'applications, téléchargements, menus.
    const ua = await wc.executeJavaScript('navigator.userAgent', true);
    check('UA identique à Chrome (sans Electron ni nom d\'app)', /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua) && !/Electron|zaalis/i.test(ua), ua);
    if (components) {
      await Promise.race([components.whenReady([components.WIDEVINE_CDM_ID]).catch(() => {}), M.AGENT.sleepMs(20000)]);
      // EME n'existe que dans un contexte sécurisé : page d'accueil zaalis://.
      await wc.loadURL(M.HOME_URL);
      await waitLoad(wc, 8000);
      const drm = await wc.executeJavaScript(`(navigator.requestMediaKeySystemAccess
        ? navigator.requestMediaKeySystemAccess('com.widevine.alpha',
            [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }])
            .then(a => a.keySystem, e => 'refus: ' + e.message)
        : Promise.resolve('contexte non sécurisé'))`, true).catch(e => 'erreur: ' + e.message);
      check('Widevine disponible (Prime Video, Netflix…)', drm === 'com.widevine.alpha', drm);
    } else {
      check('Widevine disponible (Prime Video, Netflix…)', false, 'Electron sans castlabs ECS');
    }

    t.lastGestureAt = 0;
    check('pop-up sans clic : bloquée', !M.popupAllowed(t, { disposition: 'foreground-tab' }));
    t.lastGestureAt = Date.now();
    check('pop-up après un clic : autorisée', M.popupAllowed(t, { disposition: 'foreground-tab' }));
    check('Ctrl+clic sur un lien : toujours autorisé', (t.lastGestureAt = 0, M.popupAllowed(t, { disposition: 'background-tab' })));

    check('mailto: confié au système', M.isExternalAppUrl('mailto:test@example.com') && M.isExternalAppUrl('zoommtg://zoom.us/join'));
    check('schémas dangereux refusés', M.BLOCKED_EXTERNAL_SCHEMES.has(M.urlScheme('ms-msdt:/id')) && !M.isExternalAppUrl('javascript:alert(1)') && !M.isExternalAppUrl('https://x.fr'));
    check('erreur réseau : message adapté', describeNetError(-106, 'x')[1] === 'Aucune connexion Internet' && describeNetError(-201, 'x')[0].startsWith('ERR_CERT'));

    const safeLink = 'https://eur02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.org%2Fsso%2Findex.php&data=05&reserved=0';
    check('Safe Links : destination extraite', wrappedLinkTarget(safeLink) === 'https://example.org/sso/index.php' &&
          !wrappedLinkTarget('https://example.org/?url=https%3A%2F%2Fx.fr') && !wrappedLinkTarget(safeLink.replace('https%3A', 'javascript%3A')));
    check('Safe Links injoignable : accès direct proposé', M.errorPageHtml(safeLink, -7, '').includes('id="direct"') &&
          !M.errorPageHtml('https://example.org/', -7, '').includes('id="direct"') && !M.errorPageHtml(safeLink, -201, '').includes('id="direct"'));

    const sealFile = path.join(app.getPath('userData'), 'selftest-seal');
    M.sealWrite(sealFile, 'jeton-secret');
    const sealedRaw = fs.readFileSync(sealFile, 'utf8');
    check('fichiers locaux chiffrés sur disque', M.sealAvailable() && M.sealRead(sealFile) === 'jeton-secret' && !sealedRaw.includes('jeton-secret'));
    fs.writeFileSync(sealFile, 'ancien fichier en clair', 'utf8');
    check('anciens fichiers en clair toujours lisibles', M.sealRead(sealFile) === 'ancien fichier en clair');
    try { fs.unlinkSync(sealFile); } catch {}

    const devDockBefore = M.settings.devToolsDock;
    const devOpened = () => !!t.dev && !!t.view.webContents.devToolsWebContents && /^devtools:/.test(t.dev.view.webContents.getURL());
    const devRect = { x: 0, y: 95, width: 1200, height: 700 };
    M.settings.devToolsDock = 'right';
    M.selectTab(t.id);
    M.openDevToolsFor(t);
    await M.AGENT.sleepMs(1500);
    check('F12 : outils ouverts dans la fenêtre', devOpened());
    {
      const r = M.devToolsLayout(devRect);
      check('F12 : ancrage à droite', r.dev.width === M.settings.devToolsWidth && r.page.width + r.grip.width + r.dev.width === devRect.width &&
            r.dev.x === r.page.x + r.page.width + M.DEVTOOLS_GRIP && r.dev.height === devRect.height && r.page.height === devRect.height, JSON.stringify(r));
      M.settings.devToolsDock = 'bottom';
      const b = M.devToolsLayout(devRect);
      check('F12 : ancrage en bas', b.dev.height === M.settings.devToolsHeight && b.page.height + b.grip.height + b.dev.height === devRect.height &&
            b.dev.y === b.page.y + b.page.height + M.DEVTOOLS_GRIP && b.dev.width === devRect.width, JSON.stringify(b));
      const small = M.devToolsLayout({ x: 0, y: 95, width: 300, height: 200 });
      check('F12 : petite fenêtre, rien ne déborde', small.page.height >= 0 && small.page.height + small.grip.height + small.dev.height === 200, JSON.stringify(small));
      const none = M.devToolsLayout({ x: 0, y: 95, width: 0, height: 0 });
      check('F12 : fenêtre réduite, tailles nulles sans erreur', none.page.height === 0 && none.grip.height === 0 && none.dev.height === 0, JSON.stringify(none));
    }
    M.closeDevToolsFor(t);
    await M.AGENT.sleepMs(900);
    check('F12 : fermeture', !t.dev && !t.view.webContents.devToolsWebContents);
    M.openDevToolsFor(t);
    await M.AGENT.sleepMs(1500);
    check('F12 : réouverture', devOpened());
    M.closeDevToolsFor(t);
    await M.AGENT.sleepMs(900);
    M.layoutAll();
    M.settings.devToolsDock = devDockBefore;

    const ctxTest = M.permissionContext('selftest-partition');
    ctxTest.record('https://meet.example', 'camera', true, false);
    check('autoriser une fois : valable pour la session', ctxTest.decision('https://meet.example', 'camera') === 'allow' &&
          ctxTest.decision('https://meet.example', 'microphone') === '');
    check('contenu protégé (DRM) accordé d\'office', M.AUTO_GRANTED_PERMISSIONS.has('mediaKeySystem') && M.AUTO_GRANTED_PERMISSIONS.has('fullscreen'));

    const dlDir = path.join(os.tmpdir(), 'zaalis-agent-selftest', 'dl');
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    const first = M.uniqueDownloadPath(dlDir, 'rapport.txt');
    M.reservedDownloadPaths.add(first.toLowerCase());
    const second = M.uniqueDownloadPath(dlDir, 'rapport.txt');
    M.reservedDownloadPaths.delete(first.toLowerCase());
    check('téléchargements homonymes simultanés : noms distincts', first !== second && /rapport \(1\)\.txt$/.test(second), second);
    check('nom de fichier nettoyé pour Windows', M.safeDownloadName('a:b*c?.txt') === 'a_b_c_.txt' && M.safeDownloadName('CON.txt') === '_CON.txt');

    // Téléchargement réel de bout en bout : deux fichiers homonymes en parallèle
    // depuis un petit serveur local, enregistrés sans boîte de dialogue.
    const dlServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="rapport.txt"' });
      setTimeout(() => res.end('contenu ' + req.url), 300);
    });
    await new Promise(r => dlServer.listen(0, '127.0.0.1', r));
    const dlPort = dlServer.address().port;
    const prevDownloads = app.getPath('downloads');
    for (const f of fs.readdirSync(dlDir)) { try { fs.unlinkSync(path.join(dlDir, f)); } catch {} }
    app.setPath('downloads', dlDir);
    const before = M.downloads.length;
    wc.downloadURL(`http://127.0.0.1:${dlPort}/a`);
    wc.downloadURL(`http://127.0.0.1:${dlPort}/b`);
    for (let i = 0; i < 50; i++) {
      await M.AGENT.sleepMs(100);
      const fresh = M.downloads.slice(0, M.downloads.length - before);
      if (fresh.length >= 2 && fresh.every(d => d.state !== 'progressing')) break;
    }
    const fresh = M.downloads.slice(0, M.downloads.length - before);
    const savedNames = fresh.filter(d => d.state === 'completed' && fs.existsSync(d.path)).map(d => d.name).sort();
    check('téléchargement réel : 2 fichiers enregistrés', savedNames.length === 2 &&
          savedNames[0] === 'rapport (1).txt' && savedNames[1] === 'rapport.txt', JSON.stringify(fresh.map(d => [d.name, d.state])));
    app.setPath('downloads', prevDownloads);
    dlServer.close();

    // Authentification HTTP Basic : boîte « Connexion », puis page affichée.
    const authServer = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('demo:secret').toString('base64')) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Zone de test"' }); res.end('refuse'); return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<title>Authentifie</title><p>ok</p>');
    });
    await new Promise(r => authServer.listen(0, '127.0.0.1', r));
    const authUrl = `http://127.0.0.1:${authServer.address().port}/prive`;
    wc.loadURL(authUrl).catch(() => {});
    let authWin = null;
    for (let i = 0; i < 40 && !authWin; i++) {
      await M.AGENT.sleepMs(100);
      authWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.getParentWindow && w.getParentWindow() === M.mainWin) || null;
    }
    if (authWin) {
      await waitLoad(authWin.webContents, 4000);
      await authWin.webContents.executeJavaScript(`document.getElementById('u').value = 'demo';
        document.getElementById('p').value = 'secret'; document.getElementById('f').requestSubmit(); true`, true).catch(() => {});
    }
    for (let i = 0; i < 40 && wc.getTitle() !== 'Authentifie'; i++) await M.AGENT.sleepMs(100);
    check('authentification HTTP : boîte de connexion puis page', !!authWin && wc.getTitle() === 'Authentifie', 'titre=' + wc.getTitle());
    authServer.close();

    // Page d'erreur : message adapté et bouton « Réessayer » vers l'adresse d'origine.
    wc.loadURL('http://zaalis-test.invalid/').catch(() => {});
    for (let i = 0; i < 60 && wc.getTitle() !== 'Ce site est inaccessible'; i++) await M.AGENT.sleepMs(100);
    const errTitle = wc.getTitle();
    check('page d\'erreur réseau affichée', errTitle === 'Ce site est inaccessible', errTitle);

    // Onglet planté : page « Oups » au lieu d'un onglet blanc.
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>avant</title><p>x</p>')).catch(() => {});
    wc.forcefullyCrashRenderer();
    for (let i = 0; i < 60 && wc.getTitle() !== 'Oups, la page a planté'; i++) await M.AGENT.sleepMs(100);
    check('onglet planté : page de récupération', wc.getTitle() === 'Oups, la page a planté', wc.getTitle());

    let menuOk = false;
    try { const m = M.buildAppMenu(); menuOk = !!m && m.items.length >= 5; } catch (e) { menuOk = false; }
    check('menu et raccourcis clavier construits', menuOk);

    // Recherche dans la page (Ctrl+F) : trois occurrences attendues.
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<p>banane, banane et encore banane</p>'));
    await waitLoad(wc, 8000);
    const found = new Promise(resolve => {
      const onFound = (_e, r) => { if (r.finalUpdate) { wc.removeListener('found-in-page', onFound); resolve(r.matches); } };
      wc.on('found-in-page', onFound);
      setTimeout(() => resolve(-1), 5000);
    });
    M.openFindBar();
    M.findText = 'banane';
    M.runFind(M.findText, true, true);
    check('recherche dans la page : 3 résultats', (await found) === 3);
    check('barre de recherche visible', !!M.findView && M.findBarOpen);
    M.closeFindBar();

    // Plein écran vidéo : l'onglet couvre toute la fenêtre, barre masquée. On
    // rejoue les événements de Chromium plutôt que de basculer réellement l'écran
    // (le passage réel en plein écran a été vérifié sur YouTube : 2560×1440).
    wc.emit('enter-html-full-screen');
    await M.AGENT.sleepMs(200);
    const [fw, fh] = M.mainWin.getContentSize();
    const fb = t.view.getBounds();
    check('plein écran vidéo : page sur toute la fenêtre', M.htmlFullscreenTabId === t.id && fb.x === 0 && fb.y === 0 && fb.width === fw && fb.height === fh,
          JSON.stringify({ fb, fw, fh, fs: M.htmlFullscreenTabId }));
    check('plein écran vidéo : barre d\'onglets masquée', M.chromeView.getVisible() === false);
    wc.emit('leave-html-full-screen');
    await M.AGENT.sleepMs(200);
    check('sortie du plein écran : barre restaurée', M.htmlFullscreenTabId === null && M.chromeView.getVisible() === true && t.view.getBounds().y === M.contentTop);


    // 10) Catalogue des modèles : miroir de zaalis labs ide, rangé par sections.
    const snap = M.aiProvidersSnapshot();
    check('catalogue : abonnement ChatGPT avec GPT-6 Luna', snap['compat:chatgpt'] && snap['compat:chatgpt'].group === 'subscription' &&
          snap['compat:chatgpt'].submodels.includes('gpt-6-luna') && M.validAiChoice('compat:chatgpt', 'gpt-6-luna'));
    check('catalogue : sections abonnement / API / passerelles / local',
          ['subscription', 'api', 'compat', 'local'].every(g => Object.values(snap).some(p => p.group === g)) &&
          snap.local.group === 'local' && snap.gguf.group === 'local' && snap.codex.group === 'api');

    // 11) Outils de l'agent (équivalents des extensions Claude / ChatGPT pour Chrome).
    const TOOLS_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><head><title>Outils agent</title></head><body style="margin:0">' +
      '<h1>Boutique test</h1>' +
      '<label for="couleur">Couleur</label><select id="couleur"><option value="r">Rouge</option><option value="b">Bleu</option></select>' +
      '<label><input type="checkbox" id="news"> Recevoir la newsletter</label>' +
      '<input id="champ" placeholder="Votre prénom">' +
      '<button id="go" onclick="document.getElementById(\'res\').textContent=\'envoyé\'">Valider la commande</button>' +
      '<div id="res">rien</div><div style="height:3000px"></div><p id="bas">Bas de page</p></body></html>');
    await wc.loadURL(TOOLS_PAGE);
    await waitLoad(wc, 8000);
    await M.AGENT.sleepMs(300);
    const foundEls = await runAgentTool(t, 'find', { query: 'valider commande' });
    const goRef = (String(foundEls).match(/button "Valider la commande" \[(ref_\d+)\]/) || [])[1];
    check('find : élément trouvé avec sa ref', !!goRef, foundEls);
    const shot = await runAgentTool(t, 'screenshot', {});
    check('screenshot : image jointe pour le modèle', shot && shot.image && shot.image.data.length > 1000 && /jpeg/.test(shot.image.mime), JSON.stringify(shot && shot.text));
    await runAgentTool(t, 'form_input', { selector: '#couleur', value: 'Bleu' });
    await runAgentTool(t, 'form_input', { selector: '#news', value: true });
    const formState = await wc.executeJavaScript('[document.getElementById("couleur").value, document.getElementById("news").checked]', true);
    check('form_input : liste et case à cocher réglées', formState[0] === 'b' && formState[1] === true, JSON.stringify(formState));
    await runAgentTool(t, 'click', { selector: '#champ' });
    await runAgentTool(t, 'type', { text: 'Ada' });
    await runAgentTool(t, 'key', { keys: 'ctrl+a' });
    await runAgentTool(t, 'type', { text: 'Grace' });
    const typed = await wc.executeJavaScript('document.getElementById("champ").value', true);
    check('type + key (ctrl+a) : frappe et raccourcis natifs', typed === 'Grace', 'valeur=' + typed);
    await runAgentTool(t, 'click', { ref: goRef });
    check('click par ref issue de find', (await wc.executeJavaScript('document.getElementById("res").textContent', true)) === 'envoyé');
    await runAgentTool(t, 'scroll', { direction: 'down', amount: 5 });
    const scrolled = await wc.executeJavaScript('scrollY', true);
    check('scroll : molette native', scrolled > 100, 'scrollY=' + scrolled);
    const text = await runAgentTool(t, 'get_page_text', {});
    check('get_page_text : texte de la page', /Boutique test/.test(text) && /Bas de page/.test(text));
    const list = JSON.parse(await runAgentTool(t, 'tabs_list', {}));
    check('tabs_list : onglet piloté identifié', Array.isArray(list) && list.some(x => x.piloté && x.tab_id === t.id));
    check('outils : tous déclarés au modèle', ['find', 'screenshot', 'form_input', 'key', 'scroll', 'drag', 'upload_file', 'tab_new',
      'resize_viewport', 'fetch_url', 'save_pdf'].every(n => AGENT_SYSTEM.includes('- ' + n + ' ') || AGENT_SYSTEM.includes(n + ' {')));

    // 12) Nouvel onglet : la barre d'adresse du haut est sélectionnée.
    const nt = M.openNewTab();
    await waitLoad(nt.view.webContents, 6000);
    await M.AGENT.sleepMs(400);
    const omniFocused = await M.chromeView.webContents.executeJavaScript('document.activeElement && document.activeElement.id', true);
    check('nouvel onglet : barre d\'adresse sélectionnée', omniFocused === 'omni', 'focus=' + omniFocused);
    // Barre de recherche centrale de l'accueil : saisie puis recherche.
    const homeWc = nt.view.webContents;
    await homeWc.executeJavaScript(`(() => { const i = document.getElementById('search-input');
      i.value = 'zaalis selftest'; document.getElementById('search-form').requestSubmit(); return true; })()`, true).catch(() => false);
    for (let i = 0; i < 40 && !/[?&]q=zaalis/.test(homeWc.getURL()); i++) await M.AGENT.sleepMs(100);
    check('accueil : la barre centrale lance la recherche', /[?&]q=zaalis(\+|%20)selftest/.test(homeWc.getURL()), homeWc.getURL());
    M.closeTab(nt.id);
    M.selectTab(t.id);

    // Boucle agent complète avec un vrai modèle via zaalis labs ide :
    // ZAALIS_AGENT_SELFTEST=chatgpt (abonnement ChatGPT, GPT-6 Luna) ou mistral.
    const LIVE_MODELS = {
      chatgpt: ['compat:chatgpt', process.env.ZAALIS_SELFTEST_SUBMODEL || 'gpt-6-luna'],
      mistral: ['mistral', 'mistral-large-latest'],
    };
    if (LIVE_MODELS[mode]) {
      [M.settings.aiProvider, M.settings.aiSubmodel] = LIVE_MODELS[mode];
      M.AGENT.agentAutoApprove = true;      // pas de boîte d'autorisation pendant le test
      console.log('--- Boucle agent complète (' + M.settings.aiProvider + ' / ' + M.settings.aiSubmodel + ') ---');
      const runTask = async (page, prompt) => {
        await wc.loadURL(page);
        await waitLoad(wc, 8000);
        await M.AGENT.sleepMs(300);
        M.newAiChat('selftest');
        const started = Date.now();
        await aiChatSend(prompt);
        const chat = M.aiChatById(M.aiCurrentChatId);
        const msgs = chat ? chat.messages : [];
        const steps = msgs.filter((m) => m.role === 'tool').map((m) => m.label);
        const reply = String((msgs[msgs.length - 1] || {}).content || '');
        console.log('  étapes outils : ' + (steps.join(' | ') || '(aucune)'));
        console.log('  réponse finale (' + Math.round((Date.now() - started) / 1000) + ' s) : ' + reply.replace(/\n/g, ' ').slice(0, 300));
        return { steps, reply };
      };

      // a) Formulaire complet : liste, case à cocher, saisie, clic.
      const FORM_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><html><head><title>Commande test</title></head><body>' +
        '<h1>Commande</h1><label for="taille">Taille</label><select id="taille"><option>S</option><option>M</option><option>L</option></select>' +
        '<label><input type="checkbox" id="cgv"> J\'accepte les conditions</label>' +
        '<input id="nom" placeholder="Nom complet">' +
        '<button id="ok" onclick="const t=document.getElementById(\'taille\').value,c=document.getElementById(\'cgv\').checked,n=document.getElementById(\'nom\').value;' +
        'document.getElementById(\'out\').textContent=(c?\'commande:\'+t+\':\'+n:\'refus:cgv\')">Commander</button><div id="out">vide</div></body></html>');
      const a = await runTask(FORM_PAGE, 'Sur cette page : choisis la taille L, accepte les conditions, écris « Ada Lovelace » comme nom, ' +
        'clique sur Commander, puis donne-moi le texte exact affiché dans #out.');
      const outNow = await wc.executeJavaScript('document.getElementById("out").textContent', true);
      check(mode + ' : formulaire rempli et validé par l\'agent', outNow === 'commande:L:Ada Lovelace', 'out=' + outNow);
      check(mode + ' : réponse finale propre (sans bloc outil)', a.reply.length > 0 && !a.reply.includes('zaalis-tool') && !/^⚠️/.test(a.reply), a.reply);

      // b) Vision : la couleur n'est écrite nulle part, seule la capture la montre.
      const VISION_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><html><head><title>Forme</title></head><body style="margin:0;background:#fff">' +
        '<div style="width:420px;height:420px;margin:40px;background:#e01010;border-radius:50%"></div></body></html>');
      const b = await runTask(VISION_PAGE, 'Prends une capture d\'écran de la page et dis-moi en un mot la couleur et la forme de l\'objet affiché.');
      check(mode + ' : capture d\'écran transmise au modèle (vision)', M.AGENT.lastAgentAutoShot || b.steps.some(s => /Capture/.test(s)), b.steps.join(' | '));
      check(mode + ' : image comprise par le modèle', /rouge|red/i.test(b.reply) && /rond|cercle|disque|circle|circul/i.test(b.reply), b.reply);
      M.AGENT.agentAutoApprove = false;
    }

    const fails = results.filter((r) => !r.pass).length;
    console.log('=== ' + (results.length - fails) + '/' + results.length + ' OK ===');
    app.exit(fails ? 1 : 0);
  }

  return {
    runAgentSelfTest,
  };
}

module.exports = { init };
