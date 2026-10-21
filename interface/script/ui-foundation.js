/* Shared presentation primitives and system appearance. No provider requests. */
(() => {
    'use strict';
    const phrases = new Map();
    const text = (fr, en) => { if(typeof fr==='string'&&typeof en==='string'){phrases.set(fr,[fr,en]);phrases.set(en,[fr,en]);} return state.language === 'en' ? en : fr; };
    const translate = value => {const pair=phrases.get(value);return pair?pair[state.language==='en'?1:0]:value;};
    function node(tag, className, value) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (value !== undefined) {
            element.textContent = value;
            const pair=phrases.get(value);if(pair){element.dataset.uiFr=pair[0];element.dataset.uiEn=pair[1];}
        }
        return element;
    }
    function button(label, action, className = 'ui-button') {
        const control = node('button', className, label); control.type = 'button';
        control.addEventListener('click', action); return control;
    }
    const system = matchMedia('(prefers-color-scheme: light)');
    function appearance() {
        const mode = ['system','light','dark'].includes(state.config.theme) ? state.config.theme : 'system';
        document.body.classList.toggle('theme-light', mode === 'light' || mode === 'system' && system.matches);
        document.documentElement.style.colorScheme = document.body.classList.contains('theme-light') ? 'light' : 'dark';
    }
    system.addEventListener('change', () => { if (state.config.theme === 'system') appearance(); });
    function accessibility(root = document) {
        root.querySelectorAll('button').forEach(control => {
            if (!control.getAttribute('aria-label') && !control.textContent.trim()) {
                const label = control.title || control.dataset.i18nTitle && TRANSLATIONS[state.language]?.[control.dataset.i18nTitle];
                if (label) control.setAttribute('aria-label', label);
            }
        });
        for (const [id, label] of [['send-btn', text('Envoyer le message','Send message')],['close-modal',text('Fermer les réglages','Close settings')]]) {
            const control = document.getElementById(id); if (control && !control.getAttribute('aria-label')) control.setAttribute('aria-label', label);
        }
    }
    document.addEventListener('zaalis-language-changed',()=>{
        document.querySelectorAll('[data-ui-fr]').forEach(element=>{const first=[...element.childNodes].find(child=>child.nodeType===3);if(first)first.nodeValue=state.language==='en'?element.dataset.uiEn:element.dataset.uiFr;});
        document.querySelectorAll('[aria-label],[title],[placeholder]').forEach(element=>{for(const attr of ['aria-label','title','placeholder'])if(element.hasAttribute(attr))element.setAttribute(attr,translate(element.getAttribute(attr)));});
    });
    window.ZaalisUI = { node, button, text, translate, appearance, accessibility };
})();
