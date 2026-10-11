'use strict';
const { crypto, fail, text, publicData } = require('./common');
const { boundedJson } = require('./connections');
const SAFE_CDP = /^(Page\.(navigate|reload|getFrameTree|captureScreenshot|handleJavaScriptDialog)|DOM\.(getDocument|querySelector|describeNode|getBoxModel)|Accessibility\.getFullAXTree|Runtime\.(evaluate|callFunctionOn)|Input\.(dispatchMouseEvent|dispatchKeyEvent|insertText))$/;
class BrowserTools {
  constructor(store, connections, options) { this.store = store; this.connections = connections; this.options=options;this.browser = (ctx,action,args)=>options.browserAvailable()?options.browser(ctx,action,args):this.fallback(ctx,action,args); this.unlocks = new Map(); this.cdp = new Map(); }
  async run(name, i, ctx) {
    if (name === 'assistant_browser'){const result=await this.browser(ctx,i.action||'tabs',i);return result?.image?{text:result.text,images:[{mime:'image/jpeg',data:result.image}]}:result;}
    if (name.startsWith('browser_vault_')) return this.vault(name, i, ctx);
    if (name === 'browser_get_images') return this.browser(ctx, 'execute_js', { code: 'return Array.from(document.images).slice(0,100).map(i=>({url:i.currentSrc||i.src,alt:i.alt,width:i.naturalWidth,height:i.naturalHeight}));' });
    if (name === 'browser_vision') {
      const shot = await this.browser(ctx, 'screenshot', {}); return typeof shot === 'object' && shot.image ? { text: shot.text, images: [{ mime: 'image/jpeg', data: shot.image }] } : shot;
    }
    if (name === 'browser_dialog') return this.cdpCall(ctx, 'Page.handleJavaScriptDialog', { accept: i.accept === true || i.action==='accept', promptText: String(i.text || '') });
    if (name === 'browser_cdp') {
      const method = text(i.method, 'method', 100); if (!SAFE_CDP.test(method)) throw fail('CDP method is outside the browsing allowlist.', 'method_denied', 403);
      return this.cdpCall(ctx, method, i.params || {});
    }
    throw fail('Unknown browser extension.');
  }
  async cdpCall(ctx, method, params) {
    let config; try { config = this.connections.get(ctx.userId, 'cdp'); } catch { return this.options.browser(ctx, 'cdp', { method, params }); }
    const endpoint = new URL(config.baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw fail('CDP connections must use loopback.', 'endpoint_denied', 403);
    let socketUrl = endpoint.href;
    if (['http:', 'https:'].includes(endpoint.protocol)) {
      const response = await this.connections.fetch(new URL('/json/list', endpoint), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      const tabs = await boundedJson(response), target = tabs.find(tab => tab.type === 'page' && (!(ctx.cdpTarget || this.targets?.get(ctx.userId)) || tab.id === (ctx.cdpTarget || this.targets?.get(ctx.userId))));
      if (!target?.webSocketDebuggerUrl) throw fail('No page target available on the CDP endpoint.', 'service_unavailable', 503); socketUrl = target.webSocketDebuggerUrl;
    }
    const parsed = new URL(socketUrl); if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.hostname !== endpoint.hostname) throw fail('CDP returned an unexpected endpoint.', 'endpoint_denied', 403);
    let client = this.cdp.get(ctx.userId); if (!client || client.url !== socketUrl || client.closed) { client?.close(); client = new CdpClient(socketUrl); this.cdp.set(ctx.userId, client); }
    return publicData(await client.call(method, params, ctx.signal));
  }
  rows(ctx) { return this.store.read(ctx.userId, 'browser-vault'); }
  async fallback(ctx,action,i={}) {
    if(action==='cdp')return this.cdpCall(ctx,i.method,i.params||{});
    if(['tabs','select_tab','close_tab'].includes(action)) {
      const config=this.connections.get(ctx.userId,'cdp'),endpoint=new URL(config.baseUrl);
      if(!['http:','https:'].includes(endpoint.protocol)) {
        if(action!=='tabs')throw fail('Tab management requires the HTTP CDP discovery endpoint.','unsupported',400);
      } else {
        if(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))throw fail('CDP must use loopback.');
        const response=await this.connections.fetch(new URL('/json/list',endpoint),{redirect:'error',signal:AbortSignal.timeout(10000)});
        const tabs=(await boundedJson(response)).filter(t=>t.type==='page');
        if(action==='tabs')return {tabs:tabs.map(t=>({id:t.id,title:t.title,url:t.url,active:t.id===this.targets?.get(ctx.userId)}))};
        const target=tabs.find(t=>t.id===String(i.tab_id||i.id||''));if(!target)throw fail('Browser tab not found.','not_found',404);
        this.targets||=new Map();
        if(action==='select_tab'){this.targets.set(ctx.userId,target.id);return {selected:target.id};}
        const closed=await this.connections.fetch(new URL('/json/close/'+encodeURIComponent(target.id),endpoint),{redirect:'error',signal:AbortSignal.timeout(10000)});
        if(!closed.ok)throw fail('Could not close browser tab.');this.cdp.get(ctx.userId)?.close();this.cdp.delete(ctx.userId);if(this.targets.get(ctx.userId)===target.id)this.targets.delete(ctx.userId);return {closed:target.id};
      }
    }
    if(action==='read_console'||action==='read_network') {
      await this.cdpCall(ctx,action==='read_console'?'Runtime.enable':'Network.enable',{});
      const client=this.cdp.get(ctx.userId),prefix=action==='read_console'?'Runtime.':'Network.';
      return {events:(client?.events||[]).filter(e=>e.method.startsWith(prefix)).slice(-100),collecting:true};
    }
    if(['open','navigate','search'].includes(action)){const url=action==='search'?'https://duckduckgo.com/?q='+encodeURIComponent(i.query||''):i.url;const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw fail('Only HTTP(S) browser URLs are accepted.');return this.cdpCall(ctx,'Page.navigate',{url:parsed.href});}
    if(action==='tabs'){const state=await this.cdpCall(ctx,'Page.getFrameTree',{});return {active:state.frameTree?.frame};}
    if(action==='screenshot'){const result=await this.cdpCall(ctx,'Page.captureScreenshot',{format:'jpeg',quality:80});return {text:'CDP browser screenshot',image:result.data,images:[{mime:'image/jpeg',data:result.data}]};}
    if(action==='read_page'){const result=await this.cdpCall(ctx,'Accessibility.getFullAXTree',{});return {nodes:(result.nodes||[]).filter(n=>!n.ignored).slice(0,250).map(n=>({ref:String(n.backendDOMNodeId||''),role:n.role?.value,name:n.name?.value,value:n.value?.value}))};}
    if(action==='page_text')return this.fallback(ctx,'execute_js',{code:'return document.body.innerText.slice(0,50000);'});
    if(action==='back')return this.fallback(ctx,'execute_js',{code:"history.back();return 'back';"});
    if(action==='execute_js'){const result=await this.cdpCall(ctx,'Runtime.evaluate',{expression:'(function(){'+String(i.code||'')+'})()',returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw fail('Browser script failed: '+(result.exceptionDetails.exception?.description||result.exceptionDetails.text));return result.result?.value??result.result?.description;}
    if(action==='press'){const key=String(i.key||'Enter'),map={Enter:13,Tab:9,Escape:27,Backspace:8,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Space:32};await this.cdpCall(ctx,'Input.dispatchKeyEvent',{type:'keyDown',key,windowsVirtualKeyCode:map[key]||0});await this.cdpCall(ctx,'Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode:map[key]||0});return {pressed:key};}
    if(action==='scroll'){const amount=Math.max(1,Math.min(5000,Number(i.amount)||600)),d=i.direction||'down';return this.cdpCall(ctx,'Input.dispatchMouseEvent',{type:'mouseWheel',x:200,y:200,deltaX:d==='right'?amount:d==='left'?-amount:0,deltaY:d==='up'?-amount:d==='down'?amount:0});}
    if(action==='click'||action==='fill'){
      let nodeId,backendNodeId;
      if(i.ref)backendNodeId=Number(i.ref);else{const doc=await this.cdpCall(ctx,'DOM.getDocument',{});const match=await this.cdpCall(ctx,'DOM.querySelector',{nodeId:doc.root.nodeId,selector:String(i.selector||'')});nodeId=match.nodeId;}
      if(!nodeId&&!backendNodeId)throw fail('Element not found.');const target=nodeId?{nodeId}:{backendNodeId};
      const box=await this.cdpCall(ctx,'DOM.getBoxModel',target),q=box.model.content,x=(q[0]+q[2])/2,y=(q[1]+q[5])/2;
      await this.cdpCall(ctx,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await this.cdpCall(ctx,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
      if(action==='fill'){await this.fallback(ctx,'execute_js',{code:"const e=document.activeElement;if(e&&'value' in e){e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));}return 'cleared';"});await this.cdpCall(ctx,'Input.insertText',{text:String(i.value||'')});if(i.enter)await this.fallback(ctx,'press',{key:'Enter'});}return {action,performed:true};
    }
    throw fail('This CDP action is unsupported: '+action,'unsupported',400);
  }
  async vault(name, i, ctx) {
    const action = name.replace('browser_vault_', ''), rows = this.rows(ctx);
    if (action === 'list') return { locked: (this.unlocks.get(ctx.userId) || 0) < Date.now(), credentials: rows.map(({ encrypted, ...row }) => row) };
    if (action === 'unlock') {
      const answer = await ctx.ask({ question: 'Unlock saved browser credentials for five minutes?', options: ['Unlock', 'Cancel'] });
      if (answer.answer !== 'Unlock') throw fail('Vault unlock declined.', 'denied', 403);
      this.unlocks.set(ctx.userId, Date.now() + 300000); return { unlocked: true, expiresAt: this.unlocks.get(ctx.userId) };
    }
    const origin = await this.origin(ctx);
    if (action === 'save_login') {
      const answer = await ctx.ask({ question: `Save a login for ${origin}?`, fields: [{ name: 'username', label: 'Login', type: 'text' }, { name: 'password', label: 'Password', type: 'password' }], secret: true });
      const username = text(answer.username, 'username', 500), password = text(answer.password, 'password', 10000), handle = crypto.randomUUID();
      rows.push({ handle, origin, login: username, name: String(i.name || origin).slice(0, 100), encrypted: this.connections.encrypt(JSON.stringify({ username, password })) }); this.store.write(ctx.userId, 'browser-vault', rows); return { handle, origin, login: username, saved: true };
    }
    if ((this.unlocks.get(ctx.userId) || 0) < Date.now()) throw fail('Vault is locked; ask the user to unlock it.', 'vault_locked', 423);
    if (action === 'fill') {
      const row = rows.find(row => row.handle === i.handle && row.origin === origin); if (!row) throw fail('Credential handle does not match this exact origin.', 'origin_denied', 403);
      const secret = JSON.parse(this.connections.decrypt(row.encrypted));
      require('../src/agent/secrets-mask').registerSecret('browser vault password',secret.password);
      await this.inject(ctx, origin, i.username_selector || 'input[autocomplete="username"],input[type="email"]', secret.username);
      await this.inject(ctx, origin, i.password_selector || 'input[type="password"]', secret.password);
      return { filled: true, origin, handle: row.handle, submitted: false };
    }
    if (action === 'enter_code') {
      const answer = await ctx.ask({ question: `Enter the verification code for ${origin}`, fields: [{ name: 'code', label: 'Verification code', type: 'password' }], secret: true });
      await this.inject(ctx, origin, i.selector || 'input[autocomplete="one-time-code"]', text(answer.code, 'code', 100)); return { filled: true, origin, submitted: false };
    }
    throw fail('Unknown browser vault action.');
  }
  async origin(ctx) {
    const raw = await this.browser(ctx, 'execute_js', { code: 'return location.origin;' }); let value = raw;
    if (typeof value === 'object') value = value.result || value.text || value.value;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch {} }
    const url = new URL(String(value)); if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') throw fail('No supported web origin is active.'); return url.origin;
  }
  async inject(ctx, origin, selector, value) {
    const code = `if(location.origin!==${JSON.stringify(origin)})throw new Error('Origin changed'); const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Field not found'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'filled';`;
    const result = await this.browser(ctx, 'execute_js', { code }); if (typeof result === 'string' && /^Erreur|^Error/.test(result)) throw fail('Browser rejected credential filling.', 'browser_error', 502);
  }
  close() { for (const client of this.cdp.values()) client.close(); this.unlocks.clear(); }
}
class CdpClient {
  constructor(url) {
    this.url = url; this.closed = false; this.next = 1; this.pending = new Map(); this.events=[]; this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', () => reject(fail('CDP connection failed.', 'service_unavailable', 503)), { once: true }); });
    this.socket.addEventListener('message', event => {
      let data; try { if (String(event.data).length > 2 * 1024 * 1024) return this.close(); data = JSON.parse(event.data); } catch { return; }
      if (!data.id) { if(data.method&&/^(Runtime|Network)\./.test(data.method)){this.events.push(data);if(this.events.length>200)this.events.shift();}return; } const item = this.pending.get(data.id); if (!item) return; this.pending.delete(data.id); data.error ? item.reject(fail(String(data.error.message), 'browser_error', 502)) : item.resolve(data.result);
    });
    this.socket.addEventListener('close', () => { this.closed = true; for (const item of this.pending.values()) item.reject(fail('CDP disconnected.', 'service_unavailable', 503)); this.pending.clear(); });
  }
  async call(method, params, signal) {
    let readyTimer;try { await Promise.race([this.ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(fail('CDP connection timeout.')), 10000); readyTimer.unref(); })]); } finally { clearTimeout(readyTimer); }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(fail('CDP request timeout.', 'timeout', 504)), 15000);
      const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); error ? reject(error) : resolve(value); };
      const abort = () => finish(fail('Cancelled.', 'cancelled', 499)); if (signal?.aborted) return abort(); signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: value => finish(null, value), reject: finish }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.closed = true; this.socket.close(); }
}
module.exports = { BrowserTools, CdpClient, SAFE_CDP };
