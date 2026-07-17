/* ==========================================================
   zaalis IDE — Mobile (remote control) client
   Talks to the SAME server API as the desktop, restricted to chat.
   No inline scripts (CSP script-src 'self'); everything wired here.
   ========================================================== */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  // ---- tiny i18n for the dynamic strings (static HTML stays FR) ----
  var lang = localStorage.getItem('zaalis-mobile-lang') || 'fr';
  var STR = {
    fr: { conn: 'connecté', disc: 'hors-ligne', noConv: 'Aucune conversation', err: 'Erreur de connexion au serveur.',
      thinking: 'réflexion…', stopped: 'Remote control arrêté.', del: 'Supprimer cette conversation ?',
      empty: 'Écris un message pour commencer.', saved: 'Pseudo enregistré.', stopConfirm: 'Stopper le remote control ? Ce téléphone sera déconnecté.' },
    en: { conn: 'connected', disc: 'offline', noConv: 'No conversation', err: 'Server connection error.',
      thinking: 'thinking…', stopped: 'Remote control stopped.', del: 'Delete this conversation?',
      empty: 'Type a message to start.', saved: 'Username saved.', stopConfirm: 'Stop remote control? This phone will disconnect.' }
  };
  function L(k) { return (STR[lang] || STR.fr)[k]; }

  // ---- model config (mirrors desktop providers) ----
  var MODEL_LABELS = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', mistral: 'Mistral', local: 'Ollama', gguf: 'GGUF' };
  var SUBMODELS = {
    codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.1', 'o3-mini', 'o1', 'gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-4'],
    claude: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    grok: ['grok-4.5', 'grok-4.3', 'grok-4.20-multi-agent-0309', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1', 'grok-imagine-image-quality', 'grok-imagine-image'],
    mistral: ['mistral-medium-3-5', 'mistral-small-latest', 'mistral-large-latest', 'ministral-14b-2512', 'ministral-8b-2512', 'ministral-3b-2512', 'codestral-latest'],
    local: [], gguf: []
  };
  var AGENTS = [
    { nm: 'Codex', rl: 'Développeur', c: '#6366f1' }, { nm: 'Claude', rl: 'Reviewer', c: '#a855f7' },
    { nm: 'Gemini', rl: 'Architecte', c: '#3b82f6' }, { nm: 'Grok', rl: 'Optimiseur', c: '#22d3ee' },
    { nm: 'Ollama', rl: 'Testeur', c: '#f59e0b' }
  ];
  var SYS = "Tu es l'assistant de zaalis IDE, accessible à distance depuis le téléphone de l'utilisateur. " +
    "Réponds de façon claire, utile et concise. Tu n'as PAS accès aux fichiers ni au terminal depuis le mobile : " +
    "ne propose pas de blocs d'édition ou de commandes, contente-toi de discuter et d'aider.";

  // ---- state ----
  var conversations = [], currentConvId = null, chatHistory = [], busy = false;
  var recentProjects = [];     // folder names opened on the desktop (from the account)
  var model = 'codex', submodel = SUBMODELS.codex[0];
  var DEFAULT_PROJECT = (lang === 'en') ? 'My chats' : 'Mes chats';
  var expandedProjects = {};   // project name -> expanded?
  var currentProject = null;   // project new chats are filed under
  var didInitExpand = false;
  // Live-sync snapshots: re-render the sidebar only when the server data changes.
  var lastChatsJSON = '', lastProjectsJSON = '';

  var messagesEl = $('#messages');

  // ---- helpers ----
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // Minimal, safe markdown: generated images + fenced code + inline code.
  // Images are pulled out BEFORE escaping so their URL (data: or https with &)
  // is never mangled by esc().
  function fmt(t) {
    t = String(t == null ? '' : t);
    var imgs = [];
    t = t.replace(/!\[([^\]]*)\]\((data:image\/[^)\s]+|https?:\/\/[^)\s]+)\)/g, function (m, alt, url) {
      imgs.push({ alt: alt, url: url });
      return '\u0000IMG' + (imgs.length - 1) + '\u0000';
    });
    t = esc(t);
    t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, function (m, code) { return '<pre>' + code.replace(/\n$/, '') + '</pre>'; });
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\u0000IMG(\d+)\u0000/g, function (m, i) {
      var im = imgs[+i]; return '<img class="gen-img" src="' + im.url.replace(/"/g, '&quot;') + '" alt="' + esc(im.alt) + '">';
    });
    return t;
  }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  async function api(url, method, body) {
    var opt = { method: method || 'GET', headers: {}, credentials: 'same-origin' };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r = await fetch(url, opt);
    if (r.status === 401 || r.status === 403) { showUnpaired(); throw new Error('unauth'); }
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok && !(d && d.error)) throw new Error('HTTP ' + r.status);
    return d;
  }

  // ---- messages ----
  // `image` = { url, alt } for a generated image (e.g. produced on the PC and
  // synced here). Falls back to rendering `text` (which may itself contain a
  // markdown image, handled by fmt()).
  function addMsg(type, label, text, image) {
    var m = document.createElement('div');
    m.className = 'msg ' + type;
    var inner = '';
    if (label) inner += '<div class="msg-label"><b>' + esc(label) + '</b></div>';
    var body = (image && image.url)
      ? '<img class="gen-img" src="' + esc(image.url) + '" alt="' + esc(image.alt || '') + '">'
      : fmt(text);
    inner += '<div class="bubble">' + body + '</div>';
    m.innerHTML = inner;
    if (image && image.url) { m._img = { url: image.url, alt: image.alt || '' }; m.classList.add('has-img'); }
    messagesEl.appendChild(m);
    scrollBottom();
    return m;
  }
  function addTyping() {
    var m = document.createElement('div');
    m.className = 'msg ai';
    m.innerHTML = '<div class="bubble"><span class="typing-dots"><i></i><i></i><i></i></span></div>';
    messagesEl.appendChild(m); scrollBottom();
    return m;
  }

  function recordModelChange(previous) {
    if (!previous || previous === submodel || !currentConvId || !messagesEl.querySelector('.msg.user')) return;
    var before = previous;
    var after = submodel;
    addMsg('system', null, lang === 'en' ? 'Model changed: ' + before + ' → ' + after : 'Modèle changé : ' + before + ' → ' + after);
    saveConv();
  }

  // ---- conversations (same storage format as desktop) ----
  // Persist immediately: remote control must never "lose" a chat.
  function persist() {
    // Snapshot now so our own write doesn't trip the live-sync diff on next poll.
    lastChatsJSON = JSON.stringify(conversations);
    return api('/api/chats', 'PUT', { kind: 'chat', conversations: conversations }).catch(function () {});
  }
  function projectOf(c) { return (c && c.project) || DEFAULT_PROJECT; }
  // Folder name only (mirrors the desktop's projectLabel + recent-projects list).
  function projName(p) { return String(p == null ? '' : p).replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }
  function saveConv() {
    var data = [];
    messagesEl.querySelectorAll('.msg').forEach(function (m) {
      var label = m.querySelector('.msg-label'), body = m.querySelector('.bubble');
      var img = body && body.querySelector('img');
      var entry = {
        label: label ? label.textContent : null,
        text: img ? '' : (body ? body.textContent : ''),
        type: m.classList.contains('system') ? 'system' : m.classList.contains('user') ? 'user' : 'ai'
      };
      // Keep generated images so re-saving never strips them (DOM, then the
      // stashed object as a fallback).
      if (img) entry.image = { url: img.getAttribute('src'), alt: img.getAttribute('alt') || '' };
      else if (m._img) entry.image = m._img;
      data.push(entry);
    });
    if (!data.some(function (d) { return d.type === 'user'; })) return;
    var title = (data.find(function (d) { return d.type === 'user'; }) || {}).text;
    title = (title || 'Conversation').substring(0, 40);
    var pj = currentProject || DEFAULT_PROJECT;
    if (!currentConvId) {
      currentConvId = Date.now().toString();
      conversations.push({ id: currentConvId, title: title, date: new Date().toLocaleDateString(), project: pj, messages: data });
    } else {
      var c = conversations.find(function (x) { return x.id === currentConvId; });
      if (c) { c.messages = data; if (!c.project) c.project = pj; if (!c.title || c.title === 'Conversation') c.title = title; }
      else conversations.push({ id: currentConvId, title: title, date: new Date().toLocaleDateString(), project: pj, messages: data });
    }
    expandedProjects[pj] = true;
    persist(); renderConvs();
  }
  function loadConv(id) {
    var conv = conversations.find(function (c) { return c.id === id; });
    if (!conv) return;
    currentConvId = id;
    currentProject = projectOf(conv);
    expandedProjects[currentProject] = true;
    messagesEl.innerHTML = '';
    var msgs = conv.messages || [];
    msgs.forEach(function (m) { addMsg(m.type, m.label, m.text || '', m.image); });
    messagesEl._sig = sigOf(msgs);
    chatHistory = msgs
      .filter(function (m) { return m.type === 'user' || m.type === 'ai'; })
      .map(function (m) { return { role: m.type === 'user' ? 'user' : 'assistant', content: m.image ? (m.image.alt ? ('[Image: ' + m.image.alt + ']') : '[Image]') : (m.text || '') }; });
    renderConvs(); closeSidebar(); switchTab('chat');
  }
  // New chat filed under a project (the project's pencil, or the active project).
  function newConv(project) {
    currentConvId = null; chatHistory = [];
    currentProject = project || currentProject ||
      (conversations.length ? projectOf(conversations[conversations.length - 1]) : DEFAULT_PROJECT);
    expandedProjects[currentProject] = true;
    messagesEl.innerHTML = '';
    addMsg('system', null, L('empty'));
    renderConvs(); closeSidebar(); switchTab('chat');
  }
  function delConv(id) {
    if (!window.confirm(L('del'))) return;
    conversations = conversations.filter(function (c) { return c.id !== id; });
    if (currentConvId === id) { currentConvId = null; chatHistory = []; messagesEl.innerHTML = ''; addMsg('system', null, L('empty')); }
    persist(); renderConvs();
  }

  // Group conversations by project, newest project first.
  function groupConvs() {
    var groups = {}, order = [];
    conversations.forEach(function (c) {
      var pj = projectOf(c);
      if (!groups[pj]) { groups[pj] = []; order.push(pj); }
      groups[pj].push(c);
    });
    order.sort(function (a, b) {
      var la = groups[a][groups[a].length - 1], lb = groups[b][groups[b].length - 1];
      return (parseInt(lb.id, 10) || 0) - (parseInt(la.id, 10) || 0);
    });
    // Append recent projects (folders opened on the desktop) that have no chat
    // yet, so they still appear — newest first, mirroring the desktop list.
    (recentProjects || []).forEach(function (pj) {
      if (pj && !groups[pj]) { groups[pj] = []; order.push(pj); }
    });
    return { groups: groups, order: order };
  }

  function chevSvg(collapsed) {
    return '<span class="chev' + (collapsed ? ' collapsed' : '') + '"><svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  }

  // Render the PROJETS tree exactly like the desktop mock: expandable project
  // rows (chevron + name + count + pencil) with nested chat rows.
  function renderConvs() {
    var list = $('#conv-list');
    var g = groupConvs();
    if (!g.order.length) { list.innerHTML = '<div class="sb-empty">' + L('noConv') + '</div>'; return; }
    if (!didInitExpand) {
      didInitExpand = true;
      var activePj = null;
      if (currentConvId) { var ac = conversations.find(function (c) { return c.id === currentConvId; }); if (ac) activePj = projectOf(ac); }
      expandedProjects[activePj || g.order[0]] = true;
    }
    list.innerHTML = '';
    g.order.forEach(function (pj) {
      var convs = g.groups[pj].slice().reverse(); // newest first
      var expanded = !!expandedProjects[pj];

      var prow = document.createElement('div');
      prow.className = 'proj-row';
      prow.innerHTML = chevSvg(!expanded) +
        '<span class="pname">' + esc(pj) + '</span>' +
        '<span class="pcount">' + convs.length + '</span>' +
        '<button class="pedit" aria-label="Nouveau chat"><svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M4 20h4L18 10l-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M13 7l4 4" stroke="currentColor" stroke-width="1.5"/></svg></button>';
      var toggle = function () { expandedProjects[pj] = !expanded; renderConvs(); };
      prow.querySelector('.chev').addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
      prow.querySelector('.pname').addEventListener('click', toggle);
      prow.querySelector('.pcount').addEventListener('click', toggle);
      prow.querySelector('.pedit').addEventListener('click', function (e) { e.stopPropagation(); newConv(pj); });
      list.appendChild(prow);

      if (!expanded) return;
      convs.forEach(function (conv) {
        var row = document.createElement('div');
        row.className = 'conv-row' + (conv.id === currentConvId ? ' active' : '');
        var meta = conv.id === currentConvId ? (lang === 'en' ? 'active' : 'actif') : (conv.date || '');
        var dot = document.createElement('span'); dot.className = 'cdot';
        var txt = document.createElement('div'); txt.className = 'ctext';
        txt.innerHTML = '<span class="ctitle">' + esc(conv.title) + '</span><span class="cmeta">' + esc(meta) + '</span>';
        txt.addEventListener('click', function () { loadConv(conv.id); });
        var del = document.createElement('button'); del.className = 'trash'; del.setAttribute('aria-label', 'Supprimer');
        del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        del.addEventListener('click', function (e) { e.stopPropagation(); delConv(conv.id); });
        row.appendChild(dot); row.appendChild(txt); row.appendChild(del);
        list.appendChild(row);
      });
    });
  }

  // ---- send ----
  function updateSendBtn() { $('#send-btn').disabled = busy; }
  async function send() {
    var ta = $('#prompt'); var text = ta.value.trim();
    if (!text || busy) return;
    // drop the placeholder system message if present
    var first = messagesEl.querySelector('.msg.system'); if (first && messagesEl.children.length === 1) first.remove();
    addMsg('user', null, text);
    ta.value = ''; autoGrow();
    var typing = addTyping();
    busy = true; updateSendBtn();
    try {
      var data = await api('/api/chat', 'POST', {
        model: model, submodel: submodel, message: text, systemPrompt: SYS,
        config: { ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: submodel },
        reasoningLevel: 0, history: chatHistory.slice()
      });
      typing.remove();
      if (data.error) { addMsg('system', null, data.error); }
      else {
        var resp = data.response || '';
        addMsg('ai', MODEL_LABELS[model] || model, resp);
        chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: resp });
        saveConv();
      }
    } catch (e) {
      typing.remove();
      if (e.message !== 'unauth') addMsg('system', null, L('err'));
    } finally { busy = false; updateSendBtn(); }
  }

  // ---- model selectors ----
  function fillSubmodels() {
    var sel = $('#submodel-select'); sel.innerHTML = '';
    var list = SUBMODELS[model] || [];
    list.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    if (!list.length) { var o = document.createElement('option'); o.value = ''; o.textContent = '—'; sel.appendChild(o); }
    submodel = sel.value;
  }
  async function loadLocalModels() {
    try { var d = await api('/api/ollama-models?url=' + encodeURIComponent('http://127.0.0.1:11434')); SUBMODELS.local = (d.models || []).map(function (m) { return typeof m === 'string' ? m : m.name; }); } catch (e) {}
    try { var g = await api('/api/gguf-models'); SUBMODELS.gguf = (g.models || []).map(function (m) { return m.name; }); } catch (e) {}
  }

  // ---- tabs / sidebar / settings ----
  function switchTab(which) {
    $('#tab-chat').classList.toggle('active', which === 'chat');
    $('#tab-agents').classList.toggle('active', which === 'agents');
    $('#messages').classList.toggle('hidden', which !== 'chat');
    $('#agents-body').classList.toggle('hidden', which !== 'agents');
  }
  function openSidebar() { $('#veil').classList.remove('hidden'); $('#sidebar').classList.add('open'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#veil').classList.add('hidden'); }
  function openSettings() { closeSidebar(); $('#settings-screen').classList.add('open'); refreshRemote(); loadProfile(); }
  function closeSettings() { $('#settings-screen').classList.remove('open'); }

  function showUnpaired() { $('#pair-screen').classList.remove('hidden'); }
  function hideUnpaired() { $('#pair-screen').classList.add('hidden'); }

  // ---- remote status / profile (settings) ----
  async function refreshRemote() {
    try {
      var s = await api('/api/remote/status');
      var on = !!s.active;
      $('#set-remote-status').classList.toggle('off', !on);
      $('#set-remote-status').querySelector('.rs-txt').textContent = on ? (lang === 'en' ? 'Connected' : 'Connecté') : (lang === 'en' ? 'Inactive' : 'Inactif');
      $('#set-remote-since').textContent = on && s.since ? minutesSince(s.since) : '—';
      var sb = $('#sb-remote'); sb.classList.toggle('off', !on);
    } catch (e) {}
  }
  function minutesSince(ts) {
    var min = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return (lang === 'en' ? 'Active for ' : 'Depuis ') + min + ' min';
  }
  async function loadProfile() {
    try {
      var me = await api('/api/auth/me');
      var p = (me && me.profile) || {};
      $('#acct-name').textContent = p.pseudo || (me.email ? me.email.split('@')[0] : 'Utilisateur');
      $('#acct-email').textContent = me.email || '';
      $('#acct-pseudo').value = p.pseudo || '';
      var av = $('#acct-avatar');
      if (p.photo) { av.style.backgroundImage = 'url(' + p.photo + ')'; av.textContent = ''; }
      else { av.style.backgroundImage = ''; av.textContent = (p.pseudo || me.email || 'U').charAt(0).toUpperCase(); }
      $('#set-default-model').textContent = (MODEL_LABELS[model] || model);
    } catch (e) {}
  }

  // ---- textarea autogrow + viewport ----
  function autoGrow() { var ta = $('#prompt'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }

  // ---- init ----
  function buildModelSelect() {
    var sel = $('#model-select'); sel.innerHTML = '';
    Object.keys(MODEL_LABELS).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = MODEL_LABELS[k]; sel.appendChild(o); });
    sel.value = model;
  }
  function buildAgents() {
    var r = $('#agents-roster'); r.innerHTML = '';
    AGENTS.forEach(function (a, i) {
      var on = i < 2;
      var card = document.createElement('div'); card.className = 'agent-card';
      card.innerHTML = '<span class="agent-dot" style="background:' + a.c + '"></span>' +
        '<div class="agent-meta"><span class="nm">' + a.nm + '</span><span class="rl">' + a.rl + '</span></div>' +
        '<span class="agent-badge ' + (on ? 'badge-on' : 'badge-idle') + '">' + (on ? 'ON' : 'Idle') + '</span>';
      r.appendChild(card);
    });
  }
  async function loadChats() {
    var d = await api('/api/chats?kind=chat'); // throws -> showUnpaired on 401/403
    conversations = Array.isArray(d) ? d : [];
    lastChatsJSON = JSON.stringify(conversations);
    hideUnpaired();
    await loadRecentProjects();
    renderConvs();
    if (conversations.length) loadConv(conversations[conversations.length - 1].id);
    else newConv();
  }

  // Folders opened on the desktop (mirrored to the account) -> project rows.
  async function loadRecentProjects() {
    try {
      var p = await api('/api/recent-projects');
      var list = (p && p.projects) || [];
      lastProjectsJSON = JSON.stringify(list);
      recentProjects = list.map(projName);
    } catch (e) {}
  }

  // ---- live sync ----
  // Poll the account so chats/projects created on the desktop appear here in
  // (near) real time. Cheap diff: only re-render when the JSON actually changed.
  async function pollSync() {
    if (busy || document.hidden) return;
    if ($('#pair-screen') && !$('#pair-screen').classList.contains('hidden')) return;
    try {
      var d = await api('/api/chats?kind=chat');
      var arr = Array.isArray(d) ? d : [];
      var j = JSON.stringify(arr);
      if (j !== lastChatsJSON) {
        lastChatsJSON = j;
        conversations = arr;
        renderConvs();
        // Keep the open conversation live if it gained messages on the desktop.
        if (currentConvId && !messagesEl.matches(':focus-within')) {
          var open = conversations.find(function (c) { return c.id === currentConvId; });
          if (open) refreshOpenConv(open);
        }
      }
    } catch (e) {}
    try {
      var p = await api('/api/recent-projects');
      var list = (p && p.projects) || [];
      var pj = JSON.stringify(list);
      if (pj !== lastProjectsJSON) {
        lastProjectsJSON = pj;
        recentProjects = list.map(projName);
        renderConvs();
      }
    } catch (e) {}
  }
  // Content signature: changes when a message is added or its text/image changes.
  function sigOf(msgs) {
    var last = msgs.length ? msgs[msgs.length - 1] : null;
    var tail = last ? ((last.image && last.image.url) ? ('img:' + last.image.url.slice(0, 40)) : (last.text || '').slice(0, 40)) : '';
    return msgs.length + '|' + tail;
  }
  // Re-paint the open conversation's messages only if its content changed, so a
  // chat continued on the PC keeps streaming onto the phone without flicker.
  function refreshOpenConv(conv) {
    var msgs = conv.messages || [];
    var sig = sigOf(msgs);
    if (messagesEl._sig === sig) return;
    messagesEl._sig = sig;
    messagesEl.innerHTML = '';
    msgs.forEach(function (m) { addMsg(m.type, m.label, m.text || '', m.image); });
    chatHistory = msgs
      .filter(function (m) { return m.type === 'user' || m.type === 'ai'; })
      .map(function (m) { return { role: m.type === 'user' ? 'user' : 'assistant', content: m.image ? (m.image.alt ? ('[Image: ' + m.image.alt + ']') : '[Image]') : (m.text || '') }; });
  }

  function wire() {
    $('#menu-btn').addEventListener('click', openSidebar);
    $('#sb-close').addEventListener('click', closeSidebar);
    $('#veil').addEventListener('click', closeSidebar);
    $('#open-settings').addEventListener('click', openSettings);
    $('#settings-back').addEventListener('click', closeSettings);
    $('#newchat-btn').addEventListener('click', function () { newConv(); });
    $('#tab-chat').addEventListener('click', function () { switchTab('chat'); });
    $('#tab-agents').addEventListener('click', function () { switchTab('agents'); });
    $('#send-btn').addEventListener('click', send);
    $('#pair-retry').addEventListener('click', function () { hideUnpaired(); init(); });

    var ta = $('#prompt');
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    $('#model-select').addEventListener('change', function (e) {
      var previous = submodel;
      model = e.target.value;
      fillSubmodels();
      recordModelChange(previous);
    });
    $('#submodel-select').addEventListener('change', function (e) {
      var previous = submodel;
      submodel = e.target.value;
      recordModelChange(previous);
    });

    $('#set-lang').value = lang;
    $('#set-lang').addEventListener('change', function (e) { lang = e.target.value; localStorage.setItem('zaalis-mobile-lang', lang); document.documentElement.lang = lang; refreshRemote(); });

    $('#stop-remote-btn').addEventListener('click', async function () {
      if (!window.confirm(L('stopConfirm'))) return;
      try { await api('/api/remote/stop', 'POST', {}); } catch (e) {}
      toast(L('stopped'));
      setTimeout(showUnpaired, 600);
    });
    $('#acct-save').addEventListener('click', async function () {
      var pseudo = $('#acct-pseudo').value.trim();
      try { await api('/api/profile', 'POST', { pseudo: pseudo, photo: '' }); toast(L('saved')); loadProfile(); } catch (e) {}
    });

    // keep the latest message visible when the keyboard resizes the viewport
    if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { if (!busy) scrollBottom(); });
  }

  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollSync, 4000);
    // Refresh immediately when the user returns to the tab.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pollSync(); });
  }

  async function init() {
    try {
      await loadLocalModels();
      fillSubmodels();
      await loadChats();
      startPolling();
    } catch (e) { /* unpaired screen already shown on 401/403 */ }
  }

  document.documentElement.lang = lang;
  buildModelSelect();
  fillSubmodels();
  buildAgents();
  wire();
  init();
})();
