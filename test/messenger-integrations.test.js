'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { MessengerIntegrations } = require('../messenger-integrations');
function fixture() {
 let users = [{ id: 'alice' }, { id: 'bob' }], calls = [], answers = [];
 const client = new EventEmitter(); client.info = { wid: { _serialized: 'self@c.us' }, pushname: 'Alice' };
 client.initialize = async () => {}; client.destroy = async () => {}; client.logout = async () => {}; client.sendMessage = async (to, text) => { calls.push({ to, text }); };
 const m = new MessengerIntegrations({ loadUsers: () => structuredClone(users), saveUsers: value => { users = value; }, encrypt: value => 'sealed:' + value, decrypt: value => value?.replace(/^sealed:/, '') || '', dataDir: 'fixture', appDir: 'fixture', whatsappFactory: async () => client,
  answer: async (id, input) => { answers.push({ id, input }); return 'AI answer'; }, fetchImpl: async (url, opts) => { const method = url.split('/').pop(); calls.push({ method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, result: method === 'getMe' ? { is_bot: true, username: 'zaalis_fixture_bot' } : method === 'getWebhookInfo' ? { url: '' } : [] }) }; }
 });
 return { m, calls, answers, client };
}
test('Telegram bot credentials are encrypted, isolated and never returned', async () => {
 const {m}=fixture(), token='123456789:abcdefghijklmnopqrstuvwxyz'; await m.configureTelegram('alice',token);
 assert.ok(m.user('alice').messengers.telegram.token.startsWith('sealed:')); assert.ok(!JSON.stringify(m.status('alice','telegram')).includes(token));
 await assert.rejects(m.configureTelegram('bob',token),/autre compte/); await assert.rejects(m.configureTelegram('alice','invalid'),/invalide/);
});
test('Telegram pairing requires the nonce, private chat and the exact paired sender', async () => {
 const {m,calls,answers}=fixture();await m.configureTelegram('alice','123456789:abcdefghijklmnopqrstuvwxyz');
 const session={nonce:'private-pairing-code',expires:Date.now()+60000,connected:false}; m.sessions.set('alice:telegram',session);
 const message=(id,text,type='private')=>({from:{id,is_bot:false},chat:{id,type},text});
 await m.telegramMessage('alice','token',session,message(7,'/start wrong'));await m.telegramMessage('alice','token',session,message(7,'/start private-pairing-code','group'));assert.equal(m.user('alice').messengers.telegram.chatId,undefined);
 await m.telegramMessage('alice','token',session,message(7,'/start private-pairing-code'));assert.equal(session.connected,true);assert.equal(m.user('alice').messengers.telegram.chatId,'7');
 await m.telegramMessage('alice','token',session,message(8,'unauthorized'));assert.equal(answers.length,0);
 await m.telegramMessage('alice','token',session,message(7,'Hello'));assert.equal(answers.length,1);assert.equal(answers[0].id,'alice');assert.ok(calls.some(c=>c.method==='sendMessage'&&c.body.chat_id===7&&c.body.text==='AI answer'));
 await m.telegramMessage('alice','token',session,message(7,'/new'));assert.equal(m.histories.has('alice:telegram'),false);
});
test('Telegram expiration and forged sender cannot associate a chat', async () => {
 const {m}=fixture();await m.configureTelegram('alice','123456789:abcdefghijklmnopqrstuvwxyz');const session={nonce:'secret',expires:0};
 await m.telegramMessage('alice','token',session,{from:{id:9},chat:{id:9,type:'private'},text:'/start secret'});
 session.expires=Date.now()+60000;await m.telegramMessage('alice','token',session,{from:{id:8},chat:{id:9,type:'private'},text:'/start secret'});assert.equal(m.user('alice').messengers.telegram.chatId,undefined);
});
test('WhatsApp only answers new commands in the owner self-chat and never loops or duplicates', async () => {
 const {m,client,calls,answers}=fixture();await m.startWhatsApp('alice');client.emit('ready');
 const msg=(id,body,extra={})=>({id:{_serialized:id},body,from:'self@c.us',to:'self@c.us',fromMe:true,timestamp:Math.floor(Date.now()/1000),...extra});
 client.emit('message_create',msg('foreign','!zaalis hello',{from:'foreign@c.us',fromMe:false}));client.emit('message_create',msg('group','!zaalis hello',{to:'group@g.us'}));client.emit('message_create',msg('old','!zaalis hello',{timestamp:1}));client.emit('message_create',msg('reply','Zaalis · AI answer'));client.emit('message_create',msg('regular','Hello'));
 client.emit('message_create',msg('command','!zaalis Hello'));client.emit('message_create',msg('command','!zaalis Hello'));await new Promise(r=>setTimeout(r,10));
 assert.equal(answers.length,1);assert.deepEqual(calls,[{to:'self@c.us',text:'Zaalis · AI answer'}]);
 await m.stop('alice','whatsapp',true);assert.equal(m.status('alice','whatsapp').connected,false);assert.equal(m.user('alice').messengers.whatsapp.enabled,false);
 client.emit('message_create',msg('after-disconnect','!zaalis must be ignored'));await new Promise(r=>setTimeout(r,10));assert.equal(answers.length,1);
});
test('conversation model and history remain scoped to the account and channel', async () => {
 const {m,answers}=fixture();m.settings('alice',{model:'compat:chatgpt',submodel:'gpt-6-sol',language:'fr'});
 await m.respond('alice','telegram','one');await m.respond('alice','telegram','two');await m.respond('alice','whatsapp','other channel');await m.respond('bob','telegram','other account');
 assert.equal(answers[1].input.history.length,2);assert.equal(answers[2].input.history.length,0);assert.equal(answers[3].input.history.length,0);assert.equal(answers[0].input.model,'compat:chatgpt');assert.throws(()=>m.settings('alice',{model:'x',submodel:''}),/Choisissez/);
});

