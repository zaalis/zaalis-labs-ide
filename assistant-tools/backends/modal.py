"""Owned Modal SDK adapter. No remote scripts or third-party agent code."""
import json
import sys
import threading
import modal

request = json.load(sys.stdin)
action = request.get('action', 'execute')
if action == 'create':
    app = modal.App.lookup(request['app'], create_if_missing=True)
    image = modal.Image.from_registry(request.get('image', 'debian:bookworm-slim'))
    sandbox = modal.Sandbox.create(app=app, image=image, timeout=min(86400, request.get('lifetime', 3600)))
    result = {'sandbox_id': sandbox.object_id}
else:
    sandbox = modal.Sandbox.from_id(request['sandbox_id'])
    if action == 'stop':
        sandbox.terminate()
        result = {'terminated': True}
    else:
        process = sandbox.exec('sh', '-lc', request['command'], timeout=min(1800, request.get('timeout', 120)))
        # SDK streams may be large. Bound each stream before the result is printed.
        output = {'stdout': '', 'stderr': ''}
        def collect(stream, key):
            for line in stream:
                output[key] = (output[key] + line)[-1048576:]
        readers = [threading.Thread(target=collect, args=(process.stdout, 'stdout')),
                   threading.Thread(target=collect, args=(process.stderr, 'stderr'))]
        for reader in readers:
            reader.start()
        process.wait()
        for reader in readers:
            reader.join()
        result = {**output, 'exit_code': process.returncode, 'sandbox_id': sandbox.object_id}
print(json.dumps(result))
