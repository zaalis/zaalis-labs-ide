# Sound design for the zaalis IDE stop-motion film (v2 timings).
# Everything is synthesised: soft wind whooshes, round "ploc" clicks, muffled paper taps,
# a faint air bed and a warm pad bloom on the end card. No bells, nothing sharp.
import os, numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
DUR = 39.6
D = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(11)
N = int(SR * DUR)
dry = np.zeros((N, 2), np.float32)   # direct
send = np.zeros((N, 2), np.float32)  # reverb send

def place(sig, t0, gain=1.0, pan=0.0, rev=0.15):
    """sig: mono or stereo array. pan -1..1 (equal power)."""
    if sig.ndim == 1:
        a = (pan + 1) * np.pi / 4
        sig = np.stack([sig * np.cos(a), sig * np.sin(a)], 1)
    i0 = int(round(t0 * SR))
    if i0 >= N: return
    if i0 < 0: sig = sig[-i0:]; i0 = 0
    n = min(len(sig), N - i0)
    dry[i0:i0 + n] += sig[:n] * gain
    send[i0:i0 + n] += sig[:n] * gain * rev

def env_ad(n, a, d, curve=4.0):
    t = np.arange(n) / SR
    e = np.where(t < a, (t / max(a, 1e-6)) ** 1.5, np.exp(-(t - a) / d * curve / 4))
    return e.astype(np.float32)

def pink(n):
    w = rng.standard_normal(n)
    f = np.fft.rfft(w); k = np.arange(len(f)); k[0] = 1
    f /= np.sqrt(k)
    p = np.fft.irfft(f, n)
    return (p / (np.abs(p).max() + 1e-9)).astype(np.float32)

def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, hi], 'bandpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x).astype(np.float32)

