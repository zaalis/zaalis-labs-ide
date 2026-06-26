// ==========================================================
//  REMOTE CONTROL (desktop) — pair a phone via QR over a tunnel
// ==========================================================
// Talks to /api/remote/* on this PC. The server boots `cloudflared`, returns a
// public HTTPS URL + a signed QR. Stopping kills the tunnel and revokes tokens.
(function () {
    const modal = $('#remote-modal');
    const btn = $('#remote-btn');
    if (!modal || !btn) return;

    const idleView = $('#remote-idle');
    const activeView = $('#remote-active');
    const genBtn = $('#remote-generate-btn');
    const stopBtn = $('#remote-stop-btn');
    const errEl = $('#remote-error');
    const dot = $('#remote-dot');
    const intro = $('#remote-intro');
    const points = $('#remote-idle .remote-points');
    const scanHint = $('.remote-scan-hint');
    const statusText = $('#remote-status-text');

    let working = false;

    function applyCopy() {
        const lang = state.language || 'fr';
        if (intro) intro.textContent = lang === 'en'
            ? 'Connect your phone to this zaalis session. A private encrypted link opens to this PC so you can use chat remotely without exposing your files or terminal.'
            : 'Connectez votre telephone a cette session zaalis. Un lien prive et chiffre est ouvert vers ce PC, pour utiliser le chat a distance sans exposer vos fichiers ni votre terminal.';
        if (points) {
            const items = lang === 'en'
                ? ['The phone can only access chat.', 'Files, commands, and settings stay blocked on the PC.', 'You can cut access from this PC or from the phone.']
                : ['Le telephone accede uniquement au chat.', 'Vos fichiers, commandes et reglages restent bloques cote PC.', "Vous pouvez couper l'acces depuis ce PC ou depuis le telephone."];
            points.innerHTML = items.map((text, i) => `<li>${i === 0 ? text.replace('chat', '<b>chat</b>') : text}</li>`).join('');
        }
        if (scanHint) scanHint.textContent = lang === 'en'
            ? 'Scan this code with your phone camera to open chat.'
            : "Scannez ce code avec l'appareil photo du telephone pour ouvrir le chat.";
        if (statusText) statusText.textContent = lang === 'en' ? 'Mobile access active' : 'Acces mobile actif';
        if (stopBtn) stopBtn.textContent = lang === 'en' ? 'Cut access' : "Couper l'acces";
        if (genBtn && !working) genBtn.textContent = lang === 'en' ? 'Connect my phone' : 'Connecter mon telephone';
    }

    function showError(msg) {
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.classList.toggle('hidden', !msg);
    }
    function setDot(active) {
        if (dot) dot.classList.toggle('on', !!active);
    }
    function showIdle() {
        idleView.classList.remove('hidden');
        activeView.classList.add('hidden');
        genBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
    }
    function showActive(data) {
        idleView.classList.add('hidden');
        activeView.classList.remove('hidden');
        genBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        if (data) {
            $('#remote-qr-img').src = data.qr || '';
            $('#remote-url').value = data.url || '';
        }
    }

    async function api(url, method) {
        const r = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        const d = await r.json().catch(() => ({}));
        if (!r.ok && !d.error) throw new Error('HTTP ' + r.status);
        if (d.error) throw new Error(d.error);
        return d;
    }

    async function refreshStatus() {
        try {
            const s = await api('/api/remote/status');
            setDot(s.active);
            return s;
        } catch { return { active: false }; }
    }

    async function openModal() {
        applyCopy();
        showError('');
        modal.classList.add('active');
        const s = await refreshStatus();
        if (s.active) {
            // tunnel already up — fetch a fresh QR for the existing URL
            try { showActive(await api('/api/remote/start', 'POST')); }
            catch { showIdle(); }
        } else {
            showIdle();
        }
    }
    function closeModal() { modal.classList.remove('active'); }

    async function generate() {
        if (working) return;
        working = true; showError('');
        const lang = state.language || 'fr';
        genBtn.disabled = true;
        genBtn.textContent = lang === 'en' ? 'Preparing secure link...' : 'Preparation du lien securise...';
        try {
            const data = await api('/api/remote/start', 'POST');
            showActive(data);
            setDot(true);
        } catch (e) {
            showError((lang === 'en' ? 'Failed: ' : 'Echec : ') + e.message);
        } finally {
            working = false;
            genBtn.disabled = false;
            genBtn.textContent = lang === 'en' ? 'Connect my phone' : 'Connecter mon telephone';
        }
    }

    async function stop() {
        if (working) return;
        working = true; showError('');
        try { await api('/api/remote/stop', 'POST'); } catch {}
        working = false;
        setDot(false);
        showIdle();
    }

    function copyUrl() {
        const inp = $('#remote-url');
        if (!inp || !inp.value) return;
        inp.select();
        navigator.clipboard && navigator.clipboard.writeText(inp.value).catch(() => {});
        const lang = state.language || 'fr';
        const b = $('#remote-copy'); const t = b.textContent;
        b.textContent = lang === 'en' ? 'Copied' : 'Copié';
        setTimeout(() => { b.textContent = t; }, 1200);
    }

    btn.addEventListener('click', openModal);
    $('#close-remote').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    genBtn.addEventListener('click', generate);
    stopBtn.addEventListener('click', stop);
    $('#remote-copy').addEventListener('click', copyUrl);

    // reflect status in the topbar dot at startup
    applyCopy();
    refreshStatus();
})();
