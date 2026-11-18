"""Isolated integration host. Never opens or saves the user's scene/prefs."""
import bpy
import addon_utils
import os
import sys
import time

sys.path.insert(0, os.environ['ZAALIS_BRIDGE_SOURCE'])
addon_utils.enable('zaalis_bridge', default_set=True)
import zaalis_bridge

prefs = bpy.context.preferences.addons['zaalis_bridge'].preferences
prefs.token = os.environ['ZAALIS_TEST_TOKEN']
prefs.port = int(os.environ['ZAALIS_TEST_PORT'])
zaalis_bridge.start_server()
print('ZAALIS_TEST_READY', flush=True)
try:
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline and not os.path.exists(os.environ['ZAALIS_TEST_STOP']):
        zaalis_bridge._pump()
        time.sleep(0.002)
finally:
    zaalis_bridge.stop_server()
    zaalis_bridge.unregister()
