/* Scripted performance of the Glyph for the presentation video.
 * window.renderFrame(i) advances the Glyph to frame i (60 fps); the capture
 * script screenshots after each call. The Glyph never leaves its spot. */
(() => {
    const FPS = 60;
    const variant = new URLSearchParams(location.search).get('variant') || 'nova';
    const g = Glyph.mount(document.getElementById('stage'), { variant, manual: true, seed: 11, shadow: true });
    Glyph.mount(document.getElementById('mini'), { variant, manual: true, seed: 5 });
    const caption = document.getElementById('caption');
    // [start second, action]
    const script = [
        [0.0, () => { g.lookAt(0, 0); g.turnTo(0, 0); say('Bonjour.'); }],
        [1.1, () => g.blink()],
        [1.8, () => { g.lookAt(-0.9, -0.1); g.turnTo(-0.9, -5); say('Il regarde autour de lui…'); }],
        [3.0, () => { g.lookAt(0.9, 0.1); g.turnTo(0.85, 6); }],
        [3.6, () => g.blink()],
        [4.4, () => { g.lookAt(0.2, -0.8); g.turnTo(0.15, 2); }],
        [5.2, () => { g.lookAt(0, 0); g.turnTo(0, 0); }],
        [5.5, () => g.blink()],
        [5.85, () => g.blink()],
        [6.4, () => { g.lookAt(null); g.turnTo(null); g.setState('working'); say('…travaille sur ta tâche…'); }],
        [9.4, () => { g.setState('waiting'); g.lookAt(0, -0.1); say('…attend ta confirmation…'); }],
        [11.6, () => { g.lookAt(null); g.setState('done'); say('…et c’est fait.'); }],
        [13.4, () => { g.setState('idle'); g.lookAt(0, 0); g.turnTo(0, 0); say(''); }],
        [14.1, () => { g.lookAt(-0.5, 0.2); g.turnTo(-0.4, -3); }],
        [15.0, () => { g.lookAt(0, 0); g.turnTo(0, 0); }],
        [15.4, () => g.blink()],
    ];
    function say(text) { caption.textContent = text; }
    let done = 0, frame = 0;
    window.TOTAL_FRAMES = Math.round(16.5 * FPS);
    window.renderFrame = target => {
        while (frame <= target) {
            const t = frame / FPS;
            while (done < script.length && script[done][0] <= t) script[done++][1]();
            g.step(1 / FPS);
            frame++;
        }
        return frame;
    };
    window.renderFrame(0);
})();
