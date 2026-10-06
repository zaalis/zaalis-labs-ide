/* VM terminal: a PTY over SSH for Linux; a persistent guest PowerShell console
 * for Windows Sandbox. Agent commands never go through keyboard simulation. */
(() => {
  'use strict';
  let pane, terminal, fit, stream, activeId, terminalId, timer, line = '', previousWindows = '', busy = false;
  let caps, machines = [], tabs, status, consoleNode, activity, results, system, network, createButton, stopButton, importButton, resetButton;
  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  const button = (label, action) => { const b = node('button', '', label); b.type = 'button'; b.addEventListener('click', () => action().catch(error)); return b; };
  async function api(url, body) { const response = await fetch(url, body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}); const value = await response.json(); if (!response.ok || value.error) throw new Error(value.error || 'VM indisponible'); return value; }
  function error(e) { if (status) { status.textContent = e.message || String(e); status.classList.add('error'); } }
  const selected = () => machines.find(s => s.id === activeId);
  const action = input => api('/api/vm/action', input);
  function mount(target) {
    if (pane) return;
    pane = target;
    const controls = node('div', 'vm-controls'); system = node('select'); system.setAttribute('aria-label','Système de la VM');
    for (const [value, label] of [['linux','Debian Linux'],['windows','Windows Sandbox']]) { const option = node('option','',label); option.value = value; system.append(option); }
    network = node('select'); network.setAttribute('aria-label','Réseau de la VM');
    for (const [value,label] of [['isolated','Sans accès réseau'],['internet','Internet + réseau hôte']]) { const option = node('option','',label); option.value = value; network.append(option); }
    createButton = button('Nouvelle VM', async () => { createButton.disabled = true; try { const result = await action({action:'create',system:system.value,network:network.value}); activeId=result.machine.id; await refresh(); } finally { createButton.disabled=false; } });
    controls.append(system, network, createButton); tabs = node('div','vm-tabs'); tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','Sessions VM');
    status = node('div','vm-status','Choisissez un système pour démarrer.'); status.setAttribute('role','status');
    const actions = node('div','vm-actions');
    importButton = button('Copier le projet', async () => { if (!state.projectRoot) throw new Error('Ouvrez d’abord un projet dans l’IDE.'); const result = await action({action:'import_project',id:activeId,root:state.projectRoot}); status.textContent = result.summary + ' ' + result.guestPath; });
    stopButton = button('Arrêter', async () => { await action({action:'stop',id:activeId}); await refresh(); });
    resetButton=button('Repartir propre',async()=>{const r=await action({action:'reset',id:activeId});activeId=r.machine.id;await refresh();});
    const exportButton=button('Récupérer un fichier',async()=>{const path=window.prompt('Chemin complet du fichier dans la VM (32 Mo maximum)');if(path){await action({action:'export_file',id:activeId,path});await refresh();}});
    importButton.disabled=stopButton.disabled=resetButton.disabled=true;
    const templateButton=button('Figer cet environnement Linux',async()=>{const result=await action({action:'save_template',id:activeId});status.textContent='Environnement réutilisable : '+result.template.id;await refresh();});
    actions.append(importButton,stopButton,resetButton,exportButton,templateButton); consoleNode=node('div','vm-console');results=node('div','vm-results');
    const details=node('details','vm-activity'); details.append(node('summary','','Activité de l’agent et démarrage')); activity=node('pre','vm-log'); details.append(activity);
    pane.append(controls,tabs,status,actions,consoleNode,results,details);
    terminal=new Terminal({fontFamily:'Consolas, monospace',fontSize:13,cursorBlink:true,convertEol:true,scrollback:5000,theme:{background:'#111216',foreground:'#eeeeef'}});
    fit=new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(consoleNode);
    new ResizeObserver(() => { if (consoleNode.clientWidth) { fit.fit(); if(terminalId) api(`/api/terminal/sessions/${terminalId}/resize`,{cols:terminal.cols,rows:terminal.rows}).catch(error); } }).observe(consoleNode);
    terminal.onData(async data => {
      try {
        const s=selected(); if (!s || s.status!=='ready') return;
        if(s.system==='linux') { if(terminalId) await api(`/api/terminal/sessions/${terminalId}/input`,{data}); return; }
        if(busy) return;
        for(const char of data) {
          if(char==='\r') { const command=line; line=''; terminal.write('\r\n'); if(command.trim()) { busy=true; try { await action({action:'exec',id:activeId,command}); await refresh(); } finally { busy=false; } } }
          else if(char==='\u007f') { if(line.length) {line=line.slice(0,-1);terminal.write('\b \b');} }
          else if(char==='\u0003') { line='';terminal.write('^C\r\n'); }
          else if(char>=' ' && char!=='\u001b') { line+=char;terminal.write(char); }
        }
      } catch(e) {error(e);}
    });
  }
  async function attach(s) {
    stream?.close(); stream=null; terminalId=null; line=''; previousWindows=''; terminal.reset();
    if(s.system==='windows') { terminal.write(s.output); previousWindows=s.output; return; }
    if(s.status!=='ready') {terminal.write(s.output);return;}
    const snap=await api(`/api/vm/${s.id}/terminal`,{}); if(activeId!==s.id) return;
    terminalId=snap.id; terminal.reset();terminal.write(snap.output);
    stream=new EventSource(`/api/terminal/sessions/${terminalId}/stream`);
    stream.addEventListener('snapshot',e=>{const v=JSON.parse(e.data);terminal.reset();terminal.write(v.output);});
    stream.addEventListener('data',e=>terminal.write(JSON.parse(e.data)));
    stream.addEventListener('exit',()=>terminal.write('\r\n[session fermée]\r\n'));
    fit.fit();terminal.focus();
  }
  let attachedKey='';
  async function refresh() {
    const result=await api('/api/vm'); caps=result.capabilities;machines=result.machines;
    if(!activeId && machines.length) activeId=machines[machines.length-1].id;
    tabs.replaceChildren();
    for(const s of machines) {const b=button(s.name,async()=>{activeId=s.id;await refresh();});b.setAttribute('role','tab');b.setAttribute('aria-selected',String(s.id===activeId));tabs.append(b);}
    system.querySelector('[value=windows]').disabled=!caps.windows.compatible||!caps.windows.enabled||!caps.windows.cli;
    system.querySelector('[value=linux]').disabled=!caps.linux.available;
    const s=selected();importButton.disabled=stopButton.disabled=!s||s.status!=='ready';
    stopButton.disabled=!s||['stopped'].includes(s.status);resetButton.disabled=!s||s.status==='starting';
    results.replaceChildren();for(const a of s?.artifacts||[]){const link=node('a','',a.name);link.href=`/api/vm/${s.id}/artifacts/${a.id}`;link.download=a.name;results.append(link);}
    if(!s) { status.textContent=caps.linux.available?'Prêt · sessions autonomes · 2 CPU / 2 Go par défaut':'Pack Linux absent. Consultez les paramètres Machines virtuelles.'; return; }
    status.classList.toggle('error',s.status==='error');
    const labels={starting:'Démarrage…',ready:'Prête',stopped:'Arrêtée',error:'Erreur'};
    status.textContent=`${labels[s.status]||s.status} · ${s.memoryMB/1024} Go · ${s.system==='linux'?s.cpus+' CPU · ':''}${s.network==='isolated'?'réseau désactivé':'Internet + réseau hôte'}${s.error?' · '+s.error:''}`;
    activity.textContent=s.output;activity.scrollTop=activity.scrollHeight;
    const key=s.id+':'+s.status;
    if(attachedKey!==key) {await attach(s);attachedKey=key;}
    else if(s.system==='windows') {const delta=s.output.startsWith(previousWindows)?s.output.slice(previousWindows.length):s.output;terminal.write(delta);previousWindows=s.output;}
  }
  async function settings() {
    const target=document.getElementById('vm-settings-content'); if(!target)return;
    target.replaceChildren();target.className='vm-settings';
    try {
      const result=await api('/api/vm'); const c=result.capabilities;
      for(const [name,body] of [['Linux intégré',`${c.linux.image} · ${(c.linux.imageBytes/1024/1024).toFixed(0)} Mo. ${c.linux.bundled?'Pack présent.':'Pack manquant.'} Accélération WHPX requise. Jusqu’à trois VM ; disque logique de 24 Go, espace utilisé progressivement.`],['Windows Sandbox',c.windows.reason]]) {
        const card=node('article');card.append(node('h4','',name),node('p','',body));
        if(name==='Windows Sandbox'&&c.windows.compatible&&!c.windows.enabled) card.append(button('Activer Windows Sandbox',async()=>{card.append(node('p','','Autorisez la demande administrateur Windows…'));const value=await api('/api/vm/activate-sandbox',{});await settings();if(value.restartNeeded)target.append(node('p','','Activation terminée. Redémarrez Windows pour utiliser Sandbox.'));}));
        if(name==='Linux intégré') {card.append(node('p','',`Accélération Windows : ${c.linux.accelerationEnabled?'activée':'désactivée'} · client SSH : ${c.linux.sshAvailable?'présent':'absent'}.`));if(c.linux.compatible&&(!c.linux.accelerationEnabled||!c.linux.sshAvailable))card.append(button('Activer les composants Linux',async()=>{const value=await api('/api/vm/activate-linux',{});await settings();if(value.restartNeeded)target.append(node('p','','Redémarrez Windows pour activer l’accélération Linux.'));}));}
        target.append(card);
      }
      const templates=await api('/api/vm/action',{action:'templates'});
      if(templates.templates.length){const card=node('article');card.append(node('h4','','Environnements Linux préparés'));for(const t of templates.templates)card.append(node('p','',`${t.name} · ${(t.bytes/1024/1024).toFixed(0)} Mo · templateId : ${t.id}`));target.append(card);}
      await window.ZaalisLaboratory?.mount(target);
      target.append(node('p','','Les VM sont autonomes. Le projet est copié sur demande ; vos fichiers locaux restent séparés. Aucun dossier personnel ni presse-papiers n’est partagé. Windows : console PowerShell persistante, sans applications interactives en plein écran.'));
    } catch(e) {target.textContent=e.message;}
  }
  window.ZaalisVM={open: async target=>{mount(target);await refresh().catch(error);clearInterval(timer);timer=setInterval(()=>{if(!pane.hidden)refresh().catch(error);},2000);},settings};
})();
