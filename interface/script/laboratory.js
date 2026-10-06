(() => {
 'use strict';
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error||'Service indisponible');return v;}
 const fmt=n=>new Intl.NumberFormat(state.language==='en'?'en':'fr').format(n);
 async function tokens() {
  const target=document.getElementById('tokens-content');if(!target)return;target.replaceChildren();
  const bar=el('div',undefined,'lab-toolbar'),period=el('select');period.setAttribute('aria-label','Période de consommation');
  for(const [v,label] of [['week','Semaine'],['month','Mois'],['year','Année']]){const o=el('option',label);o.value=v;period.append(o);}period.value='month';
  const date=el('input');date.type='date';const today=new Date();date.value=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;date.setAttribute('aria-label','Date de la période');
  const info=el('p',undefined,'lab-note'),content=el('div');info.setAttribute('role','status');bar.append(period,date);target.append(bar,info,content);
  let revision=0;
  async function refresh(){const version=++revision;info.classList.remove('error');info.textContent='Chargement des mesures…';try{
   const d=new Date(date.value+'T12:00:00');if(!Number.isFinite(d.getTime()))throw Error('Choisissez une date valide.');let from,to;
   if(period.value==='year'){from=new Date(d.getFullYear(),0,1);to=new Date(d.getFullYear()+1,0,1);}else if(period.value==='month'){from=new Date(d.getFullYear(),d.getMonth(),1);to=new Date(d.getFullYear(),d.getMonth()+1,1);}else{from=new Date(d.getFullYear(),d.getMonth(),d.getDate()-(d.getDay()+6)%7);to=new Date(from);to.setDate(to.getDate()+7);}
   const result=await api(`/api/usage?from=${from.getTime()}&to=${to.getTime()}`);if(version!==revision)return;content.replaceChildren();
   const t=result.total,c=result.comparison||{basis:'unavailable'},cards=el('div',undefined,'lab-metrics');
   const add=(label,value,note)=>{const card=el('article');card.append(el('span',label),el('strong',value),el('small',note));cards.append(card);};
   add('Tokens enregistrés',fmt(t.input+t.output),`${fmt(t.input)} entrée · ${fmt(t.output)} sortie, réflexion incluse`);
   add('Économie mesurée',c.percent===null||c.percent===undefined?'Indisponible':`${c.percent.toFixed(1)} %`,c.count?`${fmt(c.saved)} tokens · ${c.count} comparaisons appariées`:'Aucune référence comparable exécutée');
   add('Référence classique',c.count?fmt(c.reference):'—',c.count?`Moteur expérimental : ${fmt(c.actual)}`:'Même modèle, projet et critères requis');
   add('Qualité de la mesure',`${fmt(t.calls-t.unmeasured)} / ${fmt(t.calls)}`,`${fmt(t.unmeasured)} appel(s) sans mesure · ${fmt(t.unfinished)} incomplet(s)`);content.append(cards);
   info.textContent=`Du ${from.toLocaleDateString()} au ${new Date(to-1).toLocaleDateString()}. Mesures disponibles depuis l’installation de ce registre. Les appels sans mesure ne sont pas comptés comme gratuits.`+(c.rejected?` ${c.rejected} référence(s) invalide(s) exclue(s).`:'');
   const table=el('table',undefined,'lab-table'),head=el('thead'),hr=el('tr');for(const s of ['Modèle','Entrée','Sortie','Cache lu','Réflexion'])hr.append(el('th',s));head.append(hr);table.append(head);const body=el('tbody');
   for(const m of result.models){const row=el('tr');for(const s of [`${m.provider} · ${m.model||'défaut'}`,fmt(m.input),fmt(m.output),fmt(m.cached),fmt(m.reasoning)])row.append(el('td',s));body.append(row);}table.append(body);const scroll=el('div',undefined,'lab-table-scroll');scroll.append(table);content.append(scroll);
   content.append(el('p','Les tokens en cache et de réflexion sont des sous-catégories : ils ne s’ajoutent pas une seconde fois au total. Le coût monétaire dépend des tarifs et du type d’accès au fournisseur ; aucun prix n’est supposé.', 'lab-note'));
  }catch(e){if(version===revision){info.textContent=e.message;info.classList.add('error');}}}
  period.addEventListener('change',refresh);date.addEventListener('change',refresh);await refresh();
 }
 async function mount(target) {
  const section=el('section',undefined,'lab-section');section.append(el('h4','Laboratoire d’expériences'),el('p','Choisissez des hypothèses et des tests. Le moteur prépare des VM isolées, conserve les preuves et reteste le candidat retenu dans une nouvelle VM.','lab-note'));
  const editor=el('details'),summary=el('summary','Préparer une expérience'),form=el('form');
  const field=(title,node,parent=form)=>{const label=el('label',title,'lab-field');label.append(node);parent.append(label);return node;};
  const area=(rows,value='')=>{const n=el('textarea');n.rows=rows;n.value=value;return n;};
  const select=options=>{const n=el('select');for(const [value,title] of options){const o=el('option',title);o.value=value;n.append(o);}return n;};
  const project=field('Dossier du projet',el('input'));project.type='text';project.value=state.projectRoot||'';project.placeholder='Chemin absolu du projet sur ce PC';
  const problem=field('Objectif à vérifier',area(2,'Exemple : vérifier la présence du manifeste package.json'));
  const controls=el('div',undefined,'lab-form-grid');form.append(controls);
  const system=field('Système',select([['linux','Linux intégré'],['windows','Windows Sandbox']]),controls);
  const strategy=field('Exploration',select([['economy','Économe · une hypothèse à la fois'],['balanced','Équilibrée · jusqu’à deux en parallèle'],['deep','Approfondie · jusqu’à quatre pistes']]),controls);
  const duration=field('Durée maximale',select([['600000','10 minutes'],['300000','5 minutes'],['1200000','20 minutes']]),controls);
  const network=field('Réseau',select([['isolated','Isolé'],['internet','Internet et réseau de l’hôte']]),controls);
  const template=field('Environnement de départ',select([['','Image Linux intégrée']]),controls);
  const setup=field('Préparation commune (commandes)',area(2));setup.placeholder='Ex. : installer les dépendances avec un réseau autorisé, ou utiliser un environnement préparé.';
  form.append(el('p','Chaque hypothèse dispose de sa propre VM. Les commandes de test doivent échouer si le résultat est incorrect. Le retest final est exécuté dans une VM neuve.','lab-note'));
  const hypotheses=el('div',undefined,'lab-hypotheses');form.append(hypotheses);const entries=[];
  const add=el('button','Ajouter une hypothèse');add.type='button';
  function hypothesis(){const card=el('fieldset',undefined,'lab-hypothesis'),legend=el('legend',`Hypothèse ${entries.length+1}`),name=el('input');name.type='text';name.value=entries.length?'Nouvelle piste':'Présence du manifeste uniquement';card.append(legend);
   const label=field('Nom de la piste',name,card),changes=field('Changements à essayer (commandes)',area(2),card),command=field('Test de cette hypothèse',area(2,entries.length?'':'test -f package.json'),card),contains=field('Texte attendu dans le résultat (facultatif)',el('input'),card);
   const remove=el('button','Retirer cette hypothèse');remove.type='button';card.append(remove);const item={card,label,changes,command,contains};entries.push(item);hypotheses.append(card);
   remove.addEventListener('click',()=>{if(entries.length===1)return;entries.splice(entries.indexOf(item),1);card.remove();add.disabled=false;});add.disabled=entries.length>=4;
  }
  hypothesis();add.addEventListener('click',()=>{if(entries.length<4)hypothesis();});form.append(add);
  const final=field('Test final indépendant',area(3,'test -f package.json')),finalMarker=field('Texte attendu au retest final (facultatif)',el('input'));
  const outputs=field('Fichiers à récupérer, un chemin relatif par ligne (facultatif)',area(2));outputs.placeholder='Ex. : src/app.js';
  const guided=()=>({problem:problem.value,system:system.value,strategy:strategy.value,parallel:strategy.value==='economy'?1:2,maxMs:Number(duration.value),network:network.value,templateId:system.value==='linux'&&template.value?template.value:undefined,setup:setup.value.trim()?[setup.value]:[],hypotheses:entries.map(h=>({label:h.label.value,changes:h.changes.value.trim()?[h.changes.value]:[],checks:[{command:h.command.value,...(h.contains.value?{contains:h.contains.value}:{})}]})),finalChecks:[{command:final.value,...(finalMarker.value?{contains:finalMarker.value}:{})}],outputs:outputs.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)});
  const advanced=el('details'),advancedTitle=el('summary','Plan technique (facultatif)'),manual=el('input');manual.type='checkbox';advanced.append(advancedTitle);field('Utiliser le plan JSON à la place du formulaire',manual,advanced);
  const input=field('Plan de l’expérience (JSON)',area(12,JSON.stringify(guided(),null,2)),advanced);input.id='lab-plan-editor';advanced.addEventListener('toggle',()=>{if(advanced.open&&!manual.checked)input.value=JSON.stringify(guided(),null,2);});form.append(advanced);
  system.addEventListener('change',()=>{template.disabled=system.value!=='linux';});
  try{const r=await api('/api/vm/action',{action:'templates'});for(const t of r.templates){const o=el('option',t.name);o.value=t.id;template.append(o);}}catch{}
  const start=el('button','Lancer dans des VM isolées');start.type='submit';start.className='lab-primary';const notice=el('p',undefined,'lab-note');notice.setAttribute('role','status');form.append(start);editor.append(summary,form);section.append(editor,notice);
  const list=el('div',undefined,'lab-list'),refresh=el('button','Actualiser les expériences');refresh.type='button';section.append(refresh,list);target.append(section);
  const labels={queued:'En attente',running:'Tests en cours',verifying:'Retest final',verified:'Critères testés satisfaits',passed:'Tests réussis',refuted:'Hypothèses écartées',final_failed:'Retest final échoué',inconclusive:'Résultat incomplet',infrastructure_error:'Erreur d’environnement',cancelled:'Annulée',interrupted:'Interrompue'};
  async function load(){try{const r=await api('/api/vm/laboratory');if(!section.isConnected)return;list.replaceChildren();if(!r.experiments.length)list.append(el('p','Aucune expérience enregistrée.','lab-note'));
   for(const x of r.experiments){const card=el('article',undefined,'lab-record');card.append(el('strong',x.problem),el('span',labels[x.status]||x.status,'lab-state'),el('small',new Date(x.started).toLocaleString()));
    if(x.error)card.append(el('p',x.error));const detail=el('details');detail.append(el('summary',`${x.attempts.length} hypothèse(s) · ${x.memoryMatches||0} expérience(s) réutilisable(s)`));
    for(const a of [...x.attempts,x.final].filter(Boolean)){detail.append(el('p',`${a===x.final?'Retest final : ':''}${a.label} · ${labels[a.status]||a.status}`));if(a.error)detail.append(el('p',a.error));for(const c of a.checks||[]){const p=el('p',`${c.passed?'Réussi':'Échoué'} · code ${c.exitCode} · ${c.durationMs} ms · ${c.command}`),link=el('a','Télécharger la preuve');link.href=`/api/vm/laboratory/${x.id}/evidence/${c.log}`;link.download=c.log;detail.append(p,link);}}
    for(const a of x.final?.artifacts||[]){const link=el('a',`Récupérer ${a.path} (${fmt(a.bytes)} octets)`);link.href=`/api/vm/laboratory/${x.id}/artifacts/${a.id}`;link.download=a.path.split('/').pop();detail.append(link);}
    if(x.applied)detail.append(el('p','Fichiers intégrés au projet. Sauvegarde conservée ; retest sur le PC hôte non exécuté.','lab-note'));
    if(x.status==='verified'&&x.final?.artifacts?.length&&!x.applied){const apply=el('button','Intégrer les fichiers vérifiés');apply.type='button';apply.addEventListener('click',async()=>{if(!await customConfirm('Intégrer uniquement ces fichiers : '+x.final.artifacts.map(a=>a.path).join(', ')+' ? Une sauvegarde sera conservée.',{title:'Intégrer le résultat vérifié',okText:'Intégrer'}))return;apply.disabled=true;try{await api('/api/vm/laboratory',{action:'apply',id:x.id,root:project.value.trim()||state.projectRoot});notice.textContent='Fichiers intégrés. Sauvegarde conservée ; retest sur le PC hôte non exécuté.';await load();}catch(e){notice.textContent=e.message;apply.disabled=false;}});detail.append(apply);}
    card.append(detail);if(['queued','running','verifying'].includes(x.status)){const cancel=el('button','Arrêter cette expérience');cancel.type='button';cancel.addEventListener('click',async()=>{cancel.disabled=true;try{await api('/api/vm/laboratory',{action:'cancel',id:x.id});await load();}catch(e){notice.textContent=e.message;cancel.disabled=false;}});card.append(cancel);}list.append(card);
   }
  }catch(e){notice.textContent=e.message;}}
  form.addEventListener('submit',async e=>{e.preventDefault();start.disabled=true;try{const root=project.value.trim()||state.projectRoot;if(!root)throw Error('Choisissez le dossier du projet avant de lancer une expérience.');await api('/api/vm/laboratory',{...(manual.checked?JSON.parse(input.value):guided()),action:'run',root});notice.textContent='Expérience démarrée. Consultez les preuves avant toute intégration.';editor.open=false;await load();}catch(e){notice.textContent=e.message;}finally{start.disabled=false;}});
  refresh.addEventListener('click',load);await load();
 }
 window.ZaalisLaboratory={mount,tokens};
})();
