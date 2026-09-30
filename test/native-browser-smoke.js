'use strict';

// Run only against a deliberately started local zaalis.exe with WebView2 CDP
// enabled on 9222. It reads UI state and restores the prior layout.
const timeout = ms => new Promise((_, reject) => setTimeout(() => reject(new Error('CDP timeout')), ms));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = targets.find(target => target.type === 'page' && target.url.startsWith('http://localhost:3000/'));
  if (!page) throw new Error('Fenêtre principale introuvable dans WebView2.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }), timeout(5000)]);
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  };
  const evaluate = async expression => {
    const next = ++id;
    const done = new Promise(resolve => pending.set(next, resolve));
    socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    const result = await Promise.race([done, timeout(5000)]);
    if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result.error || result.result.exceptionDetails));
    return result.result?.result?.value;
  };
  const previous = await evaluate(`(() => ({
    mode: window.ZaalisWorkspace?.mode,
    panel: document.querySelector('.ws-rail-button[aria-expanded="true"]')?.getAttribute('aria-controls')?.replace('ws-pane-', '') || null,
    authHidden: document.querySelector('#auth-overlay')?.classList.contains('hidden'),
    workspace: !!window.ZaalisWorkspace
  }))()`);
  if (!previous.workspace) throw new Error('Workspace indisponible.');
  try {
    await evaluate(`(() => { document.querySelector('#auth-overlay').classList.add('hidden'); document.querySelector('#app').style.display=''; window.ZaalisWorkspace.setMode('chat'); window.ZaalisWorkspace.setPanel('browser'); return true; })()`);
    await sleep(5000);
    const observed = await evaluate(`(() => ({
      mode: window.ZaalisWorkspace.mode,
      pane: !document.querySelector('#ws-pane-browser').hidden,
      fallbackHidden: document.querySelector('#ws-browser-host .ws-empty-state')?.hidden,
      hostWidth: Math.round(document.querySelector('#ws-browser-host').getBoundingClientRect().width),
      hostHeight: Math.round(document.querySelector('#ws-browser-host').getBoundingClientRect().height)
    }))()`);
    const browser = await evaluate(`new Promise(resolve => {
      const handler = event => {
        if (event.data?.type !== 'browserState') return;
        window.chrome.webview.removeEventListener('message', handler);
        resolve({ ready: event.data.ready, visible: event.data.visible, tabs: event.data.tabs?.length, error: event.data.error || '' });
      };
      window.chrome.webview.addEventListener('message', handler);
      window.chrome.webview.postMessage({ type: 'browser', action: 'state' });
      setTimeout(() => resolve({ error: 'Aucun état navigateur reçu' }), 3000);
    })`);
    if (observed.mode !== 'chat' || !observed.pane || !observed.fallbackHidden || observed.hostWidth < 100 || observed.hostHeight < 100 || !browser.ready || !browser.visible || browser.tabs < 1 || browser.error) {
      throw new Error(`Navigateur natif non confirmé: ${JSON.stringify(observed)}`);
    }
    process.stdout.write(JSON.stringify({ nativeBrowser: 'visible', ...observed, browser }) + '\n');
  } finally {
    await evaluate(`(() => { window.ZaalisWorkspace.setPanel(${JSON.stringify(previous.panel)}); window.ZaalisWorkspace.setMode(${JSON.stringify(previous.mode)}); if (!${previous.authHidden}) { document.querySelector('#auth-overlay').classList.remove('hidden'); document.querySelector('#app').style.display='none'; } return true; })()`);
    socket.close();
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