def lp(x, fc, order=2):
    sos = signal.butter(order, fc, 'lowpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x).astype(np.float32)

def hp(x, fc, order=2):
    sos = signal.butter(order, fc, 'highpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x).astype(np.float32)

# ---------------------------------------------------------------- generators
def whoosh(dur, f0=350, f1=2200, f2=500, peak=0.55, pan0=0.0, pan1=0.0, bright=1.0):
    """Wind-like swoosh: pink noise through a band sweeping f0 -> f1 (at peak) -> f2, stereo-panned."""
    n = int(dur * SR)
    x = pink(n) * 0.6 + rng.standard_normal(n).astype(np.float32) * 0.08
    out = np.zeros(n, np.float32)
    zi = None; hop = 256
    u = np.arange(n) / n
    fc = np.where(u < peak, f0 * (f1 / f0) ** (u / peak), f1 * (f2 / f1) ** ((u - peak) / (1 - peak)))
    for i in range(0, n, hop):
        c = float(fc[min(i + hop // 2, n - 1)])
        sos = signal.butter(2, [max(60, c * 0.45), min(SR / 2 - 100, c * 1.9 * bright)], 'bandpass', fs=SR, output='sos')
        if zi is None: zi = signal.sosfilt_zi(sos) * 0
        out[i:i + hop], zi = signal.sosfilt(sos, x[i:i + hop], zi=zi)
    # smooth asymmetric envelope (soft attack, longer airy tail)
    e = np.where(u < peak, np.abs(np.sin(np.pi / 2 * np.clip(u / peak, 0, 1))) ** 2.2, np.abs(np.cos(np.pi / 2 * np.clip((u - peak) / (1 - peak), 0, 1))) ** 1.6)
    out = lp(out * e.astype(np.float32), 6000)
    out /= np.abs(out).max() + 1e-9
    pan = pan0 + (pan1 - pan0) * u
    a = (pan + 1) * np.pi / 4
    st = np.stack([out * np.cos(a), out * np.sin(a)], 1).astype(np.float32)
    return st

def ploc(f=520, dur=0.16, up=True, bright=0.35):
    """Round bubble 'ploc': short sine with a quick pitch glide, soft attack, no metallic partials."""
    n = int(dur * SR); t = np.arange(n) / SR
    if up: fr = f * (0.62 + 0.38 * (1 - np.exp(-t / 0.018)))
    else: fr = f * (1 + 0.6 * np.exp(-t / 0.012))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    s = np.sin(ph) + bright * 0.25 * np.sin(2 * ph)
    e = (1 - np.exp(-t / 0.0025)) * np.exp(-t / 0.045)
    s = lp((s * e).astype(np.float32), 2600)
    return s / (np.abs(s).max() + 1e-9)

def tap(weight=1.0, tone=1.0):
    """Muffled paper tap: soft noise slap + low body."""
    n = int(0.12 * SR); t = np.arange(n) / SR
    nz = bp(rng.standard_normal(n).astype(np.float32), 500 * tone, 2600 * tone) * np.exp(-t / 0.012) * (1 - np.exp(-t / 0.0015))
    body = np.sin(2 * np.pi * (120 * tone) * t * (1 + 0.25 * np.exp(-t / 0.01))) * np.exp(-t / 0.03) * weight
    s = lp((nz * 0.9 + body * 0.8).astype(np.float32), 3000)
    return s / (np.abs(s).max() + 1e-9)

def tick():
    """Keyboard tick: tiny, rounded."""
    n = int(0.03 * SR); t = np.arange(n) / SR
    f = rng.uniform(1700, 2300)
    s = bp(rng.standard_normal(n).astype(np.float32), 1200, 4200) * np.exp(-t / 0.004) + 0.5 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.003)
    s = lp(s.astype(np.float32), 5000)
    return s / (np.abs(s).max() + 1e-9)

def flap():
    """Paper card flip: two soft brushes of air."""
    n = int(0.16 * SR); t = np.arange(n) / SR
    x = bp(rng.standard_normal(n).astype(np.float32), 900, 3800)
    e = np.exp(-((t - 0.02) / 0.012) ** 2) + 0.7 * np.exp(-((t - 0.062) / 0.016) ** 2)
    s = lp((x * e).astype(np.float32), 4000)
    return s / (np.abs(s).max() + 1e-9)

def thump(f=68, dur=0.5):
    """Stamp hit: deep soft body + felt slap."""
    n = int(dur * SR); t = np.arange(n) / SR
    body = np.sin(2 * np.pi * f * t * (1 + 0.5 * np.exp(-t / 0.02))) * np.exp(-t / 0.11)
    slap = lp(rng.standard_normal(n).astype(np.float32), 1400) * np.exp(-t / 0.018)
    s = (body + slap * 0.6).astype(np.float32)
    return s / (np.abs(s).max() + 1e-9)

def plip():
    n = int(0.06 * SR); t = np.arange(n) / SR
    f = rng.uniform(1900, 3100)
    s = np.sin(2 * np.pi * f * t * (1 + 0.15 * (1 - np.exp(-t / 0.01)))) * (1 - np.exp(-t / 0.002)) * np.exp(-t / 0.014)
    return lp(s.astype(np.float32), 5000)

def pad(dur, notes, attack=1.2, release=2.0, fc=1100):
    n = int(dur * SR); t = np.arange(n) / SR
    s = np.zeros((n, 2), np.float32)
    for k, f in enumerate(notes):
        for det, ch in ((-0.22, 0), (0.22, 1)):
            ff = f * 2 ** (det / 12 / 3)
            v = np.sin(2 * np.pi * ff * t + k) + 0.18 * np.sin(4 * np.pi * ff * t)
            s[:, ch] += v.astype(np.float32) / len(notes)
    e = np.minimum(1, t / attack) ** 2 * np.minimum(1, (dur - t) / release).clip(0, 1) ** 1.5
    s *= e[:, None].astype(np.float32)
    for ch in (0, 1): s[:, ch] = lp(s[:, ch], fc)
    return s / (np.abs(s).max() + 1e-9)

PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7]

# ---------------------------------------------------------------- the score (seconds)
G_TAP, G_WORD = 0.16, 0.13
P = 1 / 12
def words(times, gain=G_WORD, tone=1.0):
    for i, t in enumerate(times):
        place(tap(0.6, tone * rng.uniform(0.92, 1.08)), t, gain * rng.uniform(0.85, 1.05), pan=rng.uniform(-0.25, 0.25), rev=0.12)

# air bed (very faint, keeps the film from feeling dead between cues)
bed = lp(pink(N), 420) * 0.012
bed *= np.minimum(1, np.arange(N) / SR / 1.0) * np.minimum(1, (DUR - np.arange(N) / SR) / 1.5).clip(0, 1)
bed2 = lp(pink(N), 420) * 0.012
bed2 *= np.minimum(1, np.arange(N) / SR / 1.0) * np.minimum(1, (DUR - np.arange(N) / SR) / 1.5).clip(0, 1)
dry += np.stack([bed, bed2], 1)

# Scene 1 — hook
words([0.25 + i * 0.25 + P for i in range(5)])
place(ploc(392, up=True), 1.333 + 0.02, 0.05, rev=0.25)          # serif word gets a tiny round accent
place(whoosh(0.45, 600, 2600, 900, 0.35, 0, 0.1), 2.18, 0.10, rev=0.05)

# Scene 2 — prompt
place(whoosh(0.6, 250, 1700, 400, 0.55, 0, 0), 2.30, 0.20, rev=0.06)  # card rises
place(tap(1.0, 0.8), 2.75, 0.14)
place(tap(0.7, 1.1), 3.05 + P, 0.12, pan=-0.4)                        # sticker
typed = set()
for k in range(0, 27):
    t = 3.0 + k * P
    if t > 5.12: break
    place(tick(), t + rng.uniform(-0.008, 0.008), 0.035 * rng.uniform(0.7, 1.0), pan=rng.uniform(-0.15, 0.15), rev=0.06)
place(ploc(460, up=True), 5.40, 0.22, rev=0.18)                     # send: the soft "ploc"
place(whoosh(0.55, 300, 2400, 700, 0.4, 0, 0), 5.88, 0.22, rev=0.05)  # card flies up

# Scene 3 — the agent works (real run: 7 rows)
place(whoosh(0.5, 220, 1500, 400, 0.6, -0.3, -0.3), 6.08, 0.18, rev=0.05)
place(tap(1.0, 0.75), 6.45, 0.12, pan=-0.3)
t0, gap = 6.75, 0.44
for i in range(7):
    place(tick(), t0 + i * gap, 0.03, pan=-0.35, rev=0.05)
    place(ploc(PENTA[i], up=False, dur=0.14), t0 + i * gap + 0.42, 0.075, pan=-0.3, rev=0.22)
place(whoosh(0.35, 700, 3000, 1200, 0.4, 0.6, 0.4), t0 + 3 * gap + 0.22, 0.09)   # diff card
place(tap(0.7, 1.05), t0 + 3 * gap + 0.3 + 3 * P, 0.11, pan=0.45)
place(whoosh(0.35, 500, 2400, 900, 0.4, 0.4, 0.5), t0 + 5 * gap + 0.02, 0.09)   # terminal slip
place(tap(0.8, 0.9), t0 + 5 * gap + 0.1 + 3 * P, 0.11, pan=0.5)
for k in range(5):
    place(tick(), t0 + 5 * gap + 0.3 + k * 1.6 / 12, 0.028, pan=0.5)
fin = t0 + 6 * gap + 0.45
place(ploc(659.25, up=True, dur=0.2), fin, 0.07, pan=-0.3, rev=0.3)
place(ploc(880.0, up=True, dur=0.22), fin + 0.11, 0.06, pan=-0.3, rev=0.3)
ss = fin + 0.35
place(whoosh(0.22, 1200, 3500, 1500, 0.7, 0.7, 0.6), ss - 0.12, 0.08)
place(thump(66), ss + 2 * P, 0.42, pan=0.55, rev=0.18)                 # stamp
for k in range(9):
    place(plip(), ss + 2 * P + 0.02 + rng.uniform(0, 0.33), 0.022, pan=rng.uniform(0.3, 0.9), rev=0.35)
place(whoosh(0.7, 300, 2000, 300, 0.4, 0.2, -0.8), 11.38, 0.26, rev=0.05)  # everything flies off

# Scene 4 — real product
words([12.0 + (i // 2) * 0.33 + (i % 2) * 0.09 + P for i in range(6)])
place(whoosh(0.4, 500, 1800, 600, 0.5, 0, 0), 12.93, 0.08)
place(whoosh(0.65, 200, 1400, 300, 0.6, 0, 0), 12.95, 0.24, rev=0.05)   # hero card drops in
place(thump(90, 0.35), 13.40, 0.16, rev=0.15)
place(tap(0.6, 1.1), 13.9 + P, 0.11, pan=-0.5)
place(tap(0.6, 1.15), 14.25 + P, 0.11, pan=0.45)
cam = whoosh(1.9, 120, 650, 260, 0.75, -0.1, 0.25, bright=0.7)            # slow camera push: a long breath
place(cam, 14.62, 0.13, rev=0.08)
place(whoosh(0.85, 180, 2600, 350, 0.45, 0.9, -0.9), 16.22, 0.42, rev=0.06)  # indigo wipe: wind, right -> left

# Scene 5 — models
words([16.95 + i * 0.2 + P for i in range(6)])
place(whoosh(0.45, 250, 1600, 400, 0.6, 0.4, 0.4), 17.18, 0.13)
place(tap(0.9, 0.8), 17.25 + 3 * P, 0.11, pan=0.35)
chip_x = [170, 650, 785, 140, 780, 160, 730, 140, 690]
for i in range(9):
    pan = (chip_x[i] / 960) * 0.9
    place(ploc(PENTA[i % 7] * 0.5 * rng.uniform(0.97, 1.03), up=True, dur=0.15), 17.75 + i * 0.17 + 2 * P, 0.085, pan=pan, rev=0.2)
place(whoosh(0.6, 900, 300, 120, 0.25, 0.3, 0.3), 21.08, 0.22, rev=0.05)   # chips fall away

# Scene 6 — local
words([21.58 + i * 0.22 + P for i in range(4)])
place(whoosh(0.5, 300, 2000, 500, 0.5, 0.95, 0.35), 21.62, 0.16)
place(tap(0.9, 0.8), 21.7 + 3 * P, 0.1, pan=0.4)
place(tap(0.8, 0.9), 22.6 + 3 * P, 0.1, pan=-0.5)
place(whoosh(0.22, 900, 2500, 1200, 0.5, -0.6, -0.4), 23.33, 0.06)
place(ploc(500, up=True), 23.35 + 2 * P, 0.2, pan=-0.45, rev=0.2)          # toggle: ploc
place(tap(0.5, 1.15), 23.5 + P, 0.09, pan=0.65)
place(tap(0.5, 1.1), 23.85 + P, 0.09, pan=0.2)
place(whoosh(0.6, 400, 1700, 250, 0.35, 0, 0), 25.3, 0.22, rev=0.05)

# Scene 7 — everything inside
words([25.85 + i * 0.16 + P for i in range(5)])
for i in range(6):
    pan = ((i % 3) - 1) * 0.55
    place(flap(), 26.6 + i * 0.22 + P * 0.5, 0.11, pan=pan, rev=0.12)
    place(tap(0.7, 0.95), 26.6 + i * 0.22 + 2 * P, 0.07, pan=pan)
place(whoosh(0.7, 300, 2200, 200, 0.35, 0, 0), 30.12, 0.25, rev=0.05)

# Scene 8 — pocket
words([30.7 + i * 0.18 + P for i in range(5)])
place(whoosh(0.5, 200, 1500, 350, 0.65, 0.5, 0.5), 30.82, 0.18)
place(thump(95, 0.3), 31.25, 0.12, pan=0.5)
place(tap(0.7, 1.05), 31.7 + P, 0.1, pan=0.2)
place(ploc(700, up=True, dur=0.18), 31.95, 0.06, pan=0.5, rev=0.3)           # soft notification on the phone
place(whoosh(0.85, 180, 2600, 350, 0.45, -0.9, 0.9), 33.52, 0.42, rev=0.06)   # indigo wipe: wind, left -> right

# Scene 9 — end card
for i in range(3):
    place(tap(1.0, 0.7 + i * 0.12), 34.15 + i * 0.17 + 3 * P, 0.14, pan=[-0.4, -0.2, 0.4][i], rev=0.2)
place(thump(80, 0.4), 35.0 + P, 0.12, rev=0.25)
bloom = pad(4.6, [110.0, 164.81, 220.0, 277.18, 329.63], attack=0.9, release=2.2, fc=1300)
place(bloom, 35.0, 0.11, rev=0.35)
swell = lp(pink(int(1.6 * SR)), 900) * np.sin(np.linspace(0, np.pi, int(1.6 * SR))) ** 2
place(swell, 34.55, 0.05, rev=0.3)
for i in range(7):
    place(tap(0.35, 1.25), 35.15 + i * 0.09 + P, 0.045, pan=-0.3 + i * 0.1, rev=0.15)
place(whoosh(0.7, 400, 1400, 600, 0.4, -0.2, 0.2, bright=0.6), 35.95, 0.07, rev=0.2)

# ---------------------------------------------------------------- reverb + master
ir_n = int(1.3 * SR); ti = np.arange(ir_n) / SR
ir = np.stack([lp(rng.standard_normal(ir_n).astype(np.float32), 4200) * np.exp(-ti / 0.32),
               lp(rng.standard_normal(ir_n).astype(np.float32), 4200) * np.exp(-ti / 0.32)], 1)
ir[: int(0.012 * SR)] = 0
ir /= np.sqrt((ir ** 2).sum(0))
wet = np.stack([signal.fftconvolve(send[:, c], ir[:, c])[:N] for c in (0, 1)], 1).astype(np.float32)
mix = dry + wet * 0.9
mix = hp(mix.T, 30).T  # clean sub rumble
mix = np.tanh(mix * 1.6) / 1.6  # gentle soft clip
peak = np.abs(mix).max()
mix *= 10 ** (-1.0 / 20) / peak
fade = np.ones(N, np.float32); fl = int(0.6 * SR); fade[-fl:] = np.linspace(1, 0, fl) ** 2
mix *= fade[:, None]
wavfile.write(os.path.join(D, 'sound.wav'), SR, (mix * 32767).astype(np.int16))
rms = np.sqrt((mix ** 2).mean())
print('ok peak', peak, 'rms dBFS', 20 * np.log10(rms + 1e-9))