test('messenger history is encrypted and restored after clearing the runtime cache', async()=>{
 const {m,answers}=fixture();await m.respond('alice','telegram','private question');assert.ok(m.user('alice').messengers.telegram.history.startsWith('sealed:'));
 assert.ok(!JSON.stringify(m.status('alice','telegram')).includes('private question'));m.histories.clear();await m.respond('alice','telegram','next question');assert.equal(answers[1].input.history[0].content,'private question');
});

test('WhatsApp can retry after authentication failure and disconnect only removes its own profile', async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');const {m,client}=fixture();m.dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-wa-disconnect-'));
 await m.startWhatsApp('alice');client.emit('auth_failure');assert.equal(m.status('alice','whatsapp').state,'error');await m.startWhatsApp('alice');assert.equal(m.status('alice','whatsapp').state,'connecting');
 const root=path.join(m.dataDir,'whatsapp-sessions'),profile=id=>path.join(root,'session-'+crypto.createHash('sha256').update(id).digest('hex'));for(const id of ['alice','bob']){fs.mkdirSync(profile(id),{recursive:true});fs.writeFileSync(path.join(profile(id),'fixture.txt'),'data');}
 await m.stop('alice','whatsapp',true);assert.equal(fs.existsSync(profile('alice')),false);assert.equal(fs.existsSync(profile('bob')),true);
});

test('WhatsApp self-chat accepts the owner LID alias and still rejects unrelated contacts', async()=>{
 const {m,client,answers}=fixture();client.getContactLidAndPhone=async()=>[{pn:'self@c.us',lid:'owner@lid'}];await m.startWhatsApp('alice');client.emit('ready');await new Promise(r=>setTimeout(r,0));
 const msg=(id,to)=>({id:{_serialized:id},from:'self@c.us',to,fromMe:true,body:'!zaalis Hello',timestamp:Math.floor(Date.now()/1000)});
 client.emit('message_create',msg('foreign','stranger@lid'));client.emit('message_create',msg('owner','owner@lid'));await new Promise(r=>setTimeout(r,10));assert.equal(answers.length,1);await m.stop('alice','whatsapp',true);
});

