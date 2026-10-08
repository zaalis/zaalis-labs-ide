(() => {
 'use strict';
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 async function api(url,body){const r=await fetch(url,{credentials:'include',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||uiText('Intégration indisponible'));return d;}
 let revision=0, page='overview';
 async function settings(next=page){
  page=next;
  const version=++revision,target=document.getElementById('integrations-content');if(!target)return;target.replaceChildren();
  if(page==='overview'){
   const intro=node('div',undefined,'integrations-intro');intro.append(node('span',uiText('VOTRE ESPACE CONNECTÉ'),'integration-eyebrow'),node('h3',uiText('Vos outils, au même endroit')),node('p',uiText('Connectez vos comptes pour travailler sur vos dépôts et continuer vos projets dans votre messagerie.')));target.append(intro);
   const grid=node('div',undefined,'integrations-grid');
   for(const [id,name,description,tag] of [['github','GitHub','Dépôts, fichiers et pull requests','Développement'],['whatsapp','WhatsApp','Continuez vos projets et conversations depuis WhatsApp sur votre téléphone.','Messagerie personnelle'],['telegram','Telegram','Retrouvez vos projets et conversations de l’IDE dans votre bot privé.','Messagerie privée']]){
    const tile=node('button',undefined,'integration-tile');tile.type='button';tile.dataset.integration=id;tile.setAttribute('aria-label',uiText('Ouvrir '+name));
    const mark=node('span',undefined,'integration-brand '+id),image=node('img');image.src='assets/integrations/'+id+'.svg';image.alt='';mark.append(image);
    const copy=node('span',undefined,'integration-tile-copy');copy.append(node('span',uiText(tag),'integration-eyebrow'),node('strong',name),node('span',uiText(description)),node('span',uiText('Configurer la connexion')+' →','integration-tile-cta'));
    tile.append(mark,copy);tile.onclick=()=>settings(id);grid.append(tile);
   }
   target.append(grid,node('p',uiText('Vos connexions restent sur ce PC. Gardez Zaalis ouvert pour recevoir les réponses dans vos messageries.'),'integration-footnote'));return;
  }
  if(page==='whatsapp'||page==='telegram'){await window.ZaalisMessengers.mount(page,target,()=>settings('overview'));return;}

  const back=node('button',uiText('← Retour aux intégrations'),'integration-back');back.type='button';back.onclick=()=>settings('overview');target.append(back);
  const notice=node('p',uiText('Chargement des intégrations…'),'lab-note');notice.setAttribute('role','status');target.append(notice);
  try{
   let status=await api('/api/integrations/github');if(version!==revision)return;
   const card=node('article',undefined,'integration-card'),header=node('div',undefined,'integration-heading');const mark=node('img',undefined,'integration-heading-logo');mark.src='assets/integrations/github.svg';mark.alt='';header.append(mark,node('strong','GitHub'),node('span',status.reauth?uiText('Reconnexion nécessaire'):status.connected?uiText('Connecté · @')+status.login:uiText('Non connecté'),'integration-status'));card.append(header);
   if(status.reauth){const warn=node('p',uiText('L’autorisation GitHub de @')+status.login+uiText(' a expiré ou a été révoquée. Reconnectez le compte : vos droits par dépôt sont conservés.'),'integration-notice error');card.append(warn);}
   card.append(node('p',uiText('Dépôts, fichiers et pull requests pour l’IA. Chaque dépôt exige une autorisation explicite ; le mode autonome respecte cette limite.'),'lab-note'));
   const actions=node('div',undefined,'lab-toolbar');card.append(actions);target.append(card);
   const button=(text,fn,parent=actions)=>{const b=node('button',text,'integration-button');b.type='button';parent.append(b);b.addEventListener('click',async()=>{b.disabled=true;notice.classList.remove('success','error');notice.textContent=uiText('Opération en cours…');try{await fn();}catch(e){notice.textContent=uiText(e.message);notice.classList.add('error');}finally{b.disabled=false;}});return b;};
   if(!status.connected||status.reauth){
    const connect=button(status.reauth?uiText('Reconnecter le compte'):uiText('Connecter le compte'),async()=>{
     if(!status.deviceAvailable){notice.textContent=uiText('Le client de connexion GitHub est manquant. Réinstallez la dernière version de Zaalis.');return;}
     const d=await api('/api/integrations/github',{action:'start'});
     const authorization=node('div',undefined,'github-authorization');authorization.setAttribute('role','status');
     authorization.append(node('p',uiText('Validez la connexion dans votre navigateur, puis revenez ici.')),node('strong',d.code,'github-device-code'));card.append(authorization);
     authorization.append(node('p',uiText('Sur la page GitHub, saisissez ce code puis autorisez la connexion.')));
     button(uiText('Copier le code'),async()=>{await navigator.clipboard.writeText(d.code);notice.textContent=uiText('Code copié. Vous pouvez le coller sur GitHub.');},authorization);
     // The code is copied right away: on GitHub the user only has to paste it.
     let copied=false;try{await navigator.clipboard.writeText(d.code);copied=true;}catch{}
     const countdown=node('p','', 'github-countdown');authorization.append(countdown);
     const tick=()=>{const left=Math.max(0,Math.round((deadline-Date.now())/1000));countdown.textContent=uiText('Code valable encore ')+`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;};
     notice.textContent=copied?uiText('Code copié ✓ Collez-le sur la page GitHub ouverte dans votre navigateur.'):uiText('Autorisation GitHub en attente…');
     connect.hidden=true;
     button(uiText('Rouvrir GitHub dans le navigateur'),async()=>{await api('/api/integrations/github',{action:'open'});},authorization);
     let stopped=false,timer,clock;const stop=()=>{stopped=true;clearTimeout(timer);clearInterval(clock);observer.disconnect();connect.hidden=false;authorization.remove();};
     const observer=new MutationObserver(()=>{if(!card.isConnected||!document.getElementById('settings-modal').classList.contains('active'))stop();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
     button(uiText('Annuler'),async()=>{stop();await api('/api/integrations/github',{action:'cancel'});notice.textContent=uiText('Connexion annulée.');},authorization);
     const deadline=Date.now()+d.expiresIn*1000;tick();clock=setInterval(tick,1000);
     const poll=async()=>{if(stopped)return;try{if(Date.now()>deadline)throw Error(uiText('Connexion expirée. Recommencez.'));const r=await api('/api/integrations/github',{action:'poll'});if(stopped)return;if(r.pending){timer=setTimeout(poll,(r.interval||d.interval)*1000);}else{stop();await settings();}}catch(e){stop();notice.textContent=uiText(e.message);}};
     timer=setTimeout(poll,d.interval*1000);
    });
    card.append(node('p',uiText('La connexion s’ouvre dans le navigateur par défaut de Windows. Aucun jeton à copier.'),'lab-note'));
    card.append(node('p',uiText('L’autorisation est présentée par le client officiel GitHub CLI. Les dépôts restent soumis aux droits que vous choisissez ici.'),'lab-note'));
   }
   if(status.connected){
    button(uiText('Déconnecter'),async()=>{await api('/api/integrations/github',{action:'disconnect'});await settings();});
    const search=node('input');search.type='search';search.placeholder=uiText('Filtrer les dépôts…');search.setAttribute('aria-label',uiText('Filtrer les dépôts GitHub'));search.className='integration-search';card.append(search);
    const list=node('div',undefined,'integration-repos');card.append(list);
    async function load(){if(status.reauth){notice.textContent=uiText('Reconnectez GitHub pour afficher vos dépôts.');return;}notice.textContent=uiText('Chargement des dépôts autorisés par GitHub…');const result=await api('/api/integrations/github/repos');if(version!==revision)return;list.replaceChildren();
     const render=()=>{list.querySelectorAll('select').forEach(s=>s._customSelectCleanup?.());list.replaceChildren();const repos=result.repositories.filter(r=>r.name.toLowerCase().includes(search.value.toLowerCase()));
      if(!repos.length)list.append(node('p',uiText('Aucun dépôt visible. Vérifiez les dépôts sélectionnés, les droits du jeton et l’autorisation de votre organisation.'),'lab-note'));
      for(const repo of repos){const grant=status.permissions[repo.name.toLowerCase()]||{},row=node('details',undefined,'integration-repo'),summary=node('summary',repo.name+(repo.private?uiText(' · privé'):'')+' · '+({read:uiText('Lecture seule'),write:uiText('Lecture et écriture')}[grant.mode]||uiText('Non autorisé')));row.append(summary);
       const content=node('div',undefined,'integration-repo-content');row.append(content);
       const rootLabel=node('label',uiText('Dossier local associé'),'lab-field'),root=node('input');root.value=grant.root||state.projectRoot||'';root.placeholder='C:\\Projets\\MonProjet';rootLabel.append(root);content.append(rootLabel);content.append(node('p',state.language==='en'?'The folder where this repository is cloned on this PC, containing .git. Example: C:\\Projets\\MonProjet. Use your actual folder path.':'Le dossier où ce dépôt est cloné sur ce PC, contenant .git. Exemple : C:\\Projets\\MonProjet. Indiquez le chemin de votre dossier.','lab-note integration-folder-help'));
       const choose=node('div',undefined,'lab-toolbar integration-project-actions');content.append(choose);button(uiText('Utiliser le projet actif'),async()=>{root.value=state.projectRoot||'';feedback.hidden=true;notice.textContent=root.value?uiText('Projet sélectionné. Enregistrez ensuite le droit.'):uiText('Ouvrez un projet dans l’IDE.');},choose);
       const label=node('label',uiText('Droits de l’IA'),'lab-field'),select=node('select');select.id='github-permission-'+String(repo.id || repos.indexOf(repo));for(const [value,text] of [['none',uiText('Aucun accès')],['read',uiText('Lecture seule')],['write',uiText('Lecture et écriture')]]){const option=node('option',text);option.value=value;option.disabled=value==='write'&&!repo.canPush;select.append(option);}select.value=grant.mode||'none';label.append(select);content.append(label);
       content.append(node('p',uiText('L’écriture exige le même dépôt origin et un dossier vérifié. Changer les droits interrompt les agents en cours. La lecture seule bloque aussi les modifications locales de l’IA pour ce projet.'),'lab-note'));
       const feedback=node('p','','integration-notice success');feedback.setAttribute('role','status');feedback.hidden=true;content.append(feedback);root.oninput=select.onchange=()=>{feedback.hidden=true;};button(uiText('Enregistrer les droits'),async()=>{feedback.hidden=true;status=await api('/api/integrations/github',{action:'permission',repo:repo.name,mode:select.value,root:root.value.trim()});notice.textContent='✓ '+uiText('Droits enregistrés. Les agents précédents ont été arrêtés.');notice.classList.add('success');feedback.textContent=state.language==='en'?'✓ Permissions saved':'✓ Droits enregistrés';feedback.hidden=false;summary.textContent=repo.name+' · '+select.selectedOptions[0].textContent;},content);list.append(row);createCustomSelect(select.id,{dropDown:true,viewport:true,label:uiText('Droits de l’IA')});
      }
     };search.oninput=render;render();notice.textContent=`${result.repositories.length} dépôt(s) visible(s).${result.truncated?uiText(' Liste limitée à 10 000 dépôts.'):''}`;
    }
    button(uiText('Actualiser les dépôts'),load);await load();
   }
   if(!status.connected)notice.textContent=uiText('Connectez GitHub pour choisir les dépôts accessibles à vos IA.');
  }catch(e){notice.textContent=e.message;notice.classList.add('error');}
 }
 window.ZaalisIntegrations={settings};
})();
