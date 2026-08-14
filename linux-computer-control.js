'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MAX_BUFFER = 24 * 1024 * 1024;
const KEY_NAMES = new Map([
  ['enter', 'Return'], ['return', 'Return'], ['tab', 'Tab'], ['escape', 'Escape'], ['esc', 'Escape'],
  ['backspace', 'BackSpace'], ['delete', 'Delete'], ['insert', 'Insert'], ['space', 'space'],
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'], ['home', 'Home'],
  ['end', 'End'], ['pageup', 'Prior'], ['pagedown', 'Next'], ['pgup', 'Prior'], ['pgdn', 'Next'],
  ['printscreen', 'Print'], ['prtsc', 'Print'], ['pause', 'Pause'], ['capslock', 'Caps_Lock'],
  ['numlock', 'Num_Lock'], ['scrolllock', 'Scroll_Lock'], ['menu', 'Menu'], ['apps', 'Menu'],
  ['win', 'Super_L'], ['windows', 'Super_L'], ['volumeup', 'XF86AudioRaiseVolume'],
  ['volumedown', 'XF86AudioLowerVolume'], ['volumemute', 'XF86AudioMute'],
  ['medianext', 'XF86AudioNext'], ['mediaprev', 'XF86AudioPrev'], ['mediastop', 'XF86AudioStop'],
  ['mediaplaypause', 'XF86AudioPlay'],
]);

function run(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || MAX_BUFFER,
      env: options.env || process.env,
      encoding: options.encoding === null ? null : 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || error).trim();
        error.detail = detail;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

async function commandPath(names) {
  for (const name of names) {
    if (!name) continue;
    try {
      // Le nom est passe en argument positionnel ($1), jamais interpole dans le
      // script : aucune injection possible meme si le modele demande un nom
      // exotique. On accepte donc des noms d'app varies selon la distribution.
      const found = String(await run('sh', ['-lc', 'command -v "$1" 2>/dev/null || true', 'sh', String(name)])).trim();
      if (found) return found;
    } catch {}
  }
  return '';
}

function safeUnlink(file) { try { fs.unlinkSync(file); } catch {} }
function tempPng() { return path.join(os.tmpdir(), `zaalis-inspect-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`); }

function parseGeometry(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z]+)=(.*)$/);
    if (match) values[match[1]] = Number(match[2]);
  }
  return {
    x: Number.isFinite(values.X) ? values.X : 0,
    y: Number.isFinite(values.Y) ? values.Y : 0,
    width: Number.isFinite(values.WIDTH) ? values.WIDTH : 0,
    height: Number.isFinite(values.HEIGHT) ? values.HEIGHT : 0,
  };
}

async function activeWindow() {
  const id = String(await run('xdotool', ['getactivewindow'])).trim();
  const [title, geometry, pid] = await Promise.all([
    run('xdotool', ['getwindowname', id]).catch(() => ''),
    run('xdotool', ['getwindowgeometry', '--shell', id]).catch(() => ''),
    run('xdotool', ['getwindowpid', id]).catch(() => ''),
  ]);
  let processName = '';
  if (String(pid).trim()) {
    try { processName = String(await run('ps', ['-p', String(pid).trim(), '-o', 'comm='])).trim(); } catch {}
  }
  return { id, title: String(title).trim(), pid: Number(String(pid).trim()) || 0, process: processName, frame: parseGeometry(geometry) };
}

async function screenshot(action, win) {
  const output = tempPng();
  try {
    if (action.target === 'active_window') {
      await run('import', ['-window', win.id, output], { timeout: 45_000 });
      return { file: output, capture: win.frame };
    }
    if (action.target === 'region') {
      const crop = `${Math.round(action.width)}x${Math.round(action.height)}+${Math.round(action.x)}+${Math.round(action.y)}`;
      await run('import', ['-window', 'root', '-crop', crop, output], { timeout: 45_000 });
      return { file: output, capture: { x: action.x, y: action.y, width: action.width, height: action.height } };
    }
    await run('import', ['-window', 'root', output], { timeout: 45_000 });
    return { file: output, capture: null };
  } catch (firstError) {
    safeUnlink(output);
    if (action.target === 'active_window') {
      await run('gnome-screenshot', ['-w', '-f', output], { timeout: 45_000 });
      return { file: output, capture: win.frame };
    }
    if (action.target === 'region') {
      await run('gnome-screenshot', ['-a', '-f', output], { timeout: 45_000 });
      return { file: output, capture: null };
    }
    await run('gnome-screenshot', ['-f', output], { timeout: 45_000 });
    return { file: output, capture: null };
  }
}

