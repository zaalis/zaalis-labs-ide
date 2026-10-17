/* Structured questions are serialized so parallel agents cannot overwrite an
 * unanswered question. Escape submits no answers, allowing a safe cancellation. */
(() => {
    'use strict';
    const { node, button, field, dialog } = window.ZaalisCollabUI;
    const queue = []; let current = null;
    function next() {
        if (current || !queue.length) return;
        current = queue.shift();
        const view = dialog('Précisions nécessaires');
        const form = node('form', undefined, 'collab-form'); const fields = new Map();
        for (const [index, question] of current.questions.entries()) {
            const group = node('fieldset'); group.append(node('legend', question.prompt || question.question || 'Question'));
            const input = field(group, 'Votre réponse', 'textarea'); input.id = `clarification-${index}`;
            fields.set(question.id || String(index), input);
            for (const option of question.options || []) {
                const choice = button(option.label, () => { input.value = option.label; input.focus(); });
                if (option.description) choice.title = option.description;
                group.append(choice);
            }
            if (question.allow_free_text === false && (question.options || []).length) input.readOnly = true;
            form.append(group);
        }
        const submit = node('button', 'Envoyer les réponses'); submit.type = 'submit'; form.append(submit);
        view.content.append(form);
        let answers = {};
        form.addEventListener('submit', event => { event.preventDefault(); answers = Object.fromEntries([...fields].map(([id, input]) => [id, input.value.trim()]).filter(([, answer]) => answer)); view.el.close(); });
        view.el.addEventListener('close', () => { const done = current; current = null; done.resolve(answers); view.el.remove(); next(); }, { once: true });
        view.el.showModal();
    }
    window.ZaalisClarification = { request(questions) { return new Promise(resolve => { queue.push({ questions, resolve }); next(); }); } };
})();
