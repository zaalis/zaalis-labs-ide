'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small interaction harness for DOM-only workspace modules. Layout, browser
// focus traps and native WebView behavior belong to the visual app checks.
function frontend(files, api) {
  const listeners = new Map();
  const document = { activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
      this.attributes = {}; this.value = ''; this.checked = false; this.open = false;
      this._text = ''; this.className = '';
      this.classList = { toggle: (name, value) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (value ?? !classes.has(name)) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      }, contains: name => this.className.split(/\s+/).includes(name) };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
    before(child) { const parent = this.parentElement; child.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(type, listener) { const group = this.listeners.get(type) || []; group.push(listener); this.listeners.set(type, group); }
    async emit(type) {
      for (const listener of this.listeners.get(type) || []) await listener({ target: this, preventDefault() {}, stopPropagation() {} });
      await settle();
    }
    focus() { document.activeElement = this; }
    setSelectionRange() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    closest(selector) { let el = this; while (el && !matches(el, selector)) el = el.parentElement; return el; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return walk(this).slice(1).filter(el => matches(el, selector)); }
  }
  function matches(el, selector) {
    if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
    const input = /^input\[type=['"]?([^\]'"]+)['"]?\]$/.exec(selector);
    if (input) return el.tagName === 'INPUT' && el.type === input[1];
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    return el.tagName.toLowerCase() === selector;
  }
  function walk(el) { return [el, ...el.children.flatMap(walk)]; }
  document.body = new Element('body');
  const toolbar = new Element('div'); toolbar.className = 'topbar-left'; document.body.append(toolbar);
  for (const [id, value] of [['ai-model', 'test-provider'], ['ai-submodel', 'test-model'], ['chat-input', '']]) {
    const el = new Element(id === 'chat-input' ? 'textarea' : 'select'); el.id = id; el.value = value; document.body.append(el);
  }
  document.createElement = tag => new Element(tag);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.querySelector = selector => document.body.querySelector(selector);
  document.getElementById = id => walk(document.body).find(el => el.id === id) || null;
  document.addEventListener = (name, action) => listeners.set(name, action);
  const requests = [], opened = [], decisions = [];
  const context = {
    window: {}, document, setTimeout, clearTimeout, console,
    state: { projectRoot: 'C:\\project', permissionMode: 'supervised', conversations: [], agentConversations: [] },
    HIST: { chat: { store: 'conversations' }, agents: { store: 'agentConversations' } },
    customConfirm: async () => true, renderHistory() {},
    loadConversation: async (kind, id) => opened.push({ kind, id }),
    deleteConversation: async (kind, id) => requests.push({ method: 'DELETE', path: `/api/conversations/${id}?kind=${kind}` }),
    handleRustInteractiveEvent: async event => decisions.push(event),
    fetch: async (url, options = {}) => {
      const request = { path: url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request); const result = await api(request);
      return { ok: !result?.error, status: result?.error ? 400 : 200, json: async () => result };
    },
  };
  vm.createContext(context);
  for (const file of ['collaboration-ui.js', ...files]) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../interface/script', file), 'utf8'), context, { filename: file });
  return { context, document, requests, opened, decisions,
    all: () => walk(document.body),
    button(label) { return walk(document.body).find(el => el.tagName === 'BUTTON' && el.textContent === label); },
    input(label) { return walk(document.body).find(el => el.tagName === 'LABEL' && el._text === label)?.children[0]; },
    form() { return walk(document.body).find(el => el.tagName === 'FORM'); },
  };
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }
module.exports = { frontend, settle };
