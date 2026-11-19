/* Temporary page opened by "Forgot password", in any browser on this PC.
   The token travels in the URL fragment (never sent in requests or logs) and
   is removed from the address bar at once. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const light = window.matchMedia('(prefers-color-scheme: light)');
    const theme = () => document.body.classList.toggle('theme-light', light.matches);
    theme(); light.addEventListener('change', theme);

    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (location.hash) history.replaceState(null, '', location.pathname);

    const show = id => ['reset-checking', 'reset-form', 'reset-done', 'reset-expired'].forEach(section => { $(section).hidden = section !== id; });
    const error = $('reset-error');
    const showError = message => { error.textContent = message; error.classList.add('show'); };
    const hideError = () => { error.classList.remove('show'); document.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid')); };
    const invalid = (input, message) => { input.setAttribute('aria-invalid', 'true'); input.focus(); showError(message); };
    const expired = message => { if (message) $('reset-expired-text').textContent = message; show('reset-expired'); };

    async function post(url, body) {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, data };
    }

    async function check() {
        if (!token) return expired('Ce lien est incomplet. Recommencez depuis « Mot de passe oublié ? » dans zaalis IDE.');
        try {
            const answer = await post('/api/auth/password-reset/check', { token });
            if (!answer.ok) return expired(answer.data.error);
            $('reset-account').textContent = `Compte : ${answer.data.email}`;
            show('reset-form');
            $('reset-password').focus();
        } catch {
            expired('zaalis IDE ne répond pas. Ouvrez l’application sur cet ordinateur, puis rechargez cette page.');
        }
    }

    $('reset-form').addEventListener('submit', async event => {
        event.preventDefault();
        hideError();
        const first = $('reset-password'), second = $('reset-password2'), password = first.value;
        if (password.length < 8) return invalid(first, 'Le mot de passe doit contenir au moins 8 caractères.');
        if (!/[A-Za-zÀ-ÿ]/.test(password) || !/\d/.test(password)) return invalid(first, 'Le mot de passe doit contenir au moins une lettre et un chiffre.');
        if (password !== second.value) return invalid(second, 'Les deux mots de passe ne correspondent pas.');
        const button = event.submitter || $('reset-form').querySelector('button');
        button.disabled = true;
        try {
            const answer = await post('/api/auth/password-reset/confirm', { token, password });
            first.value = ''; second.value = '';
            if (answer.status === 410) return expired(answer.data.error);
            if (!answer.ok) return showError(answer.data.error || 'Modification impossible pour le moment.');
            if (answer.data.message) $('reset-done-text').textContent = answer.data.message;
            show('reset-done');
        } catch {
            showError('zaalis IDE ne répond pas. Vérifiez que l’application est ouverte, puis réessayez.');
        } finally { button.disabled = false; }
    });

    check();
})();
