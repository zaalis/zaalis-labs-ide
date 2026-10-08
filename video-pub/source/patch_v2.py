# Turns film.html (v1) into film2.html: theme switch + real agent run + requested content fixes.
# Timings, motion and layout are untouched.
import os
D = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(D, 'film.html'), encoding='utf8').read()
n = 0
def rep(old, new, count=1):
    global s, n
    assert s.count(old) >= 1, 'missing: ' + old[:80]
    s = s.replace(old, new, count); n += 1

# ---------- theme tokens (UI replicas follow the IDE's dark / light theme) ----------
rep("--ui0:#0f0f12;--ui1:#18181b;--ui2:#27272a;--uit:#fafafa;--uim:#a1a1aa;}",
    "--ui0:#0f0f12;--ui1:#18181b;--ui2:#27272a;--uit:#fafafa;--uim:#a1a1aa;--uit2:#d4d4d8;--uib:#1e1e21;--uibub:#1f1f23;--term:#111114;--termt:#d4d4d8;--ok:#4ade80;--chk:#22c55e;--acc:#6366f1;--car:#818cf8;}\n"
    "html[data-theme=light]{--ui0:#ffffff;--ui1:#f7f7f9;--ui2:#d8d8de;--uit:#18181b;--uim:#6b6b74;--uit2:#3f3f46;--uib:#e6e6ea;--uibub:#eeeef1;--term:#f7f7f9;--termt:#3f3f46;--ok:#15803d;--chk:#16a34a;--acc:#5b5fe0;--car:#5b5fe0;}\n"
    "html[data-theme=light] .inp{background:#fff}html[data-theme=light] .ubub{background:#eeeef1}html[data-theme=light] .answer{background:#fff}\n"
    "html[data-theme=light] .term{border:2px solid #d8d8de}")
rep("border:2px solid #6366f1;padding:36px 40px 26px", "border:2px solid var(--acc);padding:36px 40px 26px")
rep("background:#818cf8;vertical-align:-8px", "background:var(--car);vertical-align:-8px")
rep(".send{width:76px;height:76px;border-radius:20px;background:#6366f1;", ".send{width:76px;height:76px;border-radius:20px;background:var(--acc);")
rep("font-size:24px;color:#d4d4d8;padding:12px 0 12px 18px;border-left:2px solid #1e1e21;margin-left:12px}",
    "font-size:23px;color:var(--uit2);padding:9px 0 9px 18px;border-left:2px solid var(--uib);margin-left:12px}")
rep("font-size:17px;color:#71717a;border:1.5px solid var(--ui2)", "font-size:17px;color:var(--uim);border:1.5px solid var(--ui2)")
rep(".plus{color:#22c55e;", ".plus{color:var(--chk);")
rep("padding:20px 24px;font-size:25px;line-height:1.45}", "padding:18px 24px;font-size:23px;line-height:1.45;color:var(--uit)}")
rep("letter-spacing:.09em;color:#f97316;margin-bottom:6px}", "letter-spacing:.09em;color:var(--uim);margin-bottom:6px}")
rep(".term{width:640px;border-radius:18px;background:#111114;padding:24px 28px;box-sizing:border-box;font-size:21px;line-height:1.65;color:#d4d4d8}",
    ".term{width:810px;border-radius:18px;background:var(--term);padding:24px 28px;box-sizing:border-box;font-size:18.5px;line-height:1.65;color:var(--termt)}")
rep(".term .ok{color:#4ade80}", ".term .ok{color:var(--ok)}")
rep("border-bottom:1.5px solid #1e1e21}", "border-bottom:1.5px solid var(--uib)}")
# real mode pill of the IDE: orange "Autonome"
rep(".send{", ".auto{color:#f97316;border-color:rgba(249,115,22,.55);background:rgba(249,115,22,.08)}\n.send{")
# integrations tile: two logos side by side
rep(".tile svg,.tile img{width:62px;height:62px}", ".tile svg,.tile img{width:62px;height:62px}.tile .logos{display:flex;gap:16px;align-items:center}")

