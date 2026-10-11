/* Shared catalogue: the IDE and terminal describe the same connections. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ZaalisIntegrationCatalog=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const entries=[
 ['telegram','Telegram','native','https://core.telegram.org/bots','Bot privé et association du compte','Private bot and account pairing'],
 ['discord','Discord','api','https://discord.com/developers/docs/intro','Bot et accès aux salons autorisés','Bot and authorized channels','https://discord.com/api/v10'],
 ['slack','Slack','api','https://docs.slack.dev/','Application Slack avec droits de lecture et écriture','Slack app with read and write scopes','https://slack.com/api'],
 ['mattermost','Mattermost','api','https://docs.mattermost.com/api','Serveur Mattermost et jeton du bot','Mattermost server and bot token'],
 ['matrix','Matrix','api','https://spec.matrix.org/latest/client-server-api/','Homeserver et jeton ; salons non chiffrés','Homeserver and token; unencrypted rooms'],
 ['whatsapp','WhatsApp','native','https://faq.whatsapp.com/1317564962315842','Association par QR code sur ce PC','QR pairing on this PC'],
 ['signal','Signal','api','https://github.com/bbernhard/signal-cli-rest-api','Pont signal-cli REST installé et associé','Installed and paired signal-cli REST bridge'],
 ['bluebubbles','BlueBubbles (iMessage)','api','https://docs.bluebubbles.app/','Serveur BlueBubbles sur un Mac','BlueBubbles server running on a Mac'],
 ['homeassistant','Home Assistant','existing','https://developers.home-assistant.io/docs/api/rest/','Serveur et jeton longue durée','Server and long-lived access token'],
 ['email','Email','mcp','https://www.rfc-editor.org/rfc/rfc9051','Serveur MCP de messagerie autorisé par le propriétaire','Owner-authorized email MCP server'],
 ['twilio','SMS (Twilio)','api','https://www.twilio.com/docs/messaging/api','Account SID, clé et numéro SMS','Account SID, credential and SMS number','https://api.twilio.com/2010-04-01'],
 ['dingtalk','DingTalk','mcp','https://open.dingtalk.com/','Application DingTalk et serveur MCP','DingTalk application and MCP server'],
 ['feishu','Feishu / Lark','existing','https://open.feishu.cn/document/','Application et tenant access token','Application and tenant access token','https://open.feishu.cn/open-apis'],
 ['googlechat','Google Chat','api','https://developers.google.com/workspace/chat/api','Application Chat et jeton OAuth','Chat application and OAuth token','https://chat.googleapis.com/v1'],
 ['wecombot','WeCom (group bot)','mcp','https://developer.work.weixin.qq.com/','Robot de groupe et serveur MCP','Group bot and MCP server'],
 ['wecom','WeCom (app)','mcp','https://developer.work.weixin.qq.com/','Application d’entreprise et serveur MCP','Enterprise app and MCP server'],
 ['weixin','Weixin / WeChat (Personal)','mcp','https://developers.weixin.qq.com/','Pont personnel compatible MCP à associer','Personal MCP bridge to pair'],
 ['qq','QQ Bot','mcp','https://bot.q.qq.com/wiki/','Application QQ Bot et serveur MCP','QQ Bot application and MCP server'],
 ['yuanbao','Yuanbao (元宝)','existing','https://yuanbao.tencent.com/','Serveur MCP Yuanbao','Yuanbao MCP server'],
 ['apiserver','API server','api','https://www.openapis.org/','Endpoint HTTP explicitement configuré','Explicitly configured HTTP endpoint'],
 ['webhooks','Webhooks','api','https://www.openapis.org/','Endpoint sortant ; les secrets restent chiffrés','Outgoing endpoint; secrets remain encrypted'],
 ['a2a','A2A','existing','https://a2a-protocol.org/latest/','Agent distant et fiche de capacités','Remote agent and capability card'],
 ['buzz','Buzz','mcp','https://hermes-agent.nousresearch.com/docs/','Service Buzz et adaptateur MCP requis','Buzz service and MCP adapter required'],
 ['photon','iMessage via Photon','mcp','https://photon.codes/','Pont Photon sur un Mac et serveur MCP','Photon bridge on a Mac and MCP server'],
 ['irc','IRC','mcp','https://www.rfc-editor.org/rfc/rfc2812','Serveur IRC et pont MCP','IRC server and MCP bridge'],
 ['line','LINE','api','https://developers.line.biz/en/docs/messaging-api/','Channel access token et destinataires autorisés','Channel access token and authorized recipients','https://api.line.me/v2/bot'],
 ['microsoftgraph','Microsoft Graph Webhooks','api','https://learn.microsoft.com/graph/change-notifications-overview','Application Entra et jeton Microsoft Graph','Entra application and Microsoft Graph token','https://graph.microsoft.com/v1.0'],
 ['teams','Microsoft Teams','api','https://learn.microsoft.com/graph/api/chatmessage-post','Application Microsoft Graph et accès Teams','Microsoft Graph application and Teams access','https://graph.microsoft.com/v1.0'],
 ['ntfy','ntfy','api','https://docs.ntfy.sh/','Serveur ntfy et sujet privé','ntfy server and private topic','https://ntfy.sh'],
 ['raft','Raft','mcp','https://hermes-agent.nousresearch.com/docs/','Service Raft et adaptateur MCP requis','Raft service and MCP adapter required'],
 ['relay','Relay (experimental)','mcp','https://hermes-agent.nousresearch.com/docs/user-guide/messaging/relay/','Connecteur distant ; transport MCP propre à Zaalis','Remote connector; Zaalis MCP transport'],
 ['simplex','SimpleX Chat','mcp','https://github.com/simplex-chat/simplex-chat/tree/stable/docs','SimpleX local et pont MCP','Local SimpleX and MCP bridge'],
 ['whatsappcloud','WhatsApp Cloud API','api','https://developers.facebook.com/docs/whatsapp/cloud-api/','Application Meta, numéro et jeton Cloud API','Meta application, phone ID and Cloud API token','https://graph.facebook.com/v23.0']
 ];
 return entries.map(([id,title,adapter,guide,fr,en,baseUrl])=>({id,title,adapter,guide,fr,en,baseUrl,icon:id,auth:adapter==='mcp'?'mcp':'bearer-token'}));
});
