# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 Zaalis. Original implementation; no Blender Lab source used.
import bpy
import contextlib
import hmac
import io
import json
import queue
import socket
import threading
import time
import traceback

MAX_REQUEST = 4 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
_jobs = queue.Queue(maxsize=8)
_server = None
_stop = threading.Event()
_slots = threading.BoundedSemaphore(8)


def _preferences():
    return bpy.context.preferences.addons[__package__].preferences


def _reply(client, value):
    data = json.dumps(value, ensure_ascii=True, default=str).encode('utf8')
    if len(data) > MAX_RESPONSE:
        data = b'{"status":"error","message":"Response exceeds 16 MiB; narrow the query"}'
    client.sendall(data + b'\0')


def _handle(client, token):
    try:
        with client:
            client.settimeout(10)
            data = bytearray()
            while b'\0' not in data:
                chunk = client.recv(65536)
                if not chunk:
                    return
                data.extend(chunk)
                if len(data) > MAX_REQUEST:
                    raise ValueError('Request exceeds 4 MiB')
            request = json.loads(data.split(b'\0', 1)[0])
            if not isinstance(request, dict) or not hmac.compare_digest(str(request.get('token', '')), token):
                _reply(client, {'status': 'error', 'message': 'Authentication required'})
                return
            if request.get('type') == 'ping':
                _reply(client, {'status': 'ok', 'result': {'bridge': 'zaalis', 'version': '1.0.1'}})
                return
            if request.get('type') != 'execute' or not isinstance(request.get('code'), str):
                raise ValueError('Expected execute request with code')
            job = {'code': request['code'], 'done': threading.Event(), 'cancelled': False,
                   'queued': time.perf_counter()}
            _jobs.put_nowait(job)
            if not job['done'].wait(105):
                job['cancelled'] = True
                _reply(client, {'status': 'error', 'message': 'Execution timed out; queued work cancelled, running Python cannot be interrupted'})
                return
            _reply(client, job['reply'])
    except Exception as error:
        try:
            _reply(client, {'status': 'error', 'message': str(error)})
        except OSError:
            pass
    finally:
        _slots.release()


def _listen(server, token):
    while not _stop.is_set():
        try:
            client, _ = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        if not _slots.acquire(blocking=False):
            client.close()
            continue
        threading.Thread(target=_handle, args=(client, token), daemon=True).start()


def _pump():
    # Every bpy operation executes on Blender's main thread. Network threads
    # only handle bytes and enqueue jobs. One job per tick keeps UI responsive
    # between operations; an individual Python operation can still block it.
    try:
        job = _jobs.get_nowait()
    except queue.Empty:
        return 0.01
    if job['cancelled']:
        return 0.01
    started = time.perf_counter()
    stdout, stderr = io.StringIO(), io.StringIO()
    namespace = {'bpy': bpy, '__name__': '__zaalis__'}
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(job['code'], '<zaalis-bridge>', 'exec'), namespace)
        reply = {'status': 'ok', 'result': namespace.get('result')}
    except BaseException:
        reply = {'status': 'error', 'message': traceback.format_exc()[-12000:]}
    reply.update(stdout=stdout.getvalue()[-20000:], stderr=stderr.getvalue()[-8000:],
                 timing={'queue_ms': round((started - job['queued']) * 1000, 3),
                         'execution_ms': round((time.perf_counter() - started) * 1000, 3)})
    job['reply'] = reply
    job['done'].set()
    return 0.01


def start_server():
    global _server
    if _server is not None:
        return
    prefs = _preferences()
    if not prefs.token:
        # Installer normally generates and saves it before Blender starts.
        # Never silently start an unauthenticated server.
        raise RuntimeError('Install the Zaalis bridge from the IDE to generate its token')
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(('127.0.0.1', prefs.port))
        server.listen(8)
        server.settimeout(0.5)
    except Exception:
        server.close()
        raise
    _stop.clear()
    _server = server
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, first_interval=0.01, persistent=True)
    threading.Thread(target=_listen, args=(server, prefs.token), daemon=True).start()


def stop_server():
    global _server
    _stop.set()
    if _server is not None:
        _server.close()
        _server = None
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    while not _jobs.empty():
        try:
            job = _jobs.get_nowait()
            job['cancelled'] = True
            job['reply'] = {'status': 'error', 'message': 'Bridge stopped'}
            job['done'].set()
        except queue.Empty:
            break


def _autostart():
    try:
        if _server is None and _preferences().use_autostart:
            start_server()
    except Exception as error:
        print('Zaalis bridge:', error)
    return None


@bpy.app.handlers.persistent
def _on_load_post(*_args):
    # Opening a .blend (double-click, File > Open, startup file) clears every
    # non-persistent timer. Re-arm the autostart so the bridge is always up.
    if _server is None and not bpy.app.timers.is_registered(_autostart):
        bpy.app.timers.register(_autostart, first_interval=0.5, persistent=True)


class ZaalisPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__
    port: bpy.props.IntProperty(name='Local port', default=9877, min=1024, max=65535)
    token: bpy.props.StringProperty(name='Local authentication token', subtype='PASSWORD')
    use_autostart: bpy.props.BoolProperty(name='Start with Blender', default=True)

    def draw(self, context):
        self.layout.label(text='Zaalis local bridge — 127.0.0.1 only')
        self.layout.prop(self, 'port')
        self.layout.prop(self, 'use_autostart')
        self.layout.label(text='Running' if _server else 'Stopped; restart Blender after setup')


def register():
    bpy.utils.register_class(ZaalisPreferences)
    # persistent=True: survive the file load that follows startup when Blender
    # is opened with a .blend, which would otherwise cancel the autostart.
    bpy.app.timers.register(_autostart, first_interval=1.0, persistent=True)
    if _on_load_post not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load_post)


def unregister():
    if _on_load_post in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load_post)
    if bpy.app.timers.is_registered(_autostart):
        bpy.app.timers.unregister(_autostart)
    stop_server()
    bpy.utils.unregister_class(ZaalisPreferences)
