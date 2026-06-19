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

    let working = false;

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
        genBtn.textContent = lang === 'en' ? 'Starting the tunnel…' : 'Démarrage du tunnel…';
        try {
            const data = await api('/api/remote/start', 'POST');
            showActive(data);
            setDot(true);
        } catch (e) {
            showError((lang === 'en' ? 'Failed: ' : 'Échec : ') + e.message);
        } finally {
            working = false;
            genBtn.disabled = false;
            genBtn.textContent = lang === 'en' ? 'Generate QR code' : 'Générer le QR code';
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
    refreshStatus();
})();
