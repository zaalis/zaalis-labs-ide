(() => {
 'use strict';
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const fmt=n=>new Intl.NumberFormat(state.language==='en'?'en':'fr',{notation:'compact',maximumFractionDigits:1}).format(n||0);
 const full=n=>new Intl.NumberFormat('fr').format(n||0);
 const badges=[
  {name:'Premier déclic',icon:'spark',metric:'total',target:10000,label:'10 000 tokens'},
  {name:'Petit travailleur',icon:'worker',metric:'activeDays',target:3,label:'3 jours actifs'},
  {name:'Bâtisseur',icon:'builder',metric:'total',target:1000000,label:'1 million de tokens'},
  {name:'Artisan du code',icon:'terminal',metric:'calls',target:20,label:'20 appels mesurés sur 12 mois'},
  {name:'Explorateur',icon:'explorer',metric:'models',target:3,label:'3 modèles utilisés sur 12 mois'},
  {name:'Maître des idées',icon:'ideas',metric:'activeDays',target:10,label:'10 jours actifs'},
  {name:'Architecte',icon:'architect',metric:'longestStreak',target:7,label:'7 jours consécutifs'},
  {name:'Grand créateur',icon:'creator',metric:'total',target:100000000,label:'100 millions de tokens'},
  {name:'Virtuose',icon:'virtuoso',metric:'longestStreak',target:30,label:'30 jours consécutifs'},
  {name:'Légende des tokens',icon:'legend',metric:'total',target:1000000000,label:'1 milliard de tokens'}
 ];
 let revision=0;
 async function api(url,body){const r=await fetch(url,{credentials:'include',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Mesures indisponibles');return d;}
 async function mount(){
  const version=++revision,target=document.getElementById('tokens-content');if(!target)return;target.replaceChildren();target.className='token-profile';
  const notice=el('p','Chargement de votre activité…','lab-note');notice.setAttribute('role','status');target.append(notice);
  try{
   const now=new Date(),end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)),start=new Date(end);start.setUTCDate(start.getUTCDate()-366);
   const [data,account]=await Promise.all([api(`/api/usage?from=${start.getTime()}&to=${end.getTime()}`),api('/api/token-profile')]);if(version!==revision)return;
   const hero=el('div',undefined,'token-hero'),banner=el('div',undefined,'token-banner');hero.append(banner);
   const setBanner=value=>{banner.style.backgroundImage=value?`url("${value}")`:'';};setBanner(account.banner);
   const pseudo=account.profile?.pseudo||state.profile?.pseudo||'Votre espace',photo=account.profile?.photo;
   if(/^data:image\/(png|jpeg|webp);base64,/.test(photo||'')){const avatar=el('img',undefined,'token-avatar');avatar.src=photo;avatar.alt='Votre avatar';hero.append(avatar);}else hero.append(el('span',pseudo.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase(),'token-avatar'));
   hero.append(el('h3',pseudo),el('p','Votre activité avec zaalis'));target.prepend(hero);
   const controls=el('div',undefined,'token-banner-actions'),file=el('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;
   const change=el('button','Personnaliser la bannière'),remove=el('button','Retirer la photo');change.type=remove.type='button';controls.append(change,remove,file);hero.append(controls);change.onclick=()=>file.click();
   file.onchange=async()=>{const chosen=file.files[0];if(!chosen)return;change.disabled=true;try{if(chosen.size>10*1024*1024)throw Error('Choisissez une image de moins de 10 Mo.');const bitmap=await createImageBitmap(chosen);const canvas=document.createElement('canvas');canvas.width=Math.min(1600,bitmap.width);canvas.height=Math.round(bitmap.height*canvas.width/bitmap.width);if(canvas.height>1600){canvas.width=Math.round(canvas.width*1600/canvas.height);canvas.height=1600;}canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const value=canvas.toDataURL('image/jpeg',.82);await api('/api/token-profile',{banner:value});if(version===revision)setBanner(value);notice.textContent='Bannière enregistrée.';}catch(e){notice.textContent=e.message;}finally{change.disabled=false;file.value='';}};
   remove.onclick=async()=>{remove.disabled=true;try{await api('/api/token-profile',{banner:''});if(version===revision)setBanner('');notice.textContent='Bannière retirée.';}catch(e){notice.textContent=e.message;}finally{remove.disabled=false;}};
   const p=data.profile||{},stats=el('div',undefined,'token-stats');for(const [label,value] of [['Total des tokens',fmt(p.total)],['Pic quotidien',fmt(p.peak)],['Jours actifs',full(p.activeDays)],['Meilleure série',`${p.longestStreak||0} j`],['Série en cours',`${p.currentStreak||0} j`]]){const card=el('div',undefined,'token-stat');card.append(el('strong',value),el('span',label));stats.append(card);}target.append(stats);
   const heading=el('div',undefined,'token-activity-heading'),modes=el('div',undefined,'token-mode-tabs');heading.append(el('h4','Activité des jetons'),modes);target.append(heading);
   const scroll=el('div',undefined,'token-heatmap-scroll'),heatmap=el('div',undefined,'token-heatmap');heatmap.setAttribute('role','img');heatmap.setAttribute('aria-label','Activité quotidienne des tokens sur les douze derniers mois, en UTC');scroll.append(heatmap);target.append(scroll);
   const days=new Map(data.days.map(d=>[d.day,d.input+d.output])),first=Math.floor(start.getTime()/86400000),last=Math.floor(end.getTime()/86400000)-1;
   let view='day';const buttons=[];
   function draw(){heatmap.replaceChildren();const values=[];let cumulative=0;for(let day=first;day<=last;day++){cumulative+=days.get(day)||0;values.push(view==='total'?cumulative:view==='week'?Array.from({length:7},(_,i)=>days.get(day-i)||0).reduce((a,b)=>a+b,0):days.get(day)||0);}const max=Math.max(1,...values);
    const padding=(new Date(first*86400000).getUTCDay()+6)%7;heatmap.style.gridTemplateColumns=`repeat(${Math.ceil((values.length+padding)/7)},minmax(8px,1fr))`;for(let i=0;i<padding;i++){const blank=el('span',undefined,'token-cell');blank.style.visibility='hidden';heatmap.append(blank);}
    values.forEach((value,i)=>{const cell=el('span',undefined,'token-cell');cell.dataset.level=value===0?'0':String(Math.max(1,Math.ceil(value/max*4)));cell.title=`${new Date((first+i)*86400000).toLocaleDateString('fr',{timeZone:'UTC'})} · ${full(value)} tokens${view==='week'?' sur 7 jours':view==='total'?' cumulés dans la période':''}`;heatmap.append(cell);});for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.mode===view));
   }
   for(const [mode,text] of [['day','Par jour'],['week','Sur 7 jours'],['total','Cumulé']]){const b=el('button',text);b.type='button';b.dataset.mode=mode;b.onclick=()=>{view=mode;draw();};modes.append(b);buttons.push(b);}draw();
   const months=el('div',undefined,'token-months');for(let i=0;i<12;i++){const d=new Date(start);d.setUTCMonth(d.getUTCMonth()+i);months.append(el('span',d.toLocaleDateString('fr',{month:'short',timeZone:'UTC'})));}scroll.append(months);
   const legend=el('div',undefined,'token-legend');legend.append(el('span','Moins'));for(let i=0;i<=4;i++){const cell=el('span',undefined,'token-cell');cell.dataset.level=String(i);legend.append(cell);}legend.append(el('span','Plus'));target.append(legend);
   target.append(el('h4','Paliers de création'));const grid=el('div',undefined,'token-badges');
   for(const badge of badges){
    const value=badge.metric==='models'?data.models.length:badge.metric==='calls'?Math.max(0,(data.total.calls||0)-(data.total.unmeasured||0)):(p[badge.metric]||0);
    const unlocked=value>=badge.target,card=el('article',undefined,'token-badge');card.dataset.unlocked=String(unlocked);card.dataset.metric=badge.metric;
    const image=el('img',undefined,'token-badge-icon');image.src=`image/badges/${badge.icon}.png`;image.alt='';image.width=image.height=64;image.loading='lazy';
    const progress=el('progress');progress.max=badge.target;progress.value=Math.min(value,badge.target);progress.setAttribute('aria-label',`${badge.name} : ${full(value)} sur ${full(badge.target)}`);
    card.append(image,el('strong',badge.name),el('small',`${badge.label} · ${unlocked?'Débloqué':'À atteindre'}`),progress);grid.append(card);
   }
   target.append(grid,el('p','Les badges célèbrent les tokens, les jours actifs, les séries et l’exploration des modèles. Ils n’ajoutent aucun crédit ni quota de tokens.','lab-note'));
   target.append(el('h4','Statistiques des douze derniers mois'));const t=data.total,c=data.comparison||{};for(const [label,value] of [['Entrée / sortie',`${fmt(t.input)} / ${fmt(t.output)}`],['Cache lu',fmt(t.cached)],['Tokens de réflexion',fmt(t.reasoning)],['Appels mesurés',`${full(t.calls-t.unmeasured)} / ${full(t.calls)}`],['Modèles utilisés',String(data.models.length)],['Économie mesurée',c.count&&c.percent!=null?`${c.percent.toFixed(1)} % · ${c.count} comparaison(s)`:'Aucune référence comparable'],['Appels incomplets',full(t.unfinished)]]){const row=el('div',undefined,'token-measure-row');row.append(el('span',label),el('strong',value));target.append(row);}
   notice.textContent='Historique mesuré depuis l’activation du registre. Activité et séries calculées en UTC. Le total et les badges couvrent tout l’historique ; le graphique couvre les douze derniers mois. Cache et réflexion sont inclus dans les catégories, sans double comptage.';
   target.append(notice);
  }catch(e){notice.textContent=e.message;notice.classList.add('error');}
 }
 window.ZaalisTokenProfile={mount,badges};
})();