function gatewayFixture(mode = 'self-chat') {
 const base = fixture(), clients = [];
 base.m.whatsappFactory = async () => { const client = new EventEmitter(); Object.assign(client, { isGateway: true, mode, info: { wid: { _serialized: '1555@s.whatsapp.net' }, pushname: 'Alice' }, initialize: async () => {}, destroy: async () => {}, logout: async () => {}, sendMessage: async (to, text) => { base.calls.push({ to, text }); } }); clients.push(client); return client; };
 const message = (id, body) => ({ id: { _serialized: id }, body, fromMe: true, peer: '1555@s.whatsapp.net', gatewayMessage: true, timestamp: Math.floor(Date.now() / 1000) });
 return { ...base, clients, message };
}
test('WhatsApp self-chat only treats messages starting with zaalis! as AI requests', async () => {
 const { m, clients, answers, message } = gatewayFixture(); await m.startWhatsApp('alice'); const client = clients[0]; client.emit('ready');
 client.emit('message_create', message('note', 'acheter du pain'));
 client.emit('message_create', message('mention', 'demain je teste zaalis! ce soir'));
 client.emit('message_create', message('trigger', 'zaalis! résume le projet'));
 client.emit('message_create', message('spaced', 'Zaalis ! et les tests ?'));
 client.emit('message_create', message('legacy', '!zaalis ancien format'));
 await new Promise(r => setTimeout(r, 20));
 assert.deepEqual(answers.map(a => a.input.message), ['résume le projet', 'et les tests ?', 'ancien format']);
});
test('a dedicated WhatsApp number answers allowed contacts without the trigger word', async () => {
 const { m, clients, answers, message } = gatewayFixture('bot'); await m.startWhatsApp('alice'); clients[0].emit('ready');
 clients[0].emit('message_create', message('plain', 'bonjour')); await new Promise(r => setTimeout(r, 20));
 assert.equal(answers.length, 1); assert.equal(answers[0].input.message, 'bonjour');
});
test('WhatsApp pairing states: expired QR restarts, phone logout asks to link again', async () => {
 const { m, clients } = gatewayFixture(); await m.startWhatsApp('alice');
 clients[0].emit('linking'); assert.equal(m.status('alice', 'whatsapp').state, 'linking');
 clients[0].emit('qr_expired'); assert.equal(m.status('alice', 'whatsapp').state, 'expired'); assert.equal(m.status('alice', 'whatsapp').qr, '');
 await m.startWhatsApp('alice'); assert.equal(clients.length, 2); assert.equal(m.status('alice', 'whatsapp').state, 'connecting');
 clients[1].emit('ready'); assert.equal(m.status('alice', 'whatsapp').connected, true); assert.equal(m.user('alice').messengers.whatsapp.enabled, true);
 clients[1].emit('logged_out'); const status = m.status('alice', 'whatsapp');
 assert.equal(status.connected, false); assert.equal(status.state, 'disconnected'); assert.match(status.error, /téléphone/); assert.equal(m.user('alice').messengers.whatsapp.enabled, false);
 await m.startWhatsApp('alice'); assert.equal(clients.length, 3);
});
test('WhatsApp test message reaches the self-chat and explains the trigger word', async () => {
 const { m, clients, calls } = gatewayFixture(); await assert.rejects(m.test('alice', 'whatsapp'), /Connectez/);
 await m.startWhatsApp('alice'); clients[0].emit('ready'); const status = await m.test('alice', 'whatsapp');
 assert.equal(status.tested, true); assert.equal(status.trigger, 'zaalis!'); assert.equal(calls.at(-1).to, '1555@s.whatsapp.net'); assert.match(calls.at(-1).text, /zaalis! votre demande/);
});
test('Telegram: refused key stops polling with a clear error, expired link is reported, bot can be changed', async () => {
 const { m } = fixture(); await m.configureTelegram('alice', '123456789:abcdefghijklmnopqrstuvwxyz');
 m.fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) });
 const session = { controller: new AbortController(), offset: 0, state: 'connected', connected: true }; m.sessions.set('alice:telegram', session);
 await m.pollTelegram('alice', 'token', session);
 assert.equal(session.state, 'error'); assert.equal(session.connected, false); assert.match(m.status('alice', 'telegram').error, /BotFather/);
 m.sessions.set('alice:telegram', { state: 'pairing', expires: Date.now() - 1, link: 'https://t.me/x?start=n', linkQr: 'data:image/png;base64,AA' });
 const expired = m.status('alice', 'telegram'); assert.equal(expired.state, 'expired'); assert.equal(expired.link, ''); assert.equal(expired.linkQr, '');
 m.save('alice', s => { s.telegram.binding = { kind: 'chat', conversationId: 'c1' }; s.telegram.chatId = '7'; });
 const reset = await m.resetTelegram('alice'); assert.equal(reset.configured, false);
 assert.deepEqual(m.user('alice').messengers.telegram, { binding: { kind: 'chat', conversationId: 'c1' } });
});
test('Telegram explains a wrong key when linking the bot', async () => {
 const { m } = fixture(); m.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error_code: 404 }) });
 await assert.rejects(m.configureTelegram('alice', '123456789:abcdefghijklmnopqrstuvwxyz'), /BotFather/);
});
