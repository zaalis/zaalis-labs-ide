(() => {
    'use strict';
    let cleanup = () => {};
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const text = (fr, en) => state.language === 'en' ? en : fr;
    async function api(provider, body) {
        const response = await fetch(`/api/integrations/messengers/${provider}`, { credentials: 'include', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
    }
    // One step of the guided path: number, label, and whether it is done/current.
    function stepper(labels) {
        const list = node('ol', undefined, 'messenger-flow');
        const items = labels.map((label, i) => { const item = node('li'); item.append(node('span', String(i + 1), 'messenger-flow-dot'), node('span', label)); list.append(item); return item; });
        return { list, set(current) { items.forEach((item, i) => { item.dataset.step = i < current ? 'done' : i === current ? 'current' : 'todo'; if (i === current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); }); } };
    }
    const spinner = label => { const box = node('div', undefined, 'messenger-wait'); box.append(node('span', undefined, 'messenger-spinner'), node('span', label)); return box; };
    async function mount(provider, target, back) {
        cleanup();
        let active = true, timer, clock, observer;
        cleanup = () => { active = false; clearTimeout(timer); clearInterval(clock); observer?.disconnect(); closeAllCustomSelects(); target.querySelectorAll('select').forEach(s => s._customSelectCleanup?.()); };
        const whatsapp = provider === 'whatsapp';
        const title = whatsapp ? 'WhatsApp' : 'Telegram';
        const returnButton = node('button', uiText('← Retour aux intégrations'), 'integration-back'); returnButton.type = 'button'; returnButton.onclick = () => { cleanup(); back(); }; target.append(returnButton);
        const card = node('article', undefined, 'integration-card messenger-card'), header = node('div', undefined, 'integration-heading');
        const logo = node('img', undefined, 'integration-heading-logo'); logo.src = `assets/integrations/${provider}.svg`; logo.alt = '';
        const statusLabel = node('span', uiText('Chargement…'), 'integration-status'); header.append(logo, node('strong', title), statusLabel); card.append(header);
        card.append(node('p', whatsapp ? text('Parlez à l’IA de vos projets depuis votre téléphone, dans votre discussion WhatsApp avec vous-même. Associez ce PC en scannant un QR code.', 'Talk to the AI about your projects from your phone, in your WhatsApp chat with yourself. Link this PC by scanning a QR code.') : text('Continuez votre projet dans votre bot Telegram privé. Retrouvez la même conversation dans l’IDE.', 'Continue your project in your private Telegram bot. Find the same conversation in the IDE.'), 'integration-lead'));
        const notice = node('p', '', 'integration-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); card.append(notice); target.append(card);
        const say = (message, kind) => { notice.classList.remove('success', 'error'); notice.textContent = message || ''; if (kind) notice.classList.add(kind); };
        const button = (label, action, parent, primary) => {
            const b = node('button', label, 'integration-button' + (primary ? ' primary' : '')); b.type = 'button';
            b.onclick = async () => {
                const pending = uiText('Opération en cours…');
                b.disabled = true; say(pending);
                try { await action(); if (notice.textContent === pending) say(''); } catch (e) { say(uiText(e.message), 'error'); } finally { b.disabled = false; }
            };
            parent.append(b); return b;
        };
        try {
            let status = await api(provider); if (!active) return;

            // ── 1. Connection: the guided path, rendered from the server state ──
            const connection = node('section', undefined, 'integration-section messenger-connection');
            connection.append(node('h4', text('Votre connexion', 'Your connection')));
            const flow = stepper(whatsapp
                ? [text('Connecter', 'Connect'), text('Scanner le QR code', 'Scan the QR code'), text('Utiliser', 'Use it')]
                : [text('Créer votre bot', 'Create your bot'), text('Démarrer le bot', 'Start the bot'), text('Utiliser', 'Use it')]);
            const stage = node('div', undefined, 'messenger-stage');
            connection.append(flow.list, stage); card.append(connection);
            let rendered = '', qrImage = null;
            const act = async (body, after) => { status = await api(provider, body); render(true); if (after) after(); };
            const countdown = (deadline, label) => {
                const line = node('p', '', 'messenger-countdown');
                const tick = () => { const left = Math.max(0, Math.round((deadline - Date.now()) / 1000)); line.textContent = `${label} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; };
                tick(); clearInterval(clock); clock = setInterval(tick, 1000); return line;
            };
            function whatsappStage(actions) {
                const s = status.state;
                if (status.connected) {
                    flow.set(2);
                    const done = node('div', undefined, 'messenger-success'); done.append(node('strong', text('✓ WhatsApp est relié à ce PC', '✓ WhatsApp is linked to this PC')), node('span', status.name ? text('Compte : ', 'Account: ') + status.name : ''));
                    const how = node('div', undefined, 'messenger-howto');
                    if (status.trigger) {
                        how.append(node('p', text('Dans WhatsApp, ouvrez la discussion avec vous-même (votre propre nom, « Moi »), puis commencez votre message par :', 'In WhatsApp, open the chat with yourself (your own name, “You”), then start your message with:')), node('code', `${status.trigger} ${text('résume où en est le projet', 'summarize where the project stands')}`, 'messenger-example'));
                        how.append(node('p', text(`Sans « ${status.trigger} », vos messages restent de simples notes : l’IA ne les lit pas.`, `Without “${status.trigger}”, your messages stay plain notes: the AI does not read them.`), 'messenger-hint'));
                    } else {
                        how.append(node('p', text('Depuis votre téléphone, écrivez directement à ce numéro WhatsApp, sans mot-clé : l’IA y répond comme un contact, erreurs comprises.', 'From your phone, write directly to this WhatsApp number, no keyword needed: the AI replies there like a contact, errors included.')));
                        how.append(node('p', text('Numéros autorisés : ', 'Allowed numbers: ') + (status.allowedUsers || []).map(n => '+' + n).join(', '), 'messenger-hint'));
                    }
                    stage.append(done, how, actions);
                    if (status.trigger) button(text('Envoyer un message de test', 'Send a test message'), () => act({ action: 'test' }, () => say(text('✓ Message envoyé. Ouvrez votre discussion avec vous-même sur le téléphone.', '✓ Message sent. Open your chat with yourself on the phone.'), 'success')), actions, true);
                    button(uiText('Déconnecter'), () => act({ action: 'disconnect' }, () => say(text('WhatsApp est déconnecté de ce PC.', 'WhatsApp is disconnected from this PC.'))), actions);
                    return;
                }
                if (s === 'connecting') { flow.set(0); stage.append(spinner(text('Préparation du QR code…', 'Preparing the QR code…')), actions); button(text('Annuler', 'Cancel'), () => act({ action: 'disconnect' }), actions); return; }
                if (s === 'pairing' && status.qr) {
                    flow.set(1);
                    const grid = node('div', undefined, 'messenger-pairing');
                    qrImage = node('img', undefined, 'messenger-qr'); qrImage.alt = text('QR code d’association WhatsApp', 'WhatsApp pairing QR code'); qrImage.src = status.qr;
                    const steps = node('ol', undefined, 'integration-steps');
                    for (const step of [status.mode === 'bot' ? text('Ouvrez WhatsApp du numéro dédié (second téléphone, eSIM ou WhatsApp Business) — pas votre compte personnel.', 'Open WhatsApp of the dedicated number (second phone, eSIM or WhatsApp Business) — not your personal account.') : text('Ouvrez WhatsApp sur votre téléphone.', 'Open WhatsApp on your phone.'), text('Android : touchez ⋮ puis « Appareils connectés ». iPhone : Réglages → « Appareils connectés ».', 'Android: tap ⋮ then “Linked devices”. iPhone: Settings → “Linked devices”.'), text('Touchez « Connecter un appareil ».', 'Tap “Link a device”.'), text('Visez ce QR code avec le téléphone.', 'Point the phone at this QR code.')]) steps.append(node('li', step));
                    const side = node('div'); side.append(steps, node('p', text('Le code se renouvelle tout seul toutes les 20 secondes environ : gardez cette page ouverte.', 'The code renews itself about every 20 seconds: keep this page open.'), 'messenger-hint'));
                    grid.append(qrImage, side); stage.append(grid, actions);
                    button(text('Annuler', 'Cancel'), () => act({ action: 'disconnect' }), actions); return;
                }
                if (s === 'linking') { flow.set(1); stage.append(spinner(text('QR code scanné ✓ Finalisation de l’association…', 'QR code scanned ✓ Finishing the link…'))); return; }
                if (s === 'expired') {
                    flow.set(1); stage.append(node('p', text('Le QR code a expiré avant d’être scanné. Affichez-en un nouveau quand votre téléphone est prêt.', 'The QR code expired before it was scanned. Show a new one when your phone is ready.'), 'messenger-hint'), actions);
                    button(text('Afficher un nouveau QR code', 'Show a new QR code'), () => act({ action: 'start' }), actions, true); return;
                }
                if (s === 'error') {
                    flow.set(0); stage.append(node('p', uiText(status.error || 'La connexion WhatsApp a échoué.'), 'integration-notice error'), actions);
                    button(text('Réessayer', 'Try again'), () => act({ action: 'start' }), actions, true);
                    button(text('Tout réinitialiser', 'Reset everything'), () => act({ action: 'disconnect' }), actions); return;
                }
                flow.set(0);
                if (status.error) stage.append(node('p', uiText(status.error), 'integration-notice error'));
                stage.append(node('p', s === 'offline' ? text('WhatsApp était relié mais n’est pas actif sur ce PC en ce moment.', 'WhatsApp was linked but is not active on this PC right now.') : text('Cliquez sur le bouton : un QR code apparaît ici, à scanner avec votre téléphone.', 'Click the button: a QR code appears here, to scan with your phone.'), 'messenger-hint'), actions);
                button(s === 'offline' ? text('Reconnecter WhatsApp', 'Reconnect WhatsApp') : text('Connecter WhatsApp', 'Connect WhatsApp'), () => act({ action: 'start' }), actions, true);
            }
            function telegramStage(actions) {
                const s = status.state;
                if (!status.configured) {
                    flow.set(0);
                    const steps = node('ol', undefined, 'integration-steps');
                    for (const step of [text('Ouvrez BotFather dans Telegram (bouton ci-dessous).', 'Open BotFather in Telegram (button below).'), text('Envoyez /newbot, choisissez un nom puis un identifiant finissant par « bot ».', 'Send /newbot, pick a name then a username ending in “bot”.'), text('Copiez la clé donnée par BotFather et collez-la ici.', 'Copy the key BotFather gives you and paste it here.')]) steps.append(node('li', step));
                    const tokenLabel = node('label', text('Clé de votre bot privé', 'Private bot key'), 'lab-field'), token = node('input'); token.type = 'password'; token.autocomplete = 'off'; token.placeholder = '123456789:ABC…'; tokenLabel.append(token);
                    stage.append(steps, actions, tokenLabel); const linkActions = node('div', undefined, 'integration-actions'); stage.append(linkActions, node('p', text('La clé est chiffrée sur ce PC et ne quitte jamais votre ordinateur, sauf vers Telegram.', 'The key is encrypted on this PC and never leaves your computer except to Telegram.'), 'messenger-hint'));
                    button(text('Ouvrir BotFather', 'Open BotFather'), async () => { await api(provider, { action: 'start' }); say(text('BotFather s’est ouvert dans votre navigateur : envoyez /newbot.', 'BotFather opened in your browser: send /newbot.')); }, actions);
                    button(text('Associer mon bot', 'Link my bot'), async () => { const value = token.value.trim(); if (!value) throw Error(text('Collez d’abord la clé donnée par BotFather.', 'Paste the key from BotFather first.')); token.value = ''; await act({ action: 'configure', token: value }, () => say(text('✓ Bot reconnu. Étape suivante : démarrez-le.', '✓ Bot recognized. Next step: start it.'), 'success')); }, linkActions, true);
                    return;
                }
                const changeBot = () => button(text('Changer de bot', 'Change bot'), () => act({ action: 'reset' }, () => say(text('Bot oublié. Associez le nouveau bot.', 'Bot forgotten. Link the new bot.'))), actions);
                if (status.connected) {
                    flow.set(2);
                    const done = node('div', undefined, 'messenger-success'); done.append(node('strong', text('✓ Telegram est relié à ce PC', '✓ Telegram is linked to this PC')), node('span', status.name ? '@' + status.name : ''));
                    stage.append(done, node('p', text('Écrivez simplement votre demande à votre bot. Commandes : /status, /new, /sessions, /stop.', 'Just write your request to your bot. Commands: /status, /new, /sessions, /stop.'), 'messenger-hint'));
                    if (status.error) stage.append(node('p', uiText(status.error), 'integration-notice error'));
                    stage.append(actions);
                    button(text('Envoyer un message de test', 'Send a test message'), () => act({ action: 'test' }, () => say(text('✓ Message envoyé à votre bot Telegram.', '✓ Message sent to your Telegram bot.'), 'success')), actions, true);
                    button(uiText('Déconnecter'), () => act({ action: 'disconnect' }, () => say(text('Telegram est déconnecté de ce PC.', 'Telegram is disconnected from this PC.'))), actions);
                    changeBot(); return;
                }
                if (s === 'pairing' && status.link) {
                    flow.set(1);
                    const grid = node('div', undefined, 'messenger-pairing');
                    if (status.linkQr) { const qr = node('img', undefined, 'messenger-qr'); qr.src = status.linkQr; qr.alt = text('QR code du lien Telegram', 'Telegram link QR code'); grid.append(qr); }
                    const side = node('div'), steps = node('ol', undefined, 'integration-steps');
                    for (const step of [text('Le lien s’est ouvert dans votre navigateur. Sur le téléphone, scannez plutôt ce QR code.', 'The link opened in your browser. On your phone, scan this QR code instead.'), text(`Dans Telegram, touchez « Démarrer » dans la conversation avec @${status.name}.`, `In Telegram, tap “Start” in the chat with @${status.name}.`), text('Cette page passe toute seule à « Connecté ».', 'This page switches to “Connected” by itself.')]) steps.append(node('li', step));
                    side.append(steps, countdown(status.expiresAt, text('Lien valable encore', 'Link valid for')));
                    grid.append(side); stage.append(grid, actions);
                    button(text('Copier le lien', 'Copy link'), async () => { await navigator.clipboard.writeText(status.link); say(text('Lien copié.', 'Link copied.'), 'success'); }, actions);
                    button(text('Annuler', 'Cancel'), () => act({ action: 'disconnect' }), actions); return;
                }
                if (s === 'expired') {
                    flow.set(1); stage.append(node('p', text('Le lien d’association a expiré (valable 10 minutes). Créez-en un nouveau.', 'The pairing link expired (valid for 10 minutes). Create a new one.'), 'messenger-hint'), actions);
                    button(text('Nouveau lien', 'New link'), () => act({ action: 'start' }), actions, true); changeBot(); return;
                }
                flow.set(1);
                if (status.error) stage.append(node('p', uiText(status.error), 'integration-notice error'));
                stage.append(node('p', text(`Votre bot @${status.name} est prêt. Démarrez-le depuis Telegram pour l’associer à votre compte.`, `Your bot @${status.name} is ready. Start it from Telegram to pair it with your account.`), 'messenger-hint'), actions);
                button(s === 'error' ? text('Réessayer', 'Try again') : text('Connecter Telegram', 'Connect Telegram'), () => act({ action: 'start' }), actions, true);
                changeBot();
            }
            // What happened to the last message: proof that the path works,
            // or the exact reason it did not.
            function activityLine() {
                const a = status.activity; if (!a || !status.connected) return null;
                const at = new Date(a.at).toLocaleTimeString(state.language === 'en' ? 'en' : 'fr', { hour: '2-digit', minute: '2-digit' });
                const label = { received: text('message reçu, l’IA travaille…', 'message received, the AI is working…'), replied: text('✓ réponse envoyée', '✓ reply sent'), tested: text('✓ message de test envoyé', '✓ test message sent'),
                    ignored: text(`message ignoré : commencez-le par « ${status.trigger || 'zaalis!'} »`, `message ignored: start it with “${status.trigger || 'zaalis!'}”`), failed: text('⚠ l’IA n’a pas pu répondre : ', '⚠ the AI could not reply: ') + (a.detail || '') }[a.kind] || a.kind;
                const line = node('p', text('Dernier échange', 'Last exchange') + ` · ${at} · ${label}`, 'messenger-activity'); line.dataset.kind = a.kind; return line;
            }
            function render(force) {
                const signature = [status.state, status.connected, status.configured, status.error, status.link, !!status.qr, status.activity?.at, status.activity?.kind].join('|');
                statusLabel.textContent = status.connected ? text('Connecté', 'Connected') + (status.name ? ' · ' + status.name : '')
                    : ({ pairing: whatsapp ? text('En attente du scan', 'Waiting for the scan') : text('En attente de Telegram', 'Waiting for Telegram'), linking: text('Association…', 'Linking…'), connecting: text('Connexion en cours…', 'Connecting…'), expired: text('Expiré', 'Expired'), error: text('Erreur', 'Error') }[status.state] || uiText('Non connecté'));
                statusLabel.dataset.connected = String(!!status.connected);
                statusLabel.dataset.state = status.state;
                if (!force && signature === rendered) { if (qrImage && status.qr && qrImage.src !== status.qr) qrImage.src = status.qr; return; }
                rendered = signature; qrImage = null; clearInterval(clock); stage.replaceChildren();
                const actions = node('div', undefined, 'integration-actions');
                (whatsapp ? whatsappStage : telegramStage)(actions);
                // A test or a real reply proves the last step: everything is validated.
                if (status.connected && ['replied', 'tested'].includes(status.activity?.kind)) flow.set(3);
                const line = activityLine(); if (line) stage.prepend(line);
            }
            render(true);

            // ── WhatsApp: how replies arrive. WhatsApp shows everything an
            // account sends as that account's own, so only a dedicated number
            // can answer like a contact. ──
            if (whatsapp) {
                const box = node('section', undefined, 'integration-section messenger-mode');
                box.append(node('h4', text('Comment l’IA vous répond', 'How the AI replies')));
                const current = status.mode || 'self-chat';
                const choice = (value, title, detail) => {
                    const label = node('label', undefined, 'messenger-mode-option');
                    const input = node('input'); input.type = 'radio'; input.name = 'whatsapp-mode'; input.value = value; input.checked = current === value;
                    const copy = node('span'); copy.append(node('strong', title), node('span', detail, 'messenger-hint'));
                    label.append(input, copy); box.append(label); return input;
                };
                choice('self-chat', text('Discussion avec vous-même', 'Chat with yourself'),
                    text('Vous écrivez « zaalis! … » dans votre propre discussion. WhatsApp affiche tout ce qui part de votre compte comme vos messages : les réponses apparaissent de votre côté, précédées de « Zaalis · ».', 'You write “zaalis! …” in your own chat. WhatsApp shows everything your account sends as your messages: replies appear on your side, prefixed with “Zaalis · ”.'));
                const dedicated = choice('bot', text('Numéro dédié — l’IA répond comme un contact', 'Dedicated number — the AI replies like a contact'),
                    text('Reliez un second compte WhatsApp (autre SIM, eSIM ou WhatsApp Business). Vous lui écrivez depuis votre téléphone : chaque réponse de l’IA, erreurs comprises, arrive comme le message reçu d’une personne, avec « en train d’écrire… » et accusé de lecture.', 'Link a second WhatsApp account (another SIM, eSIM or WhatsApp Business). You write to it from your phone: every AI reply, errors included, arrives like a message received from a person, with “typing…” and read receipts.'));
                const peersLabel = node('label', text('Votre numéro personnel, autorisé à écrire au numéro dédié', 'Your personal number, allowed to write to the dedicated number'), 'lab-field');
                const peers = node('input'); peers.type = 'text'; peers.inputMode = 'tel'; peers.autocomplete = 'off'; peers.placeholder = '33612345678'; peers.value = (status.allowedUsers || []).join(', ');
                peersLabel.append(peers, node('span', text('Avec l’indicatif pays, sans « + » ni espaces. Plusieurs numéros : séparez-les par des virgules.', 'With the country code, no “+” or spaces. Several numbers: separate them with commas.'), 'messenger-hint'));
                const sync = () => { peersLabel.hidden = !dedicated.checked; };
                box.querySelectorAll('input[name="whatsapp-mode"]').forEach(input => { input.onchange = sync; }); sync();
                const modeActions = node('div', undefined, 'integration-actions');
                box.append(peersLabel, modeActions); card.append(box);
                button(text('Enregistrer le mode', 'Save mode'), async () => {
                    const mode = dedicated.checked ? 'bot' : 'self-chat';
                    const allowedUsers = peers.value.split(/[,;\n]/).map(value => value.trim()).filter(Boolean);
                    if (mode !== current && status.configured && !confirm(text('Changer de mode déconnecte le compte WhatsApp relié à ce PC. Vous scannerez ensuite le QR code avec le compte du nouveau mode. Continuer ?', 'Changing mode disconnects the WhatsApp account linked to this PC. You will then scan the QR code with the account for the new mode. Continue?'))) return;
                    await api(provider, { action: 'mode', mode, allowedUsers });
                    cleanup(); target.replaceChildren(); await mount(provider, target, back);
                    const feedback = target.querySelector('.integration-notice');
                    if (feedback) { feedback.textContent = mode === 'bot' ? text('✓ Mode numéro dédié enregistré. Connectez WhatsApp et scannez le QR code avec le compte du numéro dédié.', '✓ Dedicated number mode saved. Connect WhatsApp and scan the QR code with the dedicated number’s account.') : text('✓ Mode discussion avec vous-même enregistré.', '✓ Chat with yourself mode saved.'); feedback.classList.add('success'); }
                }, modeActions, true);
            }

            // ── 2. The conversation the messenger continues ──
            const contextBox = node('section', undefined, 'integration-section');
            contextBox.append(node('h4', text('Conversation à continuer', 'Conversation to continue')), node('p', text('Reprenez une conversation de l’IDE avec son projet, son historique et ses modèles. Sans choix, une nouvelle conversation est créée au premier message.', 'Resume an IDE conversation with its project, history and models. Without a choice, a new conversation is created on the first message.')));
            const label = node('label', text('Conversation', 'Conversation'), 'lab-field'), conversation = node('select'); conversation.id = 'messenger-conversation';
            const empty = node('option', text('Choisir une conversation…', 'Choose a conversation…')); empty.value = ''; conversation.append(empty);
            for (const item of status.conversations || []) { const option = node('option', `${item.title} · ${item.project || text('Sans projet', 'No project')} · ${item.kind === 'agents' ? 'Agents' : 'Chat'}`); option.value = JSON.stringify({ kind: item.kind, conversationId: item.conversationId }); conversation.append(option); }
            conversation.value = status.binding ? JSON.stringify(status.binding) : '';
            label.append(conversation); contextBox.append(label);
            const project = node('p', '', 'integration-context-path'); contextBox.append(project);
            const showProject = () => { const item = (status.conversations || []).find(c => JSON.stringify({ kind: c.kind, conversationId: c.conversationId }) === conversation.value); project.textContent = item?.projectPath || text('Le dossier de la conversation sélectionnée sera utilisé.', 'The selected conversation’s folder will be used.'); }; conversation.onchange = showProject; showProject();
            card.append(contextBox); createCustomSelect(conversation.id, { dropDown: true, viewport: true, label: text('Conversation', 'Conversation') });
            const contextActions = node('div', undefined, 'integration-actions'); contextBox.append(contextActions);
            button(text('Utiliser la conversation active', 'Use active conversation'), async () => {
                const kind = document.getElementById('view-agents')?.classList.contains('active') ? 'agents' : 'chat';
                const id = kind === 'agents' ? state.currentAgentConvId : state.currentConvId;
                if (!id) throw Error(text('Envoyez d’abord un message dans une conversation de l’IDE.', 'Send a message in an IDE conversation first.'));
                saveConversation(kind);
                const response = await fetch('/api/chats', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, conversations: state[kind === 'agents' ? 'agentConversations' : 'conversations'] }) });
                if (!response.ok) throw Error(text('La conversation n’a pas pu être enregistrée.', 'The conversation could not be saved.'));
                await api(provider, { action: 'settings', kind, conversationId: id, language: state.language });
                cleanup(); target.replaceChildren(); await mount(provider, target, back); const feedback = target.querySelector('.integration-notice'); if (feedback) { feedback.textContent = text('✓ Conversation active liée.', '✓ Active conversation linked.'); feedback.classList.add('success'); }
            }, contextActions);
            button(text('Enregistrer la conversation', 'Save conversation'), async () => {
                if (!conversation.value) throw Error(text('Choisissez une conversation de l’IDE.', 'Choose an IDE conversation.'));
                await api(provider, { action: 'settings', ...JSON.parse(conversation.value), language: state.language });
                say(text('✓ Conversation liée. Vous pouvez continuer votre travail dans cette messagerie.', '✓ Conversation linked. You can continue your work in this messenger.'), 'success');
            }, contextActions);
            const trigger = whatsapp ? (status.trigger || 'zaalis!') + ' ' : '';
            contextBox.append(node('p', text(`Les droits du projet restent ceux choisis dans l’IDE. Pour ajuster un plan, écrivez simplement vos consignes. Pour une validation, répondez ${trigger}/approve ou ${trigger}/deny suivi du code reçu. Gardez Zaalis ouvert sur ce PC.`, `Project permissions follow the IDE configuration. To adjust a plan, simply write your instructions. To answer an approval, reply ${trigger}/approve or ${trigger}/deny followed by the received code. Keep Zaalis open on this PC.`), 'integration-footnote'));
            card.append(node('p', whatsapp ? (status.mode === 'bot'
                ? text('Connexion par WhatsApp Web via un pont communautaire, pas l’API officielle de Meta. Seuls les numéros autorisés peuvent écrire à l’IA ; les autres contacts et les groupes sont ignorés.', 'WhatsApp Web connection through a community bridge, not Meta’s official API. Only allowed numbers can write to the AI; other contacts and groups are ignored.')
                : text('Connexion par WhatsApp Web via un pont communautaire, pas l’API officielle de Meta. Seuls vos messages commençant par « zaalis! » dans votre discussion avec vous-même déclenchent l’IA.', 'WhatsApp Web connection through a community bridge, not Meta’s official API. Only your messages starting with “zaalis!” in your chat with yourself trigger the AI.')) : text('Seule la conversation Telegram que vous avez associée peut utiliser votre IA. Les autres utilisateurs et les groupes sont ignorés.', 'Only your paired Telegram conversation can use your AI. Other users and groups are ignored.'), 'integration-footnote'));

            const poll = async () => { if (!active) return; try { status = await api(provider); if (active) render(false); } catch {} if (active) timer = setTimeout(poll, ['pairing', 'linking', 'connecting'].includes(status.state) ? 1200 : 3000); };
            timer = setTimeout(poll, 1200);
            observer = new MutationObserver(() => { if (!card.isConnected || !document.getElementById('settings-modal').classList.contains('active')) cleanup(); }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        } catch (e) { say(uiText(e.message), 'error'); }
    }
    window.ZaalisMessengers = { mount, cleanup: () => cleanup() };
})();
