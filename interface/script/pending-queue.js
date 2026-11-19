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
            if (!this.drawer) {
                this.drawer = document.createElement('section');
                this.drawer.className = 'chat-pending-drawer draft-queue';
                this.drawer.setAttribute('aria-label', 'Messages en attente');
                input.before(this.drawer);
            }
            this.drawer.replaceChildren();
            this.drawer.classList.toggle('show', this.items.length > 0);
            input.closest('.chat-input-area')?.classList.toggle('has-pending-chat', this.items.length > 0);
            const title = document.createElement('strong');
            title.textContent = `${this.items.length} message(s) en attente`;
            this.drawer.append(title);
            const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Envoyer le prochain';
            resume.addEventListener('click', () => this.onSend?.()); this.drawer.append(resume);
            this.items.forEach((draft, index) => {
                const row = document.createElement('div'); row.className = 'draft-queue-row';
                const field = document.createElement('textarea'); field.value = draft.message;
                field.setAttribute('aria-label', `Message en attente ${index + 1}`);
                field.addEventListener('input', () => { draft.message = field.value; });
                row.append(field);
                for (const [label, action, disabled] of [
                    ['↑', () => this.move(index, -1), index === 0],
                    ['↓', () => this.move(index, 1), index === this.items.length - 1],
                    ['Retirer', () => { this.items.splice(index, 1); this.render(); }, false],
                ]) {
                    const button = document.createElement('button'); button.type = 'button';
                    button.textContent = label; button.disabled = disabled;
                    button.setAttribute('aria-label', label === '↑' ? 'Avancer le message' : label === '↓' ? 'Reculer le message' : 'Retirer le message');
                    button.addEventListener('click', action); row.append(button);
                }
                if (draft.attachments?.length) { const count = document.createElement('small'); count.textContent = `${draft.attachments.length} pièce(s) jointe(s)`; row.append(count); }
                this.drawer.append(row);
            });
        }
    }
    window.ZaalisPendingQueue = PendingQueue;
})();
