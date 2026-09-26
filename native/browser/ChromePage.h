#pragma once
//
// ChromePage.h
// ------------
// Interface du navigateur (la "chrome") rendue dans son propre WebView2 :
//  - barre d'onglets + bouton "+"
//  - barre d'outils : precedent / suivant / recharger / accueil,
//    barre d'adresse avec loupe (recherche Google), etoile (favori),
//    bascule de theme (clair / sombre)
//  - barre de favoris
//
// La couleur de toute la barre suit le theme (sombre = noir, clair = gris
// adouci) -> plus de bandeau blanc fixe.
//
// Communication avec le code natif (C++) :
//   envoi   : window.chrome.webview.postMessage("action\x1farg")
//   reception : window.chrome.webview.addEventListener('message', e => e.data)
//

static const char* const zaalis_CHROME_PAGE = u8R"CHROME(<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --sep: 1rem;
  }
  /* ----- Theme clair (adouci, pas blanc pur) ----- */
  body {
    --bg:        #dfe1e5;
    --bar:       #e8eaed;
    --surface:   #f1f3f4;
    --surface-h: #e2e5e9;
    --active:    #f7f8fa;
    --text:      #202124;
    --muted:     #5f6368;
    --border:    #d2d5d9;
    --input-bg:  #ffffff;
    --accent:    #1a73e8;
    --danger:    #d93025;
  }
  /* ----- Theme sombre (noir) ----- */
  body.dark {
    --bg:        #191a1c;
    --bar:       #202124;
    --surface:   #303134;
    --surface-h: #3c4043;
    --active:    #35363a;
    --text:      #e8eaed;
    --muted:     #9aa0a6;
    --border:    #3c4043;
    --input-bg:  #303134;
    --accent:    #8ab4f8;
    --danger:    #f28b82;
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  body {
    font-family: "Segoe UI", Arial, sans-serif;
    background: transparent;
    color: var(--text);
    user-select: none;
    -webkit-user-select: none;
  }

  /* ---------- Barre d'onglets ---------- */
  .tabstrip {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 40px;
    padding: 6px 8px 0 8px;
    background: var(--bg);
  }
  .brand {
    display: flex; align-items: center; gap: 8px;
    padding: 0 10px 4px 6px;
  }
  .brand img { width: 22px; height: 22px; border-radius: 5px; }
  .brand span {
    font-weight: 600; font-size: 13px; letter-spacing: .3px;
    background: linear-gradient(90deg, #4898ff, #00ffff);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .tabs { display: flex; align-items: flex-end; gap: 4px; min-width: 0; }
  .tab {
    display: flex; align-items: center; gap: 8px;
    height: 34px; max-width: 220px; min-width: 96px;
    padding: 0 8px 0 14px;
    background: var(--surface);
    border-radius: 12px 12px 0 0;
    font-size: 13px; color: var(--muted);
    cursor: default; position: relative;
    transition: background .15s ease, color .15s ease, transform .18s ease, box-shadow .15s ease;
  }
  .tab:hover { background: var(--surface-h); }
  .tab.active {
    background: var(--active); color: var(--text); font-weight: 500;
    box-shadow: 0 -1px 0 rgba(0,0,0,.03), 0 -3px 10px rgba(0,0,0,.06);
  }
  .tab.dragging { box-shadow: 0 6px 18px rgba(0,0,0,.30); cursor: grabbing; z-index: 10; }
  .tab .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab .close {
    width: 18px; height: 18px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; line-height: 1; color: var(--muted);
    flex: none;
  }
  .tab .close:hover { background: var(--surface-h); color: var(--text); }
  .tab.active .close:hover { background: var(--surface); }
  .newtab {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; color: var(--muted); margin-bottom: 2px; flex: none;
  }
  .newtab:hover { background: var(--surface-h); color: var(--text); }

  /* ---------- Barre d'outils ---------- */
  .toolbar {
    display: flex; align-items: center; gap: 6px;
    height: 52px; padding: 0 12px;
    background: var(--bar);
  }
  .iconbtn {
    width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: var(--text); flex: none;
    transition: background .12s ease, opacity .12s ease,
                transform .22s cubic-bezier(.34,1.56,.64,1);
  }
  .iconbtn:hover { background: var(--surface-h); }
  .iconbtn:active { transform: scale(.82); }
  .iconbtn.disabled { opacity: .32; pointer-events: none; }
  .iconbtn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

  /* Barre d'adresse */
  .address {
    flex: 1; display: flex; align-items: center; gap: 8px;
    height: 40px; padding: 0 6px 0 14px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 21px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .address.focus {
    border-color: transparent;
    box-shadow: 0 1px 8px rgba(26,115,232,.35);
  }
  .address .search {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; flex: none;
    color: var(--muted);
  }
  .address .search:hover { background: var(--surface-h); color: var(--accent); }
  .address .search svg { width: 16px; height: 16px; fill: currentColor; }
  .address .search { transition: background .12s ease, transform .22s cubic-bezier(.34,1.56,.64,1); }
  .address .search:active { transform: scale(.8); }
  .newtab { transition: background .12s ease, color .12s ease, transform .22s cubic-bezier(.34,1.56,.64,1); }
  .newtab:active { transform: scale(.8); }
  .bm { transition: background .12s ease, transform .18s cubic-bezier(.34,1.56,.64,1); }
  .bm:active { transform: scale(.94); }
  .address input {
    flex: 1; border: none; outline: none; background: transparent;
    font-size: 14px; color: var(--text);
    user-select: text; -webkit-user-select: text;
  }
  .address input::placeholder { color: var(--muted); }
  .star { color: var(--muted); }
  .star.on { color: #f5b400; }
  .star.on svg { fill: #f5b400; stroke: #f5b400; }
  #media.active { background: var(--surface-h); color: var(--accent); }

  /* Toujours present mais replie : il glisse a l'ouverture du mode local. */
  .lock { display: flex; align-items: center; gap: 6px; height: 30px;
          border-radius: 15px; background: rgba(217,48,37,.14); color: var(--danger);
          font-size: 12px; font-weight: 600; flex: none; overflow: hidden; white-space: nowrap;
          max-width: 0; padding: 0; margin: 0; opacity: 0;
          transition: max-width .28s cubic-bezier(.34,1.4,.64,1), padding .28s ease,
                      margin .28s ease, opacity .2s ease; }
  body.offline .lock { max-width: 140px; padding: 0 12px; margin: 0 2px 0 4px; opacity: 1; }
  .lock svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; flex: none; }

  /* ---------- Barre de progression (facon Google) ---------- */
  /* Remplace le trait separateur habituel : transparente au repos, elle se
     remplit de gauche a droite pendant le chargement d'une page/recherche. */
  .loadbar { height: 3px; background: var(--bar); overflow: hidden; flex: none; }
  .loadbar-fill {
    height: 100%; width: 0%; opacity: 0;
    background: linear-gradient(90deg, #4898ff, #00d4ff);
  }
  .loadbar-fill.animating { transition: width .2s ease, opacity .3s ease; }
  .loadbar-fill.active { opacity: 1; }

  /* ---------- Barre de favoris ---------- */
  .bookmarks {
    display: flex; align-items: center; gap: 4px;
    height: 36px; padding: 0 10px;
    background: var(--bar);
    border-top: 1px solid var(--border);
    overflow: hidden;
  }
  body.hide-bookmarks .bookmarks { display: none; }
  .bm {
    display: flex; align-items: center; gap: 6px;
    height: 26px; padding: 0 6px 0 10px;
    border-radius: 8px; font-size: 12px; color: var(--text);
    max-width: 180px;
  }
  .bm:hover { background: var(--surface-h); }
  .bm .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm .x { width: 16px; height: 16px; border-radius: 50%; display: none;
           align-items: center; justify-content: center; font-size: 12px; color: var(--muted); }
  .bm:hover .x { display: flex; }
  .bm .x:hover { background: var(--danger); color: #fff; }
  .bm .favicon { width: 14px; height: 14px; border-radius: 4px; flex: none; position: relative; overflow: hidden; }
  .bm .favicon.fallback { background: linear-gradient(90deg, #4898ff, #00ffff); }
  .bm .favicon img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .empty { font-size: 12px; color: var(--muted); padding-left: 4px; }

  /* ---------- Controle media ---------- */
  .media-pop {
    position: absolute; top: 94px; right: 10px; width: 420px; max-width: calc(100vw - 20px);
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 16px; box-shadow: none; padding: 14px;
    z-index: 50; display: block; overflow: hidden; opacity: 0; pointer-events: none;
    transform: translateY(-6px) scale(.99); transform-origin: top right;
    transition: opacity .16s cubic-bezier(.2,.8,.2,1), transform .16s cubic-bezier(.2,.8,.2,1);
  }
  body.media-open .media-pop { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }
  .media-card {
    display: grid; grid-template-columns: 82px minmax(0, 1fr) 64px; gap: 12px; align-items: center;
    background: var(--surface-h); border-radius: 14px; padding: 12px;
  }
  .media-art { width:82px; height:82px; border-radius:10px; background:var(--bg); object-fit:cover; }
  .media-info { min-width:0; overflow:hidden; }
  .media-title { display:block; max-width:100%; font-weight:700; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .media-sub { color:var(--muted); font-size:13px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .media-play {
    width:58px; height:58px; border-radius:50%; border:none; background:#77d8e8; color:#07333b;
    display:flex; align-items:center; justify-content:center;
  }
  .media-play svg { width:28px; height:28px; fill:currentColor; stroke:none; }
  .media-controls { display:flex; align-items:center; gap:10px; margin-top:12px; }
  .media-small {
    width:32px; height:32px; border:none; border-radius:50%; background:transparent; color:var(--muted);
    display:flex; align-items:center; justify-content:center;
  }
  .media-small:hover { background:rgba(128,128,128,.18); color:var(--text); }
  .media-small svg { width:19px; height:19px; }
  .media-bar { flex:1; height:5px; border-radius:999px; background:rgba(128,128,128,.22); overflow:hidden; }
  .media-fill { height:100%; width:0; border-radius:inherit; background:linear-gradient(90deg,#4898ff,#00d4ff); }
  .media-row {
    display:flex; align-items:center; gap:12px; min-height:46px; padding:10px 4px 0;
    border-top:1px solid var(--border); margin-top:12px; font-size:14px;
  }
  .media-row:first-of-type { border-top:none; }
  .media-row .grow { flex:1; }
  .media-toggle { width:40px; height:22px; border-radius:11px; background:rgba(128,128,128,.28); position:relative; }
  .media-toggle::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; }
  .media-toggle.on { background:#77d8e8; }
  .media-toggle.on::after { left:21px; }
  .media-empty { padding:22px 10px; color:var(--muted); text-align:center; }
</style>
</head>
)CHROME" u8R"CHROME(
<body>
  <div class="tabstrip">
    <div class="brand"><img id="brand-logo" src="https://zaalis.home/logo-zaalis.png" alt=""><span>zaalis</span></div>
    <div class="tabs" id="tabs"></div>
    <div class="newtab" id="newtab" title="Nouvel onglet">+</div>
  </div>

  <div class="toolbar">
    <div class="iconbtn" id="back" title="Precedent"><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></div>
    <div class="iconbtn" id="forward" title="Suivant"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div>
    <div class="iconbtn" id="reload" title="Recharger"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></div>
    <div class="iconbtn" id="home" title="Accueil"><svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg></div>

    <div class="lock" id="lock" title="Mode local securise actif : reseau coupe"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Local</div>

    <div class="address" id="address">
      <div class="search" id="go" title="Rechercher avec Google">
        <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      </div>
      <input id="omni" type="text" autocomplete="off" placeholder="Rechercher sur Google ou saisir une URL">
    </div>

    <div class="iconbtn star" id="star" title="Ajouter aux favoris"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>
    <div class="iconbtn" id="media" title="Controle media"><svg viewBox="0 0 24 24"><path d="M4 5h10"/><path d="M4 12h7"/><path d="M4 19h4"/><circle cx="17" cy="17" r="3"/><path d="M17 14V4l4 1"/></svg></div>
    <div class="iconbtn" id="settings" title="Parametres"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>
  </div>

  <div class="loadbar" id="loadbar"><div class="loadbar-fill" id="loadbar-fill"></div></div>

  <div class="bookmarks" id="bookmarks"></div>

  <div class="media-pop" id="media-pop">
    <div id="media-content"></div>
  </div>

<script>
  const wv = window.chrome && window.chrome.webview;
  const SEP = "\x1f";
  function post(...parts){ if (wv) wv.postMessage(parts.join(SEP)); }

  const $ = id => document.getElementById(id);
  const tabsEl = $("tabs"), omni = $("omni"), addr = $("address");
  let state = { theme:"light", searchEngine:"google", showBookmarks:true, tabs:[], active:{}, bookmarks:[] };
  let editing = false;
  let mediaOpen = false;
  let mediaState = { available:false };
  let mediaPoll = 0;

  function isInternal(u){ return !u || u.indexOf("zaalis.home") !== -1 || u === "about:blank"; }

  function faviconUrl(u) {
    try { return "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(new URL(u).hostname); }
    catch (e) { return ""; }
  }

  function render(){
    document.body.classList.toggle("dark", state.theme === "dark");
    document.body.classList.toggle("hide-bookmarks", state.showBookmarks === false);
    const engineNames = { google:"Google", bing:"Bing", duckduckgo:"DuckDuckGo", brave:"Brave" };
    omni.placeholder = "Rechercher avec " + (engineNames[state.searchEngine] || "Google") + " ou saisir une URL";

    // Onglets
    tabsEl.innerHTML = "";
    state.tabs.forEach(t => {
      const el = document.createElement("div");
      el.className = "tab" + (t.active ? " active" : "");
      el.dataset.id = t.id;
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = t.title && t.title.trim() ? t.title : "Nouvel onglet";
      el.appendChild(title);
      const close = document.createElement("div");
      close.className = "close"; close.textContent = "x";
      close.onclick = (e)=>{ e.stopPropagation(); post("closeTab", t.id); };
      el.appendChild(close);
      el.addEventListener("pointerdown", (e)=> startTabDrag(e, el, t.id));
      tabsEl.appendChild(el);
    });

    // Barre d'adresse (sauf si l'utilisateur tape)
    if (!editing) {
      const u = state.active.url || "";
      omni.value = isInternal(u) ? "" : u;
    }

    document.body.classList.toggle("offline", !!state.offline);

    // Boutons nav
    $("back").classList.toggle("disabled", !state.active.canBack);
    $("forward").classList.toggle("disabled", !state.active.canForward);
    $("star").classList.toggle("on", !!state.active.isBookmarked);
    $("star").title = state.active.isBookmarked ? "Retirer des favoris" : "Ajouter aux favoris";
    $("media").classList.toggle("active", mediaOpen);

    // Favoris
    const bm = $("bookmarks"); bm.innerHTML = "";
    if (!state.bookmarks.length) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "Vos favoris apparaitront ici"; bm.appendChild(e);
    } else {
      state.bookmarks.forEach(b => {
        const el = document.createElement("div"); el.className = "bm";
        const fav = document.createElement("div"); fav.className = "favicon";
        const src = faviconUrl(b.url);
        if (src) {
          const img = document.createElement("img"); img.alt = "";
          img.onerror = () => { img.remove(); fav.classList.add("fallback"); };
          img.src = src;
          fav.appendChild(img);
        } else {
          fav.classList.add("fallback");
        }
        el.appendChild(fav);
        const t = document.createElement("div"); t.className = "t";
        t.textContent = b.title && b.title.trim() ? b.title : b.url; el.appendChild(t);
        const x = document.createElement("div"); x.className = "x"; x.textContent = "x";
        x.onclick = (e)=>{ e.stopPropagation(); post("removeBookmark", b.url); };
        el.appendChild(x);
        el.onclick = ()=> post("openBookmark", b.url);
        el.title = b.url;
        bm.appendChild(el);
      });
    }

    // Barre de progression : demarre/arrete au changement d'etat de chargement.
    const loading = !!state.active.loading;
    if (loading !== wasLoading) { wasLoading = loading; setLoadingBar(loading); }

    reportHeight();
  }

  // Barre de progression "facon Google" : progression indeterminee (on ne
  // connait pas la duree du chargement a l'avance), qui ralentit en
  // s'approchant de 90% puis se termine d'un trait quand la page est prete.
  let loadTimer = 0;
  let loadPct = 0;
  let wasLoading = false;
  function setLoadingBar(active){
    const fill = $("loadbar-fill");
    clearInterval(loadTimer); loadTimer = 0;
    if (active) {
      loadPct = 0;
      fill.classList.remove("animating");
      fill.style.width = "0%";
      void fill.offsetWidth; // force reflow avant de reactiver la transition
      fill.classList.add("animating", "active");
      loadTimer = setInterval(() => {
        loadPct += (90 - loadPct) * 0.08;
        fill.style.width = Math.min(loadPct, 90) + "%";
      }, 120);
    } else {
      fill.classList.add("animating");
      fill.style.width = "100%";
      setTimeout(() => {
        fill.classList.remove("active");
        setTimeout(() => { fill.classList.remove("animating"); fill.style.width = "0%"; }, 300);
      }, 200);
    }
  }

  function fmtTime(seconds){
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function mediaCmd(cmd){
    post("mediaCommand", cmd, String(mediaState.tabId || ""));
    setTimeout(()=>post("getMediaState"), 160);
  }

  function renderMedia(){
    const root = $("media-content");
    if (!mediaState || !mediaState.available) {
      root.innerHTML = '<div class="media-empty">Aucun media actif.</div>';
      return;
    }
)CHROME" u8R"CHROME(
    const pct = mediaState.duration ? Math.max(0, Math.min(100, mediaState.current / mediaState.duration * 100)) : 0;
    const art = mediaState.artwork ? mediaState.artwork : "https://zaalis.home/logo-zaalis.png";
    root.innerHTML =
      '<div class="media-card">' +
        '<img class="media-art" src="' + art.replace(/"/g, "&quot;") + '" alt="">' +
        '<div class="media-info"><div class="media-title"></div><div class="media-sub"></div></div>' +
        '<button class="media-play" id="media-play" title="Lecture / pause"></button>' +
      '</div>' +
      '<div class="media-controls">' +
        '<button class="media-small" id="media-prev" title="Titre precedent"><svg viewBox="0 0 24 24"><path d="M19 20L9 12l10-8v16z"/><path d="M5 19V5"/></svg></button>' +
        '<button class="media-small" id="media-back" title="Reculer de 10 secondes"><svg viewBox="0 0 24 24"><path d="M11 19l-7-7 7-7"/><path d="M20 19l-7-7 7-7"/></svg></button>' +
        '<div class="media-bar"><div class="media-fill" style="width:' + pct + '%"></div></div>' +
        '<button class="media-small" id="media-forward" title="Avancer de 10 secondes"><svg viewBox="0 0 24 24"><path d="M13 5l7 7-7 7"/><path d="M4 5l7 7-7 7"/></svg></button>' +
        '<button class="media-small" id="media-next" title="Titre suivant"><svg viewBox="0 0 24 24"><path d="M5 4l10 8-10 8V4z"/><path d="M19 5v14"/></svg></button>' +
      '</div>' +
      '<div class="media-sub" style="text-align:center;margin-top:4px">' + fmtTime(mediaState.current) + ' / ' + fmtTime(mediaState.duration) + '</div>' +
      '<div class="media-row" id="media-captions"><div class="iconbtn disabled" style="width:28px;height:28px"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h4M13 12h4M7 15h7"/></svg></div><div class="grow">Sous-titres</div><div class="media-toggle' + (mediaState.captionsOn ? ' on' : '') + '"></div></div>' +
      '<div class="media-row" id="media-caption-settings"><div class="iconbtn disabled" style="width:28px;height:28px"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg></div><div class="grow"><b>Parametres des sous-titres</b></div><div class="chev">&nearr;</div></div>';
    root.querySelector(".media-title").textContent = mediaState.title || "Media";
    root.querySelector(".media-sub").textContent = mediaState.artist || mediaState.host || "";
    $("media-play").innerHTML = mediaState.paused
      ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
    $("media-play").onclick = () => mediaCmd("playPause");
    $("media-prev").onclick = () => mediaCmd("prev");
    $("media-next").onclick = () => mediaCmd("next");
    $("media-back").onclick = () => mediaCmd("seekBack");
    $("media-forward").onclick = () => mediaCmd("seekForward");
    $("media-captions").onclick = () => mediaCmd("captions");
    $("media-caption-settings").onclick = () => mediaCmd("captionSettings");
  }

  function setMediaOpen(open){
    mediaOpen = open;
    document.body.classList.toggle("media-open", mediaOpen);
    $("media").classList.toggle("active", mediaOpen);
    if (mediaOpen) {
      post("getMediaState");
      renderMedia();
      if (!mediaPoll) mediaPoll = setInterval(()=>post("getMediaState"), 1000);
    } else {
      clearInterval(mediaPoll);
      mediaPoll = 0;
    }
    reportHeight();
  }

  // ----- Reordonnancement des onglets au pointeur (facon Chrome) -----
  // L'onglet attrape suit le curseur (net, pas de fantome) ; les autres
  // s'ecartent en glissant pour lui laisser la place.
  const GAP = 4;
  const EASE = "transform .18s cubic-bezier(.2,.7,.3,1)";
  let drag = null;
  const tabEls = () => [...tabsEl.querySelectorAll(".tab")];

  function startTabDrag(e, el, id) {
    if (e.button !== 0) return;
    if (e.target.closest(".close")) return;   // clic sur fermer
    const els = tabEls();
    const index = els.indexOf(el);
    if (index < 0) return;
    const rects = els.map(t => { const b = t.getBoundingClientRect(); return { left: b.left, center: b.left + b.width / 2 }; });
    drag = { el, id, index, startX: e.clientX, rects, w: el.offsetWidth + GAP, target: index, moved: false };
    window.addEventListener("pointermove", onTabMove);
    window.addEventListener("pointerup", onTabUp, { once: true });
  }

  function onTabMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < 4) return;          // seuil : sinon c'est un clic
      drag.moved = true;
      drag.el.classList.add("dragging");
    }
    drag.el.style.transition = "none";        // l'onglet tenu suit instantanement
    drag.el.style.transform = "translateX(" + dx + "px)";

    const centerX = drag.rects[drag.index].center + dx;
    const n = drag.rects.length;
    let target = drag.index;
    while (target < n - 1 && centerX > drag.rects[target + 1].center) target++;
    while (target > 0 && centerX < drag.rects[target - 1].center) target--;
    drag.target = target;

    tabEls().forEach((t, i) => {
      if (i === drag.index) return;
      let shift = 0;
      if (target > drag.index && i > drag.index && i <= target) shift = -drag.w;
      else if (target < drag.index && i >= target && i < drag.index) shift = drag.w;
      t.style.transition = EASE;
      t.style.transform = shift ? ("translateX(" + shift + "px)") : "";
    });
  }

  function onTabUp() {
    window.removeEventListener("pointermove", onTabMove);
    const d = drag; drag = null;
    if (!d) return;
    if (!d.moved) { post("selectTab", d.id); return; }   // simple clic -> selection

    // L'onglet glisse jusqu'a sa place finale, puis on valide le nouvel ordre.
    const offset = (d.target - d.index) * d.w;
    d.el.style.transition = EASE;
    d.el.style.transform = "translateX(" + offset + "px)";

    const ids = tabEls().map(t => t.dataset.id);
    const [moved] = ids.splice(d.index, 1);
    ids.splice(d.target, 0, moved);
    setTimeout(() => post("reorderTabs", ids.join(",")), 175);
  }

  // Reception de l'etat depuis le natif
  if (wv) wv.addEventListener("message", e => {
    const d = e.data;
    if (!d) return;
    if (d.type === "state") { state = d; if (!drag) render(); }
    else if (d.type === "focusOmni") { omni.focus(); omni.select(); }
    else if (d.type === "mediaState") {
      if (d.available) {
        if (!mediaState.available ||
            (!d.paused && mediaState.paused) ||
            (d.active && !mediaState.active && d.paused === mediaState.paused) ||
            mediaState.tabId === d.tabId) mediaState = d;
      } else if (!mediaState.available || mediaState.tabId === d.tabId) {
        mediaState = d;
      }
      if (mediaOpen) renderMedia();
    }
  });

  // Double-clic sur une zone vide de la barre d'onglets -> plein ecran (comme
  // un double-clic sur la barre de titre native).
  document.querySelector(".tabstrip").addEventListener("dblclick", (e)=>{
    if (e.target.closest(".tab, .newtab, .brand")) return;
    post("toggleMaximize");
  });

  // Actions
  $("newtab").onclick = ()=> post("newTab");
  $("back").onclick = ()=> post("back");
  $("forward").onclick = ()=> post("forward");
  $("reload").onclick = ()=> post("reload");
  $("home").onclick = ()=> post("home");
  $("star").onclick = ()=> post("bookmarkToggle");
  $("media").onclick = ()=> setMediaOpen(!mediaOpen);
  $("settings").onclick = ()=> post("togglePanel");
  $("go").onclick = ()=> submit();

  function submit(){
    const v = omni.value.trim();
    if (v) { editing = false; post("navigate", v); }
  }
  omni.addEventListener("focus", ()=>{ editing = true; addr.classList.add("focus"); omni.select(); });
  omni.addEventListener("blur", ()=>{ editing = false; addr.classList.remove("focus"); render(); });
  omni.addEventListener("keydown", e => { if (e.key === "Enter") submit(); else if (e.key === "Escape") { omni.blur(); } });

  // Hauteur de la chrome -> communiquee au natif pour positionner le contenu
  function reportHeight(){
    const base = 40 + 52 + 3 + (state.showBookmarks === false ? 0 : 36);
    if (mediaOpen) {
      const pop = $("media-pop");
      const left = pop.offsetLeft, top = pop.offsetTop;
      const right = left + pop.offsetWidth, bottom = top + pop.offsetHeight;
      post("chromeHeight", Math.max(base, bottom), base,
           left, top, right, bottom);
    } else {
      post("chromeHeight", base, base);
    }
  }

  render();
  post("ready");
  reportHeight();
  window.addEventListener("resize", reportHeight);
</script>
</body>
</html>
)CHROME";
