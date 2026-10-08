# film2.html -> film3.html : feedback round 3. Same images, same timings.
# - no "studio-app" sticker, no "3/3 TESTS OK" stamp (nor its confetti)
# - "Ton code" / "Ton agent" leave as the camera push starts
# - no micro-shake at all: no per-pose jitter, still paper, no flicker, still grain
import os
D = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(D, 'film2.html'), encoding='utf8').read()
def rep(old, new):
    global s
    assert old in s, 'missing: ' + old[:90]
    s = s.replace(old, new, 1)

rep("function jit(id,t,a=1){", "function jit(id,t,a=1){return{x:0,y:0,r:0};")
rep("const tag=mk(el,'p tag cut grain',`<span", "const tag=mk(el,'p tag cut grain gone',`<span")
rep("const stamp=mk(el,'p stamp grain'", "const stamp=mk(el,'p stamp grain gone'")
rep("mk(el,'p bit',''", "mk(el,'p bit gone',''")
rep("</style>", ".gone{display:none!important}\n</style>")
rep("put(c.t1,life(t,{x:-470,y:-300,r:-5},13.9,null,{s:1.9,r:-16}),61,t);",
    "put(c.t1,life(t,{x:-470,y:-300,r:-5},13.9,14.62,{s:1.9,r:-16},{s:.5,o:0,r:-12}),61,t);")
rep("put(c.t2,life(t,{x:430,y:-345,r:4},14.25,null,{s:1.9,r:14}),62,t);",
    "put(c.t2,life(t,{x:430,y:-345,r:4},14.25,14.66,{s:1.9,r:14},{s:.5,o:0,r:12}),62,t);")
rep("paper.style.backgroundImage=`url(assets/paper${Math.floor(T*6)%4}.jpg)`;", "paper.style.backgroundImage='url(assets/paper0.jpg)';")
rep("flick.style.opacity=(hh(pose*17+3)*.028).toFixed(3);", "flick.style.opacity=0;")
rep("fg.style.transform=`translate(${(hh(pose)*20-10).toFixed(1)}px,${(hh(pose+99)*20-10).toFixed(1)}px)`;", "fg.style.transform='none';")
open(os.path.join(D, 'film3.html'), 'w', encoding='utf8').write(s)
print('film3 ok')