# ---------- theme switch + icon colors ----------
rep("const P = 12;", "const THEME = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';\ndocument.documentElement.dataset.theme = THEME;\nconst P = 12;")
rep(" vm:'<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#16151A\" stroke-width=\"2\"><rect x=\"2\" y=\"3\" width=\"20\" height=\"7\" rx=\"2\"/><rect x=\"2\" y=\"14\" width=\"20\" height=\"7\" rx=\"2\"/><path d=\"M6 6.5h.01M6 17.5h.01\"/></svg>',",
    " vm:'<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#16151A\" stroke-width=\"2\"><rect x=\"2\" y=\"3\" width=\"20\" height=\"7\" rx=\"2\"/><rect x=\"2\" y=\"14\" width=\"20\" height=\"7\" rx=\"2\"/><path d=\"M6 6.5h.01M6 17.5h.01\"/></svg>',\n"
    " bolt:'<svg width=\"26\" height=\"26\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#f97316\" stroke-width=\"2\" stroke-linejoin=\"round\"><path d=\"M13 2L4 14h7l-1 8 9-12h-7z\"/></svg>',\n"
    " screen:'<svg width=\"30\" height=\"30\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#a1a1aa\" stroke-width=\"2\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M8 20h8M12 16v4\"/><circle cx=\"12\" cy=\"10\" r=\"1.6\"/></svg>',\n"
    " github:'<svg viewBox=\"0 0 24 24\" fill=\"#16151A\"><path d=\"M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6a4.7 4.7 0 0 1 1.2-3.2c-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17.3 4.8 18.3 5.1 18.3 5.1c.6 1.7.2 3 .1 3.3a4.7 4.7 0 0 1 1.2 3.2c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.5c0 .3.2.7.8.6A12 12 0 0 0 12 .5z\"/></svg>',")
rep("const cube=(c)=>", "if (THEME === 'light') { ICON.check = ICON.check.replace('#22c55e', '#16a34a'); ICON.spin = ICON.spin.replace('stroke=\"#27272a\"', 'stroke=\"#e4e4e8\"').replace('#818cf8', '#5b5fe0'); for (const k of ['plus','mic','chev','file','screen','shield']) ICON[k] = ICON[k].replace('#a1a1aa', '#6b6b74'); }\nconst cube=(c)=>")

# ---------- scene 2: real input bar of the run (Autonome + GPT-5.6 Luna) ----------
rep("<div class=\"pill\">${ICON.shield}Supervisé${ICON.chev}</div><div class=\"pill\" style=\"color:#e4e4e7\">Claude Fable 5${ICON.chev}</div><div style=\"margin-left:auto\">${ICON.mic}</div>",
    "<div class=\"pill auto\">${ICON.bolt}<b style=\"font-weight:600\">Autonome</b>${ICON.chev}</div><div class=\"ib\">${ICON.screen}</div><div class=\"pill\" style=\"color:var(--uit2)\">GPT-5.6 Luna${ICON.chev}</div><div style=\"margin-left:auto\">${ICON.mic}</div>")
rep("c.send.style.background=pressed?'#4f46e5':'#6366f1';", "c.send.style.background=pressed?'#4338ca':'';")

# ---------- scene 3: the real steps of the GPT-5.6 Luna run (53 s, 12 steps) ----------
i0 = s.index('const STEPS=['); i1 = s.index('];', i0) + 2
s = s[:i0] + """const STEPS=[
 ['7 entrées listées','','list',''],
 ['glob','**/*','glob',''],
 ['Lecture ×5','bookings.js, db.js, bookings.test.js, server.js, package.json','read',''],
 ['4 fichiers modifiés','db.js, bookings.js, server.js, bookings.test.js','apply_patch','<span class="plus">+43</span> <span class="minus">−13</span>'],
 ['1 fichier modifié','tests/bookings.test.js','apply_patch','<span class="plus">+17</span> <span class="minus">−2</span>'],
 ['run','npm test','run',''],
 ['Relecture ×2','bookings.js, bookings.test.js','read',''],
];""" + s[i1:]
rep("<b class=\"ht\">Analyse en cours…</b>", "<b class=\"ht\">Analyse en cours</b>")
rep("<div class=\"answer\"><div class=\"who\">CLAUDE</div><b>Pagination ajoutée.</b> <span style=\"color:#d4d4d8\">GET /api/bookings?page=2 renvoie la bonne tranche, limite à 50.</span><br><b style=\"color:#4ade80\">12 tests sur 12 passent.</b></div>",
    "<div class=\"answer\"><div class=\"who\">CHATGPT</div><b>Pagination ajoutée à GET /api/bookings.</b><br><span style=\"color:var(--uit2)\">page ≥ 1 · pageSize entre 1 et 100 · paramètres invalides → 400</span><br><b style=\"color:var(--ok)\">npm test : 3 tests réussis, 0 échec.</b></div>")
