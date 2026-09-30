# Blender MCP add-on

`mcp-1.0.3.zip` is the official **MCP** add-on of Blender Lab, unmodified. It
runs inside Blender and opens a local TCP socket (port 9876 by default) that
executes Python sent to it. zaalis IDE talks to that socket itself
(`blender-connector.js`): no other program has to be installed.

| | |
|---|---|
| Origin | <https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.3/mcp-1.0.3.zip> |
| Page | <https://www.blender.org/lab/mcp-server/> |
| sha256 | `a7a9da816192502e5a0a202a396444e266b47d8fc4f74ad4698048bd43040707` |
| Requires | Blender 5.1 or newer |
| License | **GPL-3.0-or-later** (Blender Authors). The archive is its own complete source. |

The add-on is a separate program under its own license, redistributed here
verbatim. It is not part of the zaalis Labs IDE code and nothing of it is
copied into it: the IDE only exchanges messages with it over a socket.

## How it gets into Blender

**Settings → MCP → Blender → Installer** (after the user agrees in the window
that opens) runs, with Blender closed:

1. `blender --command extension install-file -r user_default -e mcp-1.0.3.zip`
   — skipped when the add-on is already installed, whichever version;
2. a windowless Blender that enables the add-on, its start with Blender, and
   Blender's "Allow Online Access" setting (the add-on refuses to start its
   server without it), then saves the preferences.

`blender-connector.js` refuses to install an archive whose sha256 differs from
the one above.

## Updating

Replace the archive, then update `ADDON` in `blender-connector.js`, this table
and the `Source:` line of `native/installer.iss` if the file name changes. Run
`node --test test/blender-connector.test.js`.
