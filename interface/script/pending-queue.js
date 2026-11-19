/* Drafts stay in memory: attachments may contain private files and are never
 * placed in localStorage. Each conversation owns its pending messages. */
(() => {
    'use strict';
    class PendingQueue {
        constructor(inputId) { this.inputId = inputId; this.items = []; this.owner = null; }
        get length() { return this.items.length; }
        push(draft, owner) {
            if (this.items.length && this.owner !== owner) throw new Error('Finish or remove the queued messages before switching conversation.');
            this.owner = owner;
            this.items.push(draft); this.render();
        }
        take() { const draft = this.items.shift(); this.render(); return draft; }
        clear() { this.items.length = 0; this.render(); }
        move(index, offset) {
            const target = index + offset;
            if (target < 0 || target >= this.items.length) return;
            [this.items[index], this.items[target]] = [this.items[target], this.items[index]]; this.render();
        }
        render() {
            const input = document.getElementById(this.inputId);
            if (!input) return;
            const en = state.language === 'en';
            if (!this.drawer) {
                this.drawer = document.createElement('section');
                this.drawer.className = 'chat-pending-drawer draft-queue';
                input.before(this.drawer);
            }
            this.drawer.setAttribute('aria-label', en ? 'Pending messages' : 'Messages en attente');
            this.drawer.replaceChildren();
            this.drawer.classList.toggle('show', this.items.length > 0);
            input.closest('.chat-input-area')?.classList.toggle('has-pending-chat', this.items.length > 0);
            const title = document.createElement('strong');
            const pendingLabel = en ? (this.items.length === 1 ? "pending message" : "pending messages")
                : (this.items.length === 1 ? "message en attente" : "messages en attente");
            title.textContent = `${this.items.length} ${pendingLabel}`;
            this.drawer.append(title);
            const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = en ? 'Send next' : 'Envoyer le prochain';
            resume.addEventListener('click', () => this.onSend?.()); this.drawer.append(resume);
            this.items.forEach((draft, index) => {
                const row = document.createElement('div'); row.className = 'draft-queue-row';
                const field = document.createElement('textarea'); field.value = draft.message;
                field.setAttribute('aria-label', (en ? 'Pending message ' : 'Message en attente ') + (index + 1));
                field.addEventListener('input', () => { draft.message = field.value; });
                row.append(field);
                for (const [label, action, disabled] of [
                    ['↑', () => this.move(index, -1), index === 0],
                    ['↓', () => this.move(index, 1), index === this.items.length - 1],
                    [en ? 'Remove' : 'Retirer', () => { this.items.splice(index, 1); this.render(); }, false],
                ]) {
                    const button = document.createElement('button'); button.type = 'button';
                    button.textContent = label; button.disabled = disabled;
                    const actionLabel = label === '↑' ? (en ? 'Move message up' : 'Avancer le message')
                        : label === '↓' ? (en ? 'Move message down' : 'Reculer le message')
                        : (en ? 'Remove message' : 'Retirer le message');
                    button.setAttribute('aria-label', actionLabel);
                    button.addEventListener('click', action); row.append(button);
                }
                if (draft.attachments?.length) {
                    const count = document.createElement('small');
                    const total = draft.attachments.length;
                    const label = en ? (total === 1 ? 'attachment' : 'attachments')
                        : (total === 1 ? 'pièce jointe' : 'pièces jointes');
                    count.textContent = `${total} ${label}`;
                    row.append(count);
                }
                this.drawer.append(row);
            });
        }
    }
    window.ZaalisPendingQueue = PendingQueue;
})();
