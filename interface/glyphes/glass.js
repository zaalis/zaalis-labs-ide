/* zaalis Glyphes — liquid glass.
 *  1. Light: the bright rim and the specular patch of every glass surface follow the tilt of the phone
 *     (DeviceOrientation; pointer position on a computer). Safari asks for motion access once, on the first tap.
 *  2. Elastic buttons: drag a button and it stretches like rubber (its anchor side stays put), then springs back.
 *     The "+" button also pulls the composer bar a little. */
(() => {
    'use strict';
    const root = document.documentElement;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ------------------------------------------------------------------ light
    let tx = -0.55, ty = -0.75, cx = tx, cy = ty, running = false;       // target / current light vector (screen, y down)
    function paint() {
        const ang = (Math.atan2(cx, -cy) * 180 / Math.PI + 360) % 360;
        root.style.setProperty('--la', ang.toFixed(1) + 'deg');
        root.style.setProperty('--lx', (50 + cx * 42).toFixed(1) + '%');
        root.style.setProperty('--ly', (50 + cy * 42).toFixed(1) + '%');
    }
    function loop() {
        cx += (tx - cx) * 0.14; cy += (ty - cy) * 0.14; paint();
        if (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002) requestAnimationFrame(loop); else running = false;
    }
    function aim(x, y) { tx = Math.max(-1, Math.min(1, x)); ty = Math.max(-1, Math.min(1, y)); if (reduce) { cx = tx; cy = ty; paint(); } else if (!running) { running = true; requestAnimationFrame(loop); } }
    let sensor = false;
    function onTilt(e) {
        if (e.gamma == null || e.beta == null) return;
        sensor = true;
        const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
        let g = e.gamma / 40, b = (e.beta - 55) / 40;                     // a phone is usually held ~55° from flat
        if (screenAngle === 90) [g, b] = [b, -g]; else if (screenAngle === -90 || screenAngle === 270) [g, b] = [-b, g];
        aim(g, b);
    }
    function startTilt() {
        addEventListener('deviceorientation', onTilt, true);
    }
    // Needs a user gesture on iOS.
    let asked = false;
    function askMotion() {
        if (asked) return; asked = true;
        const D = window.DeviceOrientationEvent;
        if (D && typeof D.requestPermission === 'function') { D.requestPermission().then(r => { if (r === 'granted') startTilt(); }).catch(() => {}); }
        else if (D) startTilt();
    }
    addEventListener('pointerup', askMotion, { once: true, capture: true });
    addEventListener('pointermove', (e) => {                              // computers (and a fallback before motion is allowed)
        if (sensor || e.pointerType === 'touch') return;
        aim((e.clientX / innerWidth - 0.5) * 2 * -1, (e.clientY / innerHeight - 0.5) * 2 * -1);
    }, { passive: true });
    paint();

    // ------------------------------------------------------------------ elastic buttons
    const TARGETS = '#menu-btn, #plug-btn, #plus-btn';
    const LIMIT = 10;                                                     // px of stretch at saturation (kept very light)
    const rubber = (d) => Math.sign(d) * LIMIT * (1 - Math.exp(-Math.abs(d) / LIMIT));
    let drag = null, spring = null, swallow = 0;

    // Stretch along the drag direction only. The point of the button opposite to the finger is the
    // anchor and never moves; the shape gets longer toward the finger and a little thinner across.
    // `amount` is the (rubber-banded) stretch in px; `ang` the drag direction, fixed for the whole gesture.
    function stretchTo(el, amount, ang, size) {
        const s = 1 + amount / size;                                      // amount < 0 = a short squash on the rebound
        const thin = 1 / Math.sqrt(Math.max(0.5, s));
        const deg = ang * 180 / Math.PI;
        el.style.transformOrigin = `${(50 - Math.cos(ang) * 50).toFixed(2)}% ${(50 - Math.sin(ang) * 50).toFixed(2)}%`;
        // Inline transform: wins over :active and any other rule, so it follows the finger at once.
        el.style.transform = `rotate(${deg.toFixed(2)}deg) scale(${s.toFixed(4)}, ${thin.toFixed(4)}) rotate(${(-deg).toFixed(2)}deg)`;
    }
    function setStretch(el, amount, ang, size) {
        if (el.id === 'plus-btn') {
            // The "+" lives inside the bar: the bar stretches with it, in the same direction, and the "+"
            // only a touch more, so it always stays in its place inside the bar.
            const f = el.closest('.field');
            if (f) {
                // The bar only grows: upward (its bottom stays put), and a few px wider when pulled sideways.
                // It never shrinks or moves, and pulling down does nothing.
                f.classList.add('stretching');
                const a = Math.max(0, amount);
                const up = Math.max(0, -Math.sin(ang)) * a, side = Math.abs(Math.cos(ang)) * a * 0.35;
                const w = f.offsetWidth || 300, h = f.offsetHeight || 48;
                f.style.transformOrigin = '50% 100%';
                f.style.transform = `scale(${(1 + side / w).toFixed(4)}, ${(1 + up / h).toFixed(4)})`;
            }
            stretchTo(el, amount * 0.35, ang, size);
            return;
        }
        stretchTo(el, amount, ang, size);
    }
    function clear(el) {
        el.classList.remove('stretching'); el.style.transform = ''; el.style.transformOrigin = '';
        const f = el.closest('.field'); if (f && el.id === 'plus-btn') { f.classList.remove('stretching'); f.style.transform = ''; f.style.transformOrigin = ''; }
    }
    function release() {
        if (!drag) return;
        const { el, ang, size } = drag; let x = drag.amount, v = 0, last = performance.now(); drag = null;
        if (reduce) { clear(el); return; }
        const step = (now) => {
            // Real elapsed time in small fixed steps: same speed even when frames are dropped.
            let t = Math.min(0.12, (now - last) / 1000); last = now;
            // Underdamped spring on the stretch itself, same direction: one small rebound, then rest.
            while (t > 0) { const dt = Math.min(1 / 240, t); t -= dt; v += (-300 * x - 20 * v) * dt; x += v * dt; }
            setStretch(el, x, ang, size);
            if (Math.abs(x) + Math.abs(v) * 0.05 > 0.25 && el.isConnected) { spring = requestAnimationFrame(step); } else { clear(el); spring = null; }
        };
        if (spring) cancelAnimationFrame(spring);
        spring = requestAnimationFrame(step);
    }

    document.addEventListener('pointerdown', (e) => {
        const el = e.target.closest && e.target.closest(TARGETS);
        if (!el || (el.id === 'plus-btn' && el.getAttribute('aria-expanded') === 'true')) return;
        if (spring) { cancelAnimationFrame(spring); spring = null; document.querySelectorAll('.elastic').forEach(clear); }
        const r = el.getBoundingClientRect();
        drag = { el, id: e.pointerId, x: e.clientX, y: e.clientY, amount: 0, ang: 0, size: Math.max(r.width, r.height), on: false, tick: false };
    }, true);
    document.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y, dist = Math.hypot(dx, dy);
        if (!drag.on) {
            if (dist < 4) return;
            drag.on = true; drag.el.classList.add('stretching');
            try { drag.el.setPointerCapture(e.pointerId); } catch {}
        }
        // Direction follows the finger smoothly (no jumps when it crosses an axis).
        const a = Math.atan2(dy, dx);
        if (!drag.dirSet) { drag.ang = a; drag.dirSet = true; }
        else { let d = a - drag.ang; d = Math.atan2(Math.sin(d), Math.cos(d)); drag.ang += d * 0.35; }
        drag.amount = rubber(dist);
        setStretch(drag.el, drag.amount, drag.ang, drag.size);
        if (!drag.tick && drag.amount > LIMIT * 0.55) { drag.tick = true; window.dispatchEvent(new CustomEvent('glyphes:haptic')); }
        e.preventDefault();
    }, { passive: false });
    // iOS: stop the page from scrolling/panning while a button is being stretched.
    document.addEventListener('touchmove', (e) => { if (drag && drag.on) e.preventDefault(); }, { passive: false });
    const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (drag.on) { swallow = performance.now() + 400; release(); } else drag = null;
    };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    // A drag is not a tap: do not open the list / plugins / menu at the end of a stretch.
    document.addEventListener('click', (e) => {
        if (performance.now() < swallow && e.target.closest && e.target.closest(TARGETS)) { e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
    for (const sel of TARGETS.split(', ')) { const n = document.querySelector(sel); if (n) n.classList.add('elastic'); }
})();
