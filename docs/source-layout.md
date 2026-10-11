# Source layout

The repository root holds project metadata, assets, platform projects, and documentation. JavaScript source code lives in `src/`, `scripts/`, `test/`, `interface/`, `assistant-tools/`, `connectors/`, `native/`, and `zaalis-browser/` according to its purpose.

| Directory | Responsibility |
| --- | --- |
| `src/app/` | HTTP server and terminal CLI entrypoints. Start with `npm start`; package the server through `npm run build:server`. |
| `src/accounts/` | Account subscriptions, provider compatibility, and model metadata. |
| `src/agent/` | Rust agent bridge, MCP registry, workspace context, secret masking, and tunnel policy. |
| `src/artifacts/` | Local document and spreadsheet artifact generation. |
| `src/integrations/` | Blender, GitHub, messaging, WhatsApp, and Opale adapters. |
| `src/laboratory/` | VM management, templates, experiments, and comparisons. |
| `src/runtime/` | Desktop automation, terminal, voice, and platform services. |
| `scripts/` | Build helpers, source staging, and manual smoke checks. |
| `test/` | Automated Node.js tests and test fixtures. |
| `interface/` | Web interface, client scripts, styles, and assets. |
| `native/` | Windows, Linux, and macOS shells, platform build scripts, and packaging. |
| `rust/` | Shared agent core, providers, tools, and native CLI. |

The server and CLI resolve the repository root when run from source. A packaged server resolves assets beside its executable. Source imports use relative paths; keep module imports and platform build paths in sync when moving files. `npm test`, `npm run check:mojibake`, `npm run build:server`, and `node test/package-smoke.js` cover the principal Node paths. Native installer behavior still requires a platform-specific build and runtime check.

User language is selected at runtime. English is the source language for documentation and developer-facing comments. Explicit French locale values are translation data and must stay available while French remains a supported interface language.
