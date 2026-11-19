/* zaalis Glyphes — app logic.
 * Runs in three places with the same code:
 *  - on the phone, served by the Glyphes server (installable web app);
 *  - on a desktop browser (sidebar layout);
 *  - inside zaalis Labs IDE at /glyphes/, where the IDE's local server relays
 *    every call to the Glyphes server with the IDE's linked account.
 */
(() => {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const IDE = location.pathname.startsWith('/glyphes/');
    const MAC_IDE = IDE && /Macintosh/.test(navigator.userAgent);
    const MAC_MIC_SETTINGS = 'Réglages Système › Confidentialité et sécurité › Microphone';
    const apiUrl = (p) => IDE ? '/api/glyphes/proxy' + p.slice(4) : p;
    const app = $('app');
    const S = {
        me: null, plugins: [], glyphs: [], current: null, messages: [], actions: [], config: {},
        files: [], sending: false, live: new Map(), models: { providers: [], defaultModel: null }, server: null,
    };
    const VARIANT_IDS = Glyph.VARIANTS.map(v => v.id);

    // ------------------------------------------------------------------ utilities
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function svgIcon(paths) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = paths; return s; }
    async function api(method, path, body, opts = {}) {
        const headers = { 'X-Glyphes': '1' };
        let payload = body;
        if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
        Object.assign(headers, opts.headers || {});
        const response = await fetch(apiUrl(path), { method, headers, body: payload, credentials: 'same-origin' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error || `Erreur ${response.status}`), { status: response.status, data });
        return data;
    }
    let toastTimer;
    function toast(text, error) {
        const t = $('toast');
        t.textContent = text; t.className = 'toast' + (error ? ' error' : ''); t.hidden = false;
        t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 5200 : 2600);
    }
    // Haptics: Android vibrates; iOS 18 Safari ticks when a switch input toggles.
    function haptic() {
        if (S.me && S.me.settings.haptics === false) return;
        try { if (navigator.vibrate) { navigator.vibrate(8); return; } $('haptic').click(); } catch {}
    }
    addEventListener('glyphes:haptic', haptic);
    const fmtTime = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    function fmtDay(t) {
        const d = new Date(t), today = new Date(); const y = new Date(); y.setDate(y.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return 'Aujourd’hui ' + fmtTime(t);
        if (d.toDateString() === y.toDateString()) return 'Hier ' + fmtTime(t);
        return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + fmtTime(t);
    }
    const STATUS = { idle: 'Disponible', working: 'Au travail…', waiting: 'Attend ta confirmation', done: 'Terminé', error: 'Problème rencontré', paused: 'En pause' };
    const glyphOf = (id) => S.glyphs.find(g => g.id === id);
    function staticGlyph(variant, size) { return Glyph.staticSvg(variant, size); }
    // Live (animated) glyphs are reused per slot so re-renders do not restart them.
    function liveGlyph(host, key, variant, state) {
        let g = S.live.get(key);
        if (g && g.host.isConnected && g.host === host) { g.setVariant(variant); g.setState(state); return g; }
        if (g) g.destroy();
        g = Glyph.mount(host, { variant, state });
        S.live.set(key, g);
        return g;
    }
    function pruneLive() { for (const [k, g] of S.live) if (!g.host.isConnected) { g.destroy(); S.live.delete(k); } }

    // Minimal, safe markdown: escape first, then a few inline forms.
    function md(text) {
        const esc = String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const inline = s => s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
            .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
        const out = []; let list = null;
        for (const line of esc.split('\n')) {
            const item = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
            if (item) { if (!list) { list = []; } list.push(`<li>${inline(item[1])}</li>`); continue; }
            if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
            if (line.trim()) out.push(`<p>${inline(line)}</p>`);
        }
        if (list) out.push(`<ul>${list.join('')}</ul>`);
        return out.join('');
    }

    // ------------------------------------------------------------------ theme & viewport
    function applySettings() {
        const s = (S.me && S.me.settings) || {};
        document.documentElement.dataset.theme = s.theme || 'system';
        document.documentElement.dataset.font = s.font || 'system';
    }
    function fitViewport() {
        const vv = window.visualViewport, root = document.documentElement;
        // iOS home-screen mode reports a layout viewport ~45 px shorter than the screen (black strip at the bottom):
        // use the real screen height there.
        const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
        const base = standalone ? Math.max(innerHeight, screen.height) : innerHeight;
        // The keyboard shrinks the *visual* viewport but not the layout one on iOS: follow the visible area
        // (height and offset) so the composer stays right above the keyboard.
        const keyboard = !!vv && base - vv.height > 120;
        root.style.setProperty('--vh', keyboard ? vv.height + 'px' : (standalone ? base + 'px' : '100%'));
        root.style.setProperty('--vt', keyboard ? vv.offsetTop + 'px' : '0px');
        root.classList.toggle('kb', keyboard);
        if (!keyboard && vv && vv.offsetTop) window.scrollTo(0, 0);
        if (keyboard !== fitViewport.was) { fitViewport.was = keyboard; if (keyboard) { const th = document.getElementById('thread'); if (th) th.scrollTop = th.scrollHeight; } }
    }
    if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); }
    addEventListener('resize', fitViewport); fitViewport();
    document.addEventListener('focusin', () => { for (const t of [0, 120, 300, 600]) setTimeout(fitViewport, t); });
    document.addEventListener('focusout', () => { for (const t of [0, 200, 500]) setTimeout(fitViewport, t); });

    // ------------------------------------------------------------------ boot
    async function boot() {
        try { S.config = await api('GET', '/api/config'); } catch (e) { S.config = {}; if (IDE && e.status !== 401) { showIdeSetup(e); return; } }
        try {
            const me = await api('GET', '/api/me');
            S.me = me.user; S.plugins = me.plugins;
        } catch (error) {
            if (error.status === 401) return showLogin(error.data);
            if (IDE) return showIdeSetup(error);
            return showLogin(null, 'Serveur Glyphes injoignable. Vérifie ta connexion.');
        }
        applySettings();
        $('login').hidden = true;
        app.dataset.view = 'main';
        renderAccount(); renderPlugins();
        await loadGlyphs();
        const wanted = new URLSearchParams(location.search).get('g') || safeGet('glyphes-current');
        select(glyphOf(wanted) ? wanted : (S.glyphs[0] && S.glyphs[0].id));
        connectEvents();
        refreshActions();
        if (!IDE) { registerWorker(); startLocation(); }
        loadModels().catch(() => {});
    }
    function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
    function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

    let loginGlyph;
    function showLogin(data, hint) {
        app.dataset.view = 'login';
        $('login').hidden = false;
        if (!loginGlyph) loginGlyph = Glyph.mount($('login-glyph'), { variant: 'nova' });
        const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
        const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
        if (IDE) {
            $('login-google').hidden = true; $('login-ide').hidden = false;
            $('login-hint').textContent = 'Relie zaalis Labs IDE à ton compte Glyphes : une page s’ouvre dans ton navigateur pour te connecter avec Google.';
        } else {
            $('login-hint').textContent = hint || (ios && !standalone ? 'Astuce : dans Safari, touche Partager › « Sur l’écran d’accueil » pour installer Glyphes comme une app.' : '');
            if (S.config.google === false) { $('login-google').classList.add('disabled'); $('login-hint').textContent = 'La connexion Google n’est pas encore configurée sur ce serveur.'; }
        }
    }
    function showIdeSetup(error) {
        showLogin(null);
        $('login-hint').textContent = error && error.data && error.data.error ? error.data.error : 'Le serveur Glyphes est injoignable depuis zaalis Labs IDE.';
    }
    $('login-ide').addEventListener('click', async () => {
        const button = $('login-ide');
        button.disabled = true; button.textContent = 'En attente de ton autorisation…';
        try {
            const start = await fetch('/api/glyphes/link/start', { method: 'POST', headers: { 'X-Glyphes': '1' } }).then(r => r.json());
            if (start.error) throw new Error(start.error);
            $('login-hint').textContent = `Autorise zaalis Labs IDE dans la page ouverte (code ${start.code}).`;
            for (let i = 0; i < 150; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const poll = await fetch('/api/glyphes/link/poll', { method: 'POST', headers: { 'X-Glyphes': '1' } }).then(r => r.json());
                if (poll.status === 'approved') { location.reload(); return; }
                if (poll.status === 'denied' || poll.status === 'expired') throw new Error(poll.status === 'denied' ? 'Connexion refusée.' : 'Le lien a expiré.');
            }
            throw new Error('Délai dépassé.');
        } catch (error) {
            toast(error.message, true);
            button.disabled = false; button.textContent = 'Relier mon compte Glyphes';
        }
    });

    // ------------------------------------------------------------------ glyph list
    async function loadGlyphs() {
        S.glyphs = (await api('GET', '/api/glyphs')).glyphs;
        renderList();
    }
    function renderList() {
        const list = $('glyph-list');
        const rows = new Map([...list.children].map(r => [r.dataset.id, r]));
        const sorted = [...S.glyphs].sort((a, b) => b.updatedAt - a.updatedAt);
        sorted.forEach((g, index) => {
            let row = rows.get(g.id);
            if (!row) {
                row = el('button', 'row'); row.type = 'button'; row.dataset.id = g.id; row.setAttribute('role', 'listitem');
                const icon = el('span', 'row-glyph'), text = el('span', 'row-text');
                text.append(el('strong'), el('small'));
                row.append(icon, text, el('span', 'row-badge'));
                row.addEventListener('click', () => { haptic(); select(g.id); closeDrawer(); });
            }
            rows.delete(g.id);
            row.querySelector('strong').textContent = g.name;
            row.querySelector('small').textContent = g.pending ? 'Attend ta confirmation' : g.status === 'working' ? 'Au travail…' : (g.taskLabel || (g.last ? g.last.text : 'Nouvelle conversation'));
            row.setAttribute('aria-current', String(S.current === g.id));
            const badge = row.querySelector('.row-badge');
            badge.replaceChildren();
            if (g.pending) badge.append(el('span', 'badge wait', String(g.pending)));
            else if (g.unread) badge.append(el('span', 'badge', String(g.unread)));
            if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
            liveGlyph(row.querySelector('.row-glyph'), 'row-' + g.id, g.variant, g.pending ? 'waiting' : g.status);
        });
        for (const row of rows.values()) row.remove();
        pruneLive();
        $('menu-dot').hidden = !S.glyphs.some(g => g.id !== S.current && (g.pending || g.unread));
    }
    function renderTop() {
        const g = glyphOf(S.current);
        if (!g) return;
        $('top-glyph-name').textContent = g.name;
        $('top-glyph-status').textContent = g.pending ? STATUS.waiting : STATUS[g.status] || '';
        liveGlyph($('top-glyph-icon'), 'top', g.variant, g.pending ? 'waiting' : g.status);
        document.title = `${g.name} · Glyphes`;
    }
    async function select(id) {
        if (!id) { $('thread-inner').replaceChildren(); return; }
        S.current = id; safeSet('glyphes-current', id);
        const g = glyphOf(id);
        renderTop(); renderList();
        $('thread-inner').replaceChildren();
        try {
            const data = await api('GET', `/api/glyphs/${id}/messages`);
            if (S.current !== id) return;
            S.messages = data.messages;
            S.actions = data.actions.concat(S.actions.filter(a => a.glyphId !== id));
            renderThread(true);
            renderConfirm();
            if (g && g.unread) { g.unread = 0; renderList(); api('POST', `/api/glyphs/${id}/read`).catch(() => {}); }
        } catch (error) { toast(error.message, true); }
    }

    // ------------------------------------------------------------------ thread
    function renderThread(scrollToEnd) {
        const inner = $('thread-inner'), g = glyphOf(S.current);
        if (!g) return;
        const thread = $('thread');
        const nearEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
        inner.replaceChildren();
        if (!S.messages.length) {
            const empty = el('div', 'empty');
            empty.append(el('h3', '', `Je suis ${g.name}.`), el('p', '', g.mode === 'autonomous'
                ? 'Mode autonome : j’agis seul pour toi. Je te demande toujours avant toute suppression définitive.'
                : 'Mode supervisé : je prépare tout et tu confirmes avant chaque action.'));
            const sug = el('div', 'suggests');
            for (const text of ['Trie mes mails non lus et résume-les', 'Ajoute une séance de sport demain à 18 h', 'Rappelle-moi d’appeler maman ce soir', 'Quel est le chemin le plus rapide pour aller au travail ?']) {
                const b = el('button', '', text); b.type = 'button'; b.addEventListener('click', () => { $('input').value = text; autoGrow(); syncSend(); $('input').focus(); });
                sug.append(b);
            }
            empty.append(sug); inner.append(empty);
            pruneLive(); return;
        }
        let prev = null;
        for (const m of S.messages) {
            // Hidden system notes (the new-Glyph greeting order) and question cards (shown in the dock) stay out of the thread.
            if ((m.data && m.data.hidden) || (m.role === 'card' && m.data && m.data.kind === 'ask')) continue;
            if (!prev || m.createdAt - prev.createdAt > 20 * 60000) inner.append(el('div', 'time', fmtDay(m.createdAt)));
            inner.append(renderMessage(m, prev, g));
            prev = m;
        }
        if (g.status === 'working') {
            const t = el('div', 'typing'); const who = el('span', 'who'); t.append(who, el('span', 'shimmer', `${g.name} réfléchit…`));
            inner.append(t); liveGlyph(who, 'typing', g.variant, 'working');
        }
        pruneLive();
        renderAsk();
        if (scrollToEnd || nearEnd) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
    }
    function renderMessage(m, prev, g) {
        if (m.role === 'user' && m.data && m.data.event) return el('div', 'event ' + (m.data.ok ? 'ok' : 'no'), m.data.label || m.content);
        if (m.role === 'card') return linkCard(m.data);
        if (m.role === 'user') {
            const row = el('div', 'msg user'), col = el('div', 'user-col');
            if (m.data && m.data.files && m.data.files.length) {
                const files = el('div', 'files');
                for (const f of m.data.files) {
                    if (/^image\//.test(f.mime)) { const img = el('img'); img.src = apiUrl(`/api/files/${f.id}`); img.alt = f.name; img.loading = 'lazy'; files.append(img); }
                    else files.append(el('span', 'file', '📎 ' + f.name));
                }
                col.append(files);
            }
            if (m.data && m.data.reply) {
                // Answer to a question of the Glyph: the question in a rounded box, the answer under it.
                const q = el('div', 'reply-q');
                q.append(svgIcon(ICON.reply), el('span', '', m.data.reply.question));
                col.append(q);
            }
            if (m.content) col.append(el('div', 'bubble' + (m.data && m.data.reply && m.data.reply.later ? ' later' : ''), m.content));
            row.append(col);
            if (prev && prev.role !== 'user') row.classList.add('gap');
            return row;
        }
        const row = el('div', 'msg glyph' + (m.data && m.data.error ? ' error' : ''));
        const cont = prev && prev.role === 'assistant' && m.createdAt - prev.createdAt < 5 * 60000;
        if (cont) row.classList.add('cont'); else if (prev) row.classList.add('gap');
        const who = el('span', 'who'); who.append(staticGlyph(g.variant, 28));
        const text = el('div', 'text'); text.innerHTML = md(m.content);
        row.append(who, text);
        return row;
    }
    function linkCard(card) {
        const box = el('div', 'link-card');
        box.append(el('div', card.kind === 'maps' ? 'lc-map' : 'lc-web'));
        const body = el('div', 'lc-body');
        body.append(el('strong', '', card.title), el('small', '', card.subtitle || ''));
        const a = el('a', '', card.kind === 'maps' ? 'Ouvrir dans Google Maps' : 'Ouvrir la page');
        a.href = card.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.addEventListener('click', haptic);
        body.append(a); box.append(body);
        return box;
    }

    // ------------------------------------------------------------------ confirmation mini-window
    function renderConfirm() {
        const box = $('confirm');
        const pending = S.actions.filter(a => a.glyphId === S.current && a.status === 'pending');
        const action = pending[0];
        if (!action) {
            if (!box.hidden && !box.classList.contains('leaving')) { box.classList.add('leaving'); setTimeout(() => { box.hidden = true; box.classList.remove('leaving'); }, 260); }
            return;
        }
        if (box.dataset.id === action.id && !box.hidden) return;
        box.dataset.id = action.id; box.hidden = false; box.classList.remove('leaving');
        box.className = 'confirm' + (action.irreversible ? ' irreversible' : '');
        box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
        box.replaceChildren();
        const g = glyphOf(action.glyphId);
        const head = el('div', 'confirm-head'), who = el('span', 'who');
        who.append(staticGlyph(g ? g.variant : 'nova', 30));
        head.append(who, el('strong', '', action.card.title || 'Confirmer cette action ?'));
        if (pending.length > 1) head.append(el('span', 'count', `1 / ${pending.length}`));
        box.append(head);
        if (action.card.fields && action.card.fields.length) {
            const dl = el('dl');
            for (const [k, v] of action.card.fields) { dl.append(el('dt', '', k), el('dd', '', String(v))); }
            box.append(dl);
        }
        if (action.card.preview) box.append(el('div', 'preview', action.card.preview));
        if (action.card.note) box.append(el('div', 'note', action.card.note));
        const actions = el('div', 'confirm-actions');
        const no = el('button', 'btn btn-ghost', 'Refuser'), yes = el('button', 'btn btn-primary', action.irreversible ? 'Supprimer' : 'Confirmer');
        no.type = yes.type = 'button';
        no.addEventListener('click', () => decide(action, false, no, yes));
        yes.addEventListener('click', () => decide(action, true, no, yes));
        actions.append(no, yes); box.append(actions);
    }
    // ------------------------------------------------------------------ question mini-window (ask_user)
    // The latest question card of the Glyph, while no answer has been sent after it.
    const answered = new Set();
    function pendingAsk() {
        for (let i = S.messages.length - 1; i >= 0; i--) {
            const m = S.messages[i];
            if (m.role === 'user' && !(m.data && m.data.hidden)) return null;
            if (m.role === 'card' && m.data && m.data.kind === 'ask') return answered.has(m.id) ? null : m;
        }
        return null;
    }
    function hideAsk(box) {
        if (box.hidden || box.classList.contains('leaving')) return;
        box.classList.add('leaving'); setTimeout(() => { box.hidden = true; box.classList.remove('leaving'); box.dataset.id = ''; }, 260);
    }
    function renderAsk() {
        const box = $('ask'), card = pendingAsk();
        if (!card) return hideAsk(box);
        if (box.dataset.id === card.id && !box.hidden) return;
        box.dataset.id = card.id; box.hidden = false; box.classList.remove('leaving');
        box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
        const g = glyphOf(card.glyphId) || glyphOf(S.current);
        const question = card.data.question || card.content;
        let choice = null;
        const head = el('div', 'ask-head'), who = el('span', 'who');
        who.append(staticGlyph(g ? g.variant : 'nova', 30));
        head.append(who, el('strong', '', question));
        const list = el('div', 'ask-options');
        const free = el('input', 'ask-free'); free.type = 'text'; free.placeholder = 'Ou écris ta réponse…'; free.enterKeyHint = 'send'; free.maxLength = 400;
        const later = el('button', 'btn btn-ghost', 'Plus tard'), go = el('button', 'btn btn-primary', 'Commencer par ça');
        later.type = go.type = 'button';
        const sync = () => { go.disabled = !choice && !free.value.trim(); };
        (card.data.options || []).forEach((text, i) => {
            const b = el('button', 'ask-option'); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
            b.append(el('span', 'ask-num', String(i + 1)), el('span', 'ask-label', text), el('span', 'ask-check'));
            b.lastChild.append(svgIcon(ICON.check));
            b.addEventListener('click', () => {
                haptic(); choice = text; free.value = '';
                list.querySelectorAll('.ask-option').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
                sync();
            });
            list.append(b);
        });
        free.addEventListener('input', () => {
            if (free.value.trim()) { choice = null; list.querySelectorAll('.ask-option').forEach(o => o.setAttribute('aria-pressed', 'false')); }
            sync();
        });
        free.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !go.disabled) { e.preventDefault(); go.click(); } });
        const send = async (isLater) => {
            const text = isLater ? 'Plus tard' : (free.value.trim() || choice);
            if (!text) return;
            haptic(); later.disabled = go.disabled = true;
            answered.add(card.id); hideAsk(box); free.blur();
            try {
                const r = await api('POST', `/api/glyphs/${card.glyphId}/messages`, { text, reply: { question, later: !!isLater } });
                if (!S.messages.some(x => x.id === r.message.id)) S.messages.push(r.message);
                const gg = glyphOf(card.glyphId); if (gg && gg.status !== 'paused') gg.status = 'working';
                renderThread(true); renderTop();
            } catch (error) {
                answered.delete(card.id); box.dataset.id = ''; toast(error.message, true); renderAsk();
            }
        };
        later.addEventListener('click', () => send(true));
        go.addEventListener('click', () => send(false));
        const actions = el('div', 'confirm-actions'); actions.append(later, go);
        box.replaceChildren(head, list, free, actions);
        sync();
    }

    async function decide(action, approve, ...buttons) {
        haptic();
        buttons.forEach(b => b.disabled = true);
        try {
            const r = await api('POST', `/api/actions/${action.id}`, { approve });
            mergeAction(r.action);
            toast(approve ? (r.action.status === 'done' ? 'C’est fait.' : 'L’action a échoué.') : 'Action refusée.', approve && r.action.status !== 'done');
        } catch (error) {
            toast(error.message, true);
            if (error.status === 409) refreshActions(); else buttons.forEach(b => b.disabled = false);
        }
    }
    function mergeAction(action) {
        const i = S.actions.findIndex(a => a.id === action.id);
        if (i >= 0) S.actions[i] = action; else S.actions.push(action);
        S.actions = S.actions.filter(a => a.status === 'pending');
        const g = glyphOf(action.glyphId);
        if (g) g.pending = S.actions.filter(a => a.glyphId === g.id).length;
        renderConfirm(); renderList(); renderTop();
    }
    async function refreshActions() {
        try { S.actions = (await api('GET', '/api/actions')).actions; renderConfirm(); } catch {}
    }

    // ------------------------------------------------------------------ live events
    let source, retry = 0;
    function connectEvents() {
        if (source) source.close();
        source = new EventSource(apiUrl('/api/events'));
        source.addEventListener('open', () => { retry = 0; });
        source.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            const g = glyphOf(m.glyphId);
            if (g) { g.updatedAt = m.createdAt; if (m.role === 'assistant' || m.role === 'user') g.last = { role: m.role, text: m.content.slice(0, 140), at: m.createdAt }; }
            if (m.glyphId === S.current) {
                if (!S.messages.some(x => x.id === m.id)) { S.messages.push(m); renderThread(); }
                if (m.role === 'assistant' && document.visibilityState === 'visible') api('POST', `/api/glyphs/${m.glyphId}/read`).catch(() => {});
            }
            renderList();
        });
        source.addEventListener('glyph', (e) => {
            const g = JSON.parse(e.data);
            const i = S.glyphs.findIndex(x => x.id === g.id);
            if (g.id === S.current && document.visibilityState === 'visible') g.unread = 0;
            if (i >= 0) { const was = S.glyphs[i].status; S.glyphs[i] = g; if (g.id === S.current && was !== g.status) renderThread(); } else S.glyphs.push(g);
            renderList(); renderTop();
        });
        source.addEventListener('glyph-deleted', (e) => {
            const { id } = JSON.parse(e.data);
            S.glyphs = S.glyphs.filter(g => g.id !== id); renderList();
            if (S.current === id) select(S.glyphs[0] && S.glyphs[0].id);
        });
        source.addEventListener('action', (e) => mergeAction(JSON.parse(e.data)));
        source.addEventListener('plugins', (e) => { S.plugins = JSON.parse(e.data); renderPlugins(); });
        source.addEventListener('error', () => {
            if (source.readyState === EventSource.CLOSED) { source.close(); setTimeout(connectEvents, Math.min(15000, 1000 * 2 ** retry++)); }
        });
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || app.dataset.view !== 'main') return;
        loadGlyphs().then(() => S.current && select(S.current)).catch(() => {});
        refreshActions(); sendLocation();
        if (!source || source.readyState === EventSource.CLOSED) connectEvents();
    });

    // ------------------------------------------------------------------ composer
    const input = $('input');
    function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(150, input.scrollHeight) + 'px'; }
    function syncSend() {
        const has = input.value.trim().length > 0 || S.files.some(f => f.id);
        $('send-btn').hidden = !has; $('mic-btn').hidden = has;
    }
    input.addEventListener('input', () => { autoGrow(); syncSend(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
    });
    $('composer').addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        const files = S.files.filter(f => f.id).map(f => ({ id: f.id }));
        if ((!text && !files.length) || S.sending || !S.current) return;
        if (S.files.some(f => !f.id)) return toast('Patiente, un fichier est encore en cours d’envoi.');
        haptic(); S.sending = true;
        const g = glyphOf(S.current);
        input.value = ''; autoGrow();
        const sentFiles = S.files; S.files = []; renderAttachments(); syncSend();
        try {
            const r = await api('POST', `/api/glyphs/${S.current}/messages`, { text, files });
            if (!S.messages.some(x => x.id === r.message.id)) { S.messages.push(r.message); }
            if (g && g.status !== 'paused') g.status = 'working';
            renderThread(true); renderTop();
            if (g && g.status === 'paused') toast(`${g.name} est en pause : il lira ton message à la reprise.`);
        } catch (error) {
            toast(error.message, true);
            input.value = text; autoGrow(); S.files = sentFiles; renderAttachments(); syncSend();
        } finally { S.sending = false; }
    });

    // + menu: camera, photos, files
    const plus = $('plus-btn'), menu = $('plus-menu');
    function toggleMenu(open) { menu.hidden = !open; plus.setAttribute('aria-expanded', String(open)); }
    plus.addEventListener('click', (e) => { e.stopPropagation(); haptic(); toggleMenu(menu.hidden); });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false); });
    menu.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-pick]'); if (!b) return;
        toggleMenu(false); $('pick-' + b.dataset.pick).click();
    });
    for (const id of ['pick-camera', 'pick-photos', 'pick-files']) $(id).addEventListener('change', (e) => { for (const f of e.target.files) upload(f); e.target.value = ''; });
    async function upload(file) {
        if (file.size > 15 * 1024 * 1024) return toast(`« ${file.name} » dépasse 15 Mo.`, true);
        if (S.files.length >= 8) return toast('8 fichiers maximum par message.', true);
        const entry = { name: file.name, mime: file.type, preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
        S.files.push(entry); renderAttachments(); syncSend();
        try {
            const blob = /^image\/(jpeg|png|heic|heif|webp)$/.test(file.type) ? await shrink(file) : file;
            const r = await api('POST', '/api/files', blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } });
            entry.id = r.file.id;
        } catch (error) { toast(error.message, true); S.files = S.files.filter(f => f !== entry); }
        renderAttachments(); syncSend();
    }
    // Photos are resized on the phone (max 2048 px) so uploads stay fast.
    async function shrink(file) {
        try {
            const bitmap = await createImageBitmap(file);
            const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return await new Promise(r => canvas.toBlob(b => r(b || file), 'image/jpeg', 0.86));
        } catch { return file; }
    }
    function renderAttachments() {
        const box = $('attachments');
        box.replaceChildren();
        box.hidden = !S.files.length;
        for (const f of S.files) {
            const chip = el('div', 'chip' + (f.id ? '' : ' loading'));
            if (f.preview) { const img = el('img'); img.src = f.preview; img.alt = ''; chip.append(img); }
            chip.append(el('span', '', f.name));
            const x = el('button'); x.type = 'button'; x.setAttribute('aria-label', 'Retirer'); x.append(svgIcon('<path d="M6 6l12 12M18 6 6 18"/>'));
            x.addEventListener('click', () => { S.files = S.files.filter(y => y !== f); renderAttachments(); syncSend(); });
            chip.append(x); box.append(chip);
        }
    }

    // Dictation: recorded on the device, transcribed by whisper on the server
    // (same engine as zaalis Labs IDE); the device's own recogniser is the fallback.
    let recorder = null, chunks = [], recognition = null;
    $('mic-btn').addEventListener('click', async () => {
        haptic();
        const mic = $('mic-btn');
        if (recognition) { recognition.stop(); return; }
        if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
        if (!S.config.dictation || !navigator.mediaDevices || !window.MediaRecorder) return nativeDictation();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
            recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
            chunks = [];
            recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
            recorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                mic.classList.remove('rec'); mic.classList.add('busy');
                try {
                    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' });
                    const r = await api('POST', '/api/transcribe', blob, { headers: { 'Content-Type': blob.type } });
                    if (r.text) { input.value = (input.value ? input.value.trimEnd() + ' ' : '') + r.text; autoGrow(); syncSend(); input.focus(); }
                    else toast('Je n’ai rien entendu.');
                } catch (error) { toast(error.message, true); }
                mic.classList.remove('busy'); recorder = null;
            };
            recorder.start(); mic.classList.add('rec');
            setTimeout(() => recorder && recorder.state === 'recording' && recorder.stop(), 120000);
        } catch {
            const settings = MAC_IDE ? MAC_MIC_SETTINGS : 'les réglages du navigateur';
            toast('Micro refusé. Autorise-le dans ' + settings + '.', true);
        }
    });
    function nativeDictation() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return toast('La dictée n’est pas disponible ici.', true);
        recognition = new SR(); recognition.lang = 'fr-FR'; recognition.interimResults = true; recognition.continuous = false;
        const base = input.value ? input.value.trimEnd() + ' ' : '';
        recognition.onresult = (e) => { input.value = base + [...e.results].map(r => r[0].transcript).join(''); autoGrow(); syncSend(); };
        recognition.onend = () => { $('mic-btn').classList.remove('rec'); recognition = null; };
        recognition.onerror = () => toast('La dictée s’est arrêtée.', true);
        $('mic-btn').classList.add('rec'); recognition.start();
    }

    // ------------------------------------------------------------------ drawer (with swipe to close)
    function openDrawer() { haptic(); app.classList.add('drawer-open'); }
    function closeDrawer() { app.classList.remove('drawer-open'); $('drawer').style.transform = ''; }
    $('menu-btn').addEventListener('click', openDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    (() => {
        const drawer = $('drawer'); let x0 = null, dx = 0;
        drawer.addEventListener('touchstart', (e) => { if (!app.classList.contains('drawer-open')) return; x0 = e.touches[0].clientX; dx = 0; drawer.style.transition = 'none'; }, { passive: true });
        drawer.addEventListener('touchmove', (e) => { if (x0 == null) return; dx = Math.min(0, e.touches[0].clientX - x0); drawer.style.transform = `translateX(${dx}px)`; }, { passive: true });
        drawer.addEventListener('touchend', () => { if (x0 == null) return; drawer.style.transition = ''; x0 = null; if (dx < -70) closeDrawer(); else drawer.style.transform = ''; });
        // Swipe from the left edge opens it.
        let ex = null;
        $('chat').addEventListener('touchstart', (e) => { const t = e.touches[0]; ex = t.clientX < 24 ? t.clientX : null; }, { passive: true });
        $('chat').addEventListener('touchmove', (e) => { if (ex != null && e.touches[0].clientX - ex > 60) { ex = null; openDrawer(); } }, { passive: true });
    })();

    // ------------------------------------------------------------------ sheets
    const sheetStack = [];
    function openSheet(title, build, { back } = {}) {
        if (!back) sheetStack.length = 0;
        sheetStack.push({ title, build });
        drawSheet();
        app.classList.add('sheet-open');
    }
    function drawSheet() {
        const top = sheetStack[sheetStack.length - 1];
        $('sheet-title').textContent = top.title;
        $('sheet-back').hidden = sheetStack.length < 2;
        const body = $('sheet-body');
        body.replaceChildren(); body.scrollTop = 0;
        top.build(body);
        pruneLive();
    }
    function closeSheet() { app.classList.remove('sheet-open'); setTimeout(() => { if (!app.classList.contains('sheet-open')) { $('sheet-body').replaceChildren(); sheetStack.length = 0; pruneLive(); } }, 450); }
    $('sheet-close').addEventListener('click', closeSheet);
    $('sheet-scrim').addEventListener('click', closeSheet);
    $('sheet-back').addEventListener('click', () => { sheetStack.pop(); drawSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (app.classList.contains('sheet-open')) closeSheet(); else closeDrawer(); } });
    (() => { // drag the sheet down to close it
        const sheet = $('sheet'); let y0 = null, dy = 0;
        sheet.addEventListener('touchstart', (e) => { if ($('sheet-body').scrollTop > 0 && !e.target.closest('.sheet-head, .sheet-grabber')) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
        sheet.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); if (dy > 4) { sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; } }, { passive: true });
        sheet.addEventListener('touchend', () => { if (y0 == null) return; y0 = null; sheet.style.transition = ''; sheet.style.transform = ''; if (dy > 110) closeSheet(); });
    })();
    function group(label, ...items) {
        const wrap = el('div');
        if (label) wrap.append(el('div', 'group-label', label));
        const g = el('div', 'group'); g.append(...items.filter(Boolean)); wrap.append(g);
        return wrap;
    }
    function item({ icon, color, label, sub, value, onClick, control, danger, chevron }) {
        const node = el(onClick ? 'button' : 'div', 'item' + (danger ? ' danger' : ''));
        if (onClick) { node.type = 'button'; node.addEventListener('click', () => { haptic(); onClick(); }); }
        if (icon) { const ic = el('span', 'ic'); if (color) ic.style.background = color; ic.append(typeof icon === 'string' ? svgIcon(icon) : icon); node.append(ic); }
        const l = el('span', 'lbl', label); if (sub) l.append(el('small', '', sub)); node.append(l);
        if (value != null) node.append(el('span', 'val', value));
        if (control) node.append(control);
        if (chevron) { const c = svgIcon('<path d="m9 6 6 6-6 6"/>'); c.classList.add('chev'); node.append(c); }
        return node;
    }
    function toggle(checked, onChange) {
        const t = el('input', 'toggle'); t.type = 'checkbox'; t.checked = !!checked;
        t.addEventListener('change', () => { haptic(); onChange(t.checked, t); });
        return t;
    }
    function seg(options, value, onChange) {
        const s = el('div', 'seg');
        for (const [v, label] of options) {
            const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(v === value));
            b.addEventListener('click', () => { haptic(); s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); onChange(v); });
            s.append(b);
        }
        return s;
    }
    const ICON = {
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        chart: '<path d="M4 20V10M12 20V4M20 20v-8"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', pin: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
        wave: '<path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0"/>', cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
        out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
        mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
        check: '<path d="M4 12.5 9 17 20 6"/>', note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>', map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
        reply: '<path d="M10 8 5 12l5 4"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
        pause: '<path d="M9 5v14M15 5v14"/>', play: '<path d="m7 5 12 7-12 7z"/>', erase: '<path d="M20 20H9L4 15l10-10 7 7-6 6"/>', text: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
    };
    const PLUGIN_ICON = { gmail: ['mail', '#ea4335'], calendar: ['cal', '#1a73e8'], tasks: ['check', '#1e8e3e'], notes: ['note', '#f9ab00'], maps: ['map', '#34a853'], web: ['globe', '#5f62e8'] };

    // Plugins ("multiprise")
    function renderPlugins() {
        const connected = S.plugins.filter(p => p.connected).length;
        $('plug-count').textContent = connected ? String(connected) : '';
    }
    $('plug-btn').addEventListener('click', () => { haptic(); openSheet('Plugins', buildPlugins); });
    function connectUrl(plugins) { return `/auth/google/start?plugins=${plugins}&return=${encodeURIComponent('/?g=' + (S.current || ''))}`; }
    function buildPlugins(body) {
        body.append(el('p', 'hint', 'Ce à quoi tes Glyphes sont branchés. Gmail, Agenda, Tasks et Notes utilisent ton compte Google ; Maps et le web sont toujours disponibles.'));
        const rows = S.plugins.map(p => {
            const [icon, color] = PLUGIN_ICON[p.id] || ['globe', '#5f62e8'];
            let control;
            if (p.connected) control = el('span', 'pill on', p.needsGoogle ? 'Connecté' : 'Actif');
            else {
                control = el('button', 'pill', 'Connecter'); control.type = 'button';
                control.addEventListener('click', () => { haptic(); openExternal(connectUrl(p.id)); });
            }
            return item({ icon: ICON[icon], color, label: p.label, control });
        });
        body.append(group('', ...rows));
        if (S.plugins.some(p => p.needsGoogle && !p.connected)) {
            const all = el('button', 'btn btn-primary', 'Tout connecter avec Google'); all.type = 'button'; all.style.width = '100%';
            all.addEventListener('click', () => { haptic(); openExternal(connectUrl(S.plugins.filter(p => p.needsGoogle && !p.connected).map(p => p.id).join(','))); });
            body.append(all);
        }
    }
    // In the IDE, Google pages open in the system browser; on the phone, in place.
    async function openExternal(path) {
        if (!IDE) { location.href = path; return; }
        try {
            const r = await fetch('/api/glyphes/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Glyphes': '1' }, body: JSON.stringify({ path }) }).then(x => x.json());
            if (r.error) throw new Error(r.error);
            toast('Termine la connexion dans ton navigateur, puis reviens ici.');
            setTimeout(() => api('GET', '/api/plugins').then(d => { S.plugins = d.plugins; renderPlugins(); }).catch(() => {}), 8000);
        } catch (error) { toast(error.message, true); }
    }

    // Glyph settings (tap the glyph at the top)
    $('top-glyph').addEventListener('click', () => { const g = glyphOf(S.current); if (g) { haptic(); openSheet(g.name, (b) => buildGlyphForm(b, g)); } });
    $('new-glyph').addEventListener('click', () => { haptic(); openSheet('Nouveau Glyphe', (b) => buildGlyphForm(b, null)); });
    function buildGlyphForm(body, g) {
        const draft = g ? { ...g } : { name: '', variant: VARIANT_IDS[S.glyphs.length % VARIANT_IDS.length], mode: 'supervised', model: null, instructions: '' };
        const preview = el('div', 'empty-glyph'); preview.style.cssText = 'width:96px;height:96px;margin:4px auto 14px';
        body.append(preview);
        const pv = liveGlyph(preview, 'form', draft.variant, 'idle');
        const nameRow = el('div', 'form-row'); nameRow.append(el('label', '', 'Nom'));
        const name = el('input', 'input'); name.value = draft.name; name.placeholder = 'Ex. Coach, Courrier, Agenda…'; name.maxLength = 40;
        nameRow.append(name); body.append(nameRow);
        const varRow = el('div', 'form-row'); varRow.append(el('div', 'label', 'Apparence'));
        const grid = el('div', 'variants');
        for (const v of Glyph.VARIANTS) {
            const b = el('button'); b.type = 'button'; b.title = v.name; b.setAttribute('aria-pressed', String(v.id === draft.variant)); b.append(staticGlyph(v.id, 44));
            b.addEventListener('click', () => { haptic(); draft.variant = v.id; grid.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); pv.setVariant(v.id); pv.setState('done'); });
            grid.append(b);
        }
        varRow.append(grid); body.append(varRow);
        const modeRow = el('div', 'form-row mode-row'); modeRow.append(el('div', 'label', 'Mode'));
        const modeHint = el('p', 'hint');
        const syncHint = () => { modeHint.textContent = draft.mode === 'autonomous' ? 'Il agit seul, sans te demander. Une suppression définitive attend toujours ta confirmation explicite.' : 'Il prépare tout et te demande Confirmer / Refuser avant chaque action (envoi, création, modification).'; };
        modeRow.append(seg([['supervised', 'Supervisé'], ['autonomous', 'Autonome']], draft.mode, (v) => { draft.mode = v; syncHint(); }), modeHint); syncHint();
        body.append(modeRow);
        const modelRow = el('div', 'form-row'); modelRow.append(el('label', '', 'Modèle IA'));
        const select = el('select', 'select');
        const def = el('option', '', 'Modèle par défaut du compte'); def.value = ''; select.append(def);
        for (const p of S.models.providers) {
            const og = el('optgroup'); og.label = p.label;
            for (const m of p.models) { const o = el('option', '', m); o.value = `${p.provider}::${m}`; og.append(o); }
            select.append(og);
        }
        if (draft.model && ![...select.options].some(o => o.value === draft.model)) { const o = el('option', '', draft.model); o.value = draft.model; select.append(o); }
        select.value = draft.model || '';
        modelRow.append(select);
        if (!S.models.providers.length) modelRow.append(el('p', 'hint', 'Aucun modèle sur le serveur : ouvre Paramètres › Modèles.'));
        body.append(modelRow);
        const missionRow = el('div', 'form-row'); missionRow.append(el('label', '', 'Mission'));
        const mission = el('textarea', 'area'); mission.value = draft.instructions; mission.placeholder = 'Ex. Chaque matin à 8 h, trie mes mails, résume les importants et prépare les réponses.';
        missionRow.append(mission); body.append(missionRow);
        const save = el('button', 'btn btn-primary', g ? 'Enregistrer' : 'Créer le Glyphe'); save.type = 'button'; save.style.width = '100%';
        save.addEventListener('click', async () => {
            haptic(); save.disabled = true;
            const payload = { name: name.value.trim(), variant: draft.variant, mode: draft.mode, model: select.value || null, instructions: mission.value };
            try {
                if (g) { const r = await api('PATCH', `/api/glyphs/${g.id}`, payload); Object.assign(g, r.glyph); toast('Enregistré.'); }
                else { const r = await api('POST', '/api/glyphs', payload); S.glyphs.unshift(r.glyph); select_(r.glyph.id); }
                renderList(); renderTop(); closeSheet(); closeDrawer();
            } catch (error) { toast(error.message, true); save.disabled = false; }
        });
        body.append(save);
        if (!g) return;
        const jobsWrap = el('div'); jobsWrap.style.marginTop = '22px'; body.append(jobsWrap);
        api('GET', `/api/glyphs/${g.id}/jobs`).then(({ jobs }) => {
            if (!jobs.length) return;
            jobsWrap.append(group('Programmé', ...jobs.map(j => {
                const x = el('button', 'pill', 'Annuler'); x.type = 'button'; x.style.background = 'var(--bg-2)'; x.style.color = 'var(--danger)';
                const row = item({ icon: ICON.clock, color: '#8e8e93', label: j.text || j.instruction, sub: `${fmtDay(j.at)}${j.repeat ? ' · ' + ({ daily: 'chaque jour', weekdays: 'en semaine', weekly: 'chaque semaine', monthly: 'chaque mois' })[j.repeat] : ''}`, control: x });
                x.addEventListener('click', async () => { haptic(); await api('DELETE', `/api/jobs/${j.id}`); row.remove(); });
                return row;
            })));
        }).catch(() => {});
        const tools = group('',
            item({ icon: g.status === 'paused' ? ICON.play : ICON.pause, color: '#8e8e93', label: g.status === 'paused' ? 'Reprendre' : 'Mettre en pause', sub: g.status === 'paused' ? '' : 'Plus aucune mission tant qu’il est en pause', onClick: async () => {
                await api('POST', `/api/glyphs/${g.id}/${g.status === 'paused' ? 'resume' : 'pause'}`); closeSheet(); } }),
            item({ icon: ICON.erase, color: '#8e8e93', label: 'Effacer la conversation', onClick: async () => {
                if (!confirm(`Effacer toute la conversation avec ${g.name} ?`)) return;
                await api('POST', `/api/glyphs/${g.id}/clear`); S.messages = []; renderThread(true); closeSheet(); } }),
            item({ icon: ICON.trash, color: '#ff453a', label: `Supprimer ${g.name}`, danger: true, onClick: async () => {
                if (!confirm(`Supprimer définitivement ${g.name}, sa conversation et ses rappels ?`)) return;
                await api('DELETE', `/api/glyphs/${g.id}`); S.glyphs = S.glyphs.filter(x => x.id !== g.id); renderList(); closeSheet(); select(S.glyphs[0] && S.glyphs[0].id); } }));
        tools.style.marginTop = '18px';
        body.append(tools);
    }
    const select_ = (id) => select(id);

    // Settings
    function renderAccount() {
        const av = $('account-avatar'); av.replaceChildren();
        if (S.me.picture) { const img = el('img'); img.src = S.me.picture; img.alt = ''; img.referrerPolicy = 'no-referrer'; av.append(img); }
        else av.textContent = (S.me.name || '?').slice(0, 1).toUpperCase();
        $('account-name').textContent = S.me.name || S.me.email;
    }
    $('open-settings').addEventListener('click', () => { haptic(); openSheet('Paramètres', buildSettings); });
    async function saveSetting(patch) {
        try { const r = await api('PATCH', '/api/settings', patch); S.me.settings = r.settings; applySettings(); }
        catch (error) { toast(error.message, true); }
    }
    function buildSettings(body) {
        const s = S.me.settings;
        const av = el('span', 'avatar'); av.style.cssText = 'width:32px;height:32px';
        if (S.me.picture) { const img = el('img'); img.src = S.me.picture; img.alt = ''; img.referrerPolicy = 'no-referrer'; av.append(img); } else av.textContent = (S.me.name || '?')[0];
        body.append(group('Compte', item({ icon: av, color: 'transparent', label: S.me.name || S.me.email, sub: S.me.email })));
        body.append(group('',
            item({ icon: ICON.chart, color: '#5f62e8', label: 'Utilisation', chevron: true, onClick: () => openSheet('Utilisation', buildUsage, { back: true }) }),
            item({ icon: ICON.cpu, color: '#af52de', label: 'Modèles IA', sub: S.models.defaultModel ? S.models.defaultModel.split('::')[1] : 'Aucun', chevron: true, onClick: () => openSheet('Modèles IA', buildModels, { back: true }) }),
            item({ icon: ICON.sun, color: '#ff9f0a', label: 'Apparence', chevron: true, onClick: () => openSheet('Apparence', buildAppearance, { back: true }) })));
        const notif = toggle(s.notifications !== false && pushEnabled, async (on, t) => {
            if (on) { const ok = await enablePush(); if (!ok) t.checked = false; else saveSetting({ notifications: true }); }
            else { await disablePush(); saveSetting({ notifications: false }); }
        });
        const loc = toggle(!!s.location, async (on, t) => {
            if (on) { const ok = await askLocation(); t.checked = ok; if (ok) { await saveSetting({ location: true }); startLocation(); } }
            else { await saveSetting({ location: false }); stopLocation(); }
        });
        body.append(group('',
            item({ icon: ICON.wave, color: '#34c759', label: 'Retour haptique', control: toggle(s.haptics !== false, (on) => saveSetting({ haptics: on })) }),
            micItem(),
            !IDE && item({ icon: ICON.bell, color: '#ff3b30', label: 'Notifications', sub: 'Tâche terminée, confirmation, nouveauté', control: notif }),
            !IDE && item({ icon: ICON.pin, color: '#0a84ff', label: 'Localisation', sub: 'Pour les trajets et lieux proches', control: loc }),
            item({ icon: ICON.clock, color: '#8e8e93', label: 'Fuseau horaire', value: (s.timezone || 'Europe/Paris').replace(/_/g, ' '), onClick: () => {
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; saveSetting({ timezone: tz }); toast(`Fuseau : ${tz}`); } })));
        if (!IDE && pushEnabled) {
            const test = el('button', 'btn btn-ghost', 'Envoyer une notification de test'); test.type = 'button'; test.style.cssText = 'width:100%;margin:-8px 0 18px';
            test.addEventListener('click', async () => { haptic(); const r = await api('POST', '/api/push/test'); toast(r.sent ? 'Notification envoyée.' : 'Aucun appareil abonné.', !r.sent); });
            body.append(test);
        }
        body.append(group('',
            item({ icon: ICON.out, color: '#8e8e93', label: IDE ? 'Délier zaalis Labs IDE' : 'Se déconnecter', onClick: logout }),
            !IDE && item({ icon: ICON.trash, color: '#ff453a', label: 'Supprimer mon compte Glyphes', danger: true, onClick: deleteAccount })));
    }
    // Microphone: show the permission and let the user grant it from here.
    function micItem() {
        const pill = el('button', 'pill', '…'); pill.type = 'button';
        const show = (state) => {
            pill.classList.toggle('on', state === 'granted');
            pill.textContent = state === 'granted' ? 'Autorisé' : state === 'denied' ? 'Bloqué' : 'Autoriser';
            pill.dataset.state = state;
        };
        const read = async () => { try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch { return 'prompt'; } };
        read().then(show);
        pill.addEventListener('click', async () => {
            haptic();
            if (pill.dataset.state === 'granted' && !MAC_IDE) { toast('Micro autorisé. Retire-le dans les Réglages de l’iPhone si besoin.'); return; }
            if (pill.dataset.state === 'denied') {
                const settings = MAC_IDE ? MAC_MIC_SETTINGS : 'Réglages › Safari (ou Glyphes) › Micro › Autoriser';
                toast('Micro bloqué : ' + settings + '.', true);
                return;
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop()); show('granted'); toast('Micro autorisé.');
            } catch {
                show(!MAC_IDE && await read() === 'granted' ? 'granted' : 'denied');
                toast(MAC_IDE ? 'Micro refusé : ' + MAC_MIC_SETTINGS + '.' : 'Micro refusé.', true);
            }
        });
        return item({ icon: ICON.mic, color: '#ff9f0a', label: 'Microphone', sub: 'Pour dicter tes messages', control: pill });
    }
    async function logout() {
        if (IDE) { await fetch('/api/glyphes/unlink', { method: 'POST', headers: { 'X-Glyphes': '1' } }); location.reload(); return; }
        await disablePush().catch(() => {});
        await api('POST', '/api/auth/logout').catch(() => {});
        location.href = '/';
    }
    async function deleteAccount() {
        const typed = prompt(`Cette suppression est définitive : Glyphes, conversations, rappels et accès Google.\nTape ton adresse (${S.me.email}) pour confirmer.`);
        if (typed == null) return;
        try { await api('DELETE', '/api/account', { confirm: typed.trim() }); location.href = '/'; } catch (error) { toast(error.message, true); }
    }
    function buildAppearance(body) {
        const s = S.me.settings;
        const r1 = el('div', 'form-row'); r1.append(el('div', 'label', 'Thème'),
            seg([['system', 'Système'], ['dark', 'Sombre'], ['black', 'Noir'], ['light', 'Clair']], s.theme || 'system', (v) => { S.me.settings.theme = v; applySettings(); saveSetting({ theme: v }); }));
        const r2 = el('div', 'form-row'); r2.append(el('div', 'label', 'Police'),
            seg([['system', 'Système'], ['rounded', 'Arrondie'], ['serif', 'Serif'], ['mono', 'Mono']], s.font || 'system', (v) => { S.me.settings.font = v; applySettings(); saveSetting({ font: v }); }));
        body.append(r1, r2);
        const sample = el('p', 'hint', 'Aperçu : « Je t’ai préparé trois brouillons de réponse. Tu veux que je les envoie ? »'); sample.style.fontSize = '16px'; sample.style.color = 'var(--text)';
        body.append(sample);
    }
    async function buildUsage(body) {
        body.append(el('p', 'hint', 'Appels aux modèles par tes Glyphes sur les 30 derniers jours (jetons mesurés par le fournisseur).'));
        try {
            const { usage } = await api('GET', '/api/usage');
            if (!usage.length) { body.append(el('p', 'hint', 'Aucune utilisation pour l’instant.')); return; }
            const byModel = new Map();
            for (const u of usage) { const m = byModel.get(u.model) || { input: 0, output: 0, calls: 0 }; m.input += u.input; m.output += u.output; m.calls += u.calls; byModel.set(u.model, m); }
            const max = Math.max(...[...byModel.values()].map(m => m.input + m.output), 1);
            const rows = [...byModel].map(([model, m]) => {
                const node = item({ label: model.split('::')[1] || model, sub: `${m.calls} appels · ${fmtTokens(m.input)} entrée · ${fmtTokens(m.output)} sortie` });
                const bar = el('div', 'usage-bar'); const fill = el('i'); fill.style.width = Math.max(3, (m.input + m.output) / max * 100) + '%'; bar.append(fill);
                node.querySelector('.lbl').append(bar); return node;
            });
            body.append(group('Par modèle', ...rows));
        } catch (error) { body.append(el('p', 'hint', error.message)); }
    }
    const fmtTokens = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' M' : n > 1e3 ? Math.round(n / 1e3) + ' k' : String(n);
    async function loadModels() { S.models = await api('GET', '/api/models'); }
    function buildModels(body) {
        body.append(el('p', 'hint', 'Tes Glyphes utilisent les mêmes modèles et abonnements que zaalis Labs IDE. Les clés sont chiffrées sur le serveur, séparément pour chaque compte.'));
        const providers = S.models.providers;
        const defProvider = ((S.models.defaultModel || '').split('::')[0]) || (providers[0] && providers[0].provider);
        const chosen = providers.find(p => p.provider === defProvider) || providers[0];
        const setDefault = async (p) => {
            const keep = (S.models.defaultModel || '').startsWith(p.provider + '::') ? S.models.defaultModel : `${p.provider}::${p.models[0]}`;
            await saveSetting({ defaultModel: keep }); await loadModels(); drawSheet(); toast(`${p.label} sélectionné par défaut.`);
        };
        const rows = providers.map(p => {
            const isDef = chosen && p.provider === chosen.provider;
            const more = el('button', 'more-btn', ''); more.type = 'button'; more.setAttribute('aria-label', `Options ${p.label}`);
            more.append(svgIcon('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'));
            const ctl = el('span', 'item-ctl');
            if (isDef) { const ck = el('span', 'def-check'); ck.title = 'Sélectionné par défaut'; ck.append(svgIcon('<path d="M5 12.5 10 17.5 19 7"/>')); ctl.append(ck); }
            ctl.append(more);
            const node = item({ icon: ICON.cpu, color: '#af52de', label: p.label, sub: `${p.models.length} modèle${p.models.length > 1 ? 's' : ''}`, control: ctl });
            more.addEventListener('click', (e) => {
                e.stopPropagation(); haptic();
                popMenu(more, [
                    { label: isDef ? 'Sélectionné par défaut' : 'Sélectionner par défaut', icon: 'check', disabled: isDef, onClick: () => setDefault(p) },
                    { label: 'Retirer', icon: 'trash', danger: true, onClick: async () => { await api('DELETE', `/api/models/${p.provider}`); await loadModels(); drawSheet(); } },
                ]);
            });
            return node;
        });
        if (rows.length) body.append(group('Connectés', ...rows));
        if (chosen) {
            const row = el('div', 'form-row'); row.append(el('label', '', `Modèle par défaut · ${chosen.label}`));
            const sel = el('select', 'select');
            for (const m of chosen.models) { const o = el('option', '', m); o.value = `${chosen.provider}::${m}`; sel.append(o); }
            sel.value = (S.models.defaultModel || '').startsWith(chosen.provider + '::') ? S.models.defaultModel : `${chosen.provider}::${chosen.models[0]}`;
            sel.addEventListener('change', async () => { await saveSetting({ defaultModel: sel.value }); await loadModels(); toast('Modèle par défaut enregistré.'); });
            row.append(sel); body.append(row);
        }
        if (IDE) {
            const sync = el('button', 'btn btn-primary', 'Envoyer mes modèles de zaalis Labs IDE'); sync.type = 'button'; sync.style.width = '100%';
            sync.addEventListener('click', async () => {
                haptic(); sync.disabled = true;
                try {
                    const r = await fetch('/api/glyphes/push-models', { method: 'POST', headers: { 'X-Glyphes': '1' } }).then(x => x.json());
                    if (r.error) throw new Error(r.error);
                    toast(r.sent ? `${r.sent} fournisseur${r.sent > 1 ? 's' : ''} envoyé${r.sent > 1 ? 's' : ''}.` : 'Aucune clé API dans zaalis Labs IDE.');
                    await loadModels(); drawSheet();
                } catch (error) { toast(error.message, true); sync.disabled = false; }
            });
            body.append(sync, el('p', 'hint', 'Envoie les clés API configurées dans l’IDE (OpenAI, Anthropic, Gemini, xAI, Mistral, Moonshot et fournisseurs compatibles).'));
        }
    }
    // Small floating menu anchored to a button (glass panel, closes on any outside tap).
    function popMenu(anchor, actions) {
        document.querySelectorAll('.pop-scrim').forEach(n => n.remove());
        const scrim = el('div', 'pop-scrim'), pop = el('div', 'pop glass');
        for (const a of actions) {
            const b = el('button', 'pop-item' + (a.danger ? ' danger' : '')); b.type = 'button'; b.disabled = !!a.disabled;
            const ic = svgIcon(ICON[a.icon] || ''); b.append(ic, el('span', '', a.label));
            b.addEventListener('click', () => { haptic(); scrim.remove(); a.onClick(); });
            pop.append(b);
        }
        scrim.append(pop); app.append(scrim);
        const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
        pop.style.left = Math.max(10, Math.min(innerWidth - w - 10, r.right - w)) + 'px';
        pop.style.top = (r.bottom + 6 + h > innerHeight - 10 ? Math.max(10, r.top - h - 6) : r.bottom + 6) + 'px';
        scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) scrim.remove(); });
    }

    // ------------------------------------------------------------------ notifications (web push)
    let pushEnabled = false, swReg = null;
    async function registerWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
            const sub = swReg.pushManager && await swReg.pushManager.getSubscription();
            pushEnabled = !!sub && Notification.permission === 'granted';
            if (sub) api('POST', '/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
            navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.glyphId) select(e.data.glyphId); });
        } catch {}
    }
    function b64(s) { const pad = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
    async function enablePush() {
        if (!swReg || !('PushManager' in window)) {
            toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Sur iPhone, ajoute d’abord Glyphes à l’écran d’accueil, puis ouvre-le depuis l’icône.' : 'Notifications indisponibles sur ce navigateur.', true);
            return false;
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') { toast('Notifications refusées dans les réglages.', true); return false; }
        const { key } = await api('GET', '/api/push/key');
        if (!key) { toast('Le serveur ne gère pas encore les notifications.', true); return false; }
        const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
        await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
        pushEnabled = true; toast('Notifications activées.');
        return true;
    }
    async function disablePush() {
        const sub = swReg && swReg.pushManager && await swReg.pushManager.getSubscription();
        if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
        pushEnabled = false;
    }

    // ------------------------------------------------------------------ location (while the app is open)
    let locTimer = null;
    function askLocation() {
        return new Promise((resolve) => {
            if (!navigator.geolocation) { toast('Localisation indisponible.', true); return resolve(false); }
            navigator.geolocation.getCurrentPosition((p) => { postLocation(p); resolve(true); }, () => { toast('Localisation refusée.', true); resolve(false); }, { enableHighAccuracy: true, timeout: 15000 });
        });
    }
    function postLocation(p) { api('POST', '/api/location', { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }).catch(() => {}); }
    function sendLocation() {
        if (IDE || !S.me || !S.me.settings.location || !navigator.geolocation || document.visibilityState !== 'visible') return;
        navigator.geolocation.getCurrentPosition(postLocation, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    }
    function startLocation() { if (!S.me || !S.me.settings.location) return; sendLocation(); clearInterval(locTimer); locTimer = setInterval(sendLocation, 120000); }
    function stopLocation() { clearInterval(locTimer); locTimer = null; }

    boot();
})();
