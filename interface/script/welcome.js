(() => {
 'use strict';
 // Ten greetings for each local time band, selected once per application launch.
 const phrases={
  morning:['Le café est prêt. Les idées aussi.','Faites chauffer vos tokens.','Une idée, un café, un premier commit.','Votre prochain projet commence ici.','Les bugs dorment encore. Profitons-en.','Une belle journée pour construire.','Le clavier attend votre première idée.','Petit café, grandes ambitions.','Aujourd’hui, on donne vie aux idées.','Une nouvelle journée, un nouveau possible.'],
  afternoon:['Une idée de plus, un pas de mieux.','Vos tokens ont encore de l’énergie.','Le prochain déclic est à une ligne de code.','Un petit changement peut faire beaucoup.','Le projet avance à votre rythme.','On transforme cette idée en quelque chose de concret.','Le clavier est chaud, les idées aussi.','Une pause, puis une belle avancée.','La meilleure fonction reste à écrire.','Votre imagination a rendez-vous avec le code.'],
  evening:['Les idées du soir ont du caractère.','Une dernière idée avant de fermer le laptop ?','Le soleil se couche, les projets s’allument.','Une soirée tranquille, un projet qui avance.','Les tokens prennent le relais du café.','Encore un petit déclic et on y est.','Le code aussi a ses belles soirées.','Une bonne idée n’attend pas demain.','Votre projet mérite sa petite lumière du soir.','Une avancée de plus pour terminer la journée.'],
  night:['Les idées ne regardent pas l’heure.','Mode nocturne, imagination allumée.','Les étoiles brillent. Votre curseur aussi.','Même les bugs ont besoin de dormir.','Une ligne de code sous les étoiles.','Nuit calme, esprit créatif.','Les tokens veillent avec vous.','Le prochain commit sera peut-être matinal.','Votre idée fait des heures supplémentaires.','Le silence de la nuit laisse de la place aux idées.'],
  project:['{project} vous attend.','Vos idées ont rendez-vous avec {project}.','Une nouvelle page pour {project}.','{project} est prêt pour la suite.','Votre prochaine avancée : {project}.','Et si on faisait grandir {project} ?','{project} a encore de belles choses à devenir.','Un petit pas de plus pour {project}.','Le prochain déclic se cache dans {project}.','{project} reprend vie avec vous.']
 };
 const band=hour=>hour>=5&&hour<12?'morning':hour<18&&hour>=12?'afternoon':hour>=18&&hour<23?'evening':'night';
 const greeting=hour=>hour>=5&&hour<18?uiText('Bonjour'):hour>=18&&hour<23?uiText('Bonsoir'):uiText('Bonne nuit');
 const random=new Uint32Array(1);crypto.getRandomValues(random);const choice=random[0];
 function message(date=new Date(),project){const group=project&&choice%3===0?'project':band(date.getHours());return {title:[greeting(date.getHours()),String(state.profile?.pseudo||'').trim().split(/[\s_.@-]+/)[0]].filter(Boolean).join(' '),text:uiText(phrases[group][choice%10]).replaceAll('{project}',project||'Votre projet')};}
 function logo(){const svg=document.querySelector('#topbar .logo svg')?.cloneNode(true);if(svg){svg.classList.add('launch-logo');svg.setAttribute('aria-hidden','true');}return svg;}
 function render(){
  const project=(state.projectRoot||state.lastProjectRoot||getRecentProjects()?.[0]||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop();
  const m=message(new Date(),project),editor=document.getElementById('welcome-screen');
  if(editor){editor.replaceChildren();const icon=logo(),title=document.createElement('h1'),sub=document.createElement('p');title.textContent=m.title;sub.textContent=m.text;sub.className='welcome-sub';if(icon)editor.append(icon);editor.append(title,sub);}
  const chat=document.getElementById('chat-messages');
  // Only the initial placeholder is replaced. New chats and history keep their own state.
  const placeholder=chat?.querySelector('[data-i18n="chat-default-msg"]');
  if(placeholder&&chat.children.length===1){const welcome=document.createElement('div');welcome.className='launch-welcome';welcome.dataset.launchWelcome='true';const icon=logo(),title=document.createElement('h2'),sub=document.createElement('p');title.textContent=m.title;sub.textContent=m.text;if(icon)welcome.append(icon);welcome.append(title,sub);chat.replaceChildren(welcome);}
  const visible=chat?.querySelector('[data-launch-welcome]');if(visible){visible.querySelector('h2').textContent=m.title;visible.querySelector('p').textContent=m.text;}
 }
 window.ZaalisWelcome={render,message,phrases,band};
 document.addEventListener('DOMContentLoaded',render);
 document.addEventListener('DOMContentLoaded',()=>{const chat=document.getElementById('chat-messages');if(chat)new MutationObserver(()=>{const welcome=chat.querySelector('[data-launch-welcome]');if(welcome&&chat.children.length>1)welcome.remove();}).observe(chat,{childList:true});});
})();
