/* Virtual machine panel. Linux gets a PTY over SSH; Windows Sandbox gets a
 * persistent guest PowerShell console. Agent commands never go through
 * keyboard simulation. The panel only renders what /api/vm reports. */
(() => {
  'use strict';
  if (typeof UI_EN === 'object') Object.assign(UI_EN, {
    'Nouvelle machine': 'New machine',
    'Machines virtuelles': 'Virtual machines',
    'Un espace isolé pour tester sans toucher à votre PC.': 'An isolated space to test without touching your PC.',
    'Système': 'System',
    'Réseau': 'Network',
    'Isolé': 'Isolated',
    'Internet': 'Internet',
    'Démarrer la machine': 'Start machine',
    'Annuler': 'Cancel',
    'Démarrage': 'Starting',
    'Arrêt…': 'Stopping…',
    'Erreur': 'Error',
    'Supprimer': 'Delete',
    'Confirmer la suppression': 'Confirm deletion',
    'Repartir propre': 'Start fresh',
    'Confirmer : tout effacer': 'Confirm: erase everything',
    'Figer l’environnement': 'Save environment',
    'Récupérer': 'Retrieve',
    'Chemin du fichier dans la machine': 'File path in the machine',
    'Fichier récupéré.': 'File retrieved.',
    'Machine supprimée, disque libéré.': 'Machine deleted, disk freed.',
    'Fichiers récupérés': 'Retrieved files',
    'Les machines virtuelles ne sont pas disponibles sur cet appareil.': 'Virtual machines are not available on this device.',
    'Pack Linux absent. Consultez les réglages Machines virtuelles.': 'Linux package missing. Open Virtual machines in settings.',
    'Composants Windows à activer dans les réglages Machines virtuelles.': 'Windows components must be enabled in Virtual machines settings.',
    'Session PowerShell jetable': 'Disposable PowerShell session',
    'sans accès réseau': 'no network access',
    'accès Internet': 'Internet access',
    'Terminal de la machine indisponible :': 'Machine terminal unavailable:',
    'Machine virtuelle indisponible.': 'Virtual machine unavailable.',
    'Fermer le message': 'Dismiss message',
    'Go': 'GB'
  });
  const t = value => (typeof uiText === 'function' ? uiText(value) : value);
  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    machine: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  const STATES = { starting: 'Démarrage', ready: 'Prête', stopping: 'Arrêt…', stopped: 'Arrêtée', error: 'Erreur' };
  const BUSY = ['starting', 'stopping'];

  let pane, terminal, fit, stream = null, timer = null, resizeTimer = null, noticeTimer = null, inflight = null;
  let activeId = null, terminalId = null, attachedKey = '', tabsKey = '', themeKey = '';
  let line = '', seen = 0, busy = false, creating = false, choice = { system: '', network: 'isolated', host: '' };
  let caps = null, machines = [], hosts = [];
  const el = {};

  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  const icon = name => { const s = node('span', 'vm-icon'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`; return s; };
  const selected = () => machines.find(s => s.id === activeId) || null;
  const action = input => api('/api/vm/action', input);

  async function api(url, body) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    let value = null;
    try { value = await response.json(); } catch {}
    if (!response.ok || !value || value.error) throw new Error((value && value.error) || t('Machine virtuelle indisponible.'));
    return value;
  }

  function notify(message, isError = false) {
    clearTimeout(noticeTimer);
    el.noticeText.textContent = t(message && message.message ? message.message : String(message || ''));
    el.notice.dataset.error = String(!!isError);
    el.notice.hidden = !el.noticeText.textContent;
    if (!isError) noticeTimer = setTimeout(() => { el.notice.hidden = true; }, 6000);
  }

  // Runs a user action: the control shows it is working, a failure is said in
  // the panel, and the view is refreshed from the server either way.
  function button(label, cls, task) {
    const b = node('button', cls, t(label)); b.type = 'button'; b.dataset.label = label;
    b.addEventListener('click', async () => {
      if (b.getAttribute('aria-busy') === 'true') return;
      b.setAttribute('aria-busy', 'true'); el.notice.hidden = true;
      try { await task(b); } catch (error) { notify(error, true); }
      finally { b.removeAttribute('aria-busy'); await refresh().catch(() => {}); }
    });
    return b;
  }
  // Destructive actions ask once more, in place, instead of a system dialog.
  function confirming(label, confirmLabel, cls, task) {
    let armed = null;
    const b = button(label, cls, async () => {
      if (!armed) {
        b.textContent = t(confirmLabel); b.dataset.armed = 'true';
        armed = setTimeout(() => { armed = null; b.textContent = t(label); delete b.dataset.armed; }, 4000);
        return;
      }
      clearTimeout(armed); armed = null; b.textContent = t(label); delete b.dataset.armed;
      await task();
    });
    return b;
  }

  function terminalTheme() {
    const css = getComputedStyle(document.body), read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return { background: read('--bg-0', '#09090b'), foreground: read('--text-0', '#fafafa'), cursor: read('--accent', '#6366f1'), cursorAccent: read('--bg-0', '#09090b'), selectionBackground: read('--accent-muted', 'rgba(99,102,241,.3)') };
  }

  function mount(target) {
    if (pane) return;
    pane = target; pane.classList.add('vm-panel');

    el.tabs = node('div', 'vm-tabs'); el.tabs.setAttribute('role', 'tablist'); el.tabs.setAttribute('aria-label', t('Machines virtuelles'));
    el.add = node('button', 'vm-add'); el.add.type = 'button'; el.add.setAttribute('aria-label', t('Nouvelle machine')); el.add.title = t('Nouvelle machine'); el.add.append(icon('plus'));
    el.add.addEventListener('click', () => { creating = true; render(); el.setup.querySelector('.vm-choice:not(:disabled)')?.focus(); });
    el.bar = node('div', 'vm-bar'); el.bar.append(el.tabs, el.add);

    el.notice = node('div', 'vm-notice'); el.notice.setAttribute('role', 'status'); el.notice.hidden = true;
    el.noticeText = node('span');
    const dismiss = node('button', 'vm-notice-close'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', t('Fermer le message')); dismiss.append(icon('close'));
    dismiss.addEventListener('click', () => { el.notice.hidden = true; });
    el.notice.append(el.noticeText, dismiss);

    // New machine
    el.setup = node('section', 'vm-setup');
    el.setup.append(node('h3', '', t('Nouvelle machine')), node('p', 'vm-hint', t('Un espace isolé pour tester sans toucher à votre PC.')));
    el.systems = node('div', 'vm-choices'); el.systems.setAttribute('role', 'radiogroup'); el.systems.setAttribute('aria-label', t('Système'));
    for (const [value, label] of [['linux', 'Debian Linux'], ['windows', 'Windows Sandbox'], ['docker', 'Conteneur Docker'], ['ssh', 'Serveur SSH']]) {
      const b = node('button', 'vm-choice'); b.type = 'button'; b.dataset.system = value; b.setAttribute('role', 'radio');
      const copy = node('span', 'vm-choice-copy'); copy.append(node('strong', '', label), node('small'));
      b.append(icon('machine'), copy);
      b.addEventListener('click', () => { choice.system = value; render(); });
      el.systems.append(b);
    }
    el.networks = node('div', 'vm-segment'); el.networks.setAttribute('role', 'radiogroup'); el.networks.setAttribute('aria-label', t('Réseau'));
    for (const [value, label] of [['isolated', 'Isolé'], ['internet', 'Internet']]) {
      const b = node('button', '', t(label)); b.type = 'button'; b.dataset.network = value; b.setAttribute('role', 'radio');
      b.addEventListener('click', () => { choice.network = value; render(); });
      el.networks.append(b);
    }
    el.networkRow = node('div', 'vm-field'); el.networkRow.append(node('span', '', t('Réseau')), el.networks);
    // SSH: one of the servers registered in the settings.
    el.hostRow = node('label', 'vm-field'); el.hostSelect = node('select', 'vm-select'); el.hostSelect.id = 'vm-ssh-host';
    el.hostSelect.addEventListener('change', () => { choice.host = el.hostSelect.value; render(); });
    el.hostRow.append(node('span', '', t('Serveur')), el.hostSelect);
    el.start = button('Démarrer la machine', 'vm-primary', async () => {
      const input = { action: 'create', system: choice.system, network: choice.network };
      if (choice.system === 'ssh') input.host = choice.host;
      const result = await action(input);
      activeId = result.machine.id; creating = false;
    });
    el.cancel = node('button', 'vm-quiet', t('Annuler')); el.cancel.type = 'button';
    el.cancel.addEventListener('click', () => { creating = false; render(); });
    const setupActions = node('div', 'vm-setup-actions'); setupActions.append(el.start, el.cancel);
    el.setup.append(el.systems, el.networkRow, el.hostRow, setupActions);

    // Selected machine
    el.machine = node('section', 'vm-machine');
    el.name = node('strong'); el.meta = node('small');
    const title = node('div', 'vm-title'); title.append(el.name, el.meta);
    el.pill = node('span', 'vm-pill'); el.pillText = node('span'); el.pill.append(node('i'), el.pillText);
    const glyph = node('span', 'vm-glyph'); glyph.append(icon('machine'));
    const summary = node('div', 'vm-summary'); summary.append(glyph, title, el.pill);
    el.error = node('p', 'vm-error'); el.error.setAttribute('role', 'alert'); el.error.hidden = true;
    el.console = node('div', 'vm-console');

    el.exportForm = node('form', 'vm-export'); el.exportForm.hidden = true;
    el.exportPath = node('input'); el.exportPath.type = 'text'; el.exportPath.id = 'vm-export-path'; el.exportPath.autocomplete = 'off'; el.exportPath.spellcheck = false; el.exportPath.maxLength = 1024;
    const exportLabel = node('label', '', t('Chemin du fichier dans la machine')); exportLabel.htmlFor = 'vm-export-path';
    const exportSubmit = node('button', 'vm-primary', t('Récupérer')); exportSubmit.type = 'submit';
    const exportCancel = node('button', 'vm-quiet', t('Annuler')); exportCancel.type = 'button';
    exportCancel.addEventListener('click', () => { el.exportForm.hidden = true; el.exportToggle.focus(); });
    const exportRow = node('div', 'vm-export-row'); exportRow.append(el.exportPath, exportSubmit, exportCancel);
    el.exportForm.append(exportLabel, exportRow);
    el.exportForm.addEventListener('submit', async event => {
      event.preventDefault();
      const guestPath = el.exportPath.value.trim(); if (!guestPath || exportSubmit.disabled) return;
      exportSubmit.disabled = true;
      try { await action({ action: 'export_file', id: activeId, path: guestPath }); el.exportForm.hidden = true; el.exportPath.value = ''; notify('Fichier récupéré.'); }
      catch (error) { notify(error, true); }
      finally { exportSubmit.disabled = false; await refresh().catch(() => {}); }
    });

    el.import = button('Copier le projet', '', async () => {
      if (!state.projectRoot) throw new Error(t('Ouvrez d’abord un projet dans l’IDE.'));
      const result = await action({ action: 'import_project', id: activeId, root: state.projectRoot });
      notify(`${t(result.summary)} ${result.guestPath}`);
    });
    el.exportToggle = node('button', '', t('Récupérer un fichier')); el.exportToggle.type = 'button';
    el.exportToggle.addEventListener('click', () => { el.exportForm.hidden = !el.exportForm.hidden; if (!el.exportForm.hidden) el.exportPath.focus(); });
    el.reset = confirming('Repartir propre', 'Confirmer : tout effacer', '', async () => { const r = await action({ action: 'reset', id: activeId }); activeId = r.machine.id; });
    el.template = button('Figer l’environnement', '', async () => { const result = await action({ action: 'save_template', id: activeId }); notify(t('Environnement réutilisable : ') + result.template.name); });
    el.stop = button('Arrêter', 'vm-danger', async () => { await action({ action: 'stop', id: activeId }); });
    el.remove = confirming('Supprimer', 'Confirmer la suppression', 'vm-danger', async () => { await action({ action: 'delete', id: activeId }); activeId = null; notify('Machine supprimée, disque libéré.'); });
    el.actions = node('div', 'vm-actions'); el.actions.append(el.import, el.exportToggle, el.reset, el.template, el.stop, el.remove);

    el.results = node('div', 'vm-results'); el.results.setAttribute('aria-label', t('Fichiers récupérés'));
    const details = node('details', 'vm-activity'); details.append(node('summary', '', t('Activité de l’agent et démarrage')));
    el.activity = node('pre', 'vm-log'); details.append(el.activity);
    el.machine.append(summary, el.error, el.console, el.exportForm, el.actions, el.results, details);

    pane.append(el.bar, el.notice, el.setup, el.machine);

    themeKey = document.body.className;
    terminal = new Terminal({ fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.25, cursorBlink: true, convertEol: true, scrollback: 5000, theme: terminalTheme() });
    fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(el.console);
    new ResizeObserver(() => {
      if (!el.console.clientWidth || !el.console.clientHeight) return;
      try { fit.fit(); } catch {}
      // A drag sends many sizes: tell the guest only once it settles.
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (terminalId) api(`/api/terminal/sessions/${terminalId}/resize`, { cols: terminal.cols, rows: terminal.rows }).catch(() => {}); }, 120);
    }).observe(el.console);
    terminal.onData(async data => {
      try {
        const s = selected(); if (!s || s.status !== 'ready') return;
        if (s.system !== 'windows') { if (terminalId) await api(`/api/terminal/sessions/${terminalId}/input`, { data }); return; }
        if (busy) return;
        for (const char of data) {
          if (char === '\r') { const command = line; line = ''; terminal.write('\r\n'); if (command.trim()) { busy = true; try { await action({ action: 'exec', id: activeId, command }); await refresh(); } finally { busy = false; } } }
          else if (char === '\u007f') { if (line.length) { line = line.slice(0, -1); terminal.write('\b \b'); } }
          else if (char === '\u0003') { line = ''; terminal.write('^C\r\n'); }
          else if (char >= ' ' && char !== '\u001b') { line += char; terminal.write(char); }
        }
      } catch (error) { notify(error, true); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  // Appends only what the server logged since the last write. `outputEnd` is a
  // running total, so this stays right once the buffer drops its oldest part.
  function writeDelta(s) {
    const output = String(s.output || ''), end = Number(s.outputEnd) || output.length;
    if (end < seen) { terminal.reset(); seen = 0; }
    const fresh = end - seen;
    if (fresh > 0) terminal.write(fresh >= output.length ? output : output.slice(-fresh));
    seen = end;
  }

  async function attach(s) {
    if (stream) { stream.close(); stream = null; }
    terminalId = null; line = ''; seen = 0; terminal.reset();
    if (s.system === 'windows' || s.status !== 'ready') { writeDelta(s); return; }
    let snap;
    try { snap = await api(`/api/vm/${s.id}/terminal`, {}); if (!snap.id || typeof snap.output !== 'string') throw new Error(t('Machine virtuelle indisponible.')); }
    catch (error) { writeDelta(s); notify(`${t('Terminal de la machine indisponible :')} ${error.message}`, true); return; }
    if (activeId !== s.id) return;
    terminalId = snap.id; terminal.reset(); terminal.write(snap.output);
    const source = new EventSource(`/api/terminal/sessions/${terminalId}/stream`); stream = source;
    source.addEventListener('snapshot', event => { if (stream !== source) return; const value = JSON.parse(event.data); terminal.reset(); terminal.write(value.output); });
    source.addEventListener('data', event => { if (stream === source) terminal.write(JSON.parse(event.data)); });
    source.addEventListener('exit', () => { if (stream !== source) return; terminal.write(t('\r\n[session fermée]\r\n')); source.close(); stream = null; });
    try { fit.fit(); } catch {}
  }

  function systemState(value) {
    if (!caps) return { ready: false, note: t('Les machines virtuelles ne sont pas disponibles sur cet appareil.') };
    if (value === 'linux') {
      const linux = caps.linux || {};
      if (linux.available) return { ready: true, note: linux.image || 'Debian' };
      return { ready: false, note: t(linux.bundled ? 'Composants Windows à activer dans les réglages Machines virtuelles.' : 'Pack Linux absent. Consultez les réglages Machines virtuelles.') };
    }
    if (value === 'docker') { const docker = caps.docker || {}; return { ready: !!docker.available, note: t(docker.available ? 'Conteneur jetable, aucun dossier partagé' : docker.reason || 'Docker non détecté.') }; }
    if (value === 'ssh') {
      const usable = hosts.filter(h => h.verified);
      if (!(caps.ssh || {}).available) return { ready: false, note: t((caps.ssh || {}).reason || 'Client OpenSSH absent.') };
      return { ready: usable.length > 0, note: usable.length ? `${usable.length} ${t('serveur(s) vérifié(s)')}` : t('Ajoutez un serveur dans les réglages Machines virtuelles.') };
    }
    const windows = caps.windows || {}, ready = !!(windows.compatible && windows.enabled && windows.cli);
    return { ready, note: ready ? t('Session PowerShell jetable') : t(windows.reason || '') };
  }

  function render() {
    if (document.body.className !== themeKey) { themeKey = document.body.className; terminal.options.theme = terminalTheme(); }
    const s = selected(), showSetup = creating || !s;

    const key = machines.map(m => `${m.id}:${m.name}:${m.status}`).join('|') + '#' + activeId + '#' + showSetup;
    if (key !== tabsKey) {
      tabsKey = key; const focused = el.tabs.contains(document.activeElement) ? document.activeElement.dataset.id : null;
      el.tabs.replaceChildren();
      for (const m of machines) {
        const b = node('button', 'vm-tab'); b.type = 'button'; b.dataset.id = m.id; b.dataset.state = m.status;
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(m.id === activeId && !showSetup));
        b.append(node('i'), node('span', '', m.name));
        b.addEventListener('click', () => { activeId = m.id; creating = false; render(); syncConsole(m).catch(error => notify(error, true)); });
        el.tabs.append(b); if (focused === m.id) b.focus();
      }
    }
    el.bar.hidden = !machines.length;
    el.setup.hidden = !showSetup; el.machine.hidden = showSetup;

    // New machine form
    const states = { linux: systemState('linux'), windows: systemState('windows'), docker: systemState('docker'), ssh: systemState('ssh') };
    if (!states[choice.system]?.ready) choice.system = ['linux', 'windows', 'docker', 'ssh'].find(name => states[name].ready) || '';
    for (const b of el.systems.children) {
      const info = states[b.dataset.system];
      b.disabled = !info.ready; b.setAttribute('aria-checked', String(choice.system === b.dataset.system));
      b.querySelector('small').textContent = info.note;
    }
    for (const b of el.networks.children) b.setAttribute('aria-checked', String(choice.network === b.dataset.network));
    const verified = hosts.filter(h => h.verified);
    if (el.hostSelect.dataset.key !== verified.map(h => h.id).join(',')) {
      el.hostSelect.dataset.key = verified.map(h => h.id).join(',');
      el.hostSelect.replaceChildren(...verified.map(h => { const o = node('option', '', `${h.name} · ${h.user}@${h.host}`); o.value = h.id; return o; }));
    }
    if (!verified.some(h => h.id === choice.host)) choice.host = verified[0]?.id || '';
    el.hostSelect.value = choice.host;
    el.hostRow.hidden = choice.system !== 'ssh';
    el.networkRow.hidden = choice.system === 'ssh';
    el.start.disabled = !choice.system || (choice.system === 'ssh' && !choice.host); el.cancel.hidden = !machines.length;
    if (!s) return;

    // Selected machine
    el.name.textContent = s.name;
    const reach = s.network === 'remote' ? 'serveur distant' : s.network === 'isolated' ? 'sans accès réseau' : 'accès Internet';
    el.meta.textContent = `${s.system === 'ssh' ? '' : s.memoryMB / 1024 + ' ' + t('Go') + ' · '}${['linux', 'docker'].includes(s.system) ? s.cpus + ' CPU · ' : ''}${t(reach)}`;
    el.pill.dataset.state = s.status; el.pillText.textContent = t(STATES[s.status] || s.status);
    el.error.hidden = !s.error; el.error.textContent = s.error ? t(s.error) : '';
    const ready = s.status === 'ready', ended = s.status === 'stopped' || s.status === 'error';
    el.import.disabled = el.exportToggle.disabled = !ready;
    if (!ready) el.exportForm.hidden = true;
    el.reset.disabled = BUSY.includes(s.status);
    el.template.hidden = s.system !== 'linux'; el.template.disabled = !ready;
    el.stop.hidden = ended; el.stop.disabled = s.status === 'stopping';
    el.remove.hidden = !ended;
    const artifacts = s.artifacts || [];
    if (el.results.childElementCount !== artifacts.length) {
      el.results.replaceChildren();
      for (const a of artifacts) { const link = node('a', '', a.name); link.href = `/api/vm/${s.id}/artifacts/${a.id}`; link.download = a.name; el.results.append(link); }
    }
    el.results.hidden = !artifacts.length;
    if (el.activity.textContent !== s.output) { const pinned = el.activity.scrollTop + el.activity.clientHeight >= el.activity.scrollHeight - 8; el.activity.textContent = s.output; if (pinned) el.activity.scrollTop = el.activity.scrollHeight; }
  }

  async function syncConsole(s) {
    const key = s.id + ':' + s.status;
    if (attachedKey !== key) { attachedKey = key; await attach(s); }
    else if (s.system === 'windows' || s.status !== 'ready') writeDelta(s);
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const result = await api('/api/vm');
      caps = result.capabilities || null; machines = Array.isArray(result.machines) ? result.machines : [];
      try { hosts = (await api('/api/vm/ssh-hosts')).hosts || []; } catch { hosts = []; }
      if (!machines.some(m => m.id === activeId)) activeId = machines.length ? machines[machines.length - 1].id : null;
      render();
      const s = selected(); if (s && !creating) await syncConsole(s);
    })().finally(() => { inflight = null; });
    return inflight;
  }

  // Quick while a machine starts or stops, calm otherwise, silent when hidden.
  async function tick() {
    clearTimeout(timer);
    if (pane && pane.isConnected && !pane.hidden && !document.hidden) { try { await refresh(); } catch (error) { caps = caps || null; render(); notify(error, true); } }
    clearTimeout(timer);
    timer = setTimeout(tick, machines.some(m => BUSY.includes(m.status)) ? 1200 : 4000);
  }

  async function settings() {
    const target = document.getElementById('vm-settings-content'); if (!target) return;
    target.replaceChildren(node('p', 'vm-settings-loading', t('Vérification des machines virtuelles…'))); target.className = 'vm-settings';
    const settingButton = (label, task) => { const b = node('button', '', label); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await task(); } catch (error) { target.append(Object.assign(node('p', 'vm-error', t(error.message)), { role: 'alert' })); } finally { b.disabled = false; } }); return b; };
    try {
      const result = await api('/api/vm'); const c = result.capabilities;
      if (!c) throw new Error(t('Les machines virtuelles ne sont pas disponibles sur cet appareil.'));
      target.replaceChildren();
      for (const [name, body] of [[t('Linux intégré'), `${c.linux.image} · ${(c.linux.imageBytes / 1024 / 1024).toFixed(0)} Mo. ${c.linux.bundled ? t('Pack présent.') : 'Pack manquant.'} ${t('Accélération WHPX requise. Jusqu’à trois VM ; disque logique de 24 Go, espace utilisé progressivement.')}`], ['Windows Sandbox', t(c.windows.reason)]]) {
        const card = node('article'); card.append(node('h4', '', name), node('p', '', body));
        if (name === 'Windows Sandbox' && c.windows.compatible && !c.windows.enabled) card.append(settingButton(t('Activer Windows Sandbox'), async () => { card.append(node('p', '', t('Autorisez la demande administrateur Windows…'))); const value = await api('/api/vm/activate-sandbox', {}); await settings(); if (value.restartNeeded) document.getElementById('vm-settings-content')?.append(node('p', '', t('Activation terminée. Redémarrez Windows pour utiliser Sandbox.'))); }));
        if (name === t('Linux intégré')) { card.append(node('p', '', `${t('Accélération Windows :')} ${c.linux.accelerationEnabled ? t('activée') : t('désactivée')} · client SSH : ${c.linux.sshAvailable ? t('présent') : 'absent'}.`)); if (c.linux.compatible && (!c.linux.accelerationEnabled || !c.linux.sshAvailable)) card.append(settingButton(t('Activer les composants Linux'), async () => { const value = await api('/api/vm/activate-linux', {}); await settings(); if (value.restartNeeded) document.getElementById('vm-settings-content')?.append(node('p', '', t('Redémarrez Windows pour activer l’accélération Linux.'))); })); }
        target.append(card);
      }
      // Docker.
      const docker = node('article'); docker.append(node('h4', '', 'Docker'), node('p', '', t(c.docker?.reason || 'Docker non détecté.')));
      target.append(docker);
      // SSH servers: registered and verified by the user only.
      const ssh = node('article'); ssh.append(node('h4', '', t('Serveurs SSH')), node('p', '', t('L’agent peut seulement choisir un serveur vérifié ici ; chaque commande y suit les règles de commandes du PC. L’empreinte du serveur est enregistrée au premier test.')));
      for (const h of (await api('/api/vm/ssh-hosts')).hosts || []) {
        const row = node('div', 'vm-host-row'); row.append(node('span', '', `${h.name} · ${h.user}@${h.host}:${h.port} · ${h.verified ? t('vérifié') + (h.system ? ' (' + h.system + ')' : '') : t('non vérifié')}`));
        row.append(settingButton(t(h.verified ? 'Retester' : 'Tester et vérifier'), async () => { await api(`/api/vm/ssh-hosts/${h.id}/verify`, {}); await settings(); }));
        row.append(settingButton(t('Retirer'), async () => { await fetch(`/api/vm/ssh-hosts/${h.id}`, { method: 'DELETE' }); await settings(); }));
        ssh.append(row);
      }
      const form = node('form', 'vm-host-form');
      const field = (name, label, placeholder, type = 'text') => { const input = node('input'); input.name = name; input.type = type; input.placeholder = placeholder; input.setAttribute('aria-label', t(label)); input.required = name !== 'port'; return input; };
      form.append(field('name', 'Nom', t('Nom')), field('host', 'Adresse', 'serveur.exemple.fr'), field('port', 'Port', '22', 'number'), field('user', 'Utilisateur', 'deploy'), field('identityFile', 'Clé privée', 'C:\\Users\\…\\.ssh\\id_ed25519'));
      const add = node('button', '', t('Ajouter le serveur')); add.type = 'submit'; form.append(add);
      form.addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); try { const answer = await fetch('/api/vm/ssh-hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const value = await answer.json(); if (!answer.ok) throw new Error(value.error); await settings(); } catch (error) { form.append(Object.assign(node('p', 'vm-error', t(error.message)), { role: 'alert' })); } });
      ssh.append(form); target.append(ssh);
      const templates = await api('/api/vm/action', { action: 'templates' });
      if (templates.templates.length) { const card = node('article'); card.append(node('h4', '', t('Environnements Linux préparés'))); for (const item of templates.templates) card.append(node('p', '', `${item.name} · ${(item.bytes / 1024 / 1024).toFixed(0)} Mo · templateId : ${item.id}`)); target.append(card); }
      await window.ZaalisLaboratory?.mount(target);
      target.append(node('p', '', t('Les VM sont autonomes. Le projet est copié sur demande ; vos fichiers locaux restent séparés. Aucun dossier personnel ni presse-papiers n’est partagé. Windows : console PowerShell persistante, sans applications interactives en plein écran.')));
    } catch (error) { target.textContent = t(error.message); }
  }

  window.ZaalisVM = { open: async target => { mount(target); await tick(); }, settings };
})();
