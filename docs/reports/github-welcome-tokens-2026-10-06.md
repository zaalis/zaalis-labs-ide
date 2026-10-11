# GitHub integration, welcome screen, and token profile — October 6, 2026

Historical work in `connexion ide` on `codex/github-welcome-token-profile` preserved preexisting local changes and was not committed or pushed during that run.

The integration settings listed repositories visible to a fine-grained GitHub token, with per-repository none, read-only, or read/write permissions. The token remained encrypted server-side. For a recognized read-only project, the server forced read-only mode and the Rust guard independently rejected host commands, writes, desktop actions, arbitrary VM/MCP actions, and local Git operations regardless of autonomous mode. Allowed file and GitHub reads remained available. The `workspace` tool exposed authorized repository listings, files, PRs, and guarded write flows with exact identity, origin, history, and head-SHA checks; force push was excluded.

The welcome view had time-aware greetings. The token profile displayed recorded totals, daily peaks, activity days, streaks, a 12-month chart, and ten milestones. Badges did not grant credits or quota.

Historical validation: 111 of 112 JavaScript tests passed, 1 skipped; 469 Rust tests passed, 8 skipped. Edge checks covered five widths, themes, reduced motion, banner persistence, chart modes, and badges. A packaged-server test with a real Rust agent and local fixture provider allowed reads and refused writes, commands, document creation, and push. Windows server, Rust/CLI, terminal, C++ shell, and installer were rebuilt.

Real personal GitHub authentication and authenticated push/merge were not tested. Browser sign-in required `ZAALIS_GITHUB_CLIENT_ID` and enabled device flow at that time. The guard limited IDE agents and integration actions; it did not change the user's Windows account rights. Native WebView2 interaction after installation was not checked. Historical installer: unsigned, SHA-256 `D02559D41DD3C8EEEBEBDBD22B2CD23FA2203AF3DC67246A9146DAAF851D3AE5`.
