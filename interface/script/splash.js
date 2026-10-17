// Launch splash: a ~1s brand animation played while main.js boots.
// It runs before the deferred scripts, plays its intro, then fades out as
// soon as main.js dispatches 'zaalis:ready' (or after MAX_WAIT_MS at worst).
//
// Variant: ?splash=<name> in the URL, else localStorage 'zaalis.splash',
// else DEFAULT_VARIANT. 'random' picks one each launch, 'off' disables it.
(function () {
    'use strict';

    const NS = 'http://www.w3.org/2000/svg';
    const VARIANTS = ['trace', 'bricks', 'slices', 'cube'];
    const DEFAULT_VARIANT = 'trace';
    const STORAGE_KEY = 'zaalis.splash';
    const MAX_WAIT_MS = 4000;
    const LEAVE_MS = 340;

    // The zaalis "Z", traced from image/logo-zaalis.ico on a 100-unit grid:
    // the top bar with its long diagonal, and the inner diagonal with the
    // bottom bar.
    const Z_PARTS = [
        [[16.5, 15], [75.5, 15], [77.5, 17], [77.5, 24], [52.5, 68.5], [42, 68.5], [69, 22.5], [10, 22.5]],
        [[40, 31.5], [53, 31.5], [27.5, 76], [86, 76], [79.5, 83.5], [22, 83.5], [19.5, 81], [19.5, 74]],
    ];
    const Z_BOX = { x0: 10, y0: 15, x1: 86, y1: 83.5 };
    const Z_CENTER = [48, 49.25];
    const VIEWBOX = '6 9 84 81';
    const INK = '#fafafa';
    const BG = '#0b0b0f';

    const snap = 'cubic-bezier(.34,1.45,.64,1)';
    const outExpo = 'cubic-bezier(.16,1,.3,1)';
    const inOut = 'cubic-bezier(.65,0,.35,1)';

    function el(tag, attrs, parent) {
        const node = document.createElementNS(NS, tag);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(node);
        return node;
    }
    const pts = poly => poly.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');

    // Sutherland-Hodgman clip of a polygon against an axis-aligned rectangle.
    function clipRect(poly, x0, y0, x1, y1) {
        const edges = [
            [p => p[0] >= x0, (a, b) => lerpX(a, b, x0)],
            [p => p[0] <= x1, (a, b) => lerpX(a, b, x1)],
            [p => p[1] >= y0, (a, b) => lerpY(a, b, y0)],
            [p => p[1] <= y1, (a, b) => lerpY(a, b, y1)],
        ];
        let out = poly;
        for (const [inside, cut] of edges) {
            const src = out;
            out = [];
            for (let i = 0; i < src.length; i++) {
                const cur = src[i], prev = src[(i + src.length - 1) % src.length];
                if (inside(cur)) {
                    if (!inside(prev)) out.push(cut(prev, cur));
                    out.push(cur);
                } else if (inside(prev)) {
                    out.push(cut(prev, cur));
                }
            }
            if (!out.length) break;
        }
        return out;
    }
    function lerpX(a, b, x) { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + (b[1] - a[1]) * t]; }
    function lerpY(a, b, y) { const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, y]; }
    function area(poly) {
        let s = 0;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            s += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(s) / 2;
    }
    function centroid(poly) {
        const n = poly.length;
        return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
    }
    const rand = (a, b) => a + Math.random() * (b - a);

    // Adjacent clipped pieces leave hairline anti-aliasing seams; once they
    // are in place, fade the whole Z in on top so the final mark is clean.
    function sealZ(ctx, svg, at) {
        const whole = el('g', {}, svg);
        Z_PARTS.forEach(p => el('polygon', { points: pts(p), fill: INK }, whole));
        ctx.anim(whole, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: at, easing: 'ease-out' });
    }

    function makeSvg(stage, viewBox) {
        return el('svg', { viewBox: viewBox || VIEWBOX, 'aria-hidden': 'true' }, stage);
    }

    // ---- Variants. Each builds into ctx.stage and returns the moment (ms)
    // the mark is complete; the shared finale then lights it up.

    // 1. The outline of the Z is traced, then filled and swept by a sheen.
    function trace(ctx) {
        const svg = makeSvg(ctx.stage);
        const defs = el('defs', {}, svg);
        const clip = el('clipPath', { id: 'zs-trace-clip' }, defs);
        Z_PARTS.forEach(p => el('polygon', { points: pts(p) }, clip));
        const grad = el('linearGradient', { id: 'zs-trace-sheen', x1: '0', x2: '1', y1: '0', y2: '0' }, defs);
        el('stop', { offset: '0', 'stop-color': '#c7d2fe', 'stop-opacity': '0' }, grad);
        el('stop', { offset: '.5', 'stop-color': '#c7d2fe', 'stop-opacity': '.9' }, grad);
        el('stop', { offset: '1', 'stop-color': '#c7d2fe', 'stop-opacity': '0' }, grad);

        const mark = el('g', {}, svg);
        Z_PARTS.forEach((p, i) => {
            const poly = el('polygon', {
                points: pts(p), fill: INK, 'fill-opacity': '0', stroke: INK,
                'stroke-width': '.9', 'stroke-linejoin': 'round',
            }, mark);
            const len = poly.getTotalLength ? poly.getTotalLength() : 240;
            poly.style.strokeDasharray = len;
            ctx.anim(poly, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
                { duration: 560, delay: i * 110, easing: inOut });
            ctx.anim(poly, [{ fillOpacity: 0 }, { fillOpacity: 1 }],
                { duration: 280, delay: 440 + i * 80, easing: 'ease-out' });
        });
        // The clip sits on a wrapper so it stays put while the sheen moves.
        const sheenBox = el('g', { 'clip-path': 'url(#zs-trace-clip)' }, svg);
        const sheen = el('rect', { x: '-30', y: '0', width: '28', height: '100', fill: 'url(#zs-trace-sheen)' }, sheenBox);
        ctx.anim(sheen, [{ transform: 'skewX(-20deg) translateX(0)' }, { transform: 'skewX(-20deg) translateX(150px)' }],
            { duration: 460, delay: 640, easing: 'ease-in-out' });
        ctx.glow = svg;
        return 660;
    }

    // 2. The Z is cut into bricks that fly in from all around and snap together.
    function bricks(ctx) {
        const svg = makeSvg(ctx.stage);
        const mark = el('g', {}, svg);
        const cell = 8.5, list = [];
        Z_PARTS.forEach(part => {
            for (let y = Z_BOX.y0; y < Z_BOX.y1; y += cell) {
                for (let x = Z_BOX.x0; x < Z_BOX.x1; x += cell) {
                    const piece = clipRect(part, x, y, x + cell, y + cell);
                    if (piece.length >= 3 && area(piece) > 1.2) list.push(piece);
                }
            }
        });
        // Build from the bottom up, like a wall.
        list.sort((a, b) => centroid(b)[1] - centroid(a)[1] || centroid(a)[0] - centroid(b)[0]);
        const spread = 470;
        list.forEach((piece, i) => {
            const brick = el('polygon', {
                points: pts(piece), fill: INK, stroke: BG, 'stroke-width': '.9', 'stroke-linejoin': 'round',
            }, mark);
            brick.style.transformBox = 'fill-box';
            brick.style.transformOrigin = 'center';
            const [cx, cy] = centroid(piece);
            const dx = cx - Z_CENTER[0], dy = cy - Z_CENTER[1];
            const d = Math.hypot(dx, dy) || 1, push = rand(38, 62);
            const from = `translate(${(dx / d * push).toFixed(1)}px,${(dy / d * push + rand(-10, 10)).toFixed(1)}px) rotate(${rand(-70, 70).toFixed(0)}deg) scale(.35)`;
            ctx.anim(brick, [
                { transform: from, opacity: 0 },
                { opacity: 1, offset: .35 },
                { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
            ], { duration: 420, delay: (i / Math.max(1, list.length - 1)) * spread + rand(0, 40), easing: snap });
        });
        sealZ(ctx, svg, 860);
        ctx.glow = svg;
        return 900;
    }

    // 3. Horizontal slices slide in from alternating sides, with a glitch.
    function slices(ctx) {
        const svg = makeSvg(ctx.stage);
        const ghost = el('g', { opacity: '0' }, svg);
        const mark = el('g', {}, svg);
        Z_PARTS.forEach(p => el('polygon', { points: pts(p), fill: '#818cf8' }, ghost));
        const count = 6, h = (Z_BOX.y1 - Z_BOX.y0) / count;
        for (let i = 0; i < count; i++) {
            const y0 = Z_BOX.y0 + i * h - (i === 0 ? 1 : 0.02);
            const y1 = Z_BOX.y0 + (i + 1) * h + (i === count - 1 ? 1 : 0.02);
            const band = el('g', {}, mark);
            Z_PARTS.forEach(part => {
                const piece = clipRect(part, -20, y0, 120, y1);
                if (piece.length >= 3) el('polygon', { points: pts(piece), fill: INK }, band);
            });
            const side = i % 2 ? 1 : -1;
            ctx.anim(band, [
                { transform: `translateX(${side * 95}px) skewX(${side * -24}deg)`, opacity: 0 },
                { opacity: 1, offset: .4 },
                { transform: 'translateX(0) skewX(0)', opacity: 1 },
            ], { duration: 400, delay: i * 55, easing: outExpo });
        }
        // Brief RGB-style split once the slices lock.
        ctx.anim(ghost, [
            { opacity: 0, transform: 'translateX(0)' },
            { opacity: .85, transform: 'translateX(-2.2px)', offset: .3 },
            { opacity: .5, transform: 'translateX(1.6px)', offset: .6 },
            { opacity: 0, transform: 'translateX(0)' },
        ], { duration: 220, delay: 560, easing: 'linear' });
        ctx.anim(mark, [
            { transform: 'translateX(0)' }, { transform: 'translateX(1.4px)', offset: .3 },
            { transform: 'translateX(-1px)', offset: .6 }, { transform: 'translateX(0)' },
        ], { duration: 220, delay: 560, easing: 'linear' });
        sealZ(ctx, mark, 600);
        ctx.glow = svg;
        return 640;
    }

    // 4. The isometric cube (the in-app icon) assembles from its three faces,
    // then flips over to reveal the Z.
    function cube(ctx) {
        const cubeSvg = makeSvg(ctx.stage, '-1 -1 26 26');
        const faces = [
            { p: [[12, 2], [22, 8.5], [12, 15.5], [2, 8.5]], fill: '#a5b4fc', from: 'translate(0,-16px) rotate(-25deg)' },
            { p: [[2, 8.5], [12, 15.5], [12, 22], [2, 15.5]], fill: '#6366f1', from: 'translate(-15px,9px) rotate(30deg)' },
            { p: [[12, 15.5], [22, 8.5], [22, 15.5], [12, 22]], fill: '#4338ca', from: 'translate(15px,9px) rotate(-30deg)' },
        ];
        faces.forEach((f, i) => {
            const face = el('polygon', { points: pts(f.p), fill: f.fill, stroke: BG, 'stroke-width': '.35', 'stroke-linejoin': 'round' }, cubeSvg);
            face.style.transformBox = 'fill-box';
            face.style.transformOrigin = 'center';
            ctx.anim(face, [
                { transform: f.from + ' scale(.4)', opacity: 0 },
                { opacity: 1, offset: .3 },
                { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
            ], { duration: 440, delay: i * 90, easing: snap });
        });
        // Flip: the cube folds away edge-on, the Z unfolds in its place.
        ctx.anim(cubeSvg, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
            { duration: 150, delay: 640, easing: 'cubic-bezier(.55,0,1,.45)' });
        const zSvg = makeSvg(ctx.stage);
        Z_PARTS.forEach(p => el('polygon', { points: pts(p), fill: INK }, zSvg));
        ctx.anim(zSvg, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
            { duration: 220, delay: 790, easing: 'cubic-bezier(0,.55,.45,1)' });
        ctx.glow = zSvg;
        return 900;
    }

    const BUILDERS = { trace, bricks, slices, cube };

    // Builds a variant into `root` and plays it. Returns the intro length (ms).
    function play(root, variant) {
        const build = BUILDERS[variant] || BUILDERS[DEFAULT_VARIANT];
        root.classList.add('zs-root');
        root.classList.remove('leaving', 'waiting');
        root.textContent = '';
        const stage = document.createElement('div');
        stage.className = 'zs-stage';
        const halo = document.createElement('div');
        halo.className = 'zs-halo';
        stage.appendChild(halo);
        const word = document.createElement('div');
        word.className = 'zs-word';
        word.innerHTML = '<b>zaalis labs</b><span>IDE</span>';
        const wait = document.createElement('div');
        wait.className = 'zs-wait';
        root.append(stage, word, wait);

        const anims = [];
        const ctx = {
            stage,
            glow: null,
            anim(node, frames, opts) {
                const a = node.animate(frames, Object.assign({ fill: 'both' }, opts));
                anims.push(a);
                return a;
            },
        };
        const at = build(ctx);

        // Shared finale: halo, glow pulse and wordmark.
        ctx.anim(halo, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }],
            { duration: 520, delay: at - 60, easing: outExpo });
        if (ctx.glow) {
            ctx.anim(ctx.glow, [
                { filter: 'drop-shadow(0 0 0 rgba(129,140,248,0))' },
                { filter: 'drop-shadow(0 0 10px rgba(129,140,248,.75))', offset: .35 },
                { filter: 'drop-shadow(0 0 5px rgba(129,140,248,.35))' },
            ], { duration: 480, delay: at, easing: 'ease-out' });
        }
        ctx.anim(word, [
            { opacity: 0, transform: 'translateY(8px)', letterSpacing: '.6em' },
            { opacity: 1, transform: 'translateY(0)', letterSpacing: '.32em' },
        ], { duration: 420, delay: at + 40, easing: outExpo });

        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            anims.forEach(a => a.finish());
            return 250;
        }
        return at + 460;
    }

    function pickVariant() {
        let v = null;
        try { v = new URLSearchParams(location.search).get('splash'); } catch { /* ignore */ }
        if (!v) { try { v = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ } }
        if (v === 'off') return 'off';
        if (v === 'random') return VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
        return VARIANTS.includes(v) ? v : DEFAULT_VARIANT;
    }

    function start() {
        const root = document.getElementById('zaalis-splash');
        if (!root) return;
        const variant = pickVariant();
        if (variant === 'off' || typeof root.animate !== 'function') { root.remove(); return; }

        let ready = false, introDone = false, gone = false;
        const leave = () => {
            if (gone) return;
            gone = true;
            root.classList.remove('waiting');
            root.classList.add('leaving');
            document.removeEventListener('keydown', onKey);
            setTimeout(() => root.remove(), LEAVE_MS + 20);
        };
        const onKey = e => { if (e.key === 'Escape') leave(); };
        const intro = play(root, variant);
        setTimeout(() => {
            introDone = true;
            if (ready) leave(); else root.classList.add('waiting');
        }, intro);
        window.addEventListener('zaalis:ready', () => { ready = true; if (introDone) leave(); }, { once: true });
        setTimeout(leave, MAX_WAIT_MS);
        root.addEventListener('click', leave);
        document.addEventListener('keydown', onKey);
    }

    window.ZaalisSplash = {
        variants: VARIANTS.slice(),
        play,
        // Persist the variant used on next launch ('random' and 'off' allowed).
        setVariant(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ } },
    };
    start();
})();
