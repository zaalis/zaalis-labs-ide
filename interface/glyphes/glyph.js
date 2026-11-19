/* zaalis Glyphes : the Glyph character.
 *
 * A rounded polygon with two oval eyes. It never moves from its spot: it can
 * only look around, turn and tilt its head, blink and breathe. One renderer
 * serves the phone app, the IDE and the video export, so a Glyph looks the
 * same everywhere.
 *
 *   const g = Glyph.mount(element, { variant: 'nova', state: 'idle' });
 *   g.setState('working');   // idle | working | waiting | done | error | paused
 *   g.lookAt(x, y);          // -1..1, null to return to free roaming
 *
 * Motion is spring-damped and runs on one shared animation frame loop. With
 * { manual: true } the caller advances time itself (g.step(dt)): the video
 * export uses that to render frames at an exact rate.
 */
(function (root) {
    'use strict';

    const VARIANTS = [
        { id: 'nova',   name: 'Nova',   sides: 6, from: '#8b8dfb', to: '#4338ca', eye: '#ffffff' },
        { id: 'iris',   name: 'Iris',   sides: 5, from: '#c4b5fd', to: '#7c3aed', eye: '#ffffff' },
        { id: 'corail', name: 'Corail', sides: 4, from: '#fda4af', to: '#e11d48', eye: '#ffffff' },
        { id: 'ambre',  name: 'Ambre',  sides: 3, from: '#fcd34d', to: '#d97706', eye: '#ffffff' },
        { id: 'jade',   name: 'Jade',   sides: 6, from: '#6ee7b7', to: '#047857', eye: '#ffffff' },
        { id: 'azur',   name: 'Azur',   sides: 8, from: '#7dd3fc', to: '#0369a1', eye: '#ffffff' },
        { id: 'onyx',   name: 'Onyx',   sides: 6, from: '#5b5b66', to: '#141418', eye: '#7df9ff' },
        { id: 'perle',  name: 'Perle',  sides: 7, from: '#fafafa', to: '#a1a1aa', eye: '#1c1c22' },
        { id: 'sakura', name: 'Sakura', sides: 5, from: '#fbcfe8', to: '#db2777', eye: '#ffffff' },
        { id: 'menthe', name: 'Menthe', sides: 4, from: '#99f6e4', to: '#0f766e', eye: '#ffffff' },
        { id: 'solar',  name: 'Solar',  sides: 8, from: '#fdba74', to: '#c2410c', eye: '#ffffff' },
        { id: 'cobalt', name: 'Cobalt', sides: 7, from: '#93c5fd', to: '#1d4ed8', eye: '#ffffff' },
    ];
    const byId = Object.fromEntries(VARIANTS.map(v => [v.id, v]));
    const STATES = ['idle', 'working', 'waiting', 'done', 'error', 'paused'];
    const NS = 'http://www.w3.org/2000/svg';
    let uid = 0;

    // Rounded regular polygon, flat or pointy so every shape sits on its base.
    function polygonPath(sides, cx, cy, r, corner) {
        const start = sides % 2 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / sides;
        const pts = [];
        for (let i = 0; i < sides; i++) {
            const a = start + i * 2 * Math.PI / sides;
            pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        let d = '';
        for (let i = 0; i < sides; i++) {
            const p = pts[i], prev = pts[(i - 1 + sides) % sides], next = pts[(i + 1) % sides];
            const toPrev = [prev[0] - p[0], prev[1] - p[1]], toNext = [next[0] - p[0], next[1] - p[1]];
            const lp = Math.hypot(...toPrev), ln = Math.hypot(...toNext), k = Math.min(corner, lp / 2.2, ln / 2.2);
            const a = [p[0] + toPrev[0] / lp * k, p[1] + toPrev[1] / lp * k];
            const b = [p[0] + toNext[0] / ln * k, p[1] + toNext[1] / ln * k];
            d += (i ? 'L' : 'M') + a[0].toFixed(2) + ' ' + a[1].toFixed(2) + 'Q' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ' ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2);
        }
        return d + 'Z';
    }
    // Where the face sits: triangles carry it lower, toward their wide base.
    const faceY = sides => sides === 3 ? 60 : sides === 4 ? 53 : 52;
    const bodyRadius = sides => sides === 3 ? 44 : sides === 4 ? 40 : 38;
    const bodyCenter = sides => sides === 3 ? 56 : 52;

    function el(name, attrs, parent) {
        const node = document.createElementNS(NS, name);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(node);
        return node;
    }

    // Seeded random so two Glyphs on one screen never move in lockstep and the
    // video export is reproducible.
    function rng(seed) {
        let s = seed >>> 0 || 1;
        return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
    }
    // Critically damped spring: smooth, no overshoot wobble.
    function spring(cur, vel, target, stiffness, dt) {
        const damping = 2 * Math.sqrt(stiffness);
        const acc = stiffness * (target - cur) - damping * vel;
        vel += acc * dt;
        return [cur + vel * dt, vel];
    }

    const live = new Set();
    let frame = 0, last = 0;
    function tick(now) {
        const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
        last = now;
        for (const g of live) g.step(dt);
        frame = live.size ? requestAnimationFrame(tick) : 0;
        if (!frame) last = 0;
    }

    class Glyph {
        constructor(host, options = {}) {
            this.host = host;
            this.options = options;
            this.variant = byId[options.variant] || VARIANTS[0];
            this.state = STATES.includes(options.state) ? options.state : 'idle';
            this.manual = !!options.manual;
            this.random = rng(options.seed || (++uid * 7919 + Date.now()));
            this.t = 0;
            // Animated values and their velocities.
            this.v = { lx: 0, ly: 0, turn: 0, tilt: 0, open: 1, squint: 0, glow: 0, joy: 0, sleep: 0 };
            this.vel = Object.fromEntries(Object.keys(this.v).map(k => [k, 0]));
            this.target = { lx: 0, ly: 0, turn: 0, tilt: 0 };
            this.forced = null;
            this.nextGaze = 0.6; this.nextBlink = 1.4; this.blinkT = -1; this.doneT = -1;
            this.build();
            this.reduced = !this.manual && root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            if (this.manual) this.step(0); else this.start();
        }
        build() {
            const id = 'g' + (++uid), v = this.variant, s = v.sides;
            const svg = el('svg', { viewBox: '0 0 100 100', class: 'glyph', role: 'img', 'aria-label': v.name });
            const defs = el('defs', {}, svg);
            const body = el('linearGradient', { id: id + 'b', x1: '0', y1: '0', x2: '0.35', y2: '1' }, defs);
            el('stop', { offset: '0', 'stop-color': v.from }, body);
            el('stop', { offset: '1', 'stop-color': v.to }, body);
            const sheen = el('radialGradient', { id: id + 's', cx: '0.38', cy: '0.22', r: '0.7' }, defs);
            this.sheenGrad = sheen;
            el('stop', { offset: '0', 'stop-color': '#ffffff', 'stop-opacity': '0.55' }, sheen);
            el('stop', { offset: '0.55', 'stop-color': '#ffffff', 'stop-opacity': '0' }, sheen);
            const glow = el('radialGradient', { id: id + 'g' }, defs);
            el('stop', { offset: '0', 'stop-color': v.from, 'stop-opacity': '0.65' }, glow);
            el('stop', { offset: '1', 'stop-color': v.from, 'stop-opacity': '0' }, glow);
            const eyeGlow = el('filter', { id: id + 'e', x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
            el('feGaussianBlur', { stdDeviation: '1.6', result: 'b' }, eyeGlow);
            const merge = el('feMerge', {}, eyeGlow);
            el('feMergeNode', { in: 'b' }, merge); el('feMergeNode', { in: 'SourceGraphic' }, merge);

            this.halo = el('circle', { cx: 50, cy: bodyCenter(s), r: 49, fill: `url(#${id}g)`, opacity: 0 }, svg);
            // Ground shadow only for the presentation video ({ shadow: true }); never in the app.
            this.shadow = el('ellipse', { cx: 50, cy: 94, rx: 26, ry: 3.2, fill: '#000', opacity: this.options.shadow ? 0.22 : 0 }, svg);
            this.head = el('g', {}, svg);
            const path = polygonPath(s, 50, bodyCenter(s), bodyRadius(s), s === 3 ? 13 : 11);
            this.bodyPath = el('path', { d: path, fill: `url(#${id}b)` }, this.head);
            this.sheen = el('path', { d: path, fill: `url(#${id}s)` }, this.head);
            el('path', { d: path, fill: 'none', stroke: '#ffffff', 'stroke-opacity': '0.18', 'stroke-width': '1' }, this.head);
            this.face = el('g', { filter: v.eye === '#1c1c22' ? '' : `url(#${id}e)` }, this.head);
            this.eyes = [-1, 1].map(() => el('ellipse', { fill: v.eye }, this.face));
            // "Done" eyes: two soft arcs, shown briefly instead of the ovals.
            this.smiles = [-1, 1].map(() => el('path', { fill: 'none', stroke: v.eye, 'stroke-width': '3.4', 'stroke-linecap': 'round', opacity: 0 }, this.face));
            this.svg = svg;
            this.host.replaceChildren(svg);
        }
        start() { live.add(this); if (!frame) frame = requestAnimationFrame(tick); }
        destroy() { live.delete(this); this.host.replaceChildren(); }
        setState(state) {
            if (!STATES.includes(state) || state === this.state) return;
            this.state = state;
            this.doneT = state === 'done' ? 0 : -1;
            this.nextGaze = 0;
        }
        setVariant(id) {
            if (!byId[id] || byId[id] === this.variant) return;
            this.variant = byId[id]; this.build();
        }
        lookAt(x, y) { this.forced = x == null ? null : { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y || 0)) }; }
        // Head turn: -1 left .. 1 right; used by the video script.
        turnTo(value, tilt = 0) { this.forcedTurn = value == null ? null : { turn: value, tilt }; }
        blink() { if (this.blinkT < 0) this.blinkT = 0; }

        pickGaze() {
            const r = this.random;
            switch (this.state) {
                case 'working': {
                    // Reading: a steady sweep left to right, with a small vertical drift.
                    const side = this.target.lx > 0 ? -1 : 1;
                    this.target.lx = side * (0.55 + r() * 0.2); this.target.ly = 0.15 + r() * 0.15;
                    this.target.turn = side * 0.35; this.target.tilt = side * -2;
                    this.nextGaze = 0.9 + r() * 0.3; break;
                }
                case 'waiting':
                    this.target.lx = 0; this.target.ly = -0.1; this.target.turn = 0; this.target.tilt = 4;
                    this.nextGaze = 2.5; break;
                case 'paused':
                    this.target.lx = 0; this.target.ly = 0.35; this.target.turn = 0; this.target.tilt = -3;
                    this.nextGaze = 4; break;
                case 'error':
                    this.target.lx = (r() - 0.5) * 0.3; this.target.ly = 0.25; this.target.turn = 0; this.target.tilt = -5;
                    this.nextGaze = 1.8; break;
                default: {
                    // Idle: look somewhere, sometimes turn the whole head, sometimes come back to you.
                    const back = r() < 0.35;
                    this.target.lx = back ? 0 : (r() * 2 - 1) * 0.85;
                    this.target.ly = back ? 0 : (r() * 2 - 1) * 0.55;
                    this.target.turn = back ? 0 : (r() < 0.55 ? this.target.lx * 0.9 : 0);
                    this.target.tilt = back ? 0 : (r() * 2 - 1) * 6;
                    this.nextGaze = 1.1 + r() * 2.4;
                }
            }
        }
        step(dt) {
            if (this.reduced) dt = Math.min(dt, 0.016);
            this.t += dt;
            const r = this.random, v = this.v, vel = this.vel, target = this.target;
            if ((this.nextGaze -= dt) <= 0) this.pickGaze();
            if (this.forced) { target.lx = this.forced.x; target.ly = this.forced.y; }
            if (this.forcedTurn) { target.turn = this.forcedTurn.turn; target.tilt = this.forcedTurn.tilt; }
            // Blinks: regular when idle, slow and deliberate when waiting for you.
            if (this.state !== 'paused' && (this.nextBlink -= dt) <= 0) {
                this.blinkT = 0;
                this.nextBlink = this.state === 'waiting' ? 2.2 : 2.4 + r() * 3.2;
                if (this.state === 'idle' && r() < 0.18) this.nextBlink = 0.32; // occasional double blink
            }
            let open = 1;
            if (this.blinkT >= 0) {
                const len = this.state === 'waiting' ? 0.62 : 0.2;
                const p = this.blinkT / len;
                open = p < 0.45 ? 1 - p / 0.45 : Math.min(1, (p - 0.45) / 0.55);
                open = Math.max(0.06, open * open * (3 - 2 * open));
                this.blinkT += dt; if (this.blinkT > len) this.blinkT = -1;
            }
            const sleepTarget = this.state === 'paused' ? 1 : 0;
            const squintTarget = this.state === 'error' ? 1 : this.state === 'working' ? 0.18 : 0;
            const glowTarget = this.state === 'waiting' ? 0.55 + 0.45 * Math.sin(this.t * 2.4) : this.state === 'working' ? 0.35 : 0;
            let joyTarget = 0;
            if (this.doneT >= 0) { this.doneT += dt; joyTarget = this.doneT < 1.6 ? 1 : 0; if (this.doneT > 2.2) this.doneT = -1; }

            const K = this.state === 'working' ? 90 : 55;
            for (const k of ['lx', 'ly']) [v[k], vel[k]] = spring(v[k], vel[k], target[k], K * 1.6, dt);
            [v.turn, vel.turn] = spring(v.turn, vel.turn, target.turn, K, dt);
            [v.tilt, vel.tilt] = spring(v.tilt, vel.tilt, target.tilt, K * 0.8, dt);
            v.open = open;
            [v.squint, vel.squint] = spring(v.squint, vel.squint, squintTarget, 60, dt);
            [v.glow, vel.glow] = spring(v.glow, vel.glow, glowTarget, 40, dt);
            [v.joy, vel.joy] = spring(v.joy, vel.joy, joyTarget, 80, dt);
            [v.sleep, vel.sleep] = spring(v.sleep, vel.sleep, sleepTarget, 25, dt);
            this.render();
        }
        render() {
            const v = this.v, s = this.variant.sides, cy = bodyCenter(s);
            const breathe = 1 + Math.sin(this.t * (this.state === 'paused' ? 1.1 : 1.8)) * (this.state === 'paused' ? 0.022 : 0.012);
            // A head turn is faked in 2D: the body narrows a touch, the face slides
            // toward the turn and the far eye gets narrower than the near one.
            const turn = v.turn, squash = 1 - Math.abs(turn) * 0.07;
            this.head.setAttribute('transform',
                `translate(50 92) rotate(${v.tilt.toFixed(2)}) scale(${(squash * breathe).toFixed(4)} ${(breathe * (2 - breathe)).toFixed(4)}) translate(-50 -92)`);
            this.sheenGrad.setAttribute('cx', (0.38 + turn * 0.16).toFixed(3));
            this.shadow.setAttribute('rx', (26 * (1 - Math.abs(v.tilt) / 90) * breathe).toFixed(2));
            this.halo.setAttribute('opacity', v.glow.toFixed(3));

            const fy = faceY(s), spread = s === 3 ? 10.5 : 11.5;
            const fx = 50 + turn * 9 + v.lx * 5, gy = fy + v.ly * 4.5 + v.sleep * 2;
            const baseRx = s === 3 ? 5.6 : 6.2, baseRy = s === 3 ? 8 : 8.8;
            const openness = Math.max(0.06, v.open * (1 - v.squint * 0.62) * (1 - v.sleep * 0.93));
            const joy = Math.max(0, Math.min(1, v.joy));
            this.eyes.forEach((eye, i) => {
                const side = i ? 1 : -1;
                const near = 1 + side * turn * 0.16;         // eye on the turn side looks bigger
                const x = fx + side * spread * (1 - Math.abs(turn) * 0.18);
                eye.setAttribute('cx', x.toFixed(2));
                eye.setAttribute('cy', gy.toFixed(2));
                eye.setAttribute('rx', (baseRx * near * (1 + (1 - openness) * 0.12)).toFixed(2));
                eye.setAttribute('ry', (baseRy * near * openness).toFixed(2));
                eye.setAttribute('opacity', (1 - joy).toFixed(3));
                const w = baseRx * near * 1.05;
                this.smiles[i].setAttribute('d', `M${(x - w).toFixed(2)} ${(gy + 2).toFixed(2)}Q${x.toFixed(2)} ${(gy - 6).toFixed(2)} ${(x + w).toFixed(2)} ${(gy + 2).toFixed(2)}`);
                this.smiles[i].setAttribute('opacity', joy.toFixed(3));
            });
            this.svg.dataset.state = this.state;
        }
    }

    // A static icon (no animation loop): lists, notifications, favicons.
    function staticSvg(variantId, size = 32) {
        const host = document.createElement('span');
        const g = new Glyph(host, { variant: variantId, manual: true, seed: 3 });
        g.svg.setAttribute('width', size); g.svg.setAttribute('height', size);
        return g.svg;
    }

    const api = {
        VARIANTS, STATES, polygonPath, staticSvg,
        mount: (host, options) => new Glyph(host, options),
        variant: id => byId[id] || VARIANTS[0],
    };
    root.Glyph = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
