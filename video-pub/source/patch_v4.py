# film3.html -> film4.html : everything in English. Same timings, motion and layout.
# Scene 3 shows the real English GPT-5.6 Luna run (47 s, 13 steps, 3/3 tests).
import os, re
D = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(D, 'film3.html'), encoding='utf8').read()
def rep(old, new):
    global s
    assert old in s, 'missing: ' + old[:90]
    s = s.replace(old, new, 1)

rep('<html lang="fr">', '<html lang="en">')
# scene 1
rep("[['Décris'],['ce'],['que'],['tu'],['veux.','serif']]", "[['Just'],['say'],['what'],['you'],['want.','serif']]")
# scene 2
rep('const PROMPT="Ajoute la pagination à /api/bookings, écris les tests et lance-les.";', 'const PROMPT="Add pagination to /api/bookings, write the tests and run them.";')
rep('<b style="font-weight:600">Autonome</b>', '<b style="font-weight:600">Autonomous</b>')
# scene 3 — real English run
i0 = s.index('const STEPS=['); i1 = s.index('];', i0) + 2
s = s[:i0] + """const STEPS=[
 ['Known projects','','workspace',''],
 ['15 entries in tree','','tree',''],
 ['Read ×6','bookings.js, bookings.test.js, db.js, package.json, server.js, README.md','read',''],
 ['4 files changed','db.js, bookings.js, server.js, bookings.test.js','apply_patch','<span class="plus">+54</span> <span class="minus">−14</span>'],
 ['run','npm test','run',''],
 ['Re-read ×3','bookings.js, bookings.test.js, db.js','read',''],
];""" + s[i1:]
rep('<div class="lab">VOUS</div>', '<div class="lab">YOU</div>')
rep('<b class="ht">Analyse en cours</b>', '<b class="ht">Analyzing</b>')
a0 = s.index('<div class="answer">'); a1 = s.index('</div>`);', a0)
s = s[:a0] + '<div class="answer"><div class="who">CHATGPT</div><b>Implemented pagination for GET /api/bookings.</b><br><span style="color:var(--uit2)">page ≥ 1 · limit between 1 and 100 · defaults page=1, limit=20</span><br><b style="color:var(--ok)">npm test passed: 3 tests passed, 0 failures.</b></div>' + s[a1 + len('</div>'):]
rep("c.ht.textContent='Analyse en cours'", "c.ht.textContent='Analyzing'")
rep("c.ht.textContent='Analyse terminée en 53s';c.hs.innerHTML=ICON.check;c.hn.textContent='· 12 étapes';",
    "c.ht.textContent='Analysis complete in 47s';c.hs.innerHTML=ICON.check;c.hn.textContent='· 13 steps';")
rep("const t0=6.75,gap=.44;", "const t0=6.75,gap=.53;")   # 6 rows over the same span as before
rep("t0+5*gap+.1,OUT+.16", "t0+4*gap+.1,OUT+.16")          # terminal arrives with the "run npm test" row
rep("Math.floor((t-(t0+5*gap+.3))*P/1.6)", "Math.floor((t-(t0+4*gap+.3))*P/1.6)")
rep("""<div class="d add">+   const page = Number(req.query.page ?? 1);</div><div class="d add">+   const pageSize = Number(req.query.pageSize ?? 25);</div>""",
    """<div class="d add">+   const page = Number.parseInt(req.query.page ?? '1', 10);</div><div class="d add">+   const limit = Number.parseInt(req.query.limit ?? '20', 10);</div>""")
l0 = s.index("const lines=['$ npm test'"); l1 = s.index('];', l0) + 2
s = s[:l0] + """const lines=['$ npm test','<span class="ok">✔</span> paginates upcoming bookings','<span class="ok">✔</span> rejects invalid pagination parameters','<span class="ok">✔</span> rejects an overlapping slot','<span class="ok">ℹ tests 3 · pass 3 · fail 0</span>'];""" + s[l1:]
# scene 4
rep("[['Il'],['lit.'],['Il'],['code.'],['Il'],['vérifie.','serif']]", "[['It'],['reads.'],['It'],['codes.'],['It'],['checks.','serif']]")
rep("'Ton code','background:var(--but)'", "'Your code','background:var(--but)'")
rep("'Ton agent','background:var(--lil)'", "'Your agent','background:var(--lil)'")
rep('assets/hero-${THEME}.jpg', 'assets/hero-en-${THEME}.jpg')
# scene 5
rep("[['Tous'],['les'],['modèles.']]", "[['Every'],['model.']]")
rep("[['Un'],['seul'],['IDE.','serif']]", "[['One'],['single'],['IDE.','serif']]")
rep("'Change de modèle en un clic.'", "'Switch models in one click.'")
rep("['et bien d’autres…','',690,420,-2]", "['and many more…','',690,420,-2]")
rep('assets/providers-${THEME}.jpg', 'assets/providers-en-${THEME}.jpg')
# scene 6
rep("[['Ou'],['100&nbsp;%']]", "[['Or'],['100%']]")
rep("[['en','serif'],['local.','serif']]", "[['fully','serif'],['local.','serif']]")
rep("'Ton code ne quitte pas ton PC.'", "'Your code never leaves your PC.'")
rep("'Hors ligne','background:var(--mint)'", "'Offline','background:var(--mint)'")
rep('assets/catalog-${THEME}.jpg', 'assets/catalog-en-${THEME}.jpg')
# scene 7
t0 = s.index('const TILES=['); t1 = s.index('];', t0) + 2
s = s[:t0] + """const TILES=[['term','Built-in terminal','Your shell, next to your code','#fff'],['globe','Browser','Search, test, preview','var(--lil)'],['cursor','PC control','The AI clicks for you','var(--mint)'],['micb','Voice dictation','Speak, it types. Locally.','var(--but)'],['vm','Virtual machines','Test without breaking a thing','var(--cor)'],['integrations','Integrations','Blender, GitHub and more','#fff']];""" + s[t1:]
rep("[['Et'],['tout'],['est'],['déjà'],['dedans.','serif']]", "[['And'],['it’s'],['all'],['built&nbsp;in.','serif']]")
# scene 8
rep("[['Ton'],['IDE,']]", "[['Your'],['IDE,']]")
rep("[['dans','serif'],['ta','serif'],['poche.','serif']]", "[['in','serif'],['your','serif'],['pocket.','serif']]")
rep("'Lance une tâche, ton PC s’en charge.'", "'Start a task, your PC takes care of it.'")
rep('>Lance les tests sur studio-app</div>', '>Run the tests on studio-app</div>')
rep('</span> 3 tests réussis, 0 échec.<br><span style="color:var(--uim)">Pagination en place.</span>', '</span> 3 tests passed, 0 failures.<br><span style="color:var(--uim)">Pagination is in place.</span>')
rep('>Écrivez votre message…</div>', '>Type a message...</div>')
rep('</span>Relié à ton PC', '</span>Linked to your PC')
# scene 9
rep("'Demande. C’est codé.'", "'Ask. It’s coded.'")

# nothing French may survive in visible strings
left = re.findall(r"[^\n]{0,30}[éèàçùêâîôû][^\n]{0,30}", s.split('<script>')[1])
left = [l for l in left if 'aria' not in l and '// ' not in l and '/*' not in l]
print('accented leftovers:', left)
open(os.path.join(D, 'film4.html'), 'w', encoding='utf8').write(s)
print('film4 ok')
