(() => {
    'use strict';
    let cleanup = () => {};
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const text = (fr, en) => state.language === 'en' ? en : fr;
    async function api(provider, body) {
        const response = await fetch(`/api/integrations/messengers/${provider}`, { credentials: 'include', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
    }
    async function mount(provider, target, back) {
        cleanup();
        let active = true, timer, observer;
        cleanup = () => { active = false; clearTimeout(timer); observer?.disconnect(); closeAllCustomSelects(); target.querySelectorAll('select').forEach(s => s._customSelectCleanup?.()); };
        const title = provider === 'whatsapp' ? 'WhatsApp' : 'Telegram';
        const returnButton = node('button', uiText('← Retour aux intégrations'), 'integration-back'); returnButton.type = 'button'; returnButton.onclick = () => { cleanup(); back(); }; target.append(returnButton);
        const card = node('article', undefined, 'integration-card messenger-card'), header = node('div', undefined, 'integration-heading');
        const logo = node('img', undefined, 'integration-heading-logo'); logo.src = `assets/integrations/${provider}.svg`; logo.alt = '';
        const statusLabel = node('span', uiText('Chargement…'), 'integration-status'); header.append(logo, node('strong', title), statusLabel); card.append(header);
        card.append(node('p', provider === 'whatsapp' ? text('Continuez une conversation de votre projet depuis votre discussion personnelle WhatsApp. Associez ce PC en scannant un QR code.', 'Continue a project conversation from your WhatsApp self-chat. Link this PC by scanning a QR code.') : text('Continuez votre projet dans votre bot Telegram privé. Retrouvez la même conversation dans l’IDE.', 'Continue your project in your private Telegram bot. Find the same conversation in the IDE.'), 'integration-lead'));
        const notice = node('p', '', 'integration-notice'); notice.setAttribute('role', 'status'); card.append(notice); target.append(card);
        try {
            let status = await api(provider); if (!active) return;
            const contextBox = node('section', undefined, 'integration-section');
            contextBox.append(node('h4', text('Continuer votre travail', 'Continue your work')), node('p', text('Reprenez une conversation de l’IDE avec son projet, son historique et ses modèles. Les questions, plans et demandes de validation arrivent dans cette messagerie.', 'Resume an IDE conversation with its project, history and models. Questions, plans and approval requests arrive in this messenger.')));
            const label = node('label', text('Conversation à continuer', 'Conversation to continue'), 'lab-field'), conversation = node('select'); conversation.id = 'messenger-conversation';
            const empty = node('option', text('Choisir une conversation…', 'Choose a conversation…')); empty.value = ''; conversation.append(empty);
            for (const item of status.conversations || []) { const option = node('option', `${item.title} · ${item.project || text('Sans projet', 'No project')} · ${item.kind === 'agents' ? 'Agents' : 'Chat'}`); option.value = JSON.stringify({ kind: item.kind, conversationId: item.conversationId }); conversation.append(option); }
            conversation.value = status.binding ? JSON.stringify(status.binding) : '';
            label.append(conversation); contextBox.append(label);
            const project = node('p', '', 'integration-context-path'); contextBox.append(project);
            const showProject = () => { const item = (status.conversations || []).find(c => JSON.stringify({ kind: c.kind, conversationId: c.conversationId }) === conversation.value); project.textContent = item?.projectPath || text('Le dossier de la conversation sélectionnée sera utilisé.', 'The selected conversation’s folder will be used.'); }; conversation.onchange = showProject; showProject();
            card.append(contextBox); createCustomSelect(conversation.id, { dropDown: true, viewport: true, label: text('Conversation', 'Conversation') });
            const saveContext = async () => { if (!conversation.value) throw Error(text('Choisissez une conversation de l’IDE.', 'Choose an IDE conversation.')); await api(provider, { action: 'settings', ...JSON.parse(conversation.value), language: state.language }); };
            const button = (label, action, parent = card) => { const b = node('button', label, 'integration-button'); b.type = 'button'; b.onclick = async () => { b.disabled = true; notice.classList.remove('success', 'error'); notice.textContent = uiText('Opération en cours…'); try { await action(); } catch (e) { notice.textContent = uiText(e.message); notice.classList.add('error'); } finally { b.disabled = false; } }; parent.append(b); return b; };
            const saved = () => { notice.textContent = text('✓ Conversation liée. Vous pouvez continuer votre travail dans cette messagerie.', '✓ Conversation linked. You can continue your work in this messenger.'); notice.classList.add('success'); };
            const contextActions = node('div', undefined, 'integration-actions'); contextBox.append(contextActions);
            button(text('Utiliser la conversation active', 'Use active conversation'), async () => {
                const kind = document.getElementById('view-agents')?.classList.contains('active') ? 'agents' : 'chat';
                const id = kind === 'agents' ? state.currentAgentConvId : state.currentConvId;
                if (!id) throw Error(text('Envoyez d’abord un message dans une conversation de l’IDE.', 'Send a message in an IDE conversation first.'));
                saveConversation(kind);
                const response = await fetch('/api/chats', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, conversations: state[kind === 'agents' ? 'agentConversations' : 'conversations'] }) });
                if (!response.ok) throw Error(text('La conversation n’a pas pu être enregistrée.', 'The conversation could not be saved.'));
                await api(provider, { action: 'settings', kind, conversationId: id, language: state.language });
                cleanup(); target.replaceChildren(); await mount(provider, target, back); const feedback=target.querySelector('.integration-notice');if(feedback){feedback.textContent=text('✓ Conversation active liée.', '✓ Active conversation linked.');feedback.classList.add('success');}
            }, contextActions);
            button(text('Enregistrer la conversation', 'Save conversation'), async () => { await saveContext(); saved(); }, contextActions);
            contextBox.append(node('p', text('Les droits du projet restent ceux choisis dans l’IDE. Pour ajuster un plan, écrivez simplement vos consignes. Pour une validation, répondez avec /approve ou /deny et le code reçu (précédés de !zaalis sur WhatsApp). Gardez Zaalis ouvert sur ce PC.', 'Project permissions follow the IDE configuration. To adjust a plan, simply write your instructions. Reply to an approval with /approve or /deny and the received code (prefixed with !zaalis on WhatsApp). Keep Zaalis open on this PC.'), 'integration-footnote'));
            if (provider === 'telegram' && !status.configured) {
                const setup = node('section', undefined, 'integration-section telegram-setup'); setup.append(node('h4', text('Créez votre bot privé', 'Create your private bot')), node('p', text('Telegram exige un bot pour recevoir les messages. Ouvrez BotFather, envoyez /newbot, puis collez ici la clé du bot. Cette clé sera chiffrée sur ce PC.', 'Telegram requires a bot to receive messages. Open BotFather, send /newbot, then paste the bot key here. It will be encrypted on this PC.')));
                button(text('Ouvrir BotFather', 'Open BotFather'), async () => { await api(provider, { action: 'start' }); notice.textContent = text('Dans BotFather, créez un bot avec /newbot.', 'In BotFather, create a bot with /newbot.'); }, setup);
                const tokenLabel = node('label', text('Clé de votre bot privé', 'Private bot key'), 'lab-field'), token = node('input'); token.type = 'password'; token.autocomplete = 'off'; token.placeholder = '123456789:…'; tokenLabel.append(token); setup.append(tokenLabel);
                button(text('Associer mon bot', 'Link my bot'), async () => { const value = token.value.trim(); token.value = ''; await api(provider, { action: 'configure', token: value }); cleanup(); target.replaceChildren(); await mount(provider, target, back); }, setup); card.append(setup);
            }
            const connection = node('section', undefined, 'integration-section'); connection.append(node('h4', text('Votre connexion', 'Your connection'))); card.append(connection);
            const qr = node('img', undefined, 'messenger-qr'); qr.alt = text('QR code d’association', 'Pairing QR code'); qr.hidden = true;
            const steps = node('ol', undefined, 'integration-steps');
            const instructions = provider === 'whatsapp' ? [text('Cliquez sur Connecter WhatsApp pour afficher le QR code.', 'Click Connect WhatsApp to display the QR code.'), text('Sur votre téléphone : WhatsApp → Appareils connectés → Connecter un appareil.', 'On your phone: WhatsApp → Linked devices → Link a device.'), text('Dans votre discussion avec vous-même, envoyez !zaalis suivi de votre question.', 'In your self-chat, send !zaalis followed by your question.')] : [text('Cliquez sur Connecter Telegram pour ouvrir votre bot.', 'Click Connect Telegram to open your bot.'), text('Appuyez sur Démarrer dans Telegram pour associer votre compte.', 'Press Start in Telegram to pair your account.'), text('Continuez votre travail : questions, plans et réponses restent dans la conversation choisie.', 'Continue your work: questions, plans and replies stay in the selected conversation.')];
            for (const step of instructions) steps.append(node('li', step)); connection.append(steps, qr);
            const actions = node('div', undefined, 'integration-actions'); connection.append(actions);
            const connect = button(text('Connecter ' + title, 'Connect ' + title), async () => { if (conversation.value) await saveContext(); status = await api(provider, { action: 'start' }); update(); }, actions);
            const disconnect = button(uiText('Déconnecter'), async () => { status = await api(provider, { action: 'disconnect' }); update(); notice.textContent = text('Connexion arrêtée.', 'Connection stopped.'); }, actions);
            function update() {
                statusLabel.textContent = status.connected ? text('Connecté', 'Connected') + (status.name ? ' · ' + status.name : '') : status.state === 'pairing' ? text('En attente de votre téléphone', 'Waiting for your phone') : status.state === 'connecting' ? text('Connexion en cours…', 'Connecting…') : uiText('Non connecté');
                statusLabel.dataset.connected = String(status.connected);
                qr.hidden = !status.qr; if (status.qr && qr.src !== status.qr) qr.src = status.qr;
                connect.hidden = status.connected || ['pairing', 'connecting'].includes(status.state) || (provider === 'telegram' && !status.configured); disconnect.hidden = status.state === 'disconnected' || status.state === 'offline';
                if (status.error) notice.textContent = uiText(status.error);
            }
            update(); card.append(node('p', provider === 'whatsapp' ? text('Connexion par WhatsApp Web via un pont communautaire. Seuls vos messages !zaalis dans votre discussion personnelle déclenchent l’IA.', 'WhatsApp Web connection through a community bridge. Only your !zaalis messages in your self-chat trigger the AI.') : text('Seule la conversation Telegram que vous avez associée peut utiliser votre IA. Les autres utilisateurs et les groupes sont ignorés.', 'Only your paired Telegram conversation can use your AI. Other users and groups are ignored.'), 'integration-footnote'));
            const poll = async () => { if (!active) return; try { status = await api(provider); if (active) update(); } catch {} if (active) timer = setTimeout(poll, 2000); }; timer = setTimeout(poll, 2000);
            observer = new MutationObserver(() => { if (!card.isConnected || !document.getElementById('settings-modal').classList.contains('active')) cleanup(); }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        } catch (e) { notice.textContent = uiText(e.message); }
    }
    window.ZaalisMessengers = { mount, cleanup: () => cleanup() };
})();
