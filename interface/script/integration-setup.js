(() => {
 'use strict';
 const tr=(fr,en)=>state.language==='en'?en:fr;
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 async function api(url,body){const r=await fetch(url,{credentials:'include',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d;}
 async function mount(id,target,back){
  const c=window.ZaalisIntegrationCatalog.find(c=>c.id===id);if(!c)return;
  const button=el('button',tr('← Retour aux intégrations','← Back to integrations'),'integration-back');button.type='button';button.onclick=back;target.append(button);
  const card=el('article',undefined,'integration-card'),head=el('div',undefined,'integration-heading'),logo=el('img',undefined,'integration-heading-logo');logo.src=`assets/integrations/${c.icon}.svg`;logo.alt='';head.append(logo,el('h3',c.title));card.append(head,el('p',tr(c.fr,c.en),'lab-note'));
  const guide=el('a',tr('Ouvrir le guide de configuration ↗','Open setup guide ↗'),'integration-button');guide.href=c.guide;guide.target='_blank';guide.rel='noopener noreferrer';card.append(guide);
  const status=el('p',tr('Chargement…','Loading…'),'integration-notice');status.setAttribute('role','status');card.append(status);target.append(card);
  const data=await api('/api/assistant/integrations');if(!card.isConnected)return;const connection=data.integrations.find(row=>row.id===id)?.connection;
  const statusText=()=>connection?.lastVerifiedAt?tr('Connexion vérifiée le ','Connection verified on ')+new Date(connection.lastVerifiedAt).toLocaleString(state.language==='en'?'en-GB':'fr-FR'):connection?.status==='configured'?tr('Configuré · vérification requise','Configured · verification required'):tr('Configuration requise','Setup required');status.textContent=statusText();
  card.append(el('p',c.adapter==='mcp'?tr('Installez et autorisez votre pont MCP, puis indiquez son identifiant et les noms de ses outils. Ce connecteur ne fournit pas lui-même le service externe.','Install and authorize your MCP bridge, then enter its ID and tool names. This connector does not provide the external service.'):tr('Les outils de lecture et d’envoi utilisent cette connexion dans l’IDE et le terminal. Cette page ne démarre pas une passerelle de réception automatique.','Read and send tools use this connection in the IDE and terminal. This page does not start an automatic inbound gateway.'),'lab-note'));
  const form=el('form',undefined,'integration-connection-form'),fields={};
  function field(key,label,value='',type='text'){const wrap=el('label',label,'lab-field'),input=el(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.value=value;input.name=key;input.autocomplete=type==='password'?'new-password':'off';wrap.append(input);form.append(wrap);fields[key]=input;}
  if(c.adapter==='mcp'||id==='yuanbao')field('mcpServer',tr('Identifiant du serveur MCP','MCP server ID'),connection?.mcpServer||'');
  else field('baseUrl',tr('URL du service','Service URL'),connection?.baseUrl||c.baseUrl||'');
  field('token',tr('Jeton (laisser vide pour conserver)','Token (leave empty to keep)'),'','password');
  if(['bluebubbles','twilio'].includes(id))field('password',tr('Mot de passe / clé privée (laisser vide pour conserver)','Password / private credential (leave empty to keep)'),'','password');
  field('target',tr('Salon, sujet ou destinataire par défaut','Default channel, topic or recipient'),connection?.options?.target||'');
  field('options',tr('Options avancées (JSON)','Advanced options (JSON)'),JSON.stringify(connection?.options||{},null,2),'textarea');
  card.append(el('p',c.adapter==='mcp'?tr('Exemple d’options : {"tools":{"read":"nom_lecture","send":"nom_envoi","test":"nom_verification"}}','Example options: {"tools":{"read":"read_tool","send":"send_tool","test":"test_tool"}}'):tr('Options selon le service : accountSid/from (Twilio), number (Signal), phoneId (WhatsApp Cloud). Mattermost : URL terminée par /api/v4.','Service options: accountSid/from (Twilio), number (Signal), phoneId (WhatsApp Cloud). Mattermost: URL ending with /api/v4.'),'lab-note'));
  const save=el('button',tr('Enregistrer la connexion','Save connection'),'integration-button');save.type='submit';form.append(save);card.append(form);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const credentials={};for(const key of ['token','password'])if(fields[key]?.value)credentials[key]=fields[key].value;const options=JSON.parse(fields.options.value||'{}');if(fields.target.value)options.target=fields.target.value;await api('/api/assistant/connections',{id,baseUrl:fields.baseUrl?.value,mcpServer:fields.mcpServer?.value,options,...(Object.keys(credentials).length?{credentials}:{})});for(const key of ['token','password'])if(fields[key])fields[key].value='';status.textContent=tr('Enregistré · vérification requise','Saved · verification required');}catch(e){status.textContent=e.message;}finally{save.disabled=false;}};
  const actions=el('div',undefined,'lab-toolbar');card.append(actions);
  for(const [label,action] of [[tr('Vérifier la connexion','Verify connection'),'test'],[tr('Déconnecter','Disconnect'),'disconnect']]){const b=el('button',label,'integration-button');b.type='button';b.onclick=async()=>{b.disabled=true;try{await api('/api/assistant/manage/manage_connections',{root:state.projectRoot,input:{id,action}});status.textContent=action==='test'?tr('Vérification réussie','Verification succeeded'):tr('Déconnecté','Disconnected');}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};actions.append(b);}
 }
 window.ZaalisIntegrationSetup={mount};
})();
