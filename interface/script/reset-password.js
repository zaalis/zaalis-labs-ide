/* Temporary page opened by "Forgot password", in any browser on this PC.
   The token travels in the URL fragment (never sent in requests or logs) and
   is removed from the address bar at once. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const en = new URLSearchParams(location.search).get('lang') === 'en';
    const translations = {
      "Nouveau mot de passe — zaalis IDE": "New password — zaalis IDE",
      "Vérification du lien…": "Checking link…",
      "Un instant.": "One moment.",
      "Nouveau mot de passe": "New password",
      "Confirmer le mot de passe": "Confirm password",
      "8 caractères minimum, avec au moins une lettre et un chiffre. Vos autres sessions seront déconnectées.": "Use at least 8 characters, including one letter and one digit. Your other sessions will be signed out.",
      "Enregistrer le mot de passe": "Save password",
      "C’est fait": "Password updated",
      "Votre mot de passe a été modifié. Vous pouvez vous connecter dans zaalis IDE.": "Your password has been changed. You can now sign in to zaalis IDE.",
      "Vous pouvez fermer cette fenêtre.": "You can close this window.",
      "Lien expiré": "Link expired",
      "Ce lien a expiré ou a déjà servi. Recommencez depuis « Mot de passe oublié ? » dans zaalis IDE.": "This link has expired or has already been used. Request a new link using “Forgot password?” in zaalis IDE.",
      "Ce lien est incomplet. Recommencez depuis « Mot de passe oublié ? » dans zaalis IDE.": "This link is incomplete. Request a new link using “Forgot password?” in zaalis IDE.",
      "zaalis IDE ne répond pas. Ouvrez l’application sur cet ordinateur, puis rechargez cette page.": "zaalis IDE is not responding. Open the app on this computer and reload this page.",
      "Le mot de passe doit contenir au moins 8 caractères.": "The password must be at least 8 characters long.",
      "Le mot de passe doit contenir au moins une lettre et un chiffre.": "The password must contain at least one letter and one digit.",
      "Les deux mots de passe ne correspondent pas.": "The passwords do not match.",
      "Modification impossible pour le moment.": "Unable to change your password right now.",
      "zaalis IDE ne répond pas. Vérifiez que l’application est ouverte, puis réessayez.": "zaalis IDE is not responding. Make sure the app is open and try again.",
      "Compte :": "Account:"
    };
    const text = value => en && Object.hasOwn(translations, value) ? translations[value] : value;
    if (en) {
        document.documentElement.lang = 'en';
        document.title = text(document.title);
        for (const label of document.querySelectorAll('.auth-form h2, .auth-form p, .auth-field span, .auth-submit')) {
            label.textContent = text(label.textContent);
        }
    }
    const light = window.matchMedia('(prefers-color-scheme: light)');
    const theme = () => document.body.classList.toggle('theme-light', light.matches);
    theme(); light.addEventListener('change', theme);

    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);

    const show = id => ['reset-checking', 'reset-form', 'reset-done', 'reset-expired'].forEach(section => { $(section).hidden = section !== id; });
    const error = $('reset-error');
    const showError = message => { error.textContent = text(message); error.classList.add('show'); };
    const hideError = () => { error.classList.remove('show'); document.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid')); };
    const invalid = (input, message) => { input.setAttribute('aria-invalid', 'true'); input.focus(); showError(message); };
    const expired = message => { if (message) $('reset-expired-text').textContent = text(message); show('reset-expired'); };

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
            $('reset-account').textContent = `${text('Compte :')} ${answer.data.email}`;
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
            if (answer.data.message) $('reset-done-text').textContent = text(answer.data.message);
            show('reset-done');
        } catch {
            showError('zaalis IDE ne répond pas. Vérifiez que l’application est ouverte, puis réessayez.');
        } finally { button.disabled = false; }
    });

    check();
})();
