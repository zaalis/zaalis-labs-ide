# Zaalis Blender Bridge

The active integration is original Zaalis code on both sides: the JavaScript
MCP connector in `src/integrations/` and the extension source in `zaalis_bridge/`.
It uses Blender's public Python API and Python's standard library. It does not
import Blender Lab code, require its add-on, or run its external MCP server.

The extension is GPL-3.0-or-later; the complete license is inside the archive.
This is source ownership of our integration, not ownership of Blender itself.

## Install

From the updated IDE, open **Settings → MCP → Blender → Installer**, with
Blender closed. The installer verifies the archive checksum, installs/enables
`zaalis_bridge`, generates a random local authentication token, enables
autostart, and saves preferences. It does **not** enable Blender's online-access
setting. Start Blender, then enable its connection in the IDE.

The bridge only binds `127.0.0.1:9877`, independently of Blender Lab's default
9876. An existing Lab installation is left untouched. No token is returned by
the public status endpoint or included in the agent skill.

Blender 5.1+ is declared in the manifest; real integration tests were run on
Windows with 5.2.2 and 5.3.0. The installer selects the newest detected Blender,
as before. Test on other versions/platforms before promising support.

## Build and verify

```powershell
python scripts/build-blender-bridge.py
node --test test/blender-connector.test.js
$env:BLENDER_TEST_EXE = 'C:\Program Files\Blender Foundation\Blender 5.3\blender.exe'
node --test test/blender-live.test.js
```

The deterministic builder emits `zaalis-bridge-1.0.1.zip` and its checksum in
`src/integrations/blender-bridge-release.js`. Rebuild after editing the Python
source. The Windows package ships this archive, not the former official one.

The original unmodified `mcp-1.0.3.zip` is retained **only as a benchmark fixture**
(GPL-3.0-or-later, Blender Authors), SHA-256
`a7a9da816192502e5a0a202a396444e266b47d8fc4f74ad4698048bd43040707`.
Source: [Blender Lab v1.0.3](https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.3/mcp-1.0.3.zip).
It is not loaded or installed by the new connector.

See `docs/BLENDER-ZAALIS-20261111.md` for features, limitations and measured comparison.
