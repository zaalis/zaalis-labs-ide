'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.ZAALIS_PLAYWRIGHT_PATH||'playwright');
const baseDir=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-github-profile-'));
const evidence=path.join(baseDir,'.tmp','github-profile-ui');fs.mkdirSync(evidence,{recursive:true});
const port=35900+Math.floor(Math.random()*300),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{cwd:baseDir,windowsHide:true,stdio:'ignore',env:{...process.env,ZAALIS_PORT:String(port),ZAALIS_DATA_DIR:path.join(temp,'data')}});
let browser;
async function main(){
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 assert.equal((await context.request.post(base+'/api/auth/register',{data:{email:'ui-github@zaalis.local',password:'password123'}})).status(),200);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('#custom-select-ai-submodel').waitFor();
 await page.evaluate(()=>{state.lastProjectRoot='C:/Projects/Orion';window.ZaalisWelcome.render();window.ZaalisWorkspace.setMode('chat');});
 assert.equal(await page.locator('[data-launch-welcome]').count(),1);
 const first=await page.locator('[data-launch-welcome]').textContent();
 await page.screenshot({path:path.join(evidence,'welcome-chat.png')});
 await page.evaluate(()=>{window.ZaalisWorkspace.setMode('editor');window.ZaalisWelcome.render();});
 assert.equal(await page.locator('[data-launch-welcome]').textContent(),first);
 const timeChecks=await page.evaluate(()=>{const w=window.ZaalisWelcome;return {count:Object.values(w.phrases).flat().length,bands:[4,5,11,12,17,18,22,23].map(w.band),titles:[8,15,20,1].map(h=>w.message(new Date(2026,9,6,h),'Orion').title)};});
 assert.equal(timeChecks.count,50);assert.deepEqual(timeChecks.bands,['night','morning','morning','afternoon','afternoon','evening','evening','night']);assert.deepEqual(timeChecks.titles,['Bonjour','Bonjour','Bonsoir','Bonne nuit']);
 await page.locator('#settings-btn').click();await page.locator('[data-settings-section=integrations]').click();
 await page.getByText('Jeton GitHub à permissions fines',{exact:true}).waitFor();
 assert.equal(await page.locator('#integrations-content input[type=password]').count(),1);
 await page.screenshot({path:path.join(evidence,'integrations.png')});
 await page.route('**/api/usage?*',r=>r.fulfill({json:{total:{input:1800000,output:200000,cached:10000,reasoning:4000,calls:20,unmeasured:1,unfinished:0},profile:{total:12500000,peak:700000,activeDays:24,longestStreak:12,currentStreak:4},days:[{day:Math.floor(Date.now()/86400000),input:80000,output:10000}],models:[{provider:'fixture',model:'ui-only'}],comparison:{count:0}}}));
 await page.locator('[data-settings-section=tokens]').click();await page.locator('.token-badges').waitFor();
 assert.equal(await page.locator('.token-badge').count(),10);assert.equal(await page.locator('.token-badge[data-unlocked=true]').count(),5);assert.equal(await page.locator('.token-stat').count(),5);
 assert.equal(await page.locator('.token-heatmap .token-cell').count(),366+((new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()+1)-366*86400000).getUTCDay()+6)%7));
 await page.getByRole('button',{name:'Sur 7 jours',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Sur 7 jours',exact:true}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:path.join(evidence,'tokens-desktop.png')});
 await page.locator('.token-badges').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'tokens-paliers.png')});await page.locator('.token-hero').scrollIntoViewIfNeeded();
 const tiny=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=32;const x=c.getContext('2d');x.fillStyle='#376c9f';x.fillRect(0,0,64,32);return c.toDataURL('image/png').split(',')[1];}),'base64');
 await page.locator('#tokens-content input[type=file]').setInputFiles({name:'banner.png',mimeType:'image/png',buffer:tiny});
 await page.waitForFunction(()=>document.querySelector('#tokens-content [role=status]')?.textContent==='Bannière enregistrée.');
 const saved=await (await context.request.get(base+'/api/token-profile')).json();assert.ok(saved.banner.startsWith('data:image/jpeg;'));
 await page.getByRole('button',{name:'Retirer la photo',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#tokens-content [role=status]')?.textContent==='Bannière retirée.');
 for(const width of [1100,768,560,375]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(evidence,`tokens-${width}.png`)});const overflow=await page.locator('[data-settings-pane=tokens]').evaluate(n=>n.scrollWidth>n.clientWidth+2);assert.equal(overflow,false,`pane overflow ${width}`);}
 await page.evaluate(()=>{state.config.theme='light';applyAppearance();});await page.screenshot({path:path.join(evidence,'tokens-light.png')});
 await page.locator('#close-modal').click();await page.evaluate(()=>{const n=document.createElement('div');n.className='msg msg-user';n.textContent='Test';document.getElementById('chat-messages').append(n);});await page.waitForFunction(()=>!document.querySelector('[data-launch-welcome]'));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',screenshots:evidence,checks:'welcome 50/hour boundaries, integrations, token metrics/badges/modes, banner persistence/removal, 5 viewport widths, light theme, chat cleanup',fixture:'UI measurements mocked; local auth and banner APIs real'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();child.kill();});
