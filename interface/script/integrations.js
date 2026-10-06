(() => {
 'use strict';
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 async function api(url,body){const r=await fetch(url,{credentials:'include',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Intégration indisponible');return d;}
 let revision=0;
 async function settings(){
  const version=++revision,target=document.getElementById('integrations-content');if(!target)return;target.replaceChildren();
  const notice=node('p','Chargement des intégrations…','lab-note');notice.setAttribute('role','status');target.append(notice);
  try{
   let status=await api('/api/integrations/github');if(version!==revision)return;
   const card=node('article',undefined,'integration-card'),header=node('div',undefined,'integration-heading');header.append(node('strong','GitHub'),node('span',status.connected?'Connecté · @'+status.login:'Non connecté','integration-status'));card.append(header);
   card.append(node('p','Dépôts, fichiers et pull requests pour l’IA. Chaque dépôt exige une autorisation explicite ; le mode autonome respecte cette limite.','lab-note'));
   const actions=node('div',undefined,'lab-toolbar');card.append(actions);target.append(card);
   const button=(text,fn,parent=actions)=>{const b=node('button',text,'integration-button');b.type='button';parent.append(b);b.addEventListener('click',async()=>{b.disabled=true;notice.textContent='Opération en cours…';try{await fn();}catch(e){notice.textContent=e.message;notice.classList.add('error');}finally{b.disabled=false;}});return b;};
   if(!status.connected){
    const label=node('label','Jeton GitHub à permissions fines','lab-field'),token=node('input');token.type='password';token.autocomplete='off';token.placeholder='github_pat_…';label.append(token);card.append(label);
    card.append(node('p','Choisissez les dépôts dans GitHub et accordez Contents en lecture (ou écriture), ainsi que Pull requests si nécessaire. Le jeton est chiffré sur ce PC et n’est jamais stocké dans le navigateur.','lab-note'));
    const docs=node('a','Créer un jeton sur GitHub');docs.href='https://github.com/settings/personal-access-tokens/new';docs.target='_blank';docs.rel='noopener noreferrer';card.append(docs);
    button('Connecter le compte',async()=>{const value=token.value;token.value='';await api('/api/integrations/github',{action:'connect',token:value});await settings();});
    if(status.deviceAvailable){button('Se connecter avec le navigateur',async()=>{const d=await api('/api/integrations/github',{action:'start'});notice.textContent=`Ouvrez GitHub et saisissez le code ${d.code}.`;const link=node('a','Autoriser zaalis sur GitHub');link.href=d.url;link.target='_blank';link.rel='noopener noreferrer';card.append(link);button('J’ai autorisé le compte',async()=>{const r=await api('/api/integrations/github',{action:'poll'});if(r.pending){notice.textContent='Autorisation en attente. Réessayez après quelques secondes.';return;}await settings();});});}
    else card.append(node('p','Connexion navigateur : disponible après configuration d’une application GitHub avec le device flow.','lab-note'));
   }else{
    button('Déconnecter',async()=>{await api('/api/integrations/github',{action:'disconnect'});await settings();});
    const search=node('input');search.type='search';search.placeholder='Filtrer les dépôts…';search.setAttribute('aria-label','Filtrer les dépôts GitHub');search.className='integration-search';card.append(search);
    const list=node('div',undefined,'integration-repos');card.append(list);
    async function load(){notice.textContent='Chargement des dépôts autorisés par GitHub…';const result=await api('/api/integrations/github/repos');if(version!==revision)return;list.replaceChildren();
     const render=()=>{list.replaceChildren();const repos=result.repositories.filter(r=>r.name.toLowerCase().includes(search.value.toLowerCase()));
      if(!repos.length)list.append(node('p','Aucun dépôt visible. Vérifiez les dépôts sélectionnés, les droits du jeton et l’autorisation de votre organisation.','lab-note'));
      for(const repo of repos){const grant=status.permissions[repo.name.toLowerCase()]||{},row=node('details',undefined,'integration-repo'),summary=node('summary',repo.name+(repo.private?' · privé':'')+' · '+({read:'Lecture seule',write:'Lecture et écriture'}[grant.mode]||'Non autorisé'));row.append(summary);
       const rootLabel=node('label','Dossier local associé','lab-field'),root=node('input');root.value=grant.root||state.projectRoot||'';root.placeholder='Racine du dépôt sur ce PC';rootLabel.append(root);row.append(rootLabel);
       const choose=node('div',undefined,'lab-toolbar');row.append(choose);button('Utiliser le projet actif',async()=>{root.value=state.projectRoot||'';notice.textContent=root.value?'Projet sélectionné. Enregistrez ensuite le droit.':'Ouvrez un projet dans l’IDE.';},choose);
       const label=node('label','Droits de l’IA','lab-field'),select=node('select');for(const [value,text] of [['none','Aucun accès'],['read','Lecture seule'],['write','Lecture et écriture']]){const option=node('option',text);option.value=value;option.disabled=value==='write'&&!repo.canPush;select.append(option);}select.value=grant.mode||'none';label.append(select);row.append(label);
       row.append(node('p','L’écriture exige le même dépôt origin et un dossier vérifié. Changer les droits interrompt les agents en cours. La lecture seule bloque aussi les modifications locales de l’IA pour ce projet.','lab-note'));
       button('Enregistrer les droits',async()=>{status=await api('/api/integrations/github',{action:'permission',repo:repo.name,mode:select.value,root:root.value.trim()});notice.textContent='Droits enregistrés. Les agents précédents ont été arrêtés.';render();},row);list.append(row);
      }
     };search.oninput=render;render();notice.textContent=`${result.repositories.length} dépôt(s) visible(s).${result.truncated?' Liste limitée à 10 000 dépôts.':''}`;
    }
    button('Actualiser les dépôts',load);await load();
   }
   const more=node('div',undefined,'integration-related');more.append(node('h4','Autres intégrations de l’IA'));
   for(const [title,description,section] of [['MCP','Vos serveurs et outils personnels','mcp'],['Blender','Création et inspection de scènes 3D','mcp'],['Opale','Connexion au projet Opale','mcp'],['Machines virtuelles','Expériences isolées et preuves de tests','vm']]){const entry=node('article');entry.append(node('strong',title),node('p',description,'lab-note'));button('Configurer',async()=>setSettingsSection(section),entry);more.append(entry);}target.append(more);
   if(!status.connected)notice.textContent='Choisissez une méthode de connexion.';
  }catch(e){notice.textContent=e.message;notice.classList.add('error');}
 }
 window.ZaalisIntegrations={settings};
})();