async function ocr(file, capture) {
  const raw = String(await run('tesseract', [file, 'stdout', '-l', 'eng', 'tsv'], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }));
  const lines = raw.split(/\r?\n/).slice(1);
  const groups = new Map();
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 12 || !cols[11].trim()) continue;
    const key = cols.slice(0, 5).join(':');
    const left = Number(cols[6]) || 0, top = Number(cols[7]) || 0, width = Number(cols[8]) || 0, height = Number(cols[9]) || 0;
    const item = groups.get(key) || { text: '', x: left, y: top, width, height };
    item.text += (item.text ? ' ' : '') + cols[11].trim();
    item.width = Math.max(item.width, left + width - item.x);
    item.height = Math.max(item.height, top + height - item.y);
    groups.set(key, item);
  }
  const ox = capture && capture.x || 0, oy = capture && capture.y || 0;
  return Array.from(groups.values()).slice(0, 100).map((item) => ({ ...item, x: item.x + ox, y: item.y + oy }));
}

const ACCESSIBILITY_SCRIPT = String.raw`
import json
try:
 import pyatspi
 desktop=pyatspi.Registry.getDesktop(0)
 nodes=[]
 app_name=''
 focused=None
 def walk(node, depth=0):
  global focused, app_name
  if len(nodes)>=400 or depth>14: return
  try:
   state=node.getState()
   if state.contains(pyatspi.STATE_FOCUSED): focused=node
   ext=node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
   role=node.getRoleName()
   name='' if role=='password text' else (node.name or '')
   if ext.width>0 and ext.height>0:
    nodes.append({'role':role,'title':name[:240],'frame':{'x':ext.x,'y':ext.y,'width':ext.width,'height':ext.height},'enabled':state.contains(pyatspi.STATE_ENABLED),'offscreen':not state.contains(pyatspi.STATE_SHOWING),'secure':role=='password text'})
  except Exception: pass
  try:
   for child in node: walk(child,depth+1)
  except Exception: pass
 for app in desktop:
  try:
   if app.getState().contains(pyatspi.STATE_ACTIVE):
    app_name=app.name or ''
    walk(app)
    break
  except Exception: pass
 print(json.dumps({'application':app_name,'focusedWindow':None,'truncated':len(nodes)>=400,'elements':nodes}))
except Exception as e:
 print(json.dumps({'error':str(e)}))
`;

async function accessibility(maxElements) {
  const data = JSON.parse(String(await run('python3', ['-c', ACCESSIBILITY_SCRIPT], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })));
  if (data.error) throw new Error(data.error);
  data.elements = Array.isArray(data.elements) ? data.elements.slice(0, maxElements || 220) : [];
  return data;
}

function shortcutMenus(processName) {
  if (/chrome|chromium|firefox|brave/i.test(processName)) return [
    ['New tab', 'Ctrl+T'], ['Focus address bar', 'Ctrl+L'], ['New window', 'Ctrl+N'],
    ['Reopen closed tab', 'Ctrl+Shift+T'], ['Find in page', 'Ctrl+F'], ['Downloads', 'Ctrl+J'],
    ['History', 'Ctrl+H'], ['Close tab', 'Ctrl+W'],
  ].map(([name, shortcut]) => ({ name, type: 'Shortcut', shortcut, source: 'browser-standard' }));
  return [['Select all','Ctrl+A'],['Copy','Ctrl+C'],['Paste','Ctrl+V'],['Cut','Ctrl+X'],['Undo','Ctrl+Z'],['Redo','Ctrl+Shift+Z'],['Save','Ctrl+S'],['Find','Ctrl+F']]
    .map(([name, shortcut]) => ({ name, type: 'Shortcut', shortcut, source: 'linux-standard' }));
}