rep("""<div class="d del">- bookings.get('/', async (_req, res) =&gt; {</div><div class="d add">+ bookings.get('/', async (req, res) =&gt; {</div><div class="d add">+   const page = Math.max(1, Number(req.query.page) || 1);</div><div class="d add">+   const limit = Math.min(50, Number(req.query.limit) || 20);</div>""",
    """<div class="d del">- bookings.get('/', async (_req, res) =&gt; {</div><div class="d add">+ bookings.get('/', async (req, res) =&gt; {</div><div class="d add">+   const page = Number(req.query.page ?? 1);</div><div class="d add">+   const pageSize = Number(req.query.pageSize ?? 25);</div>""")
rep("<div class=\"big\">12/12</div>", "<div class=\"big\">3/3</div>")
rep("const t0=6.75,gap=.62;", "const t0=6.75,gap=.44;")
rep("const fin=t0+4*gap+.45;", "const fin=t0+(STEPS.length-1)*gap+.45;")
rep("c.ht.textContent='Analyse en cours…'", "c.ht.textContent='Analyse en cours'")
rep("c.ht.textContent='Analyse terminée en 14 s';c.hs.innerHTML=ICON.check;c.hn.textContent='· 5 étapes';",
    "c.ht.textContent='Analyse terminée en 53s';c.hs.innerHTML=ICON.check;c.hn.textContent='· 12 étapes';")
rep("put(c.diff,life(t,{x:470,y:-200,r:2.5},t0+2*gap+.3,", "put(c.diff,life(t,{x:470,y:-200,r:2.5},t0+3*gap+.3,")
rep("put(c.term,life(t,{x:520,y:150,r:-2.5},t0+4*gap+.1,", "put(c.term,life(t,{x:520,y:150,r:-2.5},t0+5*gap+.1,")
rep("""const lines=['$ npm test','<span class="ok">✔</span> refuse un créneau qui chevauche','<span class="ok">✔</span> renvoie 20 résultats par page','<span class="ok">✔</span> limite à 50 par page','<span class="ok">tests 12 · pass 12 · fail 0</span>'];""",
    """const lines=['$ npm test','<span class="ok">✔</span> GET /api/bookings pagine les résultats et renvoie les métadonnées','<span class="ok">✔</span> GET /api/bookings refuse les paramètres invalides','<span class="ok">✔</span> refuse un créneau qui chevauche','<span class="ok">ℹ tests 3 · pass 3 · fail 0</span>'];""")
rep("Math.floor((t-(t0+4*gap+.3))*P/1.6)", "Math.floor((t-(t0+5*gap+.3))*P/1.6)")

# ---------- scene 4: real IDE capture of that run ----------
rep("<img src=\"assets/hero.jpg\">", "<img src=\"assets/hero-${THEME}.jpg\">")
rep("const hero=mk(el,'p card grain','", "const hero=mk(el,'p card grain',`")
rep("<img src=\"assets/hero-${THEME}.jpg\">','width:1500px", "<img src=\"assets/hero-${THEME}.jpg\">`,'width:1500px")

# ---------- scene 5: complete provider menu + "et bien d'autres…" ----------
rep("['+ compatibles OpenAI','#8F8CF7',690,420,-2]", "['et bien d’autres…','',690,420,-2]")
rep("const prov=mk(el,'p card grain','<img src=\"assets/providers.jpg\">','width:400px;height:636px;border-radius:20px');",
    "const prov=mk(el,'p card grain',`<img src=\"assets/providers-${THEME}.jpg\">`,'width:300px;height:658px;border-radius:20px');")
