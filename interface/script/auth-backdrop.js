/* Dotted backdrop of the sign-in screens: the dots near the pointer lift
   gently (spring), then settle. Animates only while visible and while
   something moves; static with "reduce motion". */
(() => {
    'use strict';
    const SPACING = 24, RADIUS = 1.15, REACH = 130, LIFT = 7, STIFFNESS = 0.16, DAMPING = 0.74;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    function mount(canvas) {
        const ctx = canvas.getContext('2d');
        let width = 0, height = 0, dpr = 1, dots = [], frame = 0;
        const pointer = { x: -1e4, y: -1e4, inside: false };
        // A fixed element has no offsetParent: visibility is read from its boxes.
        const visible = () => canvas.isConnected && canvas.getClientRects().length > 0 && !document.hidden;
        const token = name => getComputedStyle(canvas).getPropertyValue(name).trim();

        function layout() {
            dpr = Math.min(2, window.devicePixelRatio || 1);
            width = canvas.clientWidth; height = canvas.clientHeight;
            canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            dots = [];
            const offsetX = (width % SPACING) / 2, offsetY = (height % SPACING) / 2;
            for (let y = offsetY; y <= height; y += SPACING)
                for (let x = offsetX; x <= width; x += SPACING) dots.push({ x, y, lift: 0, speed: 0 });
            draw();
        }
        function draw() {
            const rgb = token('--auth-dot') || '255, 255, 255';
            const accent = token('--auth-accent') || '#5f62e8';
            ctx.clearRect(0, 0, width, height);
            // Resting dots in one pass, lifted ones on top with their shadow.
            ctx.fillStyle = `rgba(${rgb}, .13)`;
            ctx.beginPath();
            for (const dot of dots) if (dot.lift < 0.02) { ctx.moveTo(dot.x + RADIUS, dot.y); ctx.arc(dot.x, dot.y, RADIUS, 0, Math.PI * 2); }
            ctx.fill();
            for (const dot of dots) {
                if (dot.lift < 0.02) continue;
                const lift = Math.min(1.2, dot.lift);
                ctx.fillStyle = `rgba(0, 0, 0, ${0.22 * lift})`;
                ctx.beginPath(); ctx.arc(dot.x, dot.y + 1, RADIUS * (1 + lift * 0.4), 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = Math.min(1, 0.18 + lift * 0.7);
                ctx.fillStyle = lift > 0.45 ? accent : `rgb(${rgb})`;
                ctx.beginPath(); ctx.arc(dot.x, dot.y - lift * LIFT, RADIUS * (1 + lift * 0.9), 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        function step() {
            frame = 0;
            if (!visible()) return;
            let moving = false;
            for (const dot of dots) {
                let target = 0;
                if (pointer.inside) {
                    const distance = Math.hypot(dot.x - pointer.x, dot.y - pointer.y);
                    if (distance < REACH) { const t = 1 - distance / REACH; target = t * t * (3 - 2 * t); }
                }
                dot.speed = (dot.speed + (target - dot.lift) * STIFFNESS) * DAMPING;
                dot.lift += dot.speed;
                if (Math.abs(dot.speed) > 0.001 || Math.abs(target - dot.lift) > 0.002) moving = true;
                else { dot.lift = target; dot.speed = 0; }
            }
            draw();
            if (moving) frame = requestAnimationFrame(step);
        }
        const wake = () => { if (!frame && !reduced.matches && visible()) frame = requestAnimationFrame(step); };
        window.addEventListener('pointermove', event => {
            pointer.x = event.clientX - canvas.getBoundingClientRect().left;
            pointer.y = event.clientY - canvas.getBoundingClientRect().top;
            pointer.inside = true; wake();
        }, { passive: true });
        document.documentElement.addEventListener('pointerleave', () => { pointer.inside = false; wake(); });
        window.addEventListener('blur', () => { pointer.inside = false; wake(); });
        new ResizeObserver(layout).observe(canvas);
        // The overlay is shown again after a sign-out: redraw at its real size.
        new MutationObserver(() => { if (visible()) layout(); }).observe(canvas.parentElement, { attributes: true, attributeFilter: ['class'] });
        new MutationObserver(draw).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        layout();
    }
    const start = () => document.querySelectorAll('canvas.auth-backdrop').forEach(mount);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
