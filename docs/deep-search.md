# Native web research

Status: implemented in the shared Rust core.

`zaalis-extensions` registers `web_search`, `web_fetch`, and `deep_search` in the universal `ToolRuntime`. The tools are therefore available to providers, Chat, Agents, and the CLI through the same runtime.

Before fetching, `web_fetch` accepts only HTTP(S) URLs without credentials or fragments, checks DNS and pins the resolved address, rejects private, loopback, link-local, metadata, and nonroutable addresses, disables automatic redirects, and accepts text only. Responses are capped at 1 MiB and tool output is bounded.

`deep_search` performs bounded search, reads up to six public sources with the same safeguards, and returns a structured research brief. The agent is responsible for synthesis and citations within its budget.
