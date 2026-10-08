const { launch } = require('./cdp');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'shots3'); fs.mkdirSync(OUT, { recursive: true });
const out = n => path.join(OUT, n + '.png');
const rects = {};
const MENU = `[...document.querySelectorAll('[role=listbox],[role=menu],.custom-select-options,.model-menu,.dropdown-menu')].filter(e=>e.offsetParent && /CLOUD/.test(e.innerText))[0]`;
const rectOf = expr => `(()=>{const e=${expr}; if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()`;
const pick = txt => `(()=>{const o=[...document.querySelectorAll('*')].find(e=>e.children.length<=2 && e.textContent.trim()===${JSON.stringify(txt)} && e.offsetParent); if(o) o.click(); return !!o;})()`;

(async () => {
  for (const theme of ['dark', 'light']) {
    fs.rmSync(path.join(__dirname, '.chrome-profile-9360'), { recursive: true, force: true });
    const b = await launch({ port: 9360, width: 1600, height: 1000, scale: 2 });
    await b.goto('http://127.0.0.1:31899/');
    await b.sleep(1800);
    await b.eval(`setLanguage('en')`); await b.sleep(800);
    if (theme === 'dark') await b.eval(`state.config.theme='dark'; document.body.classList.remove('theme-light');`);
    if (theme === 'light') await b.eval(`state.config.theme='light'; document.body.classList.add('theme-light'); saveState && saveState(); const st=document.createElement('style'); st.textContent='body.theme-light .code-highlight{color:#1f2328}body.theme-light .tok-comment{color:#6e7781}body.theme-light .tok-string{color:#0a3069}body.theme-light .tok-number{color:#0550ae}body.theme-light .tok-keyword{color:#cf222e}body.theme-light .tok-func{color:#8250df}body.theme-light .tok-type{color:#953800}'; document.head.appendChild(st);`);
    // provider + model shown in the selector
    await b.eval(`document.querySelector('[aria-label^="Fournisseur"],[aria-label^="Provider"]').click()`); await b.sleep(500);
    console.log(theme, 'provider', await b.eval(pick('ChatGPT (subscription)'))); await b.sleep(600);
    await b.eval(`document.querySelector('[aria-label^="Modèle"],[aria-label^="Model"]').click()`); await b.sleep(500);
    console.log(theme, 'model', await b.eval(pick('GPT-5.6 Luna'))); await b.sleep(500);
    // real conversation
    await b.eval(`loadConversation('chat','1791307208804')`); await b.sleep(1500);
    await b.eval(`(async()=>{ for (const n of ['src','routes']) { const it=[...document.querySelectorAll('.tree-item')].find(e=>e.textContent.trim()===n); it&&it.click(); await new Promise(r=>setTimeout(r,350)); } })()`);
    await b.eval(`openFile('src/routes/bookings.js','bookings.js')`); await b.sleep(700);
    await b.eval(`(()=>{const c=document.getElementById('chat-messages'); c.scrollTop=0;})()`); await b.sleep(200);
    console.log(theme, 'innerText FR-ish:', JSON.stringify(await b.eval(fs.readFileSync(path.join(__dirname, 'en-fix.js'), 'utf8'))));
    console.log(theme,'FR left:', JSON.stringify(await b.eval(`(()=>{ document.querySelectorAll('button, span, div').forEach(e=>{ if(e.children.length===0 && e.textContent.trim()==='Copier') e.textContent='Copy'; }); const bad=[]; const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const el=n.parentElement; if(!el||!el.offsetParent) continue; const r=el.getBoundingClientRect(); if(r.width===0||r.bottom<0||r.top>innerHeight) continue; const t=n.textContent.trim(); if(/[éèàçùê]|\b(le|la|les|des|un|une|du|et|pour|avec|dans|Aucun|Projet|Fichiers|Modèle|Fournisseur|Ouvrir|Afficher|Bienvenue|Charger|Installer|Aide|Effacer|Envoyer|Copier|abonnement)\b/i.test(t)) bad.push(t.slice(0,60)); } return [...new Set(bad)].slice(0,40); })()`)));
    await b.shot(out(`hero-${theme}`));
    rects[`ai-${theme}`] = await b.eval(rectOf(`document.getElementById('ai-panel')`));
    // expanded steps
    await b.eval(`document.querySelectorAll('#chat-messages details').forEach(d=>d.setAttribute('open',''))`); await b.sleep(300);
    await b.eval(`(()=>{const c=document.getElementById('chat-messages'); c.scrollTop=0;})()`);
    await b.shot(out(`steps-${theme}`));
    await b.eval(`document.querySelectorAll('#chat-messages details').forEach(d=>d.removeAttribute('open'))`); await b.sleep(200);
    // full provider menu: taller viewport so nothing is clipped
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1500, deviceScaleFactor: 2, mobile: false }); await b.sleep(600);
    await b.eval(`document.querySelector('[aria-label^="Fournisseur"],[aria-label^="Provider"]').click()`); await b.sleep(700);
    await b.eval(`(()=>{const m=${MENU}; [m,...m.querySelectorAll('*')].forEach(e=>{const cs=getComputedStyle(e); if(cs.maxHeight!=='none'){e.style.maxHeight='none'} if(/auto|scroll/.test(cs.overflowY)){e.style.overflow='visible'; e.scrollTop=0}});})()`); await b.sleep(300);
    rects[`providers-${theme}`] = await b.eval(rectOf(MENU));
    await b.shot(out(`providers-${theme}`));
    await b.eval(`document.body.click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await b.sleep(300);
    // model list of the subscription provider
    await b.eval(`document.querySelector('[aria-label^="Modèle"],[aria-label^="Model"]').click()`); await b.sleep(700);
    rects[`models-${theme}`] = await b.eval(rectOf(`[...document.querySelectorAll('[role=listbox],[role=menu],.custom-select-options,.model-menu,.dropdown-menu')].filter(e=>e.offsetParent && /Luna/.test(e.innerText))[0]`));
    await b.shot(out(`models-${theme}`));
    await b.eval(`document.body.click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await b.sleep(300);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false }); await b.sleep(600);
    // local model catalog
    await b.eval(`document.getElementById('catalog-btn').click()`); await b.sleep(1300);
    rects[`catalog-${theme}`] = await b.eval(rectOf(`document.querySelector('.modal-overlay.active .modal, .modal-overlay.active > div')`));
    await b.eval(`(()=>{ const M={'Qualite superieure, GPU conseille.':'Higher quality, GPU recommended.','Raisonnement local compact.':'Compact local reasoning.','Raisonnement plus avance.':'More advanced reasoning.','Rapide, stable et polyvalent.':'Fast, stable and versatile.','Bon generaliste local signe Google.':'Solid local all-rounder from Google.'}; const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const t=n.textContent.trim(); if(M[t]) n.textContent=M[t]; else if(/^~?[0-9.]+ Go$/.test(t)) n.textContent=t.replace(' Go',' GB'); } })()`); await b.sleep(200);
    await b.shot(out(`catalog-${theme}`));
    await b.close();
    await b.sleep(800);
  }
  fs.writeFileSync(path.join(OUT, 'rects.json'), JSON.stringify(rects, null, 1));
  console.log(JSON.stringify(rects));
})().catch(e => { console.error(e); process.exit(1); });