rep("const chips=CHIPS.map(c=>mk(el,'p chip cut grain',`<i style=\"background:${c[1]}\"></i>${c[0]}`,c[0].startsWith('+')?'font-size:28px;background:#fff':''));",
    "const chips=CHIPS.map(c=>mk(el,'p chip cut grain',c[1]?`<i style=\"background:${c[1]}\"></i>${c[0]}`:`<span class=\"serif\" style=\"font-size:40px\">${c[0]}</span>`,c[1]?'':'background:var(--lil)'));")

# ---------- scene 6: catalog in the right theme ----------
rep("'<img src=\"assets/catalog.jpg\">','width:600px", "`<img src=\"assets/catalog-${THEME}.jpg\">`,'width:600px")

# ---------- scene 7: integrations tile (Blender + GitHub) ----------
rep("['blender','Blender','Modélise en parlant','#fff']", "['integrations','Intégrations','Blender, GitHub et plus','#fff']")
rep("${ic==='blender'?'<img src=\"assets/blender.png\">':ICON[ic]}", "${ic==='integrations'?'<div class=\"logos\"><img src=\"assets/blender.png\">'+ICON.github+'</div>':ICON[ic]}")

# ---------- scene 8: no more "scan me" QR — a "linked to your PC" tag instead ----------
rep("'Scanne, et continue depuis ton téléphone.'", "'Lance une tâche, ton PC s’en charge.'")
rep("<div class=\"m\" style=\"background:#1f1f23;margin-left:90px\">", "<div class=\"m\" style=\"background:var(--uibub);margin-left:90px\">")
rep("<div class=\"m\" style=\"background:transparent;border:1.5px solid #27272a\"><span style=\"color:#f97316;font-size:13px;font-weight:700;letter-spacing:.08em\">CLAUDE</span><br><span style=\"color:#4ade80\">✔</span> 12 tests sur 12 passent.<br><span style=\"color:#a1a1aa\">Rien à corriger.</span></div>",
    "<div class=\"m\" style=\"background:transparent;border:1.5px solid var(--ui2)\"><span style=\"color:var(--uim);font-size:13px;font-weight:700;letter-spacing:.08em\">CHATGPT</span><br><span style=\"color:var(--ok)\">✔</span> 3 tests réussis, 0 échec.<br><span style=\"color:var(--uim)\">Pagination en place.</span></div>")
rep("border-radius:20px;border:1.5px solid #27272a;color:#52525b;font-size:19px", "border-radius:20px;border:1.5px solid var(--ui2);color:var(--uim);font-size:19px")
rep("const qr=mk(el,'p qr cut grain','<img src=\"assets/qr.png\"><div>Scanne-moi</div>');",
    "const qr=mk(el,'p tag cut grain','<span style=\"display:inline-block;width:16px;height:16px;border-radius:50%;background:#1f9d55;margin-right:14px;vertical-align:2px\"></span>Relié à ton PC','background:var(--mint)');")
rep("put(c.qr,life(t,{x:175,y:250,r:-8},31.7,", "put(c.qr,life(t,{x:205,y:-300,r:-6},31.7,")


# ---------- layout fixes found on the v2 stills ----------
rep("['GGUF local','#5B57F0',265,345,4]", "['GGUF local','#5B57F0',140,330,4]")
rep("put(c.qr,life(t,{x:205,y:-300,r:-6},31.7,", "put(c.qr,life(t,{x:200,y:330,r:-6},31.7,")
# fonts: load every face before the first frame (display=block hides text while loading)
rep("window.ready=(async()=>{await document.fonts.ready;",
    "window.ready=(async()=>{await Promise.all(['500 20px \"Inter Tight\"','600 20px \"Inter Tight\"','700 20px \"Inter Tight\"','400 20px Inter','500 20px Inter','600 20px Inter','700 20px Inter','italic 400 20px \"Instrument Serif\"','400 20px \"JetBrains Mono\"','500 20px \"JetBrains Mono\"'].map(f=>document.fonts.load(f)));await document.fonts.ready;")

open(os.path.join(D, 'film2.html'), 'w', encoding='utf8').write(s)
print('patched', n)