// Alias generiques -> type MIME freedesktop. Sert a resoudre « l'app par defaut
// du bureau » via xdg-mime, quel que soit l'environnement (GNOME, KDE, XFCE,
// MATE, Cinnamon, LXQt...) et donc quelle que soit la distribution.
const SEMANTIC_MIME = {
  notepad: 'text/plain', 'notepad.exe': 'text/plain', notes: 'text/plain', note: 'text/plain',
  editor: 'text/plain', texteditor: 'text/plain', 'text editor': 'text/plain',
  editeur: 'text/plain', 'editeur de texte': 'text/plain', 'bloc-notes': 'text/plain', 'bloc notes': 'text/plain',
  browser: 'x-scheme-handler/https', 'web browser': 'x-scheme-handler/https', web: 'x-scheme-handler/https',
  navigateur: 'x-scheme-handler/https', 'navigateur web': 'x-scheme-handler/https', internet: 'x-scheme-handler/https',
  files: 'inode/directory', explorer: 'inode/directory', 'file manager': 'inode/directory',
  fichiers: 'inode/directory', 'gestionnaire de fichiers': 'inode/directory',
};

function appCandidates(input) {
  const alias = String(input || '').trim().toLowerCase();
  // Une liste par famille, couvrant les grands bureaux Linux. On essaie chaque
  // variante et on garde la premiere reellement installee : peu importe la
  // distribution, le nom exact demande par le modele, ou le bureau utilise.
  const editors = ['xed', 'gnome-text-editor', 'org.gnome.TextEditor', 'gedit', 'pluma', 'kate', 'kwrite', 'mousepad', 'leafpad', 'l3afpad', 'geany'];
  const browsers = ['firefox', 'firefox-esr', 'org.mozilla.firefox', 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge-stable', 'microsoft-edge', 'vivaldi-stable', 'epiphany', 'falkon', 'midori'];
  const fileManagers = ['nemo', 'nautilus', 'org.gnome.Nautilus', 'dolphin', 'thunar', 'caja', 'pcmanfm', 'pcmanfm-qt'];
  const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'mate-terminal', 'tilix', 'kitty', 'alacritty', 'xterm'];
  const map = {
    chrome: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'],
    'chrome.exe': ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'],
    chromium: ['chromium', 'chromium-browser'],
    firefox: browsers, 'firefox.exe': browsers,
    edge: ['microsoft-edge-stable', 'microsoft-edge'], msedge: ['microsoft-edge-stable', 'microsoft-edge'],
    browser: browsers, navigateur: browsers, web: browsers, internet: browsers, 'web browser': browsers, 'navigateur web': browsers,
    code: ['code', 'codium', 'code-oss'],
    notepad: editors, 'notepad.exe': editors, notes: editors, note: editors, editor: editors, texteditor: editors,
    'text editor': editors, editeur: editors, 'editeur de texte': editors, 'bloc-notes': editors, 'bloc notes': editors,
    'gnome-text-editor': editors, gedit: editors, pluma: editors, kate: editors, mousepad: editors, xed: editors, leafpad: editors,
    explorer: fileManagers, files: fileManagers, fichiers: fileManagers, 'file manager': fileManagers, 'gestionnaire de fichiers': fileManagers,
    nautilus: fileManagers, nemo: fileManagers, dolphin: fileManagers, thunar: fileManagers,
    terminal: terminals, terminale: terminals, console: terminals,
  };
  return map[alias] || [input];
}

// Application par defaut du bureau pour un type MIME (freedesktop). Retourne un
// identifiant .desktop, ex. « org.x.editor.desktop ». Universel toutes distros.
async function xdgDefaultDesktop(mime) {
  if (!mime) return '';
  try { return String(await run('sh', ['-lc', 'xdg-mime query default "$1" 2>/dev/null || true', 'sh', String(mime)])).trim(); }
  catch { return ''; }
}

// Localise un fichier .desktop dans les emplacements standards (systeme, XDG,
// Flatpak, Snap). Permet de lancer une app par son id meme si son binaire n'est
// pas sur le PATH (cas frequent des paquets Flatpak/Snap).
function desktopFilePath(id) {
  const file = String(id || '').endsWith('.desktop') ? String(id) : `${id}.desktop`;
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications', '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/snapd/desktop/applications',
  ];
  for (const d of dirs) { const p = path.join(d, file); try { if (fs.existsSync(p)) return p; } catch {} }
  return '';
}

