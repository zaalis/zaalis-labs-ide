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
    try {
      const found = String(await run('sh', ['-lc', `command -v ${name}`])).trim();
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

function appCandidates(input) {
  const alias = String(input || '').trim().toLowerCase();
  const map = {
    chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    'chrome.exe': ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    chromium: ['chromium', 'chromium-browser'], firefox: ['firefox'],
    edge: ['microsoft-edge', 'microsoft-edge-stable'], msedge: ['microsoft-edge', 'microsoft-edge-stable'],
    code: ['code'], notepad: ['gnome-text-editor', 'gedit', 'kate', 'mousepad'],
    'notepad.exe': ['gnome-text-editor', 'gedit', 'kate', 'mousepad'],
    explorer: ['nautilus', 'dolphin', 'thunar'], terminal: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal'],
  };
  return map[alias] || [input];
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
    const script = String.raw`
import gi, json, os, signal, urllib.request
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, Gdk, GLib
screen=Gdk.Screen.get_default(); visual=screen.get_rgba_visual()
border=Gtk.Window(type=Gtk.WindowType.TOPLEVEL); border.set_decorated(False); border.set_keep_above(True); border.set_accept_focus(False); border.set_app_paintable(True)
if visual: border.set_visual(visual)
border.set_default_size(screen.get_width(),screen.get_height()); border.move(0,0)
box=Gtk.EventBox(); box.set_visible_window(True); box.set_name('border'); border.add(box)
css=Gtk.CssProvider(); css.load_from_data(b'#border { background: rgba(0,0,0,0); border: 6px solid rgba(139,92,246,0.72); } #dock { background: rgba(17,10,32,0.94); border: 1px solid rgba(168,85,247,0.65); border-radius: 14px; padding: 10px 14px; }')
Gtk.StyleContext.add_provider_for_screen(screen,css,Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
border.realize(); border.get_window().set_pass_through(True); border.show_all()
dock=Gtk.Window(type=Gtk.WindowType.TOPLEVEL); dock.set_decorated(False); dock.set_keep_above(True); dock.set_type_hint(Gdk.WindowTypeHint.UTILITY)
panel=Gtk.Box(spacing=14); panel.set_name('dock'); label=Gtk.Label(label="L'IA travaille sur ce PC Linux"); button=Gtk.Button(label='Arrêter le travail'); panel.pack_start(label,True,True,0); panel.pack_start(button,False,False,0); dock.add(panel); dock.show_all(); dock.move(max(20,screen.get_width()-420),30)
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
        let target = '';
        for (const candidate of appCandidates(action.path)) {
          if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) {
            try { fs.accessSync(candidate, fs.constants.X_OK); target = candidate; break; } catch {}
          }
          target = await commandPath([candidate]); if (target) break;
        }
        if (!target) throw new Error(`application-not-found:${action.path}`);
        const child = spawn(target, [], { detached: true, stdio: 'ignore' }); child.unref();
        await new Promise((resolve) => setTimeout(resolve, 900));
        const name = path.basename(target).replace(/-stable$/, '');
        await run('xdotool', ['search', '--sync', '--onlyvisible', '--pid', String(child.pid), 'windowactivate'], { timeout: 5000 })
          .catch(() => run('xdotool', ['search', '--sync', '--onlyvisible', '--class', name, 'windowactivate'], { timeout: 5000 }).catch(() => {}));
        const win = await activeWindow().catch(() => null);
        return { ok: true, processId: child.pid, windowTitle: win && win.title, application: win && win.process };
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