function createLinuxComputerAction({ port, secret }) {
  let overlayProcess = null;
  let overlayState = '';

  function publish(action) {
    if (!overlayState || !action) return;
    try { fs.writeFileSync(overlayState, JSON.stringify({ action: action.action, x: action.x, y: action.y, at: Date.now() }), 'utf8'); } catch {}
  }

  function stopOverlay() {
    if (overlayState) safeUnlink(overlayState);
    overlayState = '';
    if (overlayProcess && overlayProcess.exitCode == null) { try { overlayProcess.kill('SIGTERM'); } catch {} }
    overlayProcess = null;
  }

  function startOverlay() {
    if (overlayProcess && overlayProcess.exitCode == null) return { ok: true, pid: overlayProcess.pid };
    overlayState = path.join(os.tmpdir(), `zaalis-linux-overlay-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(overlayState, '{}', 'utf8');
    // Rendu strictement aligne sur l'overlay macOS (Electron/CSS) et sur celui
    // de Windows (WPF) : memes couleurs, memes proportions, memes cadences.
    //   bordure  : 28 px, degrade 135 deg, opacite .9 respirant vers .55 en 5,5 s
    //   brume    : deux halos dans les coins haut-gauche et bas-droit, alpha .28,
    //              derive de 3% / -2% et zoom 1.06 en 12 s, aller-retour
    //   barre    : 320x58, centree en bas de la zone de travail, marge 34 px
    // La geometrie des halos vient de « .mist{inset:-25%} » cote CSS : ramenes
    // en coordonnees d'ecran, les degrades radiaux se logent dans les coins, pas
    // au milieu de l'ecran.
    const script = String.raw`
import gi, os, signal, time, urllib.request, cairo
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, Gdk, GLib
screen=Gdk.Screen.get_default(); visual=screen.get_rgba_visual()
border=Gtk.Window(type=Gtk.WindowType.TOPLEVEL); border.set_decorated(False); border.set_keep_above(True); border.set_accept_focus(False); border.set_app_paintable(True)
if visual: border.set_visual(visual)
border.set_default_size(screen.get_width(),screen.get_height()); border.move(0,0)
box=Gtk.EventBox(); box.set_visible_window(False); box.set_app_paintable(True); border.add(box)
start=time.monotonic()
def wave(period):
 # Triangle 0->1->0 sur une periode, equivalent d'une animation CSS alternate.
 t=(time.monotonic()-start)%(2*period)/period
 return t if t<=1 else 2-t
def mist(cr, cx, cy, rx, ry, color):
 cr.save(); cr.translate(cx,cy); cr.scale(rx,ry)
 g=cairo.RadialGradient(0,0,0,0,0,1); g.add_color_stop_rgba(0,*color); g.add_color_stop_rgba(1,color[0],color[1],color[2],0)
 cr.set_source(g); cr.rectangle(-1,-1,2,2); cr.fill(); cr.restore()
def edge_mask(x0,y0,x1,y1,peak):
 # Une bande « plume » le long d'un bord : transparente au ras (0), opaque au
 # pic (20 px), re-transparente a 80 px. EXTEND_PAD par defaut hors [0,1] ->
 # le reste de l'ecran reste transparent. Transpose au double du -webkit-mask
 # du navigateur (transparent, #000 10px, transparent 40px).
 m=cairo.LinearGradient(x0,y0,x1,y1)
 m.add_color_stop_rgba(0,1,1,1,0); m.add_color_stop_rgba(peak,1,1,1,1); m.add_color_stop_rgba(1,1,1,1,0)
 return m
def draw_overlay(widget, cr):
 w=widget.get_allocated_width(); h=widget.get_allocated_height()
 d=wave(12.0)
 cr.save(); cr.translate(.03*w*d, -.02*h*d); cr.translate(w/2,h/2); cr.scale(1+.06*d,1+.06*d); cr.translate(-w/2,-h/2)
 mist(cr, .95*w, 1.01*h, .456*w, .479*h, (.400,.176,.824,.28))
 cr.restore()
 # Bordure = halo « setAiControlBorder » du navigateur zaalis, en violet et
 # deux fois plus epais : un degrade horizontal qui DEFILE (repete deux fois sur
 # la largeur -> background-size 200%, translate anime -> background-position),
 # decoupe en cadre par quatre masques plume (haut/bas/gauche/droite). La
 # douceur vient du fondu des masques, exactement comme le blur+mask CSS.
 tile=max(1.0,w/2.0)
 flow=cairo.LinearGradient(0,0,tile,0)
 flow.add_color_stop_rgba(0.0,.357,.133,.686,.85)
 flow.add_color_stop_rgba(0.25,.615,.349,1.0,.85)
 flow.add_color_stop_rgba(0.5,.780,.549,1.0,.85)
 flow.add_color_stop_rgba(0.75,.615,.349,1.0,.85)
 flow.add_color_stop_rgba(1.0,.357,.133,.686,.85)
 flow.set_extend(cairo.Extend.REPEAT)
 ph=((time.monotonic()-start)/7.0)%1.0*tile
 flow.set_matrix(cairo.Matrix(1,0,0,1,ph,0))
 cr.push_group()
 for m in (edge_mask(0,0,0,80,0.25), edge_mask(0,h-80,0,h,0.75), edge_mask(0,0,80,0,0.25), edge_mask(w-80,0,w,0,0.75)):
  cr.set_source(flow); cr.mask(m)
 cr.pop_group_to_source(); cr.paint_with_alpha(0.8)
 return False
box.connect('draw',draw_overlay)
css=Gtk.CssProvider(); css.load_from_data(b'#dock { background: rgba(24,14,42,0.88); border: 1px solid rgba(214,187,255,0.36); border-radius: 18px; color: #f4ecff; } #dock label { font-size: 12px; font-weight: 650; } #stop { background-image: none; background-color: #db3d56; color: #ffffff; font-size: 12px; font-weight: 700; border: 0; border-radius: 11px; padding: 8px 12px; min-height: 0; } #stop:hover { background-color: #f05068; }')
Gtk.StyleContext.add_provider_for_screen(screen,css,Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
border.realize(); border.get_window().set_pass_through(True); border.show_all()
dock=Gtk.Window(type=Gtk.WindowType.TOPLEVEL); dock.set_decorated(False); dock.set_keep_above(True); dock.set_accept_focus(False); dock.set_app_paintable(True); dock.set_type_hint(Gdk.WindowTypeHint.UTILITY)
if visual: dock.set_visual(visual)
dock.set_size_request(320,58)
panel=Gtk.Box(spacing=12); panel.set_name('dock'); panel.set_margin_start(13); panel.set_margin_end(13)
pulse=Gtk.DrawingArea(); pulse.set_size_request(9,9); pulse.set_valign(Gtk.Align.CENTER)
def draw_pulse(widget, cr):
 # Point qui bat, comme le .pulse de la barre macOS (1,6 s, aller-retour).
 k=wave(.8); r=4.5*(1-.4*k)
 cr.set_source_rgba(.702,.424,1,1-.55*k); cr.arc(4.5,4.5,r,0,6.2832); cr.fill()
 return False
pulse.connect('draw',draw_pulse)
label=Gtk.Label(label="L'IA travaille sur ce PC Linux"); label.set_xalign(0.0); label.set_ellipsize(3)
button=Gtk.Button(label='Arrêter le travail'); button.set_name('stop'); button.set_valign(Gtk.Align.CENTER)
panel.pack_start(pulse,False,False,0); panel.pack_start(label,True,True,0); panel.pack_start(button,False,False,0)
dock.add(panel); dock.show_all()
mon=Gdk.Display.get_default().get_primary_monitor()
area=mon.get_workarea() if mon else None
if area: dock.move(area.x+max(0,(area.width-320)//2), area.y+area.height-58-34)
else: dock.move(max(0,(screen.get_width()-320)//2), screen.get_height()-58-34)
def tick():
 box.queue_draw(); pulse.queue_draw(); return True
GLib.timeout_add(40,tick)
def stop(*args): Gtk.main_quit(); return False
def clicked(*args):
 try:
  req=urllib.request.Request('http://127.0.0.1:'+os.environ['ZAALIS_OVERLAY_PORT']+'/api/automation/stop-bridge',method='POST',headers={'x-zaalis-computer':os.environ['ZAALIS_OVERLAY_SECRET']})
  urllib.request.urlopen(req,timeout=5).read()
 except Exception: pass
 stop()
button.connect('clicked',clicked); signal.signal(signal.SIGTERM,lambda *a: GLib.idle_add(stop)); Gtk.main()
`;
    overlayProcess = spawn('python3', ['-c', script], { stdio: 'ignore', env: { ...process.env, ZAALIS_OVERLAY_PORT: String(port), ZAALIS_OVERLAY_SECRET: secret, ZAALIS_OVERLAY_STATE: overlayState } });
    overlayProcess.once('exit', () => { overlayProcess = null; safeUnlink(overlayState); overlayState = ''; });
    overlayProcess.once('error', () => { overlayProcess = null; });
    return { ok: true, pid: overlayProcess.pid };
  }

  return async function linuxComputerAction(action) {
    if (process.platform !== 'linux') return { ok: false, error: 'unsupported-platform' };
    if (action && action.action === 'overlay_start') return startOverlay();
    if (action && action.action === 'overlay_stop') { stopOverlay(); return { ok: true }; }
    try {
      const hasInput = !!await commandPath(['xdotool']);
      const hasCapture = !!await commandPath(['import', 'gnome-screenshot']);
      if (action.action === 'status' || action.action === 'request_permissions') {
        let hasAtSpi = false;
        try { await run('python3', ['-c', 'import pyatspi']); hasAtSpi = true; } catch {}
        const hasDesktop = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
        return { ok: hasDesktop && hasInput && hasCapture && hasAtSpi, accessibility: hasDesktop && hasInput && hasAtSpi, screenRecording: hasDesktop && hasCapture, platform: 'linux', session: process.env.XDG_SESSION_TYPE || '' };
      }
      if (!hasInput) throw new Error('xdotool-not-installed');
      publish(action);
      if (action.action === 'move') { await run('xdotool', ['mousemove', '--sync', String(Math.round(action.x)), String(Math.round(action.y))]); return { ok: true }; }
      if (action.action === 'click') { await run('xdotool', ['mousemove', '--sync', String(Math.round(action.x)), String(Math.round(action.y)), 'click', action.button === 'right' ? '3' : '1']); return { ok: true }; }
      if (action.action === 'scroll') {
        const button = action.dy > 0 ? '4' : '5', count = Math.max(1, Math.min(40, Math.abs(Number(action.dy) || 1)));
        await run('xdotool', ['click', '--repeat', String(count), '--delay', '20', button]); return { ok: true };
      }
      if (action.action === 'type') {
        const xclip = await commandPath(['xclip']);
        if (xclip) {
          const clipboard = spawn(xclip, ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
          clipboard.stdin.end(String(action.text));
          await new Promise((resolve) => setTimeout(resolve, 100));
          await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
          setTimeout(() => { try { clipboard.kill('SIGTERM'); } catch {} }, 250).unref();
        } else await run('xdotool', ['type', '--clearmodifiers', '--delay', '1', String(action.text)]);
        return { ok: true };
      }
      if (action.action === 'key') {
        const mods = (action.modifiers || []).map((m) => ({ control: 'ctrl', command: 'ctrl', cmd: 'ctrl', option: 'alt', opt: 'alt', meta: 'super', win: 'super', windows: 'super' }[m] || m));
        const name = String(action.key || '').toLowerCase();
        const key = KEY_NAMES.get(name) || (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(name) ? name.toUpperCase() : (name.length === 1 ? name : ''));
        if (!key) throw new Error(`unsupported-key:${name}`);
        await run('xdotool', ['key', '--clearmodifiers', [...mods, key].join('+')]); return { ok: true };
      }
      if (action.action === 'open_terminal') {
        const terminal = await commandPath(appCandidates('terminal'));
        if (!terminal) throw new Error('terminal-not-found');
        const child = spawn(terminal, [], { detached: true, stdio: 'ignore' }); child.unref(); return { ok: true, processId: child.pid };
      }
      if (action.action === 'activate_app') {
        const requested = String(action.path || '');
        const candidates = appCandidates(requested);
        let launched = null; // { pid, name, byDesktop }
        // 1) Executable direct : chemin absolu, ou commande trouvee sur le PATH.
        for (const candidate of candidates) {
          if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) {
            try { fs.accessSync(candidate, fs.constants.X_OK); const c = spawn(candidate, [], { detached: true, stdio: 'ignore' }); c.unref(); launched = { pid: c.pid, name: path.basename(candidate).replace(/-stable$/, '') }; break; } catch {}
          }
          const found = await commandPath([candidate]);
          if (found) { const c = spawn(found, [], { detached: true, stdio: 'ignore' }); c.unref(); launched = { pid: c.pid, name: path.basename(found).replace(/-stable$/, '') }; break; }
        }
        // 2) Repli universel freedesktop : lancer le .desktop de l'app par defaut
        //    du bureau (via xdg-mime) ou celui portant le nom demande, avec
        //    gtk-launch puis gio. Couvre Flatpak/Snap et toute distribution.
        if (!launched) {
          const ids = [];
          const mime = SEMANTIC_MIME[requested.trim().toLowerCase()];
          if (mime) { const def = await xdgDefaultDesktop(mime); if (def) ids.push(def); }
          for (const c of candidates) ids.push(c);
          ids.push(requested);
          const gtk = await commandPath(['gtk-launch']);
          for (const id of ids) {
            const deskPath = desktopFilePath(id);
            if (!deskPath) continue;
            const base = path.basename(deskPath).replace(/\.desktop$/, '');
            try {
              const c = gtk
                ? spawn(gtk, [base], { detached: true, stdio: 'ignore', env: process.env })
                : spawn('gio', ['launch', deskPath], { detached: true, stdio: 'ignore', env: process.env });
              c.unref(); launched = { pid: c.pid, name: base, byDesktop: true }; break;
            } catch {}
          }
        }
        if (!launched) throw new Error(`application-not-found:${requested}`);
        // On attend que la fenetre soit reellement visible avant de rendre la
        // main : une app qui demarre a froid (Firefox, LibreOffice, un Flatpak)
        // peut mettre plusieurs secondes, et un type/key envoye trop tot partirait
        // dans le vide. On sonde jusqu'a ~8 s, par PID (executable direct) puis
        // par classe/nom (lancement .desktop, ou le PID est celui du lanceur).
        const selectors = launched.byDesktop
          ? [['--class', launched.name], ['--classname', launched.name], ['--name', launched.name]]
          : [['--pid', String(launched.pid)], ['--class', launched.name], ['--classname', launched.name]];
        let windowId = '';
        for (let i = 0; i < 40 && !windowId; i += 1) {
          for (const sel of selectors) {
            try {
              const ids = String(await run('xdotool', ['search', '--onlyvisible', ...sel], { timeout: 3000 })).trim().split(/\s+/).filter(Boolean);
              if (ids.length) { windowId = ids[ids.length - 1]; break; }
            } catch {}
          }
          if (!windowId) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (windowId) {
          await run('xdotool', ['windowactivate', '--sync', windowId], { timeout: 4000 }).catch(() => {});
          // Laisse le gestionnaire de fenetres donner le focus clavier avant que
          // le modele n'enchaine un type/key.
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        const win = await activeWindow().catch(() => null);
        return { ok: true, processId: launched.pid, windowTitle: win && win.title, application: win && win.process, ready: !!windowId };
      }
      const win = await activeWindow();
      if (action.action === 'menus') {
        let ui = null; try { ui = await accessibility(action.max_elements || 220); } catch {}
        const elements = (ui && ui.elements || []).filter((e) => /menu|button|tab|toolbar/i.test(e.role || '') && e.title).slice(0, 120);
        const menus = elements.length ? elements.map((e) => ({ name: e.title, type: e.role, frame: e.frame, source: 'at-spi' })) : shortcutMenus(win.process);
        return { ok: true, application: win.title || win.process, process: win.process, menus };
      }
      if (action.action === 'observe' || action.action === 'inspect') {
        const result = { ok: true, target: action.target || 'active_window', application: win.title || win.process, process: win.process };
        let capture = null;
        if (action.include_image !== false) {
          try { capture = await screenshot(action, win); result.capture = capture.capture; result.image = fs.readFileSync(capture.file).toString('base64'); result.mime = 'image/png'; }
          catch (error) { result.captureError = error.detail || error.message; }
        }
        if (action.action === 'inspect' && action.include_ocr !== false && capture) {
          try { result.ocr = await ocr(capture.file, capture.capture); } catch (error) { result.ocr = []; result.ocrError = error.detail || error.message; }
        }
        if (action.action === 'inspect' && action.include_ui !== false) {
          try { result.ui = await accessibility(action.max_elements || 220); result.ui.focusedWindow = win.frame; }
          catch (error) { result.uiError = error.detail || error.message; }
        }
        if (capture) safeUnlink(capture.file);
        return result;
      }
      throw new Error(`unsupported-action:${action.action}`);
    } catch (error) {
      return { ok: false, error: String(error.detail || error.message || error).slice(0, 1000) };
    }
  };
}

module.exports = { createLinuxComputerAction };
